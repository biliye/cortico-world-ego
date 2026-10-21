import type { ConfigGroup } from 'cortico/core/types.ts';
export interface EgoConfigSection {
  enabled: boolean;
  cliFile: string;
  spaceName: string;
  requestTimeoutMs: number;
  maxChars: number;
  restoreMinimized: boolean;
  connectionMode: 'auto' | 'direct' | 'helper';
  helperDir: string;
  video: { intervalMs: number; maxFrames: number; frameWidth: number; danmaku: boolean };
}
export const EGO_DEFAULTS: EgoConfigSection = {
  enabled: false, cliFile: 'ego-browser', spaceName: '', requestTimeoutMs: 45000, maxChars: 16000, restoreMinimized: true,
  connectionMode: 'auto', helperDir: '',
  video: { intervalMs: 15000, maxFrames: 4, frameWidth: 640, danmaku: true },
};
export function egoConfigGroup(language = 'zh'): ConfigGroup {
  const zh = language.startsWith('zh');
  const prop = (type: 'string' | 'integer' | 'boolean', title: string, en: string, extra = {}) => ({ type, title: zh ? title : en, ...extra });
  return { id: 'world:ego', owner: 'world:ego', schema: { type: 'object', title: zh ? 'Ego 浏览器' : 'Ego Browser', properties: {
    'worlds.ego.connectionMode': prop('string', '连接方式', 'Connection method', { enum: ['auto', 'direct', 'helper'], 'x-options': 'ego-connection', description: zh ? '自动选择：管理员宿主使用普通权限助手，其余尝试直连。修改后重启 World。' : 'Automatic: use the helper for an elevated host; otherwise try direct. Restart this World after changes.' }),
    'worlds.ego.helperDir': prop('string', '助手目录（通常留空）', 'Helper directory (usually leave empty)', { description: zh ? '留空使用本部署的专用目录；需要与其他宿主共用同一个助手时才填写。不要放在无权访问的系统目录。修改后重启 World。' : 'Empty uses a deployment-specific directory. Set only to share a helper with another host. Restart after changes.' }),
    'worlds.ego.cliFile': prop('string', 'ego-browser 程序路径（通常不用改）', 'ego-browser executable (usually unchanged)', { description: zh ? '默认自动查找；找不到时填完整 exe 路径。修改后重启 World；使用助手时还需停止助手、重新生成并启动脚本。' : 'Found through PATH by default. Set the full executable path if missing. Restart the World; also regenerate and restart its helper if used.' }),
    'worlds.ego.spaceName': prop('string', '专属浏览空间名称（可留空）', 'Dedicated Space name (optional)', { description: zh ? '留空按部署目录生成。不同 bot 不要共用一个名称。修改后重启 World。' : 'Empty generates a deployment-specific name. Use a different name for each bot. Restart after changes.' }),
    'worlds.ego.requestTimeoutMs': prop('integer', '命令超时（毫秒）', 'Command timeout (ms)', { minimum: 5000, maximum: 120000, 'x-hot': true, description: zh ? '默认 45000，即 45 秒。' : 'Default 45000 = 45 seconds.' }),
    'worlds.ego.maxChars': prop('integer', '正文返回上限', 'Text receipt limit', { minimum: 1000, maximum: 60000, 'x-hot': true }),
    'worlds.ego.restoreMinimized': prop('boolean', '截图时恢复最小化的 Ego 窗口', 'Restore minimized Ego window for screenshots', { 'x-hot': true, description: zh ? 'Ego 在最小化时无法截图。启用后恢复窗口；截图会选中目标页，不额外置顶。' : 'Ego cannot screenshot a minimized window. Restore it when enabled; screenshots select the target page without an extra foreground request.' }),
    'worlds.ego.video.intervalMs': prop('integer', '观看画面发送间隔（毫秒）', 'Scene delivery interval (ms)', { minimum: 10000, maximum: 120000, 'x-hot': true, description: zh ? '默认 15000：在 15 秒内均匀采几帧，合成一张图，连同可用字幕发送。' : 'Default 15000: sample several frames within 15 seconds, then send one mosaic and available subtitles.' }),
    'worlds.ego.video.maxFrames': prop('integer', '每张拼图最多几帧', 'Maximum frames per scene', { minimum: 1, maximum: 9, 'x-hot': true, description: zh ? '默认 4：15 秒内约每 5 秒采一帧；最多 9 帧。不会每采一帧就发给模型。' : 'Default 4: approximately one frame every 5 seconds within each 15-second window. Up to 9 frames; intermediate samples are not sent to the model.' }),
    'worlds.ego.video.frameWidth': prop('integer', '单帧宽度（像素）', 'Frame width (px)', { minimum: 240, maximum: 1280, 'x-hot': true }),
    'worlds.ego.video.danmaku': prop('boolean', '附上 B 站弹幕文字', 'Include Bilibili danmaku text', { 'x-hot': true, description: zh ? '读取播放器已请求的历史弹幕，每次最多附 12 条并带时间。不是屏幕弹幕截图；接口不可读时会说明原因。' : 'Read historical danmaku requested by the player, returning up to 12 timestamped lines per scene. This is separate text, not the visible overlay; failures are reported.' }),
  } } };
}
export function bounded(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(min, Math.min(max, Math.floor(value))) : fallback;
}
