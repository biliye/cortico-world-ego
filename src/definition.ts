import { describeTools, type WorldDefinition } from 'cortico/world.ts';
import { EGO_DEFAULTS, type EgoConfigSection } from './config.ts';
import { EGO_TOOL_DECLS } from './tools.ts';
import { EgoWorld } from './world.ts';
export const EGO: WorldDefinition<EgoConfigSection> = {
  id: 'ego', label: 'Ego 浏览器', defaults: () => structuredClone(EGO_DEFAULTS),
  configOptions: (kind, language) => kind !== 'ego-connection' ? [] : [
    { value: 'auto', label: language.startsWith('zh') ? '自动选择（推荐）' : 'Automatic (recommended)' },
    { value: 'helper', label: language.startsWith('zh') ? '普通权限助手（宿主可用管理员权限）' : 'Ordinary-permission helper (host can stay elevated)' },
    { value: 'direct', label: language.startsWith('zh') ? '直接连接（宿主须用普通权限）' : 'Direct (ordinary-permission host)' },
  ],
  create: ctx => new EgoWorld({ cfg: ctx.cfg, timezone: ctx.timezone, dataDir: ctx.dataDir, botDir: ctx.botDir }),
  describe: {
    tools: describeTools(EGO_TOOL_DECLS, {
      ego_open: { zh: '在专用 Space 打开网页或 BV 视频。', en: 'Open a web page or Bilibili video in the dedicated Space.' },
      ego_navigate: { zh: '让已有页面转到新地址。', en: 'Navigate a managed page.' },
      ego_tabs: { zh: '列出专用 Space 的页面。', en: 'List tabs in the dedicated Space.' },
      ego_read: { zh: '读取可分页的网页结构与操作引用。', en: 'Read a paginated semantic snapshot.' },
      ego_click: { zh: '点击网页元素并报告弹出页。', en: 'Click an element and report popup pages.' },
      ego_fill: { zh: '填写网页输入框。', en: 'Fill an input.' },
      ego_press: { zh: '向元素发送按键。', en: 'Send keys to an element.' },
      ego_scroll: { zh: '滚动网页。', en: 'Scroll a page.' },
      ego_evaluate: { zh: '在网页中执行 JavaScript。', en: 'Evaluate JavaScript inside the page.' },
      ego_shot: { zh: '获取网页当前视口的图片附件。', en: 'Capture the page viewport as an attachment.' },
      ego_close: { zh: '关闭 bot 创建的页面。', en: 'Close an agent-created page.' },
      ego_handoff: { zh: '将 Space 交给操作员并停止操作。', en: 'Hand control to the operator and stop commands.' },
      ego_video: { zh: '控制视频，读取字幕与画面，按需持续观看。', en: 'Control videos, read subtitles and frames, optionally watch continuously.' },
      ego_bilibili: { zh: '搜索 B 站视频、查看推荐与评论。', en: 'Search Bilibili, list related videos and comments.' },
    }),
    events: [
      { type: 'ego.state', description: { zh: '连接、接管或恢复状态。', en: 'Connection, control handoff or resume state.' } },
      { type: 'ego.video.state', description: { zh: '视频播放与观看状态。', en: 'Playback and observation state.' } },
      { type: 'ego.video.scene', description: { zh: '显式观看期间的画面拼图与可用字幕。', en: 'Timestamped frame mosaic and available subtitles during explicit watching.' } },
    ],
  },
};
