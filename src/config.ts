import type { ConfigGroup } from 'cortico/core/types.ts';
import { DEFAULT_SEARCH_SETTINGS, type SearchSettings } from './search-settings.ts';
export interface EgoConfigSection {
  enabled: boolean;
  cliFile: string;
  spaceName: string;
  requestTimeoutMs: number;
  maxChars: number;
  restoreMinimized: boolean;
  allowPageScripts: boolean;
  connectionMode: 'auto' | 'direct' | 'helper';
  helperDir: string;
  video: { intervalMs: number; maxFrames: number; frameWidth: number; danmaku: boolean; smoothWatch?: boolean };
  search?: SearchSettings;
}
export const EGO_DEFAULTS: EgoConfigSection = {
  enabled: false, cliFile: 'ego-browser', spaceName: '', requestTimeoutMs: 45000, maxChars: 16000, restoreMinimized: true,
  connectionMode: 'auto', helperDir: '', allowPageScripts: false,
  video: { intervalMs: 15000, maxFrames: 4, frameWidth: 640, danmaku: true, smoothWatch: true },
  search: structuredClone(DEFAULT_SEARCH_SETTINGS),
};
export function egoConfigGroup(language = 'zh'): ConfigGroup {
  const zh = language.startsWith('zh');
  const prop = (type: 'string' | 'integer' | 'boolean', title: string, en: string, extra = {}) => ({ type, title: zh ? title : en, ...extra });
  return { id: 'world:ego', owner: 'world:ego', schema: { type: 'object', title: zh ? 'Ego 浏览器' : 'Ego Browser', properties: {
    'worlds.ego.connectionMode': prop('string', '连接方式', 'Connection method', { enum: ['auto', 'direct', 'helper'], 'x-options': 'ego-connection', description: zh ? '自动选择：管理员宿主使用普通权限助手，其余尝试直连。修改后重启 World。' : 'Automatic: use the helper for an elevated host; otherwise try direct. Restart this World after changes.' }),
    'worlds.ego.helperDir': prop('string', '助手目录（通常留空）', 'Helper directory (usually leave empty)', { description: zh ? '留空使用本部署的专用目录；需要与其他宿主共用同一个助手时才填写。不要放在无权访问的系统目录。修改后重启 World。' : 'Empty uses a deployment-specific directory. Set only to share a helper with another host. Restart after changes.' }),
    'worlds.ego.cliFile': prop('string', 'ego-browser 程序路径（通常不用改）', 'ego-browser executable (usually unchanged)', { description: zh ? '默认自动查找；找不到时填完整 exe 路径。修改后重启 World；使用助手时还需停止助手、重新生成并启动脚本。' : 'Found through PATH by default. Set the full executable path if missing. Restart the World; also regenerate and restart its helper if used.' }),
    'worlds.ego.spaceName': prop('string', '专属浏览空间名称（可留空）', 'Dedicated Space name (optional)', { description: zh ? '留空按部署目录生成。不同 bot 不要共用一个名称。修改后重启 World。' : 'Empty generates a deployment-specific name. Use a different name for each bot. Restart after changes.' }),
    'worlds.ego.requestTimeoutMs': prop('integer', '命令超时（毫秒）', 'Command timeout (ms)', { minimum: 5000, maximum: 120000, 'x-hot': true, description: zh ? '默认 45000，即 45 秒。这是命令总时限，不会提高 Ego 自身约 15 秒的页面求值上限；纯等待使用 ego_wait。' : 'Default 45000 = 45 seconds. This command deadline does not extend Ego’s approximately 15-second page evaluation limit; use ego_wait for delays.' }),
    'worlds.ego.maxChars': prop('integer', '正文返回上限', 'Text receipt limit', { minimum: 1000, maximum: 60000, 'x-hot': true }),
    'worlds.ego.allowPageScripts': prop('boolean', '允许 Coo 执行页内 JavaScript', 'Allow Coo to run JavaScript in pages', {
      'x-hot': true,
      description: zh
        ? '默认关闭。开启后在「提示词」页重载系统前缀，Coo 即可在 Ego 管理的网页中使用该页的登录态执行 JavaScript。保存关闭设置后，尚未派发的脚本会被拒绝。'
        : 'Off by default. After enabling, reload the system prefix on the Prompts page to let Coo run JavaScript in managed Ego pages with their signed-in access. Saving this setting off blocks scripts that have yet to be dispatched.',
    }),
    'worlds.ego.restoreMinimized': prop('boolean', '截图时恢复最小化的 Ego 窗口', 'Restore minimized Ego window for screenshots', { 'x-hot': true, description: zh ? 'Ego 在最小化时无法截图。启用后恢复窗口；截图会选中目标页，不额外置顶。' : 'Ego cannot screenshot a minimized window. Restore it when enabled; screenshots select the target page without an extra foreground request.' }),
    'worlds.ego.video.smoothWatch': prop('boolean', '流畅陪看', 'Smooth watch', { 'x-hot': true, description: zh ? '默认开启。陪看时继续播放，投递积压时优先保留最近的画面。关闭后可暂歇播放以保留采样。下次开始陪看时生效。' : 'On by default. Keep playing during observation and retain the most recent scenes when delivery falls behind. Turn off to pause as needed to preserve sampling. Applies to the next watch.' }),
    'worlds.ego.video.intervalMs': prop('integer', '默认采集窗口（视频毫秒）', 'Default sampling window (video ms)', { minimum: 10000, maximum: 120000, 'x-hot': true, description: zh ? '默认 15000：每图计划覆盖 15 秒视频内容，实际墙钟等待受倍速、卡顿和处理耗时影响。热改下一批生效；bot 可临时覆盖本次观看。' : 'Default 15000: target 15 video seconds per scene. Wall-clock delivery depends on playback rate, stalls and processing. Hot changes apply next batch; the bot may override this watch only.' }),
    'worlds.ego.video.maxFrames': prop('integer', '默认每张拼图最多几帧', 'Default maximum frames per scene', { minimum: 1, maximum: 9, 'x-hot': true, description: zh ? '默认 4：15 视频秒内约每 5 秒采一帧；最多 9 帧。热改下一批生效，本次观看的临时覆盖优先；中间采样不逐帧发送。' : 'Default 4: approximately every 5 video seconds within 15 video seconds. Up to 9 frames. Hot changes apply next batch; temporary watch parameters take priority. Intermediate samples stay local.' }),
    'worlds.ego.video.frameWidth': prop('integer', '单帧宽度（像素）', 'Frame width (px)', { minimum: 240, maximum: 1280, 'x-hot': true }),
    'worlds.ego.video.danmaku': prop('boolean', '默认附上弹幕文字', 'Include danmaku text by default', { 'x-hot': true, description: zh ? '适用于 B 站和抖音。每批最多附 12 条弹幕文字和时间。Coo 或 bot 可单独为本次观看开关。' : 'Applies to Bilibili and Douyin. Includes up to 12 timestamped lines per scene. The agent can override this setting for a watch.' }),
  } } };
}
export function bounded(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(min, Math.min(max, Math.floor(value))) : fallback;
}
