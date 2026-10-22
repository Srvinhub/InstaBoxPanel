# InstaBox Panel

基于 Cloudflare Workers 的私人多账号管理面板，带真实交互式 Web 终端。

## 功能

- 多账号添加、别名、启停同步、同账号 Key 替换与移除；身份去重。
- 完整分页读取机器，合并多个账号可见的同一机器。
- 每 10 秒刷新；后台标签页暂停轮询，失败时逐步退避到最长 60 秒。
- 暂停、恢复、启动、停止确认；持久化幂等请求、任务进度和操作记录。
- xterm.js 终端：ANSI 颜色、Unicode、控制键、窗口缩放、复制粘贴、字号、全屏、手动重连。
- 绑定 D1 后自动建表；首次设置管理员账号密码，之后通过内置登录保护管理接口与终端。
- 密码加盐哈希；API Key 使用 AES-256-GCM 加密保存，登录 Cookie 为 HttpOnly。
- 桌面和手机界面，本地演示，后端及浏览器测试。

## 本地查看

需要 Node.js 22.12+。

~~~sh
npm ci
npm run dev
~~~

打开 http://127.0.0.1:5173 。

这是显式的**演示模式**，不连接真实账号和机器。首次访问会展示管理员设置页，请使用至少 12 个字符的示例密码。演示登录信息与机器数据只在当前页面内存中保存，刷新页面重置；生产环境保存到 D1。演示账号表单可使用 **ibk_demo_example**；**ibk_demo_error** 用于查看账号失效状态。演示终端只模拟 help、ls、pwd、clear 和部分控制键，不执行本机或远端命令。

生产构建不包含演示接口。真实连接需要部署到 Cloudflare 的 HTTPS 地址，可直接使用 workers.dev。项目没有预置真实 API Key、管理员密码、Cloudflare 凭据或公网部署地址。

Windows PowerShell 如果阻止执行 npm.ps1，请改用 npm.cmd / npx.cmd。

## 部署

推荐流程：**部署 Worker → 在 Cloudflare 后台绑定 D1 为 DB → 打开网站设置管理员 → 添加 InstaBox 账号**。

正常部署无需填写源码中的数据库 ID，无需手动执行 SQL，也无需预先配置管理员密码或加密密钥。

### 1. 部署 Worker

通过 Cloudflare 后台部署：

1. 将本项目上传到自己的 Git 仓库，例如 GitHub。
2. 在 Cloudflare 控制台进入 **Workers & Pages**，创建 Worker 并连接该仓库，使用 **Workers Builds** 部署。
3. 选择包含 `package.json` 和 `wrangler.jsonc` 的项目根目录，填写以下构建配置：

   | 配置 | 值 |
   | --- | --- |
   | Worker 名称 | `instabox-panel`，与 `wrangler.jsonc` 中的 `name` 一致 |
   | 构建命令 | `npm run build` |
   | 部署命令 | `npx wrangler deploy` |

4. 完成首次部署。默认开启 `workers.dev`，可以使用 Cloudflare 分配的 HTTPS 地址访问，也可以之后绑定自己的域名。

也可以在本地项目目录执行以下命令完成部署，再按下一节到 CF 后台绑定数据库：

~~~sh
npm ci
npx wrangler login
npm run deploy
~~~

### 2. 在 Cloudflare 后台配置 DB

1. 准备一个 D1 数据库：可以在 Cloudflare 的 **D1** 页面新建，也可以选择已有数据库与其他应用共用。
2. 进入 **Workers & Pages → 刚部署的 Worker → Bindings（绑定）→ Add binding（添加绑定）**。
3. 绑定类型选择 **D1 database**，变量名必须填写 **`DB`**（大写），然后选择目标数据库。数据库自身的名称可以任意命名。
4. 保存绑定，并按控制台提示完成部署或应用更改。
5. 打开 Worker 的 HTTPS 地址。如果此前显示数据库未绑定，点击页面上的“重试连接”。

`DB` 是 **D1 资源绑定**，不是普通文本环境变量。正常部署不需要修改 `wrangler.d1.jsonc`；该文件只供可选的手动迁移命令使用。

主配置使用 Workers 上传元数据 `keep_bindings: ["d1", "secret_text", "secret_key"]` 保留控制台设置的 D1 绑定，并保留 Wrangler 默认保护的密钥绑定，后续部署不会按本地空配置删除它们；该字段通过 Wrangler 的 `unsafe.metadata` 传递。这是 Wrangler 的实验性配置，升级 Wrangler 后应重新运行 `npm run worker:check` 检查输出。

### 3. 首次设置与使用

首次打开自动初始化 `insb_` 表，并进入“设置管理员账号”页面。填写账号与至少 12 个字符的密码，确认后直接进入面板。第一次成功设置后永久关闭设置入口；以后使用同一账号密码登录。没有默认账号密码，也无需配置 Cloudflare Access 或额外的加密环境变量。

首次设置允许第一位成功提交者建立管理员；部署后先完成自己的设置，再分享访问地址。请将密码保存到密码管理器。

在面板添加 InstaBox 账号。每个账号在官方 Profile → API keys 创建专用 Key，授予 **machines:write**，它已包含读取权限。不需要 machines:delete。

添加账号会用 /v1/me 和完整机器列表验证身份与读取权限。写权限不足会在机器控制或终端建连时失败，不通过试暂停来测试权限。官方的机器写权限同时包含命令执行和终端。

如果希望另加 Cloudflare Access，可在 Zero Trust 配置域名保护，它作为内置登录之外的额外入口保护。程序不再要求 Access 的团队域名、AUD 或允许邮箱。

## 自动初始化与共用 D1

登录页面请求 /api/session，提交设置和登录时也会检查表。查询明确报出 no such table: insb_… 时，程序执行随 Worker 打包的初始化 SQL，然后继续处理请求。不是所有数据库错误都代表未初始化：绑定缺失、数据库损坏、SQL 不兼容等会正常返回错误。

建表与索引使用 IF NOT EXISTS，并放在 D1 事务批次中执行；同时访问不会创建多个管理员或覆盖已有数据。部分非管理员表缺失时可以重建，但不会恢复丢失的数据或重置密码。

| 表 | 内容 |
| --- | --- |
| insb_accounts | InstaBox 账号及加密凭据 |
| insb_actions | 机器操作与审计记录 |
| insb_admin | 唯一管理员、密码哈希和加密后的数据密钥 |
| insb_sessions | 登录会话哈希、会话保护的数据密钥、过期时间 |
| insb_login_limits | 登录请求限流 |
| insb_d1_migrations | 本项目的迁移记录 |

所有显式索引也带 insb_ 前缀。初始化脚本只操作这些表与索引，不使用其他应用的 accounts、actions 或 d1_migrations。共用 D1 时，表名前缀提供命名隔离；共享同一数据库的应用仍有整个数据库的读写权限。

无需手动执行迁移。可选的 npm run db:local / npm run db:remote 用于维护，使用独立 wrangler.d1.jsonc；执行前将其 database_name 和 database_id 改为目标库，迁移记录仍写入 insb_d1_migrations。

## 管理员登录与凭据

密码使用随机盐和原生 PBKDF2-HMAC-SHA-256（100,000 次，512 位派生结果）；其中一半用于密码验证，另一半用于保护随机生成的数据加密密钥。Workers 原生 PBKDF2 的迭代上限为 100,000。API Key 使用 AES-256-GCM 和账号 ID 绑定保存。

登录会话使用 256 位随机 Cookie，有效期 12 小时，设置 Secure、HttpOnly、SameSite=Strict。D1 只保存会话哈希，数据密钥由会话 Cookie 再次加密；客户端 JavaScript 不读取密钥或 Cookie。写请求验证 Origin 和 X-Panel-Request，终端建连也验证登录与 Origin。登录限流按 IP 和全局 15 分钟窗口记录到 D1。

登录页面与静态资源可公开加载，机器管理接口和 WebSocket 终端必须登录。退出删除当前服务端会话并关闭当前页面的终端。当前版本没有邮件找回密码；丢失密码也会丢失解密凭据的能力，请备份 D1 并妥善保存密码，不要通过删除管理员记录重置旧账号。

从旧版 Access 登录升级时，如果库中已有加密账号，请在首次设置前临时保留原 KEY_ENCRYPTION_SECRET。程序会先验证它能解密旧凭据，再用新管理员密码保护该密钥；设置成功后可以移除这个环境变量。新安装不需要它。

## Web 终端

不需要额外 VPS、SSH 私钥或长期 SSH token：

~~~text
浏览器 xterm.js
  → 同源 WebSocket /api/accounts/:id/machines/:machineId/terminal
  → Worker 验证管理员登录与 Origin，解密账号 API Key
  → InstaBox /v1/machines/:id/terminal?session=panel&wake=0
  → 真实 PTY 登录 Shell
~~~

它使用官方 WebSocket 终端协议，提供 SSH 终端的交互体验；不是通用 TCP SSH 客户端或 SFTP 工具。

- 二进制帧传输终端字节，文本帧传输 resize/session/exit/taken/error 控制信息。
- 使用独立的 panel 持久会话。一个会话只有一个查看者；被其他页面接管后不会自动抢回。
- 关闭窗口只断开连接，持久 Shell 留在远端。使用重连按钮恢复会话及近期输出；未发送的输入不会被自动重放。
- wake=0 避免连接隐式唤醒机器。暂停或停止时，先按按钮恢复或启动。
- 终端输入和输出属于活动，可能延长机器运行时间；机器列表的 GET 查询不会。
- ANSI 颜色、Vim、top、tmux 等由真实 PTY 支持。输入过程的语法高亮取决于远端 Shell，例如 Fish 或 zsh-syntax-highlighting；面板不会自行修改机器配置。
- Ctrl+C / Ctrl+D / Ctrl+L / Ctrl+R、Tab、方向键和 Esc 传给终端。Esc 不关闭终端窗口。
- Ctrl+Shift+C / Ctrl+Shift+V 用于复制粘贴，也有工具栏按钮。Ctrl+W、Ctrl+L 等可能被浏览器或系统保留，可点击底部快捷键按钮。
- 复制粘贴需要 HTTPS 和浏览器许可。远端 OSC 52 剪贴板命令被禁用。
- 登录会话在 WebSocket 建连时鉴权。退出会关闭当前页面的终端并阻止该会话再次连接；其他页面已经建立的终端不会由服务器立即撤销。结束它们请关闭对应窗口；必要时暂停机器或在 InstaBox 撤销 API Key。
- 官方当前每个用户最多允许 8 个打开的终端。平台更新、网络和机器生命周期操作都可能断开连接。

## 状态与失败处理

运行、暂停和停止是不同状态。暂停通常保留内存和进程；恢复也可能回退到冷启动，操作记录会根据 runtime.processesPreserved=false 提示。runtime.ready 单独表示服务是否就绪。

每个操作先写 D1，再向上游发送 Idempotency-Key。202 只代表受理，完成任务查询后才显示成功。同一请求重试复用原 key；提交后断网显示“结果待确认”，可以在操作记录中“重试原请求”。6 天后停止使用原请求重试，避免超过上游 7 天的幂等保存期后重复执行。

关闭页面后，上游任务继续运行。重新打开可从 D1 找回未完成任务。账号有未确认任务时暂不能移除，避免丢失查询凭据。移除账号清空凭据并保留审计记录，不调用机器删除接口。

账号状态相互独立，一个 Key 失效不影响其他账号。超过 30 秒的数据标记过期，查询出错保留最后一次成功结果。每个账号最多读取 30 页；异常游标或超限会明确报错，不会悄悄返回部分机器。

## 验证

~~~sh
npm run check
npm test
npm run build
npm run worker:check
npm run test:browser
~~~

- 后端测试使用本地真实 D1 和 workerd、模拟上游，不读取真实凭据。
- 覆盖自动建表、并发首次设置、密码登录、过期与退出会话、限流、旧凭据保留、加密、CSRF、分页、账号隔离、密钥替换、操作幂等和断网恢复；共库测试预置其他应用的同名表与索引，确认初始化及操作不会修改其数据。
- WebSocket 测试在两个本地 Workers 间代理真实连接，验证 UTF-8/控制字节、resize、Origin 防护和凭据不外泄。
- 浏览器测试覆盖首次设置、密码确认、登录失败与成功、退出、查询筛选、暂停恢复、账号失效及修复、移除账号、终端键盘和移动端布局。截图及报告保存在 test-results/。
- 浏览器测试优先使用 Windows 上已安装的 Edge/Chrome。其他环境可设置 PLAYWRIGHT_EXECUTABLE_PATH，或先执行 npx playwright install chromium。

没有真实账号 Key 时，本地测试只能验证实现和协议转发。部署后还需使用一台可中断的测试机器验证暂停/恢复及终端，确认实际组织权限、配额和终端可用性。

## 项目结构

~~~text
src/client/       React 页面、xterm.js 终端、本地演示
src/worker/       自动建表、管理员登录、账号、生命周期、WebSocket 代理
src/shared/       前后端共享类型
migrations/       D1 数据库迁移
tests/            后端与真实 Workers 协议测试
tools/            浏览器测试、主密钥生成
wrangler.jsonc    Cloudflare 部署配置
wrangler.d1.jsonc 可选的手动 D1 迁移配置
~~~

官方依据：[API keys and SDK](https://instabox.sh/docs/keys-sdk) · [OpenAPI](https://api.instabox.sh/v1/openapi.json) · [Workers WebSockets](https://developers.cloudflare.com/workers/runtime-apis/websockets/)。
