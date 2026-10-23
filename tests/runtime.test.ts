import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { execute } from '../src/bridge-runtime.mjs';
let dir: string;
let task: any, page: any, calls: any[], pending: any[];
beforeEach(async () => {
  dir = await mkdtemp(join(process.cwd(), '.test-data-'));
  calls = []; pending = [];
  page = { label: 'p1', targetId: undefined, info: async () => { page.targetId = 'parent'; },
    screenshot: async ({ path }: any) => { await writeFile(path, 'png-bytes'); },
    url: async () => 'https://example.com', close: vi.fn(), events: async () => pending.splice(0),
    cdp: async (method: string, params: any) => {
      calls.push({ method, params });
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'parent' } } };
      if (method === 'Page.createIsolatedWorld') return { executionContextId: 1 };
      if (method === 'Runtime.evaluate') return { result: { value: { found: false } } };
      if (method === 'Target.attachToTarget') return { sessionId: 'child-session' };
      if (method === 'Target.sendMessageToTarget') {
        const message = JSON.parse(params.message);
        const result = message.method === 'Page.getFrameTree' ? { frameTree: { frame: { id: 'owned-child' } } }
          : message.method === 'Page.createIsolatedWorld' ? { executionContextId: 2 }
          : { result: { value: { found: true, time: 2, paused: false, tracks: [], image: { base64: 'anBlZw==', mime: 'image/jpeg' } } } };
        pending.push({ method: 'Target.receivedMessageFromTarget', params: { sessionId: params.sessionId, message: JSON.stringify({ id: message.id, result }) } });
      }
      return {};
    } };
  task = { spaceId: 1, page: () => page, tabs: async () => [{ label: 'p1', openedBy: 'agent' }], cdp: async (method: string, params: any) => {
    calls.push({ method, params });
    if (method === 'Browser.getWindowForTarget') { expect(params.targetId).toBe('parent'); return { windowId: 1, bounds: { windowState: 'minimized' } }; }
    if (method === 'Target.getTargets') return { targetInfos: [{ targetId: 'unrelated-child', parentId: 'someone-elses-page', type: 'iframe' }, { targetId: 'owned-child', parentId: 'parent', type: 'iframe' }] };
    return {};
  } };
  vi.stubGlobal('taskSpace', async () => task);
});
afterEach(async () => { vi.unstubAllGlobals(); if (!dir.startsWith(join(process.cwd(), '.test-data-'))) throw new Error('Unsafe cleanup'); await rm(dir, { recursive: true, force: true }); });
it('resolves the page target before restoring a minimized window, then uses official screenshot', async () => {
  const result = await execute({ operation: 'shot', args: { page: 'p1', restoreMinimized: true, screenshotFile: join(dir, 'shot.png') } });
  expect(result.error).toBeUndefined(); expect(result.value.restoredWindow).toBe(true);
  expect(Buffer.from(result.value.image.base64, 'base64').toString()).toBe('png-bytes');
});
it('leaves window state alone when automatic restoration is disabled', async () => {
  const result = await execute({ operation: 'shot', args: { page: 'p1', restoreMinimized: false, screenshotFile: join(dir, 'shot.png') } });
  expect(result.error).toBeUndefined(); expect(calls).toHaveLength(0);
});
it('attaches only iframe targets descending from the managed page and detaches its session', async () => {
  const result = await execute({ operation: 'video', args: { page: 'p1', action: 'look' } });
  expect(result.value.found).toBe(true); expect(result.value.frameId).toBe('owned-child');
  expect(calls.filter(c => c.method === 'Target.attachToTarget').map(c => c.params.targetId)).toEqual(['owned-child']);
  expect(calls.some(c => c.method === 'Target.detachFromTarget')).toBe(true);
});
it('refuses to close a user-owned tab even when it is managed', async () => {
  task.tabs = async () => [{ label: 'p1', openedBy: 'unknown' }];
  const result = await execute({ operation: 'close', args: { page: 'p1' } });
  expect(result.error).toContain('user-owned'); expect(page.close).not.toHaveBeenCalled();
});
it('returns stable control-stop codes to the World', async () => {
  vi.stubGlobal('taskSpace', async () => { throw Object.assign(new Error('operator control'), { error_code: 'EGO_TASK_SPACE_USER_IN_CONTROL' }); });
  const result = await execute({ operation: 'tabs', args: {} });
  expect(result.code).toBe('EGO_TASK_SPACE_USER_IN_CONTROL');
});
it('observes delegated control without selecting a page, claiming or taking over', async () => {
  const select = vi.fn(async () => task), takeover = vi.fn(), claim = vi.fn();
  vi.stubGlobal('taskSpace', select); vi.stubGlobal('takeOverTaskSpace', takeover); vi.stubGlobal('claimTaskSpace', claim);
  vi.stubGlobal('listTaskSpaces', async () => [{ id: 1, ownership: 'agentDelegatedToUser' }]);
  expect(await execute({ operation: 'control-status', args: { spaceId: 1 } })).toMatchObject({ spaceId: 1, value: { control: 'user' } });
  expect(select).not.toHaveBeenCalled(); expect(takeover).not.toHaveBeenCalled(); expect(claim).not.toHaveBeenCalled();
});
it('confirms returned control using the official bounded control probe on the same id', async () => {
  task.waitForControl = vi.fn(async () => {});
  vi.stubGlobal('listTaskSpaces', async () => [{ id: 1, ownership: 'agent' }]);
  const select = vi.fn(async () => task); vi.stubGlobal('taskSpace', select);
  expect(await execute({ operation: 'control-status', args: { spaceId: 1 } })).toMatchObject({ spaceId: 1, value: { control: 'agent' } });
  expect(select).toHaveBeenCalledWith(1); expect(task.waitForControl).toHaveBeenCalledWith({ interval: 1, timeout: 1 });
  task.waitForControl.mockRejectedValueOnce(Object.assign(new Error('user took control again'), { error_code: 'EGO_TASK_SPACE_USER_IN_CONTROL' }));
  expect(await execute({ operation: 'control-status', args: { spaceId: 1 } })).toMatchObject({ code: 'EGO_TASK_SPACE_USER_IN_CONTROL' });
});
it('never creates a replacement or claims an ended task during a control check', async () => {
  const select = vi.fn(); vi.stubGlobal('taskSpace', select);
  vi.stubGlobal('listTaskSpaces', async () => [{ id: 1, ownership: 'user' }]);
  expect(await execute({ operation: 'control-status', args: { spaceId: 1 } })).toMatchObject({ value: { control: 'inactive' } });
  expect(await execute({ operation: 'control-status', args: { spaceId: 2 } })).toMatchObject({ code: 'EGO_TASK_SPACE_NOT_FOUND', uncertain: false });
  expect((await execute({ operation: 'control-status', args: {} })).error).toContain('existing Space id');
  expect(select).not.toHaveBeenCalled();
});
it('returns a serializable null when page JavaScript returns undefined', async () => {
  page.evaluate = async () => undefined;
  const result = await execute({ operation: 'evaluate', args: { page: 'p1', expression: 'undefined' } });
  expect(JSON.parse(JSON.stringify(result)).value).toBe(null);
});
it('still returns danmaku when the subtitle API fails and obeys the danmaku switch', async () => {
  page.url = async () => 'https://www.bilibili.com/video/BVfixture';
  const evaluate = vi.fn(async (fn: unknown) => {
    if (typeof fn === 'function') throw new Error('Subtitle API denied');
    return { status: 'available', comments: [{ time: 2, text: '弹幕' }] };
  });
  page.evaluate = evaluate;
  const result = await execute({ operation: 'video', args: { page: 'p1', action: 'look' } });
  expect(result.value.subtitleError).toBe('Subtitle API denied'); expect(result.value.danmaku.comments[0].text).toBe('弹幕');
  evaluate.mockClear();
  const off = await execute({ operation: 'video', args: { page: 'p1', action: 'look', danmaku: false } });
  expect(off.value.danmaku).toBeUndefined(); expect(evaluate).toHaveBeenCalledTimes(1);
});
it('does not screenshot or enrich an early video-time poll', async () => {
  page.url = async () => 'https://www.bilibili.com/video/BVfixture'; page.evaluate = vi.fn(); page.screenshot = vi.fn();
  const original = page.cdp;
  page.cdp = (method: string, params: any) => method === 'Runtime.evaluate'
    ? { result: { value: { found: true, time: 3, samplePending: true, image: null } } } : original(method, params);
  const result = await execute({ operation: 'video', args: { page: 'p1', action: 'look', targetTime: 5 } });
  expect(result.value.samplePending).toBe(true); expect(page.screenshot).not.toHaveBeenCalled(); expect(page.evaluate).not.toHaveBeenCalled();
});
it('enriches a late intermediate sample that completed its batch using the actual batch range', async () => {
  page.url = async () => 'https://www.bilibili.com/video/BVfixture'; page.evaluate = vi.fn(async () => ({ subtitles: [] }));
  const original = page.cdp;
  page.cdp = (method: string, params: any) => method === 'Runtime.evaluate'
    ? { result: { value: { found: true, time: 25, batchComplete: true, image: { base64: 'anBlZw==', mime: 'image/jpeg' } } } } : original(method, params);
  const result = await execute({ operation: 'video', args: { page: 'p1', action: 'sample', since: 5, danmaku: false } });
  expect(result.value.bilibili).toEqual({ subtitles: [] });
  expect(page.evaluate).toHaveBeenCalledWith(expect.any(Function), { time: 25, since: 5 });
});
