import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { execute } from '../src/bridge-runtime.mjs';
import { MAX_FILE_BYTES } from '../src/file-transfer.mjs';
import { runInNewContext } from 'node:vm';
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
it('checks playback in the specified Space without capturing or touching player state', async () => {
  const video = { tagName: 'VIDEO', paused: false, ended: false,
    get textTracks() { throw new Error('The playback probe must not load tracks.'); } };
  const select = vi.fn(async () => task);
  vi.stubGlobal('taskSpace', select);
  page.cdp = vi.fn(async (method: string, params: any) => {
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'parent' } } };
    if (method === 'Page.createIsolatedWorld') return { executionContextId: 1 };
    if (method !== 'Runtime.evaluate') throw new Error(`Unexpected CDP call: ${method}`);
    const context = { document: { querySelectorAll: () => [video] } };
    const value = await runInNewContext(params.expression, context);
    expect(context).not.toHaveProperty('__corticoEgoVideo');
    return { result: { value } };
  });
  const playback = [{ page: 'p1', frameId: 'parent' }, { page: 'p2' }];
  expect((await execute({ operation: 'tabs', args: { playback, spaceName: 'dedicated-name' } })).error).toContain('existing Space id');
  expect(select).not.toHaveBeenCalled();
  expect(await execute({ operation: 'tabs', args: { playback, spaceId: 1 } })).toEqual({ spaceId: 1, value: { playing: [true, false] } });
  expect(select).toHaveBeenLastCalledWith(1);
  video.ended = true;
  expect(await execute({ operation: 'tabs', args: { playback, spaceId: 1 } })).toEqual({ spaceId: 1, value: { playing: [false, false] } });
});
it.each([-32000, 'EGO_TASK_PAGE_TIMEOUT'])('isolates a playback error with code %s but still reports loss of control for the Space', async code => {
  const controlError = Object.assign(new Error('user took control'), { code: 'EGO_TASK_SPACE_USER_IN_CONTROL' });
  const failingPage = { cdp: vi.fn().mockRejectedValue(Object.assign(new Error('Frame unavailable'), { code })) };
  task.tabs = async () => [{ label: 'p1' }, { label: 'p2' }];
  task.page = (label: string) => label === 'p1' ? failingPage : page;
  page.cdp = vi.fn(async (method: string) => {
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'parent' } } };
    if (method === 'Page.createIsolatedWorld') return { executionContextId: 1 };
    return { result: { value: { found: true, playing: true } } };
  });
  const args = { spaceId: 1, playback: [{ page: 'p1' }, { page: 'p2' }] };
  expect(await execute({ operation: 'tabs', args })).toEqual({ spaceId: 1, value: { playing: [null, true] } });
  failingPage.cdp.mockRejectedValueOnce(controlError);
  page.cdp.mockClear();
  expect(await execute({ operation: 'tabs', args })).toMatchObject({ code: 'EGO_TASK_SPACE_USER_IN_CONTROL' });
  expect(page.cdp).not.toHaveBeenCalled();
});
it('returns an iframe playback timeout beside the result for a healthy target', async () => {
  vi.useFakeTimers();
  try {
    page.events = async () => [];
    const healthyPage = { cdp: vi.fn(async (method: string) => {
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'healthy' } } };
      if (method === 'Page.createIsolatedWorld') return { executionContextId: 1 };
      return { result: { value: { found: true, playing: true } } };
    }) };
    task.tabs = async () => [{ label: 'p1' }, { label: 'p2' }];
    task.page = (label: string) => label === 'p1' ? page : healthyPage;
    const check = execute({ operation: 'tabs', args: { spaceId: 1, playback: [{ page: 'p1' }, { page: 'p2' }] } });
    await vi.advanceTimersByTimeAsync(1999);
    expect(healthyPage.cdp).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(healthyPage.cdp).toHaveBeenCalled();
    await expect(check).resolves.toEqual({ spaceId: 1, value: { playing: [null, true] } });
    expect(calls.filter(call => call.method === 'Target.detachFromTarget')).toHaveLength(1);
  } finally { vi.useRealTimers(); }
});
it.each([
  { video: true, frameId: undefined, result: true, visited: ['hung-child', 'video-child'] },
  { video: false, frameId: undefined, result: null, visited: ['hung-child', 'video-child'] },
  { video: true, frameId: 'video-child', result: true, visited: ['video-child'] },
])('checks same-page iframes with a timeout and frame hint $frameId, returning $result', async ({ video, frameId, result, visited }) => {
  vi.useFakeTimers();
  try {
    task.cdp = vi.fn(async () => ({ targetInfos: ['hung-child', 'video-child'].map(targetId => ({ targetId, parentId: 'parent' })) }));
    const attached: string[] = [], detached: string[] = [];
    page.cdp = vi.fn(async (method: string, params: any, options: any) => {
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'parent' } } };
      if (method === 'Page.createIsolatedWorld') return { executionContextId: 1 };
      if (method === 'Runtime.evaluate') return { result: { value: { found: false } } };
      if (method === 'Target.attachToTarget') { attached.push(params.targetId); return { sessionId: params.targetId }; }
      if (method === 'Target.detachFromTarget') { detached.push(params.sessionId); return {}; }
      expect(method).toBe('Target.sendMessageToTarget');
      expect(options.timeout).toBeGreaterThan(0);
      expect(options.timeout).toBeLessThanOrEqual(2000);
      if (params.sessionId !== 'hung-child') {
        const message = JSON.parse(params.message);
        const childResult = message.method === 'Page.getFrameTree' ? { frameTree: { frame: { id: 'video-child' } } }
          : message.method === 'Page.createIsolatedWorld' ? { executionContextId: 2 }
          : { result: { value: { found: video, playing: video } } };
        pending.push({ method: 'Target.receivedMessageFromTarget', params: { sessionId: params.sessionId, message: JSON.stringify({ id: message.id, result: childResult }) } });
      }
      return {};
    });
    const check = execute({ operation: 'tabs', args: { spaceId: 1, playback: [{ page: 'p1', frameId }] } });
    await vi.advanceTimersByTimeAsync(2000);
    await expect(check).resolves.toEqual({ spaceId: 1, value: { playing: [result] } });
    expect(attached).toEqual(visited);
    expect(detached).toEqual(visited);
  } finally { vi.useRealTimers(); }
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

it('uses the file input or arms the dynamic chooser before clicking', async () => {
  const transferFile = join(dir, 'photo.png');
  const args = { page: 'p1', selector: '#upload', transferFile, transferTimeoutMs: 3000 };
  page.setInputFiles = vi.fn();
  await execute({ operation: 'upload', args });
  expect(page.setInputFiles).toHaveBeenCalledWith('#upload', [transferFile]);

  const setFiles = vi.fn(() => ({ dialog: { message: 'Confirm' } }));
  page.waitForFileChooser = vi.fn(async () => { calls.push('arm'); return { setFiles }; });
  page.click = vi.fn(async () => { calls.push('click'); });
  expect(await execute({ operation: 'upload', args: { ...args, chooser: true } })).toMatchObject({ value: { dialog: { message: 'Confirm' } } });
  expect(calls).toEqual(['arm', 'click']);
  expect(setFiles).toHaveBeenCalledWith(transferFile);
});

it('arms download before clicking and copies only the completed bounded artifact', async () => {
  const bytes = Buffer.from([0, 255, 127]);
  const fixture = join(dir, 'fixture.zip');
  const transferFile = join(dir, 'download');
  await writeFile(fixture, bytes);
  page.waitForEvent = vi.fn(async () => { calls.push('arm'); return { path: async () => fixture, suggestedFilename: () => 'report.zip' }; });
  page.click = vi.fn(async () => { calls.push('click'); });
  expect(await execute({ operation: 'download', args: { page: 'p1', selector: '#download', transferFile, transferTimeoutMs: 3000 } })).toMatchObject({ value: { name: 'report.zip' } });
  expect(calls).toEqual(['arm', 'click']);
  expect(page.waitForEvent).toHaveBeenCalledWith('download', { timeout: 3000 });
  expect(await readFile(transferFile)).toEqual(bytes);
});

it.each(['readable', 'lost control', 'dialog', 'pending click'])('diagnoses a missing download event with %s', async state => {
  const error = new Error('page.waitForEvent("download") timed out after 25000ms');
  page.waitForEvent = vi.fn(() => new Promise((_, reject) => setImmediate(() => reject(error))));
  page.click = vi.fn(async () => state === 'pending click'
    ? new Promise(() => {})
    : { dialog: state === 'dialog' ? { message: 'Confirm?' } : undefined });
  page.snapshot = vi.fn(async () => 'ready');
  task.waitForControl = vi.fn(async () => {});
  if (state === 'lost control') task.waitForControl.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('user took control'));

  const args = { page: 'p1', selector: '#download', transferFile: join(dir, 'download'), transferTimeoutMs: 43500 };
  const result = await execute({ operation: 'download', args });
  expect(page.waitForEvent).toHaveBeenCalledWith('download', { timeout: 25000 });
  expect(page.click).toHaveBeenCalledOnce();
  expect(result).toMatchObject({ code: 'EGO_DOWNLOAD_START_TIMEOUT', uncertain: state !== 'readable' });
  expect(result.error).toContain('download outcome is unknown');
  if (state === 'readable' || state === 'lost control') {
    expect(task.waitForControl).toHaveBeenCalledTimes(2);
    expect(page.snapshot).toHaveBeenCalledOnce();
  } else {
    expect(task.waitForControl).not.toHaveBeenCalled();
    expect(page.snapshot).not.toHaveBeenCalled();
  }
});

it('bounds direct downloads even when no content length is provided', async () => {
  const bytes = Uint8Array.from([0, 255, 127]);
  let responseBytes = bytes;
  const fixtureFetch = vi.fn(async (_url: URL) => new Response(responseBytes, { headers: { 'content-type': 'image/png' } }));
  page.evaluate = (fn: Function, args: any) => runInNewContext(`(${fn.toString()})(args)`, {
    args, URL, fetch: fixtureFetch, AbortController, document: { baseURI: 'https://example.com/current' }, setTimeout, clearTimeout, btoa,
  });
  const transferFile = join(dir, 'download');
  const args = { page: 'p1', url: '/images/photo.png', transferFile, transferTimeoutMs: 3000 };
  expect(await execute({ operation: 'download', args })).toMatchObject({ value: { name: 'photo.png', mime: 'image/png' } });
  expect(String(fixtureFetch.mock.lastCall?.[0])).toBe('https://example.com/images/photo.png');
  expect(await readFile(transferFile)).toEqual(Buffer.from(bytes));
  responseBytes = new Uint8Array(MAX_FILE_BYTES + 1);
  expect(await execute({ operation: 'download', args })).toMatchObject({ error: 'File exceeds the 8 MiB transfer limit.' });
  expect(await readFile(transferFile)).toEqual(Buffer.from(bytes));
});
it('preserves responsive pending-Promise timeout metadata without claiming the script stopped', async () => {
  page.evaluate = async () => { throw Object.assign(new Error('page.evaluate timed out after 15000ms; evaluation still pending'), {
    code: 'EGO_PAGE_EVALUATION_TIMED_OUT', timeoutMs: 15000, executionStopped: false, pageResponsive: true, mayHaveLateEffects: true,
  }); };
  const result = await execute({ operation: 'evaluate', args: { page: 'p1', expression: 'new Promise(r => setTimeout(r, 20000))' } });
  expect(JSON.parse(JSON.stringify(result))).toMatchObject({ code: 'EGO_PAGE_EVALUATION_TIMED_OUT', uncertain: true,
    evaluation: { page: 'p1', timeoutMs: 15000, executionStopped: false, pageResponsive: true, mayHaveLateEffects: true } });
});
it('keeps unknown evaluation-timeout metadata unknown and conservatively uncertain', async () => {
  page.evaluate = async () => { throw Object.assign(new Error('page evaluation timed out'), { code: 'EGO_PAGE_EVALUATION_TIMED_OUT' }); };
  const result = await execute({ operation: 'evaluate', args: { page: 'p1', expression: 'pending()' } });
  expect(result.uncertain).toBe(true); expect(JSON.parse(JSON.stringify(result)).evaluation).toEqual({ page: 'p1' });
});
it('can read the same managed page after evaluation times out without replaying or taking over', async () => {
  page.evaluate = vi.fn(async () => { throw Object.assign(new Error('still pending'), { code: 'EGO_PAGE_EVALUATION_TIMED_OUT' }); });
  page.snapshot = vi.fn(async () => 'current page snapshot');
  const select = vi.fn(async () => task), takeover = vi.fn(), claim = vi.fn();
  vi.stubGlobal('taskSpace', select); vi.stubGlobal('takeOverTaskSpace', takeover); vi.stubGlobal('claimTaskSpace', claim);
  expect(await execute({ operation: 'evaluate', args: { spaceId: 1, page: 'p1', expression: 'pending()' } })).toMatchObject({ code: 'EGO_PAGE_EVALUATION_TIMED_OUT' });
  expect(await execute({ operation: 'read', args: { spaceId: 1, page: 'p1', fullPage: true } })).toMatchObject({ spaceId: 1, value: 'current page snapshot' });
  expect(select.mock.calls).toEqual([[1], [1]]); expect(page.evaluate).toHaveBeenCalledTimes(1);
  expect(page.snapshot).toHaveBeenCalledWith({ scope: 'full_page' });
  expect(takeover).not.toHaveBeenCalled(); expect(claim).not.toHaveBeenCalled();
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
