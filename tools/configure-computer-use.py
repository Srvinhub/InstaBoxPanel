#!/usr/bin/env python3
"""Configure the existing InstaBox computer-use MCP for this Linux Codex host."""
import argparse
import datetime
import json
import os
from pathlib import Path
import subprocess
import tempfile
import tomllib


def atomic_write(path: Path, content: str):
    descriptor, temporary = tempfile.mkstemp(prefix=path.name + '.', dir=path.parent)
    try:
        with os.fdopen(descriptor, 'w', encoding='utf-8') as output:
            output.write(content)
        os.chmod(temporary, 0o600)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true', help='Inspect prerequisites without writing configuration')
    parser.add_argument('--codex-binary', type=Path, help='Path to the Codex CLI; defaults to the installed code-server extension')
    args = parser.parse_args()
    command = Path('/usr/local/bin/instabox-computer-use')
    if not command.is_file() or not os.access(command, os.X_OK):
        raise RuntimeError('This host has no executable InstaBox computer-use wrapper')
    config = Path(os.environ.get('CODEX_HOME', str(Path.home() / '.codex'))) / 'config.toml'
    original = config.read_text() if config.exists() else ''
    data = tomllib.loads(original)
    expected = {'command': str(command), 'args': ['mcp'], 'startup_timeout_sec': 45, 'tool_timeout_sec': 120}
    existing = data.get('mcp_servers', {}).get('instabox_computer')
    if existing and (existing.get('command') != str(command) or existing.get('args', []) != ['mcp'] or existing.get('enabled') is False):
        raise RuntimeError('An existing instabox_computer entry differs; review it instead of overwriting it')
    if args.check:
        print(json.dumps({'config': str(config), 'configured': bool(existing), 'server': expected}))
        return
    binary = args.codex_binary
    if not binary:
        candidates = list((Path.home() / '.local/share/code-server/extensions').glob('openai.chatgpt-*/bin/linux-*/codex'))
        if not candidates:
            raise RuntimeError('Pass --codex-binary for a Codex installation outside code-server')
        binary = max(candidates, key=lambda file: file.stat().st_mtime)
    if existing:
        subprocess.run([str(binary), '--strict-config', 'app-server'], input='', text=True, capture_output=True, timeout=20, check=True)
        print(json.dumps({'configured': True, 'changed': False, 'server': 'instabox_computer'}))
        return
    rendered = original.rstrip() + '\n\n[mcp_servers.instabox_computer]\ncommand = "/usr/local/bin/instabox-computer-use"\nargs = ["mcp"]\nstartup_timeout_sec = 45\ntool_timeout_sec = 120\n'
    tomllib.loads(rendered)
    config.parent.mkdir(parents=True, exist_ok=True)
    backup = config.with_name(config.name + '.before-panel-computer-' + datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ'))
    descriptor = os.open(backup, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, 'w', encoding='utf-8') as output:
        output.write(original)
    if (config.read_text() if config.exists() else '') != original:
        raise RuntimeError('Codex configuration changed during setup; retry after reviewing it')
    atomic_write(config, rendered)
    try:
        subprocess.run([str(binary), '--strict-config', 'app-server'], input='', text=True, capture_output=True, timeout=20, check=True)
    except Exception:
        if config.read_text() == rendered:
            atomic_write(config, original)
        raise RuntimeError('Codex rejected the MCP configuration; the prior configuration was restored') from None
    print(json.dumps({'configured': True, 'changed': True, 'server': 'instabox_computer', 'backup': str(backup)}))


if __name__ == '__main__':
    main()
