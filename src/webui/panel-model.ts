import type { EvaluationTimeout } from '../bridge.ts';
export interface EgoPanelStatus {
  running: boolean; connected: boolean; halted: boolean; reason: string; code?: string;
  spaceId?: number; spaceName: string; watching: string | null; spaceMissing?: boolean; autoRecovering?: boolean; checkingControl?: boolean;
  evaluation?: EvaluationTimeout;
  sampling?: { batch: number; current: { windowSec: number; frameIntervalSec: number; plannedFrames: number }; pending: { windowSec: number; frameIntervalSec: number; plannedFrames: number } | null } | null;
  connectionMode: 'auto' | 'direct' | 'helper'; transport: 'direct' | 'helper';
  helperOnline: boolean; helperDir: string; launcherFile: string; canPrepareHelper: boolean;
}
export function panelView(status: EgoPanelStatus, zh = true) {
  const say = (cn: string, en: string) => zh ? cn : en;
  const directBlocked = status.connectionMode === 'direct' && status.code === 'EGO_CLIENT_ELEVATED';
  const needsHelper = status.connectionMode === 'helper' || status.transport === 'helper' || (!directBlocked && /^EGO_(CLIENT_ELEVATED|HELPER_)/.test(status.code ?? ''));
  const missingSpace = status.code === 'EGO_TASK_SPACE_NOT_FOUND' && status.spaceMissing === true;
  const nameInUse = status.code === 'EGO_TASK_SPACE_NAME_IN_USE';
  let title: string, detail: string;
  if (!status.running) { title = say('World 已停用', 'World is disabled'); detail = say('启用 Ego 浏览器 World 后再连接。', 'Enable the Ego Browser World to connect.'); }
  else if (missingSpace) {
    title = status.autoRecovering ? say('正在自动重建浏览空间', 'Automatically recovering browser Space') : say('浏览空间已失效', 'Browser Space is missing');
    detail = status.autoRecovering
      ? say(`Ego 找不到之前的 Space ${status.spaceId ?? ''}，正在按本 bot 的专属名称自动重建。请保持 Ego 和助手运行，失败后会延迟重试。旧网页需要重新打开，视频不会自动续看。`, `Ego cannot find Space ${status.spaceId ?? ''}. Automatic recovery uses this bot's dedicated name and retries with backoff. Keep Ego and its helper running. Reopen pages and restart watching afterwards.`)
      : say(`Ego 找不到之前的 Space ${status.spaceId ?? ''}。点击「重新建立浏览空间」可立即重试；旧页面标签失效，需要重新打开网页，视频不会自动续看。`, `Ego cannot find Space ${status.spaceId ?? ''}. Recreate the dedicated Space to retry now. Old page labels are invalid; reopen pages and restart watching.`);
  } else if (nameInUse) {
    title = say('浏览空间名称已被占用', 'Space name is already in use');
    detail = say('请在配置中改用本 bot 独有的浏览空间名称，再重启 World。不会接管占用该名称的空间。', 'Choose a unique Space name in settings, then restart this World. The existing Space will not be claimed.');
  } else if (status.halted && status.code === 'EGO_PAGE_EVALUATION_TIMED_OUT') {
    title = say('页面脚本求值超时', 'Page evaluation timed out');
    const response = status.evaluation?.pageResponsive;
    detail = (response === true ? say('Ego 报告页面仍有响应。', 'Ego reports that the page is responsive. ')
      : response === false ? say('Ego 报告页面未响应。', 'Ego reports that the page is unresponsive. ')
      : say('尚无页面响应状态。', 'The page response state is unknown. '))
      + say('脚本可能仍有延迟效果，操作暂停等待核对；bot 仍可列标签作诊断。纯等待请用 ego_wait，不要在页面执行长时间 Promise。', 'Scheduled script effects may still finish. Actions remain paused for review; the bot can list tabs for diagnosis. Use ego_wait for simple delays instead of a long page Promise.');
  } else if (status.halted) {
    const user = status.code === 'EGO_TASK_SPACE_USER_IN_CONTROL';
    title = user ? say('浏览器由你操作', 'You control the browser') : say('操作已暂停，等待确认', 'Automation paused for review');
    detail = user && status.checkingControl ? say('在 Ego 中交还后会自动同步，无需再点一次。也可在这里点击「交还 bot」。视频需要重新发起观看。', 'Returning control in Ego is synchronized automatically. You can also return it here. Restart video watching separately.')
      : status.checkingControl ? say('只读命令超时，正在自动检查原 Space，确认可用后恢复。失败命令不会重放，视频不会自动续看。', 'A read-only command timed out. Checking the same Space automatically before resuming. The failed operation and video watching are not restarted.')
      : say('请先在 Ego 核对页面及未完成操作，确认后再恢复。', 'Check the page and any unfinished operation in Ego before resuming.');
  } else if (status.connected) {
    title = status.watching ? say('正在观看视频', 'Watching a video') : say('浏览器已连接', 'Browser connected');
    detail = status.watching ? say(`正在采集页面 ${status.watching} 的画面和可用字幕。`, `Sampling frames and available subtitles from ${status.watching}.`)
      : say('bot 可以浏览网页；只有主动开始观看时才采集视频。', 'The bot can browse. Video is sampled only after an explicit watch request.');
  } else if (directBlocked) {
    title = say('直接连接受权限限制', 'Direct connection is blocked by elevation');
    detail = say('将连接方式改为「自动选择」或「普通权限助手」，再重启这个 World；宿主可继续保留管理员权限。', 'Choose Automatic or Helper mode, then restart this World. The host can stay elevated.');
  } else if (status.code === 'EGO_CLI_NOT_FOUND') {
    title = say('未找到 ego-browser', 'ego-browser was not found'); detail = say('在配置中填写 ego-browser 可执行文件的完整路径。使用助手时，先停止助手，再重新生成并运行启动脚本。', 'Set the full ego-browser executable path. When using the helper, stop it, regenerate and run its launcher.');
  } else if (needsHelper && !status.helperOnline) {
    title = say('需要启动普通权限助手', 'Start the ordinary-permission helper');
    detail = say('宿主可继续使用管理员权限。Ego 的连接由普通权限助手执行。', 'The host can stay elevated. The helper runs Ego commands without elevation.');
  } else if (needsHelper && status.helperOnline) {
    title = say('助手已启动，等待连接', 'Helper ready to connect'); detail = say('点击「连接浏览器」，无需退出管理员宿主。', 'Connect the browser without closing the elevated host.');
  } else { title = say('尚未连接 Ego', 'Ego is not connected'); detail = say('先打开 Ego Lite，再点击「连接浏览器」。', 'Open Ego Lite, then connect the browser.'); }
  return { title, detail, needsHelper,
    canConnect: status.running && !status.halted && !status.connected && !directBlocked && (!needsHelper || status.helperOnline),
    canResume: status.running && status.halted && !missingSpace && !nameInUse,
    canRecreate: status.running && status.halted && missingSpace && !!status.spaceId && (!needsHelper || status.helperOnline),
    canHandoff: status.running && status.connected && !status.halted,
    canPause: status.running && !!status.watching && !status.halted,
    canPrepare: status.running && status.canPrepareHelper,
  };
}
