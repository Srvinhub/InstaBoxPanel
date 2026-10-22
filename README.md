# InstaBox Panel

基于 Cloudflare Workers 的私人多账号管理面板，带真实交互式 Web 终端。

## 功能

- 多账号添加、别名、启停同步、同账号 Key 替换与移除；身份去重。
- 完整分页读取机器，合并多个账号可见的同一机器。
- 每 10 秒刷新；后台标签页暂停轮询，失败时逐步退避到最长 60 秒。
- 暂停、恢复、启动、停止确认；持久化幂等请求、任务进度和操作记录。
- xterm.js 终端：ANSI 颜色、Unicode、控制键、窗口缩放、复制粘贴、字号、页面内最大化、手动重连。
- 非模态浮动终端：拖动标题栏移动、右下角缩放、页面内最大化，同时打开多台机器的终端并操作后台页面。
- 每分钟定时保活：默认关闭，可选全天或每天最多 5 个时间窗口，支持跨午夜与时区；暂停时自动恢复。
- Telegram 私人机器人：查询账号、机器和状态，恢复/暂停机器；离线通知默认关闭，按离线事件去重。
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

保活和 Telegram 属于可选自动化功能。启用它们时，需要额外在 CF 后台配置一个 `AUTOMATION_SECRET`，具体步骤见后面的“保活与免费额度”和“Telegram 机器人”。不启用时仍只需绑定 `DB`。

### 1. 部署 Worker

通过 Cloudflare 后台部署：

1. 将本项目的完整源码提交并推送到自己的 Git 仓库，例如 GitHub。仓库应包含 `package.json`、`package-lock.json`、`wrangler.jsonc`、`index.html`、TypeScript/Vite 配置，以及 `src/`、`migrations/`、`tools/`、`tests/` 等源码目录；不能只上传 README。`node_modules/`、`dist/` 和本地数据库无需上传。
2. 在 Cloudflare 控制台进入 **Workers & Pages**，创建 Worker 并连接该仓库，使用 **Workers Builds** 部署。
3. 选择包含 `package.json` 和 `wrangler.jsonc` 的项目根目录，填写以下构建配置：

   | 配置 | 值 |
   | --- | --- |
   | Worker 名称 | `instabox-panel`，与 `wrangler.jsonc` 中的 `name` 一致 |
   | 根目录 | `package.json` 所在目录；源码在仓库顶层时使用默认仓库根目录 |
   | 构建命令 | `npm run build` |
   | 部署命令 | `npx wrangler deploy` |

4. 完成首次部署。默认开启 `workers.dev`，可以使用 Cloudflare 分配的 HTTPS 地址访问，也可以之后绑定自己的域名。

也可以在本地项目目录执行以下命令完成部署，再按下一节到 CF 后台绑定数据库：

~~~sh
npm ci
npx wrangler login
npm run deploy
~~~

如果构建提示 `ENOENT: Could not read package.json`，请检查该次构建使用的仓库、分支和提交是否包含源码：

- GitHub 上只有 README：将本地源码提交并推送，再构建包含源码的最新提交；只在本地保存文件并不会上传到 GitHub。
- `package.json` 位于仓库子目录，例如 `InstaBoxPanel/package.json`：将 CF 构建根目录设置为 `InstaBoxPanel`，构建命令和部署命令保持不变。
- `package.json` 已在仓库顶层：使用默认仓库根目录，并确认 CF 构建的是包含该文件的分支和提交。

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
| insb_keepalive | 机器保活模式、时间窗口及最近检查结果 |
| insb_scheduler | 定时任务运行记录与并发锁 |
| insb_automation | 由 Worker Secret 保护的自动化数据密钥 |
| insb_telegram | 加密的机器人 Token、授权私人聊天及通知设置 |
| insb_telegram_updates | Telegram 更新去重与重试记录 |
| insb_machine_watch | 离线通知状态及待重试消息 |

所有显式索引也带 insb_ 前缀。初始化脚本只操作这些表与索引，不使用其他应用的 accounts、actions 或 d1_migrations。共用 D1 时，表名前缀提供命名隔离；共享同一数据库的应用仍有整个数据库的读写权限。

无需手动执行迁移。可选的 npm run db:local / npm run db:remote 用于维护，使用独立 wrangler.d1.jsonc；执行前将其 database_name 和 database_id 改为目标库，迁移记录仍写入 insb_d1_migrations。

## 管理员登录与凭据

密码使用随机盐和原生 PBKDF2-HMAC-SHA-256（100,000 次，512 位派生结果）；其中一半用于密码验证，另一半用于保护随机生成的数据加密密钥。Workers 原生 PBKDF2 的迭代上限为 100,000。API Key 使用 AES-256-GCM 和账号 ID 绑定保存。

登录会话使用 256 位随机 Cookie，有效期 12 小时，设置 Secure、HttpOnly、SameSite=Strict。D1 只保存会话哈希，数据密钥由会话 Cookie 再次加密；客户端 JavaScript 不读取密钥或 Cookie。写请求验证 Origin 和 X-Panel-Request，终端建连也验证登录与 Origin。登录限流按 IP 和全局 15 分钟窗口记录到 D1。

登录页面与静态资源可公开加载，机器管理接口和 WebSocket 终端必须登录。退出删除当前服务端会话并关闭当前页面的终端。当前版本没有邮件找回密码；丢失密码也会丢失解密凭据的能力，请备份 D1 并妥善保存密码，不要通过删除管理员记录重置旧账号。

从旧版 Access 登录升级时，如果库中已有加密账号，请在首次设置前临时保留原 KEY_ENCRYPTION_SECRET。程序会先验证它能解密旧凭据，再用新管理员密码保护该密钥；设置成功后可以移除这个环境变量。新安装不需要它。

## 保活与免费额度

针对 1–5 台机器，默认采用 **每 1 分钟检查一次**。Cloudflare Cron 支持分钟级触发，并非最低只能 5 分钟。程序只创建一个 Cron，统一处理保活和已开启的离线通知。

| 检查间隔 | Cron 调用/天 | 占 Workers 免费请求额度 | 5 台稳定运行机器的保活基础 D1 写入/天 |
| --- | --- | --- | --- |
| 1 分钟（默认） | 1,440 | 1.44% | 约 10,080 |
| 2 分钟 | 720 | 0.72% | 约 5,040 |
| 5 分钟 | 288 | 0.288% | 约 2,016 |

截至 2026-10-22，Workers 免费额度是每天 100,000 次请求；D1 是每天 5,000,000 行读取、100,000 行写入。基础写入按每轮 2 次调度锁写入、每台 1 次检查结果写入估算；表中的 2/5 分钟仅用于比较。程序默认的 1 分钟方案，基础写入约占 D1 免费写入额度的 10.08%，为目标的 20%–25% 留出余量。

这不是整个 Cloudflare 账号用量的保证：恢复任务、索引更新、Telegram 消息、页面轮询、其他应用及异常重试都会增加用量。Workers 向 InstaBox 发出的子请求不按额外 Worker 入站请求计费，但仍有每次执行的子请求限制。Free 计划还限制每次 Cron 的 CPU 时间为 10 ms；等待网络不等于 CPU 时间。请上线后观察 Workers 和 D1 的实际统计，而不是仅按 Cron 次数估计。单轮后台请求最多 35 次，其中通知最多使用 25 次、前 60 秒，预留至少 10 次请求给最多 5 台机器保活。账号较多时轮换通知检测顺序，预算耗尽的检测在后续分钟继续。

### 配置后台自动化

1. 在本地运行 `npm run secret:generate`，生成一个 32 字节随机数的 Base64 编码。
2. 到 **Cloudflare → 该 Worker → Settings → Variables and Secrets**，添加名为 **`AUTOMATION_SECRET`** 的 **Secret（密钥）**，值填入刚生成的内容，并保存应用更改。
3. 部署新版本后，在 **Settings → Trigger Events / Cron Triggers** 确认存在 `* * * * *`。部署配置已包含此触发器，无需再添加第二个。Cron 配置传播可能需要几分钟。
4. 在机器行的终端按钮旁点击心跳图标，选择保活模式并保存。已有数据库会自动补建新表，无需手动执行迁移。

Cron 没有浏览器登录 Cookie，也不知道管理员密码，因此自动化需要独立 Secret。开启保活或绑定机器人时，程序会用这个 Secret 加密保存自动化所需的数据密钥；API Key 仍加密保存，机器人 Token 也加密保存，不将它们明文写入 D1。

不要随意更换或删除 `AUTOMATION_SECRET`。轮换后需要登录面板重新保存保活设置；机器人需要解除并重新绑定。普通登录和手动机器管理不依赖这个 Secret。

### 保活规则

- **不保活**：默认值，不自动恢复机器。
- **全天保活**：每轮查询状态，仅当机器为 `suspended` 且无未完成操作时调用 `resume`。
- **指定时间范围**：每天重复，最多 5 段，默认时区 `Asia/Shanghai`；支持 `22:00–06:00` 这样的跨午夜范围。开始时间包含在内，结束时间不包含；不允许重叠，窗口外不主动暂停机器。
- `running` 不重复发恢复请求；`stopped` 需手动启动；正在启动、暂停或恢复等过渡状态等待完成。对运行中机器盲目调用 `resume` 不能当作可靠保活协议。
- 这项功能是在自动暂停后恢复，并不阻止机器先进入暂停。通常在下一次分钟检查后发起恢复，另需唤醒耗时；Cron 调度、网络和上游服务均可能产生延迟，不保证连续零中断在线。
- 开启保活时，手动暂停也可能被下次检查恢复。需要长时间暂停，请先关闭保活。停用或移除账号后，不再对其机器执行保活。
- 自动恢复也写入操作记录。重复 Cron 不并行提交同一任务；响应丢失时复用原幂等键。明确失败后的再次恢复至少间隔 5 分钟，避免反复失败耗尽额度。
- CF 的免费额度与 InstaBox 的机器运行费用是两回事；保活会增加实际运行时间，受 InstaBox 的额度与权限约束。

依据：[Workers 计费](https://developers.cloudflare.com/workers/platform/pricing/) · [D1 计费](https://developers.cloudflare.com/d1/platform/pricing/) · [Workers 限制](https://developers.cloudflare.com/workers/platform/limits/)。

## Telegram 机器人

### 绑定

1. 按上一节配置 `AUTOMATION_SECRET`，并确认 Worker 已通过 HTTPS 部署。
2. 在 Telegram 的官方 **@BotFather** 创建专用机器人，取得 Bot Token。先向自己的机器人发送 `/start`，允许它向你发送私信。
3. 获取你自己的 Telegram **数字用户 ID**，不要填写 `@用户名` 或群组 ID。私人聊天 ID 与该用户 ID 相同。
4. 登录面板，点击右上角 **Telegram**，填写 Token 和私人聊天 ID。离线通知默认不勾选。
5. 点击“绑定机器人”。面板会验证机器人与私人聊天，自动注册 `/api/telegram/webhook`；保存后不再显示 Token。

只接受绑定用户在私人聊天中发送的命令，其他用户和群组消息会被忽略。Webhook 同时验证 Telegram 的随机 Secret 请求头，不能通过直接调用该 URL 控制机器。请勿将机器人 Token 放到公开仓库。

如果另外启用了 Cloudflare Access，需仅对 `/api/telegram/webhook` 配置允许 Telegram 回调的入口规则，否则 Telegram 无法通过 Access 登录。该路径仍由应用内的 Webhook Secret 与聊天身份校验保护。

### 命令

| 命令 | 功能 |
| --- | --- |
| `/help` 或 `/start` | 查看帮助 |
| `/accounts [页码]` | 查询所有绑定账号，包含停用状态；按页显示 |
| `/machines 账号ID [页码]` | 查询指定账号的机器与状态 |
| `/status 账号ID 机器ID` | 查询机器状态与服务就绪情况 |
| `/resume 账号ID 机器ID` | 恢复已暂停机器 |
| `/suspend 账号ID 机器ID` | 暂停运行中机器 |
| `/notifications on` | 开启离线通知 |
| `/notifications off` | 关闭离线通知 |

账号可使用不含空格的唯一别名，也可复制 `/accounts` 返回的完整账号 ID；机器使用完整 ID，避免名称重复时操作错机器。查询返回可复制的后续命令。恢复/暂停显示“已受理”时，任务仍在执行，请再用 `/status` 查询；结果也保存在面板操作记录。重复 Webhook 不会重新执行同一个已处理命令。

### 离线通知

通知与保活共用每分钟的 Cron，不需要另加定时器。开启后检查所有已启用账号的机器，首次检查建立基线；后续从运行变为暂停、停止、异常或从完整列表消失时通知。网络错误或 API 查询失败不会被直接判定为机器离线。

同一段持续离线只提醒一次，恢复运行后再次离线才会再次提醒。发送失败保留待发消息并重试，即使机器随后被保活恢复，也会补发离线事件并注明当前已恢复。共享机器不会因为单个账号看不到它就被判定删除；仅在所有已启用账号的完整列表均检查成功、且均未发现它时通知。周期性检测无法捕获两次检查之间发生并恢复的短暂离线。若 Telegram 已收到但回复在网络中丢失，极端情况下仍可能重复送达。关闭通知不影响查询和机器控制；解除绑定会停止 Telegram 控制和通知，保活设置保留。

尚未提供真实机器人 Token 时，本地测试使用模拟 Telegram API，不能替代部署后实际收发验证。

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
- 终端是非模态浮动窗口，不遮罩或禁用后面的页面。拖动标题栏移动，拖动右下角调整大小；点击窗口置顶。可以同时打开最多 8 台不同机器的终端，重复打开同一机器会聚焦已有窗口。
- 标题栏包含复制、粘贴、字号、最大化/还原和关闭按钮；连接状态放在左下方，已连接为亮绿色，断开为橙红色，并提供重连按钮。
- 最大化铺满当前网页，双击标题栏也可切换。原先的全屏错误来自对原生 `dialog` 请求浏览器全屏；现在使用页面内最大化，不需要浏览器全屏权限。使用浏览器自身的 F11 可进一步隐藏浏览器界面。
- Ctrl+Shift+C / Ctrl+Shift+V 用于复制粘贴，也有标题栏按钮。Ctrl+W、Ctrl+L 等可能被浏览器或系统保留，可点击底部快捷键按钮。
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
- 自动化测试覆盖保活时间窗口、真实 workerd 定时事件、Cron 去重、并发启用上限、状态判定、失败冷却、响应丢失重试、跨面板/机器人/定时任务的并发操作、通知预算隔离、Telegram 身份限制、Webhook 保存失败、命令幂等、共享机器离线事件去重及恢复后通知补发。
- 浏览器测试覆盖首次设置、密码登录、保活模式与 5 个时间范围、Telegram 设置、暂停恢复、账号管理、多终端拖动缩放与最大化、后台页面操作及移动端退出。截图及报告保存在 test-results/。
- 浏览器测试优先使用 Windows 上已安装的 Edge/Chrome。其他环境可设置 PLAYWRIGHT_EXECUTABLE_PATH，或先执行 npx playwright install chromium。

没有真实账号 Key 或机器人 Token 时，本地测试只能验证实现和协议转发，不代表已通过真实 Cloudflare 和 Telegram 的端到端验证。部署后建议按以下顺序验收：

1. 使用一台可中断的测试机器验证手动暂停、恢复与终端，确认实际组织权限和终端可用性。
2. 在 CF 后台确认 `DB`、`AUTOMATION_SECRET` 和唯一的 `* * * * *` Cron。开启测试机全天保活，暂停机器并关闭网页；等后续 Cron 后重新登录，核对机器、保活最近检查及操作记录。Cron 配置更新可能需要等待传播。
3. 验证时间窗口内恢复、窗口外不恢复，结束后关闭测试保活。
4. 绑定私人机器人，验证 `/accounts`、`/machines`、`/status`、`/resume` 和 `/suspend`；其他用户发命令应无响应。开启通知后先等待一轮建立基线，再暂停测试机，确认收到一次通知而非每分钟重复发送；关闭通知和解除绑定后应停止通知。
5. 观察 Workers 的 Cron 执行结果及 CPU 时间、D1 每天读写量。免费 Cron 每次仅有 10 ms CPU，必须用真实统计确认；不要仅凭本地测试和每日调用次数判断额度安全。

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
