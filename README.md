# cortico-world-ego

<img src="assets/icon.webp" width="96" height="96" alt="Ego 浏览器图标">

Ego 浏览器：专为 AI 打造的浏览器 World，让你家的小肥鱼上网、看图、看视频更顺手。让 Cortico 与 Coopanion（Coo）通过已安装的 [Ego Lite](https://github.com/citrolabs/ego-lite) 浏览网页、读取字幕和视频画面。World id 为 `ego`，契约为 world 6。

需要本机 Ego Lite 与 `ego-browser` 2.1 API。直接连接时由宿主调用 CLI；管理员宿主通过独立的普通权限助手调用。助手需要系统可找到 Node.js 22 以上。无需 web-access、Chrome 调试端口或另一个浏览器实例。Windows/macOS 可用。

**这不是即插即用的包**：装完扩展还要先装 Ego Lite，再启用 World。市场卡片会带「需额外安装」标签，指的就是这一步。

## 怎么装

1. 装 Ego Lite（[citrolabs/ego-lite](https://github.com/citrolabs/ego-lite)），确认命令行能运行 `ego-browser`。
2. 在宿主「扩展」市场搜 `cortico-world-ego` 安装并重启宿主；也可以从 npm 下载本包，用「手动安装」填入目录或 `.tgz`。不要用全局 `npm i -g`，Cortico 扩展由宿主自己管理依赖。
3. 在宿主的「扩展 → 手动安装」中填本包目录或本地 `.tgz` 同样可以，重启宿主，再启用「Ego 浏览器」World。

无需停用原 Browser：工具分别使用 `ego_` 与 `browser_` 前缀，配置分别为 `worlds.ego` 与 `worlds.browser`。

若宿主报找不到命令，在 World 配置里将 `cliFile` 填为 `ego-browser.exe` 的完整路径（macOS 填对应可执行文件）。Windows 可在命令行用 `Get-Command ego-browser` 查看路径。路径只填写可执行文件，不附带参数，不支持 `.cmd`/`.bat`。修改可执行文件或 Space 名称后重启这个 World。

## 市场标签

- `internet`、`browser`、`video`：联网读页面、操作浏览器、看视频与字幕。
- `external-setup`（需额外安装）：扩展本身不够，必须先装 Ego Lite。
- `high-cost`：持续观看会把画面附件放进模型上下文，token 用得快。

## 反馈

去 [GitHub 开 issue](https://github.com/biliye/cortico-world-ego/issues)，或在 QQ 群里 @筆離嘢（与作者同名）。

## 管理员宿主如何连接（0.1.1）

Ego 会在执行浏览器脚本之前拒绝管理员身份的 `ego-browser`，原话为 `ego lite closed the connection because ego-browser is running as administrator`。普通子进程继承宿主权限，所以只重启 World 无法改变权限。

宿主可继续保留管理员权限，按下面三步启用普通权限助手：

**从旧版升级且助手已在运行时**：先在控制面板展开助手卡片，点击「停止助手」，再更新包、重启宿主，并重新生成和运行启动脚本。助手也必须重启，否则仍可能执行旧版视频代码。

1. 更新至 0.1.6 并重启宿主，连接方式保持「自动选择」；管理员宿主会自动选用助手。也可明确选择「普通权限助手」。
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

先用 `ego_open {url}` 打开页面，之后使用返回的 `page`（例如 `p1`）。`ego_video {page, action:"inspect"}` 查视频状态；`look` 立即取当前画面及已有采样缓存，不等待 15 秒，也不能通过 `since` 恢复过去的画面。要看一段时间内的变化，调用一次 `watch` 播放并开始定期观察，等待后续 `ego.video.scene`；不要反复调用 `watch`，它会重置采样。`pause`、`seek`（额外传 `time` 秒数）或 `exit` 结束观察。视频有多个 frame 或播放器时，用返回的 `frameId` 配合 `index` 或 `selector` 选择；跨域 iframe 也可使用。

持续观看默认在每 15 秒内均匀采 4 帧（约每 5 秒一帧），合成一张带时间戳的图，再连同该段字幕发送。第一次 `watch` 只返回开始采集的文字确认；首帧留在本地，等拼图完成再投递。每张图最多 9 帧，下一段共用上一段最后的边界帧；中间采样不逐帧发送给模型。发送间隔、帧数、单帧宽度均可热改。暂停、跳转、导航、关页、切源、接管和停用会使旧观察失效。

0.1.6 可按本次观看指定总窗长和帧距，单位均为**视频秒**。默认值仍由用户在扩展配置页设置；省略这两个参数即可沿用。临时覆盖不写回默认设置，下次重新 `watch` 不带参数时仍使用用户默认值。

```json
{"page":"p1","action":"watch","windowSec":20,"frameIntervalSec":10}
```

这会计划采集 0、10、20 秒三格，下一批接为 20、30、40 秒，共享边界算在总帧数内。窗口允许 10–120 秒，帧距至少 1 秒且不能超过窗口，计划格数 `ceil(windowSec / frameIntervalSec) + 1` 不得超过 9；不能整除时末格补在窗口末尾。例如 20 秒 / 6 秒为 0、6、12、18、20，共 5 格。超限或只传一个数会报错，不会静默删帧。

观看中用 `tune` 调整，必须同时给两个数：

```json
{"page":"p1","action":"tune","windowSec":60,"frameIntervalSec":20}
```

新参数在下一批生效，当前批次和排队拼图保留；修改默认设置和单帧尺寸也在批次边界应用，本次观看参数优先于默认值。控制面板显示当前与待生效采样。单帧默认模式继续兼容，但一格无法同时容纳共享边界和新画面。

采样会根据视频倍速调度，卡顿或尚未到目标时刻只检查状态，不把重复时刻算新帧。实际时间仍以 `frameTimes` 为准；场景的 `observation` 给出 `batch`、`windowSec`、`frameIntervalSec`、`plannedFrames`、`actualVideoSpanSec` 和 `maxActualGapSec`。慢调用可能错过目标，回执不会伪造过去的帧。字幕和弹幕覆盖实际批次范围。当前不支持低于 10 秒的快速窗口。

从 0.1.5 起，未消费的帧不会因命令延迟超过窗口而过期。每批拼图及字幕/弹幕处理期间暂歇播放，处理完自动续播，避免接口等待时视频跑过一段。已完成的图按顺序排队，积压到 4 批时暂停播放，投递后自动继续；不会用新图覆盖旧批次。实际墙钟发送间隔可能长于配置值。卡顿、循环和提前结束仍可能少于配置帧数，离散采样仍可能漏掉快速动作。

首次 `watch` 返回 `observation.phase:"collecting"`；后续场景为 `scene`，提前播完则为 `ended` 并补发已采到的片尾画面。只有多于一帧才标记 `capture:"video-mosaic"`，一帧使用 `video-frame`。`frameCount` 与 `frameTimes` 是实际格数及视频秒数，顺序为从左到右、从上到下；时间也保留在不被正文长度限制截断的回执头和图片说明中。不能把单帧描述成多个时间点。

网页 `textTracks` 的字幕会读取为文字；B 站额外尝试通过当前登录页的播放器接口读取字幕，优先中文。视频抽帧不包含网页叠加的字幕和弹幕层。

0.1.2 随画面附上 B 站历史弹幕文字：读取当前视频 CID 的播放器已请求分段，按本次视频时间范围筛选，最多均匀选 12 条，返回时间、正文、总条数和截断标志。`danmaku.status` 为 `available`、`partial` 或 `unavailable`；未捕获分段、CORS 和接口错误会说明，不能把读取失败说成没有弹幕。弹幕与字幕分别读取，一方失败不会吞掉另一方。`video.danmaku` 默认开启，可在设置中关闭。它不是屏幕可见弹幕的逐条复刻，也不保证其他视频网站的弹幕可读。

B 站请求可能受登录、区域、接口签名和风控影响，失败会保留原始错误。这个版本没有扫码授权面板、画质切换或无字幕语音识别；登录直接在 Ego 内操作。

视频跨域像素不可读、DRM 或尚未解码时，会尝试返回网页视口截图，并标记 `viewport-fallback`；视口可能不包含播放器。Ego 最小化时无法截图：默认 `restoreMinimized=true` 会恢复窗口，截图会选中目标页；不需要自动恢复时关闭此配置，截图失败会原样返回。

**画面理解需要支持图片输入的模型。** World 将 JPEG/PNG 交给宿主作为附件，不调用额外付费识图服务。纯文本模型只能阅读字幕和状态，不能据此声称看懂画面；缺字幕也不等于视频没有声音。观看图片进入上下文，会增加模型输入与费用。

## 接管与错误恢复

在 Ego 接管、调用 `ego_handoff` 或点 World 面板「我要操作浏览器」后，World 停止命令与观察。操作员完成登录或处理浏览器提示后，点「交还 bot」才恢复；恢复后须重新发起观看。bot 没有恢复接管的工具。

命令超时或取消后，浏览器内的操作可能仍在结束。World 会保存停止状态，重启 World 也不会绕过；先检查 Ego 中的页面和未完成操作，再点「已核对，恢复操作」。连接前的权限拒绝、CLI 缺失和助手未运行使用连接重试流程，不要求交还一个尚不存在的 Space。导航失败会保留页面标签，可之后读取或关闭。

如果报 `task space not found: <id>`，说明助手能响应，但 Ego 已找不到 World 保存的旧空间。0.1.3 会显示「浏览空间已失效」，由你点击「重新建立浏览空间」并确认后，按本 bot 的专属名称连接或建立空间；成功后更新 id。旧页面标签失效，需要重新开网页，视频不会自动续看。助手离线时先启动助手；若提示空间名称被占用，在设置中改为本 bot 独有的 `spaceName`，重启 World。不要填操作员正在使用的名称。不会自动换空间绕过接管、失去分配或结果不确定的故障，也无需手工删除运行数据。

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

`pnpm smoke:tail` 验证观察周期未满就结束的短视频：启动只回文字，结束后真实返回多帧拼图，暂停后旧场景可撤回；证据和图片位于工位内 `.test-data/smoke-short-tail/`。

`pnpm smoke:continuity` 验证连续两批各 9 帧、共享边界、忙碌时保留前批，并注入 11.5 秒回执延迟，核对视频时间没有因此出现采样空档；使用专属测试 Space 和本地有限时长合成视频，证据在 `.test-data/smoke-continuity/`。

`pnpm smoke:sampling` 验证真实 20 秒 / 10 秒帧距三格，观看中 `tune` 为 10 秒 / 5 秒帧距三格，两批共享尾帧且不改默认设置；注入 11.5 秒回执等待检查连续性。使用独立 Space 和本地合成视频，证据在 `.test-data/smoke-sampling/`。

`scripts/smoke-helper.ts` 用生成的后台启动脚本启动真实普通权限助手，验证 Ego 中文表单和使用宿主样式的新面板；管理员拒绝的切换分支由确定性模拟错误触发。该脚本不代表已经在你的管理员宿主中更新并验收。助手完整发布入口为 `dist/ego-helper.mjs`；macOS 可从普通权限命令行执行 `node dist/ego-helper.mjs --dir <助手目录>`。

已在 Windows 本机 Ego Lite 0.6.0.16 / ego-browser guide 2.1.0 验证；Cortico 0.2.1 与 Coo 0.2.5 的中英文干装载通过。真实 B 站账号、接口与长视频尚未验收，macOS 尚未实机验证。源码、测试、包内 WebUI 和干装载通过不代表已安装到你的运行实例；实例启用仍需现场确认。
