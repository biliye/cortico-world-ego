import type { EvaluationTimeout } from '../bridge.ts';
export interface EgoPanelStatus {
  running: boolean; connected: boolean; halted: boolean; reason: string; code?: string;
  spaceId?: number; spaceName: string; watching: string | null; spaceMissing?: boolean; autoRecovering?: boolean; checkingControl?: boolean;
  evaluation?: EvaluationTimeout; evaluationRecoveryBlocked?: string; lastUnknownEvaluation?: EvaluationTimeout;
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
      + (status.checkingControl
        ? say('正在后台检查原 Space 的控制权和超时页面快照，通过后自动恢复工具，无需点恢复。', 'Checking control of the original Space and a snapshot of the timed-out page; successful diagnosis restores tools automatically without a panel resume. ')
        : say('自动诊断未运行；请核对空间、页面信息或助手状态后恢复。', 'Automatic diagnosis is not running; check the Space, page information or helper status before resuming. '))
      + (status.evaluationRecoveryBlocked ? say(`诊断停止：${status.evaluationRecoveryBlocked}。`, `Diagnosis stopped: ${status.evaluationRecoveryBlocked}. `) : '')
      + say('bot 仍可用 ego_tabs 列标签、ego_read 读快照。恢复只代表浏览器可用，原脚本结果仍未知，不能自动重放。纯等待请用 ego_wait。', 'The bot can still use ego_tabs and ego_read. Recovery only establishes browser availability; the script outcome stays unknown and must not be replayed automatically. Use ego_wait for simple delays.');
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
    if (status.lastUnknownEvaluation) detail += say('上次超时脚本结果仍未知；继续任务前需核对页面，不能自动重放可能的提交。', 'The last timed-out script outcome is still unknown; inspect the page before continuing and do not automatically replay a possible submission.');
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
