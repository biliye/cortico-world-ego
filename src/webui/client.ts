import type { WebUiClientBundle, WebUiPanelContext } from 'cortico/web/shared/client-panel.ts';
import { panelView, type EgoPanelStatus } from './panel-model.ts';
export default { panels: { control: { mount } } } satisfies WebUiClientBundle;
export function mount(ctx: WebUiPanelContext): void {
  const ui = ctx.ui, zh = ctx.language.startsWith('zh');
  const say = (cn: string, en: string) => zh ? cn : en;
  const connection = ui.sheet({ title: say('浏览器连接', 'Browser connection') });
  const heading = ui.h('h3', null, say('正在读取状态…', 'Reading status…'));
  heading.setAttribute('role', 'status');
  const detail = ui.h('p');
  const summary = ui.h('div');
  const actions = ui.actions();
  const message = ui.msgline();
  connection.body.append(heading, detail, summary, actions, message);
  const helper = ui.foldSheet('ego-helper', { title: say('普通权限助手', 'Ordinary-permission helper'), defaultOpen: false });
  const steps = ui.h('ol');
  steps.style.listStyle = 'decimal'; steps.style.paddingInlineStart = '24px'; steps.style.lineHeight = '1.8';
  for (const label of [say('点击下方按钮生成启动脚本。', 'Generate the launcher below.'),
    say('在文件资源管理器中普通双击 start-ego-helper.cmd；不要选择「以管理员身份运行」。', 'Double-click start-ego-helper.cmd in File Explorer. Do not run it as administrator.'),
    say('回到这里，点击「连接浏览器」。助手会在后台运行。', 'Return here and connect. The helper runs in the background.')]) steps.append(ui.h('li', null, label));
  const helperState = ui.h('p');
  const launcher = ui.h('code', 'mono'); launcher.style.overflowWrap = 'anywhere'; launcher.style.display = 'block'; launcher.style.marginBlock = '10px';
  const helperActions = ui.actions();
  helper.body.append(helperState, steps, launcher, helperActions);
  const diagnostic = ui.foldSheet('ego-diagnostics', { title: say('诊断详情', 'Diagnostics'), defaultOpen: false });
  diagnostic.note.textContent = say('需要排查时展开查看原始错误', 'Expand to inspect original errors');
  const raw = ui.h('pre', 'mono'); raw.style.whiteSpace = 'pre-wrap'; raw.style.overflowWrap = 'anywhere';
  let current: EgoPanelStatus | undefined, busy = false, fetching = false, revision = 0, actionError = '', neededSetup = false;
  diagnostic.body.append(ui.copyButton(() => JSON.stringify({ ...current, actionError: actionError || undefined }, null, 2)), raw);
  ctx.root.append(connection.el, helper.el, diagnostic.el);
  function button(label: string, method: string, primary = false): HTMLButtonElement {
    const element = ui.button(label, { variant: primary ? 'primary' : 'plain', onClick: () => void act(method) });
    element.disabled = busy; return element;
  }
  function render(status: EgoPanelStatus): void {
    if (ctx.signal.aborted) return;
    current = status;
    const view = panelView(status, zh);
    heading.textContent = view.title; detail.textContent = view.detail;
    summary.replaceChildren(ui.kv([
      { k: say('连接通道', 'Connection'), v: status.transport === 'helper' ? say('普通权限助手', 'Ordinary-permission helper') : say('直接连接', 'Direct') },
      { k: 'Space', v: status.spaceId ? `${status.spaceName} (#${status.spaceId})` : say('连接后创建', 'Created after connection') },
      { k: say('视频观看', 'Video'), v: status.watching || say('未在观看', 'Not watching') },
    ]));
    actions.replaceChildren();
    if (view.canConnect) actions.append(button(say('连接浏览器', 'Connect browser'), 'connect', true));
    if (view.canRecreate) actions.append(button(say('重新建立浏览空间', 'Recreate browser Space'), 'recreate-space', true));
    if (view.canResume) actions.append(button(say(status.code === 'EGO_TASK_SPACE_USER_IN_CONTROL' ? '交还 bot' : '已核对，恢复操作', 'Checked: return control'), 'resume', true));
    if (view.canHandoff) actions.append(button(say('我要操作浏览器', 'Take browser control'), 'handoff'));
    if (view.canPause) actions.append(button(say('暂停视频观看', 'Pause video watching'), 'pause'));
    helperState.textContent = status.helperOnline ? say('助手在线', 'Helper online') : say('助手未启动', 'Helper not running');
    helper.note.textContent = helperState.textContent;
    const needsSetup = view.needsHelper && !status.connected && !status.halted;
    if (helper.el instanceof HTMLDetailsElement && needsSetup !== neededSetup) helper.el.open = needsSetup;
    neededSetup = needsSetup;
    launcher.textContent = status.launcherFile || status.helperDir;
    helperActions.replaceChildren();
    if (view.canPrepare) helperActions.append(button(say(status.launcherFile ? '重新生成启动脚本' : '生成启动脚本', 'Generate launcher'), 'prepare-helper', !status.launcherFile));
    if (status.launcherFile) helperActions.append(button(say('打开助手目录', 'Open helper folder'), 'open-helper-folder'));
    if (status.helperOnline) helperActions.append(button(say('停止助手', 'Stop helper'), 'stop-helper'));
    message.textContent = actionError ? say('操作未成功，请按当前状态的提示处理。原始错误在诊断详情中。', 'The action failed. Follow the current status guidance; diagnostics include the original error.') : '';
    raw.textContent = JSON.stringify({ ...status, actionError: actionError || undefined }, null, 2);
  }
  async function act(method: string): Promise<void> {
    if (busy) return;
    if (method === 'stop-helper' && !await ui.confirm({ title: say('停止普通权限助手？', 'Stop the helper?'), body: say('通过该助手的浏览器连接会断开。', 'Browser connections using this helper will disconnect.') })) return;
    if (method === 'recreate-space' && !await ui.confirm({ title: say('重新建立浏览空间？', 'Recreate the browser Space?'), body: say('Ego 已确认找不到旧空间。将按本 bot 的专属名称重新连接或建立空间；旧页面标签将失效，需要重新打开网页。视频不会自动续看。', 'Ego confirmed the old Space is missing. Connect or create a Space using this bot’s dedicated name. Reopen pages; video watching will not resume automatically.') })) return;
    busy = true; revision++; actionError = ''; if (current) render(current);
    try { const status = await ctx.invoke<EgoPanelStatus>(method); render(status); await ctx.refresh(); }
    catch (error) {
      actionError = String(error);
      try { render(await ctx.invoke<EgoPanelStatus>('status')); } catch { if (current) render(current); }
    } finally { busy = false; if (current && !ctx.signal.aborted) render(current); }
  }
  async function refresh(): Promise<void> {
    if (busy || fetching) return;
    fetching = true; const version = revision;
    try { const status = await ctx.invoke<EgoPanelStatus>('status'); if (version === revision && !busy) render(status); }
    catch (error) { if (!ctx.signal.aborted) message.textContent = say('状态读取失败：', 'Status read failed: ') + String(error); }
    finally { fetching = false; }
  }
  void refresh(); ctx.interval(() => void refresh(), 3000);
}
