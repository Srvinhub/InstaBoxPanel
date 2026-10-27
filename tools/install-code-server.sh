#!/usr/bin/env bash
# Native code-server setup for Debian/Ubuntu with systemd.
# Configuration and usage: docs/CODE_SERVER.md
set -Eeuo pipefail
umask 077

fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
log() { printf '\n==> %s\n' "$*"; }

[[ $# == 0 ]] || fail 'Configure this script with CODE_SERVER_* environment variables; see docs/CODE_SERVER.md.'
[[ -r /etc/os-release ]] || fail 'This script requires Debian or Ubuntu.'
. /etc/os-release
case "${ID:-}" in debian|ubuntu) ;; *) fail 'Only Debian and Ubuntu are supported.' ;; esac
[[ $(cat /proc/1/comm) == systemd ]] || fail 'systemd must be running as PID 1.'

ROOT=()
if [[ $(id -u) != 0 ]]; then
  command -v sudo >/dev/null || fail 'Install sudo or run this script as root.'
  if ! sudo -n true 2>/dev/null; then sudo -v; fi
  ROOT=(sudo)
fi

app_user=${CODE_SERVER_USER:-${SUDO_USER:-}}
[[ ${CODE_SERVER_USER:-} != root ]] || fail 'CODE_SERVER_USER must not be root.'
if [[ -z "$app_user" || "$app_user" == root ]]; then
  if [[ $(id -u) != 0 ]]; then app_user=$(id -un)
  elif id user >/dev/null 2>&1; then app_user=user
  else app_user=coder
  fi
fi
[[ "$app_user" =~ ^[a-z_][a-z0-9_-]*$ && "$app_user" != root ]] || fail 'CODE_SERVER_USER must be a non-root Linux username.'
if ! id "$app_user" >/dev/null 2>&1; then
  log "Creating development user: $app_user"
  "${ROOT[@]}" useradd --create-home --shell /bin/bash "$app_user"
fi
[[ $(id -u "$app_user") != 0 ]] || fail 'The development account must not have UID 0.'
app_home=$(getent passwd "$app_user" | cut -d: -f6)
[[ "$app_home" =~ ^/[A-Za-z0-9_./-]+$ && "$app_home" != / ]] || fail 'The account home must be an absolute path without spaces or systemd specifiers.'
as_user() {
  if [[ $(id -un) == "$app_user" ]]; then env HOME="$app_home" "$@"
  else "${ROOT[@]}" runuser -u "$app_user" -- env HOME="$app_home" "$@"
  fi
}

publish=${CODE_SERVER_PUBLISH:-auto}
case "$publish" in auto|yes|no) ;; *) fail 'CODE_SERVER_PUBLISH must be auto, yes, or no.' ;; esac
port_helper=$(command -v instabox-port || true)
[[ "$publish" != yes || -n "$port_helper" ]] || fail 'InstaBox publishing was requested, but instabox-port is not installed.'

missing=()
for pair in 'curl:curl' 'ss:iproute2' 'sha256sum:coreutils'; do
  command -v "${pair%%:*}" >/dev/null || missing+=("${pair#*:}")
done
[[ -f /etc/ssl/certs/ca-certificates.crt ]] || missing+=(ca-certificates)
if (( ${#missing[@]} )); then
  log 'Installing prerequisites'
  "${ROOT[@]}" apt-get update
  "${ROOT[@]}" env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "${missing[@]}"
fi

temp_dir=$(mktemp -d /tmp/code-server-setup.XXXXXXXX)
chmod 755 "$temp_dir"
cleanup() {
  if [[ -n ${temp_dir:-} && "$temp_dir" == /tmp/code-server-setup.* && ! -L "$temp_dir" ]]; then
    rm -rf -- "$temp_dir"
  fi
}
trap cleanup EXIT
trap 'printf "ERROR: setup failed at line %s. Existing project files are not removed.\n" "$LINENO" >&2' ERR

installed_version=$(dpkg-query -W -f='${Status} ${Version}' code-server 2>/dev/null | awk '$1 == "install" && $3 == "installed" { print $4 }' || true)
version=${CODE_SERVER_VERSION:-${installed_version:-4.143.1}}
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail 'CODE_SERVER_VERSION must have the form X.Y.Z.'
package_changed=0
if [[ "$installed_version" != "$version" ]]; then
  architecture=$(dpkg --print-architecture)
  digest=${CODE_SERVER_SHA256:-}
  if [[ -z "$digest" && "$version" == 4.143.1 ]]; then
    case "$architecture" in
      amd64) digest=e4b771c98fafbe2af3990ecd71d93ba22515588db550007076768a014ae34c02 ;;
      arm64) digest=79ca8df2db219b24de75e2a830c5302808124d8c2bf132f4bc6105cea834bb1c ;;
    esac
  fi
  case "$architecture" in amd64|arm64) ;; *) fail 'Only amd64 and arm64 packages are supported.' ;; esac
  [[ "$digest" =~ ^[a-fA-F0-9]{64}$ ]] || fail 'Supply the official CODE_SERVER_SHA256 when selecting another version.'
  package="$temp_dir/code-server.deb"
  log "Downloading code-server $version ($architecture)"
  curl -fL --retry 3 --connect-timeout 20 --max-time 600 \
    "https://github.com/coder/code-server/releases/download/v${version}/code-server_${version}_${architecture}.deb" -o "$package"
  printf '%s  %s\n' "$digest" "$package" | sha256sum -c -
  chmod 644 "$package"
  "${ROOT[@]}" env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "$package"
  package_changed=1
else
  log "code-server $version is already installed; no package download needed"
fi

node=/usr/lib/code-server/lib/node
[[ -x "$node" ]] || fail 'Expected the official Debian package and its bundled Node.js.'
"$node" -e 'if(typeof require("/usr/lib/code-server/node_modules/js-yaml").load !== "function")process.exit(1)' || fail 'The bundled YAML library is unavailable.'

cat > "$temp_dir/configure.cjs" <<'JS'
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const yaml = require('/usr/lib/code-server/node_modules/js-yaml');
const [home, user, requestedPort, requestedBind, requestedWorkspace, hasPublisher] = process.argv.slice(2);
const configDir = path.join(home, '.config/code-server');
const configFile = path.join(configDir, 'config.yaml');
const accessFile = path.join(configDir, 'access.json');
const read = p => fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
const object = (value, label) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(label + ' must contain an object');
  return value;
};
// Strip JSONC comments and trailing commas without interpreting any code.
function parseSettings(text) {
  let clean = '', quoted = false, escaped = false;
  text = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i], next = text[i + 1];
    if (quoted) {
      clean += c;
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') quoted = false;
    } else if (c === '"') { quoted = true; clean += c; }
    else if (c === '/' && next === '/') {
      while (i + 1 < text.length && text[i + 1] !== '\n') i++;
      clean += ' ';
    } else if (c === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2);
      if (end < 0) throw new Error('Unterminated settings comment');
      clean += ' '; i = end + 1;
    } else clean += c;
  }
  let normalized = ''; quoted = false; escaped = false;
  for (let i = 0; i < clean.length; i++) {
    const c = clean[i];
    if (quoted) {
      normalized += c;
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') quoted = false;
    } else if (c === '"') { quoted = true; normalized += c; }
    else if (c !== ',' || !/^\s*[}\]]/.test(clean.slice(i + 1))) normalized += c;
  }
  return object(JSON.parse(normalized), 'settings.json');
}
function safePath(value, label) {
  if (typeof value !== 'string' || !/^\/[A-Za-z0-9_./-]+$/.test(value) || path.resolve(value) === '/') {
    throw new Error(label + ' must be an absolute path without spaces or systemd specifiers');
  }
  return path.resolve(value);
}
let changed = false;
function save(file, content, backup = false) {
  const old = read(file);
  if (old === content) { fs.chmodSync(file, 0o600); return; }
  if (backup && old !== null && !fs.existsSync(file + '.before-code-server-setup')) {
    fs.writeFileSync(file + '.before-code-server-setup', old, { flag: 'wx', mode: 0o600 });
  }
  const temporary = file + '.setup-' + process.pid;
  fs.writeFileSync(temporary, content, { flag: 'wx', mode: 0o600 });
  fs.renameSync(temporary, file);
  changed = true;
}
const config = read(configFile) ? object(yaml.load(read(configFile)), 'config.yaml') : {};
if (config.cert && config.cert !== false) throw new Error('An existing TLS configuration was found; this installer manages an HTTP backend. Preserve your TLS setup and configure it manually.');
const existingBind = /^(.*):(\d+)$/.exec(String(config['bind-addr'] || ''));
const port = Number(requestedPort || existingBind?.[2] || 8080);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('The port must be between 1024 and 65535');
const bind = requestedBind || existingBind?.[1] || (hasPublisher ? '0.0.0.0' : '127.0.0.1');
if (!['127.0.0.1', '0.0.0.0'].includes(bind)) throw new Error('Supported bind addresses: 127.0.0.1 and 0.0.0.0');
const previousAccess = read(accessFile) ? JSON.parse(read(accessFile)) : {};
const workspace = safePath(requestedWorkspace || previousAccess.workspace || path.join(home, 'projects'), 'Workspace');
const dataDir = safePath(config['user-data-dir'] || path.join(home, '.local/share/code-server'), 'User data directory');
const settingsFile = path.join(dataDir, 'User/settings.json');
const settings = read(settingsFile) ? parseSettings(read(settingsFile)) : {};
const listeners = cp.execFileSync('ss', ['-H', '-lntp', `( sport = :${port} )`], { encoding: 'utf8' }).trim();
if (listeners) {
  for (const listener of listeners.split('\n')) {
    const pids = [...listener.matchAll(/pid=(\d+)/g)].map(match => match[1]);
    if (!pids.length || pids.some(pid => !fs.readFileSync(`/proc/${pid}/cgroup`, 'utf8').includes(`/code-server@${user}.service`))) {
      throw new Error(`Port ${port} is occupied by another service; choose CODE_SERVER_PORT`);
    }
  }
}
config['bind-addr'] = `${bind}:${port}`;
config.auth = 'password';
if (!config['hashed-password'] && !config.password) config.password = crypto.randomBytes(32).toString('base64url');
if (!config['hashed-password'] && typeof config.password !== 'string') throw new Error('Existing password must be a string');
config.cert = false;
config['disable-telemetry'] = true;
config['user-data-dir'] = dataDir;
settings['remote.autoForwardPorts'] = true;
settings['remote.autoForwardPortsSource'] = 'hybrid';
settings['remote.restoreForwardedPorts'] = true;
settings['remote.otherPortsAttributes'] = { ...object(settings['remote.otherPortsAttributes'] || {}, 'remote.otherPortsAttributes'), onAutoForward: 'notify' };
settings['remote.portsAttributes'] = object(settings['remote.portsAttributes'] || {}, 'remote.portsAttributes');
settings['remote.portsAttributes'][String(port)] = { ...settings['remote.portsAttributes'][String(port)], label: 'code-server', onAutoForward: 'ignore' };
for (const directory of [configDir, path.dirname(settingsFile), workspace]) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
fs.chmodSync(configDir, 0o700);
save(configFile, yaml.dump(config, { lineWidth: -1, noRefs: true }), true);
save(settingsFile, JSON.stringify(settings, null, 2) + '\n', true);
save(accessFile, JSON.stringify({
  url: previousAccess.port === port ? previousAccess.url || null : null,
  password: config['hashed-password'] ? null : config.password,
  authentication: config['hashed-password'] ? 'Existing hashed password; keep using your current password.' : 'password',
  port, workspace, config: configFile, service: `code-server@${user}.service`,
}, null, 2) + '\n');
console.log(JSON.stringify({ port, bind, workspace, dataDir, configFile, accessFile, changed }));
JS
chmod 644 "$temp_dir/configure.cjs"
log 'Configuring persistent files, password authentication, and automatic port forwarding'
as_user "$node" "$temp_dir/configure.cjs" "$app_home" "$app_user" \
  "${CODE_SERVER_PORT:-}" "${CODE_SERVER_BIND:-}" "${CODE_SERVER_WORKSPACE:-}" "$port_helper" > "$temp_dir/metadata.json"
metadata() { "$node" -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))[process.argv[2]])' "$temp_dir/metadata.json" "$1"; }
port=$(metadata port)
workspace=$(metadata workspace)
config_file=$(metadata configFile)
access_file=$(metadata accessFile)
config_changed=$(metadata changed)

unit="code-server@${app_user}.service"
dropin_dir="/etc/systemd/system/${unit}.d"
dropin="$dropin_dir/zz-code-server-setup.conf"
cat > "$temp_dir/service.conf" <<UNIT
[Unit]
After=network-online.target
Wants=network-online.target
RequiresMountsFor=$app_home $workspace

[Service]
WorkingDirectory=$workspace
Environment="HOME=$app_home"
Environment="VSCODE_PROXY_URI=./proxy/{{port}}/"
ExecStart=
ExecStart=/usr/bin/code-server --config $config_file $workspace
Restart=always
RestartSec=5
UNIT
unit_changed=0
if ! "${ROOT[@]}" cmp -s "$temp_dir/service.conf" "$dropin"; then
  "${ROOT[@]}" install -d -m 0755 "$dropin_dir"
  "${ROOT[@]}" install -m 0644 "$temp_dir/service.conf" "$dropin"
  unit_changed=1
fi
if (( unit_changed || package_changed )); then "${ROOT[@]}" systemctl daemon-reload; fi
"${ROOT[@]}" systemctl enable "$unit"
if ! systemctl is-active --quiet "$unit"; then "${ROOT[@]}" systemctl start "$unit"
elif [[ "$config_changed" == true || "$unit_changed" == 1 || "$package_changed" == 1 ]]; then "${ROOT[@]}" systemctl restart "$unit"
fi
for attempt in $(seq 1 30); do
  if curl -fsS --max-time 2 "http://127.0.0.1:$port/healthz" >/dev/null 2>&1; then break; fi
  sleep 1
done
curl -fsS --max-time 5 "http://127.0.0.1:$port/healthz" >/dev/null || fail "Service health check failed; inspect journalctl -u $unit."
status=$(curl -sS --max-time 5 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/")
[[ "$status" == 302 ]] || fail 'The unauthenticated entry did not redirect to the login page.'

url="http://127.0.0.1:$port/"
if [[ "$publish" != no && -n "$port_helper" ]]; then
  log 'Publishing the single code-server entry on InstaBox'
  as_user "$port_helper" publish "$port" --name code-server --json > "$temp_dir/published.json"
  url=$("$node" -e 'const p=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); const u=p.url||p.port?.url; if(!u||!u.startsWith("https://"))process.exit(1); console.log(u.replace(/\/$/,"")+"/")' "$temp_dir/published.json")
fi
as_user "$node" -e 'const fs=require("fs"),p=process.argv[1],a=JSON.parse(fs.readFileSync(p,"utf8"));a.url=process.argv[2];fs.writeFileSync(p,JSON.stringify(a,null,2)+"\n",{mode:0o600});' "$access_file" "$url"

log 'code-server is ready'
printf 'URL:       %s\nUser:      %s\nWorkspace: %s\nService:   %s\nLogin:     %s\n' "$url" "$app_user" "$workspace" "$unit" "$access_file"
printf 'Application ports appear automatically in the Ports panel and share this entry.\n'
printf 'Installed package and persistent user data sizes:\n'
du -sh /usr/lib/code-server
as_user du -sh "$(metadata dataDir)"
