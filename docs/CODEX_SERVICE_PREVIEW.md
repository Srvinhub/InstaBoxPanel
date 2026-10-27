# 让 Codex 自动给出服务预览地址

在这台 VPS 上，已将服务启动与预览规则追加到全局 `/data/home/.codex/AGENTS.md`，原指引已备份。新建 Codex 会话后会读取这些规则；各项目自己的 `AGENTS.md` 仍可以进一步规定框架和运行方式。

使用全局文件，是因为 Codex 的项目指引从 Git 根目录向当前目录查找；父目录 `/data/home/projects/AGENTS.md` 不一定会被其中各个独立仓库继承。规则的发现与优先级见 [OpenAI 官方文档](https://developers.openai.com/codex/guides/agents-md)。

## 日常使用

在项目目录中新建会话，直接说：

> 启动这个项目供我预览，按本机端口规则选择空闲端口，验证服务，然后给我完整的 code-server 预览链接。

AI 应检查端口、启动服务并给出：

```text
https://你的-code-server-入口/proxy/项目端口/
```

例如项目监听 3003，就使用编辑器入口的 `/proxy/3003/`。预览需要登录 code-server，多项目共用同一个编辑器公网入口。8080 留给 code-server，47831 留给 Codex Relay Manager。

code-server 已开启自动端口发现；AI 仍需要启动应用，才能访问对应端口。应用的资源路径和 HMR 如不支持代理前缀，需要按框架调整并验证；必要时使用 `/absproxy/端口/` 配合应用 base 路径。

## 需要独立公开链接时

明确告诉 AI：

> 将这个服务部署为独立公开入口，配置持续运行，检查现有端口发布，验证后给我访问地址。

AI 可以使用已经安装的 `instabox-port publish <端口> --name <名称> --json`，并以命令返回的 URL 为准。独立公开入口不会自动继承编辑器的登录保护，应用认证按项目需求设置。平台端口额度不足时，不能擅自取消其他服务的发布。

在已有会话中，也可以直接要求“先读取 `/data/home/.codex/AGENTS.md`，按其中的服务预览规则继续”。
