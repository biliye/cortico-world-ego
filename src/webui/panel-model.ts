export interface EgoPanelStatus {
  running: boolean; connected: boolean; halted: boolean; reason: string; code?: string;
  spaceId?: number; spaceName: string; watching: string | null;
  connectionMode: 'auto' | 'direct' | 'helper'; transport: 'direct' | 'helper';
  helperOnline: boolean; helperDir: string; launcherFile: string; canPrepareHelper: boolean;
}
export function panelView(status: EgoPanelStatus, zh = true) {
  const say = (cn: string, en: string) => zh ? cn : en;
  const directBlocked = status.connectionMode === 'direct' && status.code === 'EGO_CLIENT_ELEVATED';
  const needsHelper = status.connectionMode === 'helper' || status.transport === 'helper' || (!directBlocked && /^EGO_(CLIENT_ELEVATED|HELPER_)/.test(status.code ?? ''));
  let title: string, detail: string;
  if (!status.running) { title = say('World 已停用', 'World is disabled'); detail = say('启用 Ego 浏览器 World 后再连接。', 'Enable the Ego Browser World to connect.'); }
  else if (status.halted) {
    const user = status.code === 'EGO_TASK_SPACE_USER_IN_CONTROL';
    title = user ? say('浏览器由你操作', 'You control the browser') : say('操作已暂停，等待确认', 'Automation paused for review');
    detail = user ? say('操作完成后，点击「交还 bot」。之后需要重新发起视频观看。', 'When finished, return control to the bot. Restart video watching separately.')
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
    canResume: status.running && status.halted,
    canHandoff: status.running && status.connected && !status.halted,
    canPause: status.running && !!status.watching && !status.halted,
    canPrepare: status.running && status.canPrepareHelper,
  };
}
