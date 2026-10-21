import type { WebUiClientBundle, WebUiPanelContext } from 'cortico/web/shared/client-panel.ts';
export default { panels: { control: { mount } } } satisfies WebUiClientBundle;
function mount(ctx: WebUiPanelContext): void {
  const zh = ctx.language.startsWith('zh');
  const status = document.createElement('pre'); status.style.whiteSpace = 'pre-wrap';
  const info = document.createElement('p');
  info.textContent = zh ? '用户接管或命令超时后自动停止。恢复前请在 Ego 核对页面和未完成操作；恢复不会自动继续观看。' : 'User takeover or uncertain commands stop automation. Check Ego before resuming. Watching stays stopped after resume.';
  ctx.root.append(info, status);
  const buttons: HTMLButtonElement[] = [];
  const show = (value: unknown) => { status.textContent = JSON.stringify(value, null, 2); };
  for (const [method, label] of [
    ['connect', zh ? '连接' : 'Connect'], ['handoff', zh ? '我来操作' : 'Take control'],
    ['resume', zh ? '已核对，交还 bot' : 'Checked: return control'], ['pause', zh ? '暂停观看' : 'Pause watching'],
  ]) {
    const button = document.createElement('button'); button.textContent = label; button.type = 'button'; button.style.marginRight = '12px';
    button.addEventListener('click', async () => {
      buttons.forEach(b => { b.disabled = true; });
      try { show(await ctx.invoke(method)); await ctx.refresh(); }
      catch (error) { status.textContent = String(error); }
      finally { if (!ctx.signal.aborted) buttons.forEach(b => { b.disabled = false; }); }
    }, { signal: ctx.signal });
    buttons.push(button); ctx.root.append(button);
  }
  const refresh = async () => { try { show(await ctx.invoke('status')); } catch (error) { if (!ctx.signal.aborted) status.textContent = String(error); } };
  void refresh(); ctx.interval(() => void refresh(), 3000);
}
