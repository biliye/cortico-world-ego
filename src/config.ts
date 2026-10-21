import type { ConfigGroup } from 'cortico/core/types.ts';
export interface EgoConfigSection {
  enabled: boolean;
  cliFile: string;
  spaceName: string;
  requestTimeoutMs: number;
  maxChars: number;
  restoreMinimized: boolean;
  video: { intervalMs: number; maxFrames: number; frameWidth: number };
}
export const EGO_DEFAULTS: EgoConfigSection = {
  enabled: false, cliFile: 'ego-browser', spaceName: '', requestTimeoutMs: 45000, maxChars: 16000, restoreMinimized: true,
  video: { intervalMs: 15000, maxFrames: 4, frameWidth: 640 },
};
export function egoConfigGroup(language = 'zh'): ConfigGroup {
  const zh = language.startsWith('zh');
  const prop = (type: 'string' | 'integer' | 'boolean', title: string, en: string, extra = {}) => ({ type, title: zh ? title : en, ...extra });
  return { id: 'world:ego', owner: 'world:ego', schema: { type: 'object', title: zh ? 'Ego 浏览器' : 'Ego Browser', properties: {
    'worlds.ego.cliFile': prop('string', 'ego-browser 可执行文件', 'ego-browser executable', { description: zh ? '默认从 PATH 查找；Coo 找不到时填完整 exe 路径。修改后重启 World。' : 'Resolved from PATH by default. Set an absolute executable path if Coo cannot find it. Restart this World after changes.' }),
    'worlds.ego.spaceName': prop('string', '专用 Space 名称', 'Dedicated Space name', { description: zh ? '留空按部署目录生成。不同 bot 不要共用一个名称。修改后重启 World。' : 'Empty generates a deployment-specific name. Use a different name for each bot. Restart after changes.' }),
    'worlds.ego.requestTimeoutMs': prop('integer', '命令超时（毫秒）', 'Command timeout (ms)', { minimum: 5000, maximum: 120000, 'x-hot': true }),
    'worlds.ego.maxChars': prop('integer', '正文返回上限', 'Text receipt limit', { minimum: 1000, maximum: 60000, 'x-hot': true }),
    'worlds.ego.restoreMinimized': prop('boolean', '截图时恢复最小化的 Ego 窗口', 'Restore minimized Ego window for screenshots', { 'x-hot': true, description: zh ? 'Ego 在最小化时无法截图。启用后恢复窗口；截图会选中目标页，不额外置顶。' : 'Ego cannot screenshot a minimized window. Restore it when enabled; screenshots select the target page without an extra foreground request.' }),
    'worlds.ego.video.intervalMs': prop('integer', '观看采样间隔（毫秒）', 'Watch interval (ms)', { minimum: 10000, maximum: 120000, 'x-hot': true }),
    'worlds.ego.video.maxFrames': prop('integer', '画面拼图格数', 'Frames per mosaic', { minimum: 1, maximum: 9, 'x-hot': true }),
    'worlds.ego.video.frameWidth': prop('integer', '单帧宽度（像素）', 'Frame width (px)', { minimum: 240, maximum: 1280, 'x-hot': true }),
  } } };
}
export function bounded(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(min, Math.min(max, Math.floor(value))) : fallback;
}
