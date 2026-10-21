# cortico-world-ego

让 Cortico 与 Coopanion（Coo）通过已安装的 [Ego Lite](https://github.com/citrolabs/ego-lite) 浏览网页、读取字幕和视频画面。World id 为 `ego`，契约为 world 6。

需要本机 Ego Lite 与 `ego-browser` 2.1 API。直接连接时由宿主调用 CLI；管理员宿主通过独立的普通权限助手调用。助手需要系统可找到 Node.js 22 以上。无需 web-access、Chrome 调试端口或另一个浏览器实例。Windows/macOS 可用。

在宿主的「扩展 → 手动安装」中填本包目录或本地 `.tgz`，重启宿主，再启用「Ego 浏览器」World。无需停用原 Browser：工具分别使用 `ego_` 与 `browser_` 前缀，配置分别为 `worlds.ego` 与 `worlds.browser`。

若宿主报找不到命令，在 World 配置里将 `cliFile` 填为 `ego-browser.exe` 的完整路径（macOS 填对应可执行文件）。Windows 可在命令行用 `Get-Command ego-browser` 查看路径。路径只填写可执行文件，不附带参数，不支持 `.cmd`/`.bat`。修改可执行文件或 Space 名称后重启这个 World。

## 管理员宿主如何连接（0.1.1）

Ego 会在执行浏览器脚本之前拒绝管理员身份的 `ego-browser`，原话为 `ego lite closed the connection because ego-browser is running as administrator`。普通子进程继承宿主权限，所以只重启 World 无法改变权限。

宿主可继续保留管理员权限，按下面三步启用普通权限助手：

1. 更新至 0.1.1 并重启宿主，连接方式保持「自动选择」；管理员宿主会自动选用助手。也可明确选择「普通权限助手」。
2. 在「浏览器控制」面板点击「生成启动脚本」，再点「打开助手目录」。在文件资源管理器里普通双击 `start-ego-helper.cmd`，不要选择「以管理员身份运行」，也不要从管理员命令行执行它。
3. 助手会在后台运行。面板显示「助手已启动，等待连接」后，点击「连接浏览器」。不需要退出管理员宿主。

启动脚本只在助手目录写文件和日志，不注册服务、计划任务或开机启动。注销或重启电脑后需要重新运行脚本。助手本身若以管理员权限启动会拒绝运行。

助手绑定 `127.0.0.1` 随机端口，凭据存在助手目录的 `endpoint.json`，不放入 URL 或界面。不要将该文件提供给网页或其他用户。宿主和助手须使用同一个助手目录；通常保持 `helperDir` 留空即可。

普通权限的宿主默认直接连接，无需助手；管理员模式下若「自动选择」无法读取系统权限，仍只在 Ego 明确拒绝管理员客户端后切换助手。其他结果不确定的失败不会自动重发命令。

要修改助手使用的 `cliFile`，先展开助手卡片点「停止助手」，修改配置并重启 World，然后重新生成并运行启动脚本。重复连接错误和日志在「诊断详情」中查看。0.1.0 误存为 `UNCERTAIN` 的管理员拒绝会自动迁移为可重试状态，无需手工删除运行数据。

每份部署按部署目录生成独立 Space 名称；也可设置 `spaceName`，不同 bot 使用不同名称。首次启用建立 Space，重启复用其中的页面标签。暂停/停用 World 保留 Space 与页面供继续工作，若当时正在观看则尝试暂停播放。关闭 World 不退出 Ego、不清除登录态。

## 浏览与视频

| 工具 | 用途 |
|---|---|
| `ego_open` / `ego_navigate` / `ego_tabs` | 打开网址或 BV 号、导航已有页、列出本 Space 的页面 |
| `ego_read` | 读取带操作引用的语义快照，支持 `fullPage`、`offset`、`maxChars` |
| `ego_click` / `ego_fill` / `ego_press` / `ego_scroll` | 点击、填表、按键、滚动 |
| `ego_evaluate` / `ego_shot` / `ego_close` | 页内 JavaScript、视口图片附件、关闭 bot 创建的页 |
| `ego_video` | 视频状态、播放、暂停、跳转、画面和字幕、持续观看 |
| `ego_bilibili` | B 站搜索、推荐与评论，只读 |
| `ego_handoff` | 交给操作员，停止操作与采集 |

先用 `ego_open {url}` 打开页面，之后使用返回的 `page`（例如 `p1`）。`ego_video {page, action:"inspect"}` 查视频状态，`look` 取一张带时间戳的画面拼图和可用字幕；`watch` 播放并开始定期观察。`pause`、`seek`（额外传 `time` 秒数）或 `exit` 结束观察。视频有多帧或多个播放器时，用返回的 `frameId` 配合 `index` 或 `selector` 选择；跨域 iframe 也可使用。

持续观看默认每 15 秒取当前视频帧，拼图保留最近 4 次采样，最多 9 格；字幕读取两次观察之间的可用文本。采样间隔、格数、单帧宽度均可热改。暂停、跳转、导航、关页、切源、接管和停用会使旧观察失效；bot 忙碌时只保留最新一条未投递画面。这里是离散采样，快速动作可能发生在两次采样之间。

网页 `textTracks` 的字幕会读取为文字；B 站额外尝试通过当前登录页的播放器接口读取字幕，优先中文。B 站请求可能受登录、区域、接口签名和风控影响，失败会保留原始错误。这个版本没有弹幕、扫码授权面板、画质切换或无字幕语音识别；登录直接在 Ego 内操作。

视频跨域像素不可读、DRM 或尚未解码时，会尝试返回网页视口截图，并标记 `viewport-fallback`；视口可能不包含播放器。Ego 最小化时无法截图：默认 `restoreMinimized=true` 会恢复窗口，截图会选中目标页；不需要自动恢复时关闭此配置，截图失败会原样返回。

**画面理解需要支持图片输入的模型。** World 将 JPEG/PNG 交给宿主作为附件，不调用额外付费识图服务。纯文本模型只能阅读字幕和状态，不能据此声称看懂画面；缺字幕也不等于视频没有声音。观看图片进入上下文，会增加模型输入与费用。

## 接管与错误恢复

在 Ego 接管、调用 `ego_handoff` 或点 World 面板「我要操作浏览器」后，World 停止命令与观察。操作员完成登录或处理浏览器提示后，点「交还 bot」才恢复；恢复后须重新发起观看。bot 没有恢复接管的工具。

命令超时或取消后，浏览器内的操作可能仍在结束。World 会保存停止状态，重启 World 也不会绕过；先检查 Ego 中的页面和未完成操作，再点「已核对，恢复操作」。连接前的权限拒绝、CLI 缺失和助手未运行使用连接重试流程，不要求交还一个尚不存在的 Space。导航失败会保留页面标签，可之后读取或关闭。Space 已被删除时需要改成新的专用 `spaceName` 后重启；不要填操作员正在使用的 Space 名称。

本包只操作自己 Space 中的已管理页面。用户创建或来源未知的页不能由 `ego_close` 关闭。网页、字幕和评论仍是外部内容；公开发言、付款等行为遵守 bot 的 Persona 授权规则。运行期只写宿主 `dataDir/ego/`，不修改 Persona 或 Memory，也不导入宿主内建 World。

## 开发与验证

本工位使用 Node ≥22、pnpm；开发期的 TypeScript/Vitest 路径指向相邻的 Cortico 源码，宿主运行时用自己的 `cortico/*` 解析器。发布包没有生产依赖。

```text
pnpm install
pnpm typecheck
pnpm test
pnpm build:webui
```

从 Cortico checkout 运行 `pnpm describe:extension <包目录>` 与 `pnpm check:extension <包目录>`。WebUI bundle 已包含在安装包中。

本地 `scripts/smoke.ts` 通过真实 Ego 运行合成视频与中文字幕，验证表单、弹出页、截图、播放/暂停/跳转、定时观察、旧帧撤回与跨域 iframe。它使用专用测试 Space，成功时关闭测试 Space；不运行真实 bot，也不使用模型密钥。再次验收应为新的测试任务设置新的 `spaceName`。

`scripts/smoke-helper.ts` 用生成的后台启动脚本启动真实普通权限助手，验证 Ego 中文表单和使用宿主样式的新面板；管理员拒绝的切换分支由确定性模拟错误触发。该脚本不代表已经在你的管理员宿主中更新并验收。助手完整发布入口为 `dist/ego-helper.mjs`；macOS 可从普通权限命令行执行 `node dist/ego-helper.mjs --dir <助手目录>`。

已在 Windows 本机 Ego Lite 0.6.0.16 / ego-browser guide 2.1.0 验证；Cortico 0.2.1 与 Coo 0.2.5 的中英文干装载通过。真实 B 站账号、接口与长视频尚未验收，macOS 尚未实机验证。源码、测试、包内 WebUI 和干装载通过不代表已安装到你的运行实例；实例启用仍需现场确认。
