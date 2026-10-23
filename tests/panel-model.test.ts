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
it('explains automatic recovery while preserving the manual fallback and control boundary', () => {
  const view = panelView({ ...base, spaceId: 3, halted: true, spaceMissing: true, code: 'EGO_TASK_SPACE_NOT_FOUND', autoRecovering: true });
  expect(view).toMatchObject({ title: '正在自动重建浏览空间', canRecreate: true, canResume: false, canConnect: false });
  expect(view.detail).toContain('失败后会延迟重试');
  expect(panelView({ ...base, spaceId: 3, halted: true, spaceMissing: true, code: 'EGO_TASK_SPACE_NOT_FOUND', autoRecovering: true }, false).title).toBe('Automatically recovering browser Space');
});
it('explains automatic control synchronization and read-only timeout recovery', () => {
  expect(panelView({ ...base, halted: true, code: 'EGO_TASK_SPACE_USER_IN_CONTROL', checkingControl: true }).detail).toContain('无需再点一次');
  expect(panelView({ ...base, halted: true, code: 'EGO_COMMAND_TIMEOUT', checkingControl: true }).detail).toContain('只读命令超时');
  expect(panelView({ ...base, halted: true, code: 'UNCERTAIN' }).detail).toContain('未完成操作');
});
it('explains diagnosis-based recovery without treating script completion as confirmed', () => {
  const status = { ...base, halted: true, code: 'EGO_PAGE_EVALUATION_TIMED_OUT', checkingControl: true };
  const view = panelView({ ...status, evaluation: { page: 'p1', executionStopped: false, pageResponsive: true, mayHaveLateEffects: true } });
  expect(view).toMatchObject({ title: '页面脚本求值超时', canResume: true, canConnect: false });
  expect(view.detail).toContain('仍有响应'); expect(view.detail).toContain('ego_wait'); expect(view.detail).toContain('列标签'); expect(view.detail).toContain('ego_read');
  expect(view.detail).toContain('通过后自动恢复'); expect(view.detail).toContain('原脚本结果仍未知');
  expect(panelView({ ...status, evaluation: { pageResponsive: false } }).detail).toContain('页面未响应');
  expect(panelView(status).detail).toContain('尚无页面响应状态');
  expect(panelView({ ...status, checkingControl: false, evaluationRecoveryBlocked: 'EGO_TASK_SPACE_INACTIVE' }).detail).toContain('诊断停止：EGO_TASK_SPACE_INACTIVE');
  expect(panelView({ ...base, connected: true, lastUnknownEvaluation: { page: 'p1' } }).detail).toContain('上次超时脚本结果仍未知');
  expect(panelView({ ...status }, false).detail).toContain('restores tools automatically');
});
