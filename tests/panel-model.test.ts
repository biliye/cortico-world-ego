import { expect, it } from 'vitest';
import { panelView, type EgoPanelStatus } from '../src/webui/panel-model.ts';
const base: EgoPanelStatus = { running: true, connected: false, halted: false, reason: '', spaceName: 'test', watching: null,
  connectionMode: 'auto', transport: 'direct', helperOnline: false, helperDir: 'test', launcherFile: '', canPrepareHelper: true };
it('shows helper setup, without takeover recovery, for administrator rejection before a Space exists', () => {
  const view = panelView({ ...base, code: 'EGO_HELPER_REQUIRED', transport: 'helper' });
  expect(view.title).toBe('需要启动普通权限助手'); expect(view.canResume).toBe(false); expect(view.canHandoff).toBe(false); expect(view.canPause).toBe(false); expect(view.canConnect).toBe(false);
  expect(panelView({ ...base, code: 'EGO_HELPER_REQUIRED', helperOnline: true }).canConnect).toBe(true);
});
it('offers control return only for a real pause and connection retry only for connection failure', () => {
  const view = panelView({ ...base, halted: true, code: 'EGO_TASK_SPACE_USER_IN_CONTROL' });
  expect(view.canResume).toBe(true); expect(view.canConnect).toBe(false);
});
it('shows video controls only while watching and supports English status text', () => {
  expect(panelView({ ...base, connected: true }).canPause).toBe(false);
  expect(panelView({ ...base, connected: true, watching: 'p1' }).canPause).toBe(true);
  expect(panelView({ ...base, connected: true }, false).title).toBe('Browser connected');
});
it('offers explicit recreation for a confirmed missing Space rather than a helper retry or takeover', () => {
  const status = { ...base, spaceId: 3, halted: true, spaceMissing: true, code: 'EGO_TASK_SPACE_NOT_FOUND', transport: 'helper' as const, helperOnline: true };
  expect(panelView(status)).toMatchObject({ title: '浏览空间已失效', canConnect: false, canResume: false, canRecreate: true });
  expect(panelView({ ...status, helperOnline: false }).canRecreate).toBe(false);
  expect(panelView({ ...status, spaceMissing: false }).canRecreate).toBe(false);
  expect(panelView({ ...status, code: 'EGO_TASK_SPACE_NAME_IN_USE' })).toMatchObject({ title: '浏览空间名称已被占用', canResume: false, canRecreate: false });
});
