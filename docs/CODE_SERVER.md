# 一键部署 code-server

[安装脚本](../tools/install-code-server.sh) 可以单独使用，无需部署 InstaBox Panel 或安装本项目的 npm 依赖。

它面向 **Debian / Ubuntu + systemd**，提供 amd64 和 arm64 官方软件包的校验值。首次安装默认使用已验证的 **code-server 4.143.1 / Code 1.143.1**；已安装时默认保留当前版本。

## 使用

将 `tools/install-code-server.sh` 复制到目标 Linux 主机，执行：

```bash
bash install-code-server.sh
```

如果已经在服务器上克隆本仓库，则执行：

```bash
bash tools/install-code-server.sh
```

使用普通账户执行时需要 sudo 权限；也可由 root 执行。程序始终使用普通 Linux 账户运行：默认选择执行脚本的用户或 `SUDO_USER`；直接以 root 执行时优先使用已有的 `user` 账户，否则创建 `coder`。

完成后会打印访问地址、运行账户、项目目录、systemd 服务名和登录信息文件路径。密码保存在打印出的 `Login` 文件中，文件权限为 `600`，不会输出到安装日志。

## 配置结果

- 原生安装官方 `.deb`，下载后验证 SHA-256；退出时清理安装临时目录。
- systemd 开机自启、异常退出后重启，并等待项目所在磁盘挂载。
- 密码认证；已有密码或哈希密码会保留，新配置生成随机密码。
- 配置默认位于用户的 `~/.config/code-server/`，编辑器数据位于 `~/.local/share/code-server/`，项目位于 `~/projects/`。InstaBox 默认用户的家目录是 `/data/home`，因此这些内容位于持久化磁盘。
- 自动发现应用端口，显示通知及预览链接，并恢复转发记录。`VSCODE_PROXY_URI` 指向 code-server 内置的 `/proxy/<端口>/`。
- 检测到 `instabox-port` 时，自动发布 code-server 的一个 HTTPS 入口。普通 VPS 默认仅监听 `127.0.0.1`，可以通过 SSH 转发访问，或接入自己的 HTTPS 反向代理。

首次打开项目时，如出现工作区信任提示，请在确认代码来源后信任该项目，以启用完整开发功能。

## 自动端口转发

在 code-server 的终端启动应用，例如：

```bash
python3 -m http.server 8000 --bind 127.0.0.1
```

启动后，底部 **Ports / 端口** 面板会自动显示端口，点击链接预览。也可以访问：

```text
https://你的-code-server-入口/proxy/8000/
```

预览与编辑器共用公网入口和登录保护，无需为每个应用分别发布 InstaBox 端口。自动发现不会代替你启动应用进程。

部分前端框架需要配置资源路径、路由前缀和热更新 WebSocket。对于需要保留完整请求路径的应用，可使用 `/absproxy/<端口>/`，并在项目中配置对应的 base 路径和预览地址。详情见 [code-server 官方代理说明](https://coder.com/docs/code-server/guide#accessing-web-services)。

## 可选参数

通过环境变量传入，例如：

```bash
CODE_SERVER_PORT=9090 CODE_SERVER_WORKSPACE=/data/home/projects bash install-code-server.sh
```

| 变量 | 默认行为 |
| --- | --- |
| `CODE_SERVER_USER` | 自动选择普通账户；指定的账户不存在时创建它 |
| `CODE_SERVER_PORT` | 保留已有端口，否则使用 `8080`；范围为 `1024–65535` |
| `CODE_SERVER_BIND` | 保留已有监听地址；新配置在 InstaBox 使用 `0.0.0.0`，其他机器使用 `127.0.0.1`；支持这两个地址 |
| `CODE_SERVER_WORKSPACE` | 保留脚本上次记录的项目目录，否则使用 `~/projects` |
| `CODE_SERVER_PUBLISH` | `auto`：有 `instabox-port` 就发布；`yes`：要求该工具存在；`no`：跳过平台发布 |
| `CODE_SERVER_VERSION` | 保留已安装版本；新安装默认 `4.143.1`；显式指定时安装该版本 |
| `CODE_SERVER_SHA256` | 选择其他版本时，填写该版本、对应架构的官方 `.deb` SHA-256 |

例如，在普通 VPS 上创建独立账户并仅通过 SSH 访问：

```bash
CODE_SERVER_USER=coder CODE_SERVER_BIND=127.0.0.1 CODE_SERVER_PUBLISH=no bash install-code-server.sh
```

升级时明确指定版本及其官方校验值；脚本不自动追踪最新版，也不依赖目标主机能够访问 GitHub API。

账户家目录、项目目录和已有的编辑器数据目录需要是绝对路径，且不包含空格或 systemd 特殊字符。

## 重复执行与已有配置

重复执行会保留密码、扩展、项目文件和其他编辑器设置，并确保自动转发设置启用。设置支持 JSONC 注释和尾随逗号；写回时会规范化为 JSON。首次改写已有配置时，为 YAML 和编辑器设置各保留一份 `.before-code-server-setup` 备份，后续不累积备份。

配置与软件包没有变化时，脚本不会重启运行中的服务。端口被其他服务占用、设置文件格式错误或存在需要保留的 TLS 配置时，会报错退出，避免覆盖这些配置。

脚本管理的 systemd 覆盖文件是：

```text
/etc/systemd/system/code-server@用户名.service.d/zz-code-server-setup.conf
```

如已有其他自定义 systemd 覆盖，请通过 `systemctl cat code-server@用户名.service` 检查最终生效配置。

默认 InstaBox 账户的维护命令：

```bash
systemctl status code-server@user.service
sudo systemctl restart code-server@user.service
sudo journalctl -u code-server@user.service -n 50 --no-pager
cat /data/home/.config/code-server/access.json
```

其他账户请使用安装完成时打印的服务名和登录文件路径。

## 存储占用

本次在 Debian 13 amd64 上实测：

| 内容 | 占用及位置 |
| --- | --- |
| code-server 程序 | 约 676 MiB，`/usr/lib/code-server`，位于系统盘 |
| 初始配置、编辑器数据和日志 | 约 3 MiB，位于 `/data/home` |
| 后续已安装的 OpenAI 扩展 | 约 621 MiB；包含它之后，code-server 用户目录约 624 MiB |
| 下载的安装包和测试临时文件 | 安装及验证后已清理 |

这台 InstaBox 的系统盘为 16 GiB，另有 20 GiB 的 `/data` 持久化盘。最终检查时，系统盘剩余约 9.9 GiB，`/data` 总计使用约 854 MiB、剩余约 19 GiB。扩展安装包缓存几乎为空，目前没有必要删减内置语言支持、已安装扩展或运行库。

安装脚本使用 Debian 包管理器维护程序，下载文件随安装临时目录清理。后续空间增长主要来自项目依赖、扩展、构建产物和容器镜像，可按实际项目需要管理。

## 验证范围

已在 Debian 13 amd64 上通过临时账户与真实 systemd 服务验证：首次配置和密码登录、重复执行、密码保留、JSONC 设置合并、无变化时保持服务 PID、端口冲突保护以及错误设置文件保护。也已在现有 InstaBox 上以普通用户执行两次，验证免密 sudo、原密码和公网地址保留、重复运行不重启服务。另已在实际部署中验证编辑器终端、自动端口发现、HTTP/WebSocket 代理和登录保护。

ARM64 使用官方发布的 SHA-256，尚未在 ARM64 主机上实测。脚本不支持没有运行 systemd 的普通容器。
