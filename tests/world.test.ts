import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { videoOperation } from '../src/video-page.mjs';
import { EgoWorld, normalizeUrl } from '../src/world.ts';
import { EGO_DEFAULTS } from '../src/config.ts';
import { EGO } from '../src/definition.ts';
import type { BridgeReceipt, EgoBridge } from '../src/bridge.ts';
import type { DeferredEventSpec, EventEnvelope, WorldHost, ToolOutcome } from 'cortico/core/types.ts';
import { nullLogger } from 'cortico/core/util.ts';

class Browser implements EgoBridge {
  calls: Array<{ op: string; args: Record<string, unknown> }> = [];
  next?: BridgeReceipt;
  replies: BridgeReceipt[] = [];
  time = 10;
  ended = false;
  updatedAt = Date.now();
  async run(op: string, args: Record<string, unknown>): Promise<BridgeReceipt> {
    this.calls.push({ op, args });
    if (this.next) { const next = this.next; this.next = undefined; return next; }
    if (this.replies.length) return this.replies.shift()!;
    if (op === 'video') { if (!this.ended) this.time += (Date.now() - this.updatedAt) / 1000; this.updatedAt = Date.now(); const time = this.time;
      const samplePending = typeof args.targetTime === 'number' && time < args.targetTime - 0.02 && !this.ended;
      return { spaceId: 1, value: { found: true, time, playbackRate: 1, source: 'video1', frameId: 'frame1', ended: this.ended, paused: this.ended || args.action === 'pause', samplePending,
      ...(args.action === 'look' && !samplePending ? { capture: 'video-mosaic', frameTimes: [time], image: { base64: Buffer.from('jpeg').toString('base64'), mime: 'image/jpeg' } } : {}) } }; }
    return { spaceId: 1, value: op === 'read' ? 'abcdefghij' : { page: 'p1', op } };
  }
}
let dir: string, world: EgoWorld, browser: Browser;
let events: EventEnvelope[], deferred: DeferredEventSpec[];
let cfg: typeof EGO_DEFAULTS;
function host(): WorldHost {
  return { log: nullLogger(), pushEvent: async (e: any) => { events.push(e); return e; }, pushDeferred: (e: DeferredEventSpec) => { deferred.push(e); } } as unknown as WorldHost;
}
async function call(name: string, args: Record<string, unknown> = {}): Promise<ToolOutcome> {
  const value = await world.tools().find(t => t.name === `ego_${name}`)!.handler(args, { role: 'test', log: nullLogger() });
  return typeof value === 'string' ? { text: value } : value;
}
beforeEach(async () => {
  dir = await mkdtemp(join(process.cwd(), '.test-data-'));
  events = []; deferred = []; browser = new Browser(); cfg = structuredClone(EGO_DEFAULTS);
  world = new EgoWorld({ cfg, dataDir: dir, botDir: dir, timezone: 'Asia/Shanghai', bridge: browser });
  await world.start(host());
});

describe('per-watch video-time sampling', () => {
  async function advance(ms: number) {
    while (ms > 0) { const step = Math.min(ms, 1000); await vi.advanceTimersByTimeAsync(step); await (world as any).queue; ms -= step; }
  }
  function videoFixture(rate = 1) {
    let updatedAt = Date.now();
    const state = { stalled: false };
    const video = { tagName: 'VIDEO', currentSrc: 'video1', currentTime: 0, readyState: 4, videoWidth: 640, videoHeight: 360,
      duration: 600, paused: true, ended: false, playbackRate: rate, textTracks: [],
      play() { this.paused = false; }, pause() { this.paused = true; } };
    const operation = runInNewContext(`(${videoOperation.toString()})`, { Date, Image: class { async decode() {} }, document: {
      querySelectorAll: () => [video], createElement: () => ({ getContext: () => ({ drawImage() {}, fillRect() {}, fillText() {} }),
        toDataURL: () => 'data:image/jpeg;base64,anBlZw==' }),
    } });
    browser.run = async (op, args) => {
      browser.calls.push({ op, args });
      if (!video.paused && !state.stalled) video.currentTime += (Date.now() - updatedAt) / 1000 * video.playbackRate;
      updatedAt = Date.now();
      return { value: { ...await operation(args), frameId: 'frame1' } };
    };
    return { video, state };
  }
  async function batch(index: number) {
    const rendered = await deferred[index]!.render();
    if (!rendered || typeof rendered === 'string') throw new Error('Missing scene');
    return JSON.parse(rendered.text.slice(rendered.text.indexOf('\n', rendered.text.indexOf('totalChars=')) + 1));
  }
  it('tunes at the next batch without losing queued mosaics or the previous tail frame', async () => {
    vi.useFakeTimers(); videoFixture();
    await call('video', { page: 'p1', action: 'watch', windowSec: 20, frameIntervalSec: 10 });
    await advance(10000);
    const tune = await call('video', { page: 'p1', action: 'tune', windowSec: 10, frameIntervalSec: 5 });
    expect(tune.failed).toBeUndefined(); expect(tune.text).toContain('"appliesAtBatch":2');
    expect(world.status().sampling).toMatchObject({ batch: 1, current: { windowSec: 20 }, pending: { windowSec: 10 } });
    await advance(10000); await advance(10000);
    expect(deferred).toHaveLength(2);
    const first = await batch(0), second = await batch(1);
    expect(first.frameTimes).toEqual([0, 10, 20]); expect(second.frameTimes).toEqual([20, 25, 30]);
    expect(first.observation).toMatchObject({ batch: 1, windowSec: 20, plannedFrames: 3, maxActualGapSec: 10, actualVideoSpanSec: 20 });
    expect(second.observation).toMatchObject({ batch: 2, windowSec: 10, plannedFrames: 3 });
    expect(cfg).toEqual(EGO_DEFAULTS);
    await call('video', { page: 'p1', action: 'watch' });
    expect(world.status().sampling?.current).toEqual({ windowSec: 15, frameIntervalSec: 5, plannedFrames: 4 });
  });
  it('freezes defaults and frame size until the batch boundary, then applies hot configuration', async () => {
    vi.useFakeTimers(); videoFixture(); await call('video', { page: 'p1', action: 'watch' });
    await advance(5000); cfg.video.intervalMs = 20000; cfg.video.maxFrames = 3; cfg.video.frameWidth = 320;
    expect(world.status().sampling).toMatchObject({ current: { windowSec: 15, plannedFrames: 4 }, pending: { windowSec: 20, plannedFrames: 3 } });
    await advance(10000); await advance(20000);
    expect((await batch(0)).frameTimes).toEqual([0, 5, 10, 15]); expect((await batch(1)).frameTimes).toEqual([15, 25, 35]);
    const captures = browser.calls.filter(c => ['sample', 'look'].includes(String(c.args.action)));
    expect(captures.filter(c => Number(c.args.since ?? 0) < 15).every(c => c.args.frameWidth === 640)).toBe(true);
    expect(captures.filter(c => Number(c.args.since ?? 0) >= 15).every(c => c.args.frameWidth === 320)).toBe(true);
  });
  it('keeps a watch override ahead of hot defaults and preserves collection after invalid requests', async () => {
    vi.useFakeTimers(); videoFixture(); await call('video', { page: 'p1', action: 'watch', windowSec: 20, frameIntervalSec: 10 });
    cfg.video.intervalMs = 10000; cfg.video.maxFrames = 9;
    const count = browser.calls.length;
    for (const args of [
      { page: 'p1', action: 'watch', windowSec: 2, frameIntervalSec: 1 },
      { page: 'p1', action: 'tune', windowSec: 20, frameIntervalSec: 1 },
      { page: 'p2', action: 'tune', windowSec: 20, frameIntervalSec: 10 },
      { page: 'p1', action: 'tune', windowSec: 20 },
    ]) expect((await call('video', args)).failed).toBe(true);
    expect(browser.calls).toHaveLength(count);
    await advance(40000); expect(deferred).toHaveLength(2);
    expect((await batch(0)).frameTimes).toEqual([0, 10, 20]); expect((await batch(1)).frameTimes).toEqual([20, 30, 40]);
    await call('video', { page: 'p1', action: 'pause' });
    expect((await call('video', { page: 'p1', action: 'tune', windowSec: 20, frameIntervalSec: 10 })).failed).toBe(true);
  });
  it('uses video seconds at double speed and includes a shorter final interval', async () => {
    vi.useFakeTimers(); videoFixture(2);
    await call('video', { page: 'p1', action: 'watch', windowSec: 20, frameIntervalSec: 6 });
    await advance(9999); expect(deferred).toHaveLength(0);
    await advance(1); expect((await batch(0)).frameTimes).toEqual([0, 6, 12, 18, 20]);
  });
  it('does not fill a stalled batch with duplicate timestamps and reports gaps when targets are missed', async () => {
    vi.useFakeTimers(); const { state, video } = videoFixture();
    await call('video', { page: 'p1', action: 'watch', windowSec: 10, frameIntervalSec: 2 });
    state.stalled = true; await advance(6000); expect(deferred).toHaveLength(0);
    expect(browser.calls.filter(c => c.args.action === 'sample').length).toBeGreaterThan(1);
    // A delayed observation sees the playhead past several targets; there is no historical reconstruction.
    state.stalled = false; video.currentTime = 6; await advance(4000);
    const result = await batch(0);
    expect(result.frameTimes).toEqual([0, 8, 10]);
    expect(result.frameCount).toBe(3); expect(result.observation).toMatchObject({ plannedFrames: 6, maxActualGapSec: 8 });
  });
});
afterEach(async () => { vi.useRealTimers(); await world.stop(); if (!dir.startsWith(join(process.cwd(), '.test-data-'))) throw new Error('Unsafe test cleanup path'); await rm(dir, { recursive: true, force: true }); });

describe('contract and tools', () => {
  it('matches self-description and declares all actually emitted events', () => {
    expect(world.tools().map(t => t.name)).toEqual(EGO.describe!.tools.map(t => t.name));
    expect(events[0]).toMatchObject({ type: 'ego.state', origin: 'internal' });
    expect(EGO.describe!.events.map(e => e.type)).toEqual(['ego.state', 'ego.video.state', 'ego.video.scene']);
    expect(EGO.defaults().enabled).toBe(false);
  });
  it('does not share nested config defaults', () => { const cfg1 = EGO.defaults(); cfg1.video.maxFrames = 9; expect(EGO.defaults().video.maxFrames).toBe(4); });
  it('pages long snapshots without losing the continuation position', async () => {
    const result = await call('read', { page: 'p1', offset: 2, maxChars: 100 });
    expect(result.text).toContain('offset=2 end=10 totalChars=10 truncated=false\ncdefghij');
  });
  it('normalizes BV ids and rejects non-web schemes', async () => {
    expect(normalizeUrl('BV1xx411c7mD')).toBe('https://www.bilibili.com/video/BV1xx411c7mD');
    expect((await call('open', { url: 'javascript:alert(1)' })).failed).toBe(true);
    expect((await call('open', { url: 'file:///private' })).failed).toBe(true);
    expect((await call('open', { url: 'https://u:p@example.com' })).failed).toBe(true);
    expect(browser.calls.filter(c => c.op === 'open')).toHaveLength(0);
  });
  it('requires finite seek seconds before talking to the browser', async () => {
    expect((await call('video', { page: 'p1', action: 'seek' })).failed).toBe(true);
    expect((await call('video', { page: 'p1', action: 'seek', time: NaN })).failed).toBe(true);
    expect((await call('video', { page: 'p1', action: 'seek', time: -1 })).failed).toBe(true);
    expect(browser.calls.filter(c => c.op === 'video')).toHaveLength(0);
  });
  it('allows numeric scrolling and empty fill text', async () => {
    expect((await call('scroll', { page: 'p1', deltaY: 300 })).failed).toBeUndefined();
    expect((await call('fill', { page: 'p1', selector: '#query', text: '' })).failed).toBeUndefined();
  });
});

describe('control boundaries', () => {
  const evaluationTimeout = () => ({ code: 'EGO_PAGE_EVALUATION_TIMED_OUT', error: 'page.evaluate timed out after 15000ms; evaluation still pending', uncertain: true,
    evaluation: { page: 'p1', timeoutMs: 15000, executionStopped: false, pageResponsive: true, mayHaveLateEffects: true } });
  it('allows tab diagnosis after the reported 20-second Promise timeout while keeping actions paused', async () => {
    vi.useFakeTimers(); browser.next = evaluationTimeout();
    const result = await call('evaluate', { page: 'p1', expression: 'new Promise(r => setTimeout(r, 20000))' });
    expect(result.failed).toBe(true); expect(result.text).toContain('EGO_PAGE_EVALUATION_TIMED_OUT');
    const beforeTabs = browser.calls.length, tabs = await call('tabs');
    expect(tabs.failed).toBeUndefined(); expect(tabs.text).toContain('Read-only diagnosis only'); expect(browser.calls).toHaveLength(beforeTabs + 1);
    expect(world.status()).toMatchObject({ halted: true, uncertain: true, checkingControl: false, evaluation: { executionStopped: false, pageResponsive: true } });
    expect((await call('click', { page: 'p1', selector: '@1' })).failed).toBe(true);
    expect((await call('evaluate', { page: 'p1', expression: 'submit()' })).failed).toBe(true);
    const count = browser.calls.length; await vi.advanceTimersByTimeAsync(60000); await (world as any).queue; expect(browser.calls).toHaveLength(count);
    await world.stop(); await world.start(host());
    expect(world.status()).toMatchObject({ halted: true, evaluation: { timeoutMs: 15000, pageResponsive: true } });
    expect((await call('tabs')).failed).toBeUndefined();
    await world.webUi().invoke!('control', 'resume', []); expect(world.status()).toMatchObject({ halted: false, evaluation: undefined });
  });
  it.each(['EGO_HELPER_UNAVAILABLE', 'EGO_TASK_SPACE_USER_IN_CONTROL', 'EGO_TASK_SPACE_NOT_FOUND', 'EGO_COMMAND_TIMEOUT'])('keeps the original evaluation stop if a diagnostic returns %s', async (code: string) => {
    browser.next = evaluationTimeout(); await call('evaluate', { page: 'p1', expression: 'pending()' });
    browser.next = { error: code, code, uncertain: code === 'EGO_COMMAND_TIMEOUT' };
    expect((await call('tabs')).failed).toBe(true);
    expect(world.status()).toMatchObject({ halted: true, code: 'EGO_PAGE_EVALUATION_TIMED_OUT', uncertain: true, checkingControl: false });
    expect((await call('click', { page: 'p1', selector: '@1' })).failed).toBe(true);
  });
  it('keeps tab diagnostics blocked during ordinary takeover or an unknown uncertain command', async () => {
    await call('handoff'); let count = browser.calls.length;
    expect((await call('tabs')).failed).toBe(true); expect(browser.calls).toHaveLength(count);
    await world.webUi().invoke!('control', 'resume', []); browser.next = { error: 'unknown late effects', uncertain: true };
    await call('evaluate', { page: 'p1', expression: 'pending()' }); count = browser.calls.length;
    expect((await call('tabs')).failed).toBe(true); expect(browser.calls).toHaveLength(count);
  });
  async function controlTick(ms: number) { await vi.advanceTimersByTimeAsync(ms); await (world as any).queue; }
  it('synchronizes Ego return without a second panel click and never replays work or restarts watching', async () => {
    vi.useFakeTimers();
    await call('video', { page: 'p1', action: 'watch' }); await call('handoff');
    const count = browser.calls.length;
    browser.next = { spaceId: 1, value: { control: 'user' } }; await controlTick(2000);
    expect(world.status()).toMatchObject({ halted: true, checkingControl: true, watching: null });
    browser.next = { spaceId: 1, value: { control: 'agent' } }; await controlTick(4000);
    expect(world.status()).toMatchObject({ halted: false, connected: true, checkingControl: false, watching: null });
    expect(browser.calls.slice(count)).toEqual([{ op: 'control-status', args: { spaceId: 1 } }, { op: 'control-status', args: { spaceId: 1 } }]);
    expect(JSON.parse(await readFile(join(dir, 'ego', 'space.json'), 'utf8')).halted).toBe(false);
    expect(events.at(-1)?.text).toContain('failed operation was not replayed');
    await controlTick(60000); expect(browser.calls).toHaveLength(count + 2);
  });
  it.each(['read', 'tabs'])('automatically checks %s timeouts without replaying the failed observation', async (op: string) => {
    vi.useFakeTimers(); browser.next = { error: 'timed out', code: 'EGO_COMMAND_TIMEOUT', uncertain: true };
    expect((await call(op, { page: 'p1' })).failed).toBe(true);
    expect(world.status()).toMatchObject({ halted: true, checkingControl: true });
    const count = browser.calls.length;
    browser.next = { spaceId: 1, value: { control: 'agent' } }; await controlTick(2000);
    expect(world.status()).toMatchObject({ halted: false, connected: true });
    expect(browser.calls.slice(count).map(c => c.op)).toEqual(['control-status']);
  });
  it.each(['click', 'fill', 'press', 'evaluate', 'video'])('keeps uncertain %s timeouts stopped across restart', async (op: string) => {
    vi.useFakeTimers(); browser.next = { error: 'timed out', code: 'EGO_COMMAND_TIMEOUT', uncertain: true };
    await call(op, { page: 'p1', selector: '@1', text: 'x', key: 'Enter', expression: 'submit()', action: 'inspect' });
    const count = browser.calls.length; await controlTick(120000); await world.stop(); await world.start(host()); await controlTick(120000);
    expect(world.status()).toMatchObject({ halted: true, checkingControl: false }); expect(browser.calls).toHaveLength(count);
  });
  it('resumes control checking after restart, but preserves the stop while the helper is unavailable', async () => {
    vi.useFakeTimers(); await call('handoff'); await world.stop(); await world.start(host());
    browser.next = { error: 'offline', code: 'EGO_HELPER_UNAVAILABLE' }; await controlTick(2000);
    expect(world.status()).toMatchObject({ halted: true, code: 'EGO_TASK_SPACE_USER_IN_CONTROL' });
    browser.next = { spaceId: 1, value: { control: 'agent' } }; await controlTick(4000);
    expect(world.status()).toMatchObject({ halted: false, connected: true });
  });
  it.each(['EGO_TASK_SPACE_INACTIVE', 'EGO_TASK_SPACE_NOT_FOUND', 'EGO_TASK_HOST_DISCONNECTED'])('never reconnects or replaces a Space when control checking returns %s', async (code: string) => {
    vi.useFakeTimers(); await call('handoff'); const count = browser.calls.length;
    browser.next = { error: code, code }; await controlTick(2000); await controlTick(120000);
    expect(world.status()).toMatchObject({ halted: true, code, checkingControl: false, autoRecovering: false });
    expect(browser.calls.slice(count).map(c => c.op)).toEqual(['control-status']);
  });
  it('does not resume on ambiguous, mismatched or uncertain control observations', async () => {
    vi.useFakeTimers(); await call('handoff');
    for (const [delay, receipt] of [
      [2000, { spaceId: 2, value: { control: 'agent' } }],
      [4000, { spaceId: 1, value: {} }],
      [8000, { spaceId: 1, uncertain: true, value: { control: 'agent' } }],
    ] as const) { browser.next = receipt; await controlTick(delay); expect(world.status().halted).toBe(true); }
    await world.stop(); const count = browser.calls.length; await controlTick(120000); expect(browser.calls).toHaveLength(count);
  });
  it('cancels control checks when the operator stops the helper', async () => {
    vi.useFakeTimers(); await call('handoff'); vi.spyOn((world as any).helper, 'stop').mockResolvedValue(undefined);
    await world.webUi().invoke!('control', 'stop-helper', []); const count = browser.calls.length;
    await controlTick(120000); expect(browser.calls).toHaveLength(count);
  });
  it('keeps a user-control receipt with uncertain effects stopped without probing', async () => {
    vi.useFakeTimers(); browser.next = { error: 'control changed after an uncertain action', code: 'EGO_TASK_SPACE_USER_IN_CONTROL', uncertain: true };
    await call('tabs'); const count = browser.calls.length; await controlTick(120000);
    expect(world.status().checkingControl).toBe(false); expect(browser.calls).toHaveLength(count);
  });
  it('does not infer a safe return from a legacy control stop that did not persist uncertainty', async () => {
    vi.useFakeTimers(); await world.stop();
    await writeFile(join(dir, 'ego', 'space.json'), JSON.stringify({ spaceName: world.status().spaceName, spaceId: 1, halted: true,
      code: 'EGO_TASK_SPACE_USER_IN_CONTROL', reason: 'A previous operation might still finish.' }));
    const count = browser.calls.length; await world.start(host()); await controlTick(120000);
    expect(world.status()).toMatchObject({ halted: true, uncertain: true, checkingControl: false }); expect(browser.calls).toHaveLength(count);
  });
  it('automatically reconnects a stale id by its dedicated name and clears the old helper reason', async () => {
    (world as any).saved = { spaceId: 3, halted: false, reason: 'The operator stopped the ordinary-permission helper.', code: 'EGO_HELPER_UNAVAILABLE' };
    browser.next = { error: 'task space not found: 3', uncertain: false };
    const count = browser.calls.length;
    await world.webUi().invoke!('control', 'connect', []);
    expect(world.status()).toMatchObject({ spaceId: 1, connected: true, halted: false, spaceMissing: false, reason: '', autoRecovering: false });
    expect(browser.calls).toHaveLength(count + 2);
    expect(browser.calls.at(-1)).toMatchObject({ op: 'connect', args: { spaceName: world.status().spaceName, spaceId: undefined } });
    expect(events.at(-1)?.text).toContain('Automatically re-established');
  });
  it('recovers a confirmed missing Space without replaying the failed click and persists the new id', async () => {
    const previous = browser.calls.length;
    browser.replies = [{ error: 'task space not found: 1', uncertain: false }, { spaceId: 7, value: { pages: [] } }];
    const result = await call('click', { page: 'p1', selector: '@1' });
    expect(result.failed).toBe(true); expect(result.text).toContain('automatically re-established');
    expect(result.text).toContain('failed operation was not replayed'); expect(result.text).toContain('Old page labels and refs are invalid');
    expect(browser.calls.slice(previous).map(c => c.op)).toEqual(['click', 'connect']);
    expect(browser.calls.at(-1)).toMatchObject({ op: 'connect', args: { spaceName: world.status().spaceName, spaceId: undefined } });
    expect(world.status()).toMatchObject({ spaceId: 7, connected: true, halted: false, spaceMissing: false, watching: null });
    expect(JSON.parse(await readFile(join(dir, 'ego', 'space.json'), 'utf8'))).toMatchObject({ spaceId: 7, halted: false, spaceMissing: false });
    expect(world.tools().some(t => /recreate|resume/.test(t.name))).toBe(false);
    await expect(world.webUi().invoke!('control', 'recreate-space', [])).rejects.toThrow('只有确认');
  });
  it('never recreates after user takeover or uncertain effects, including an uncertain NOT_FOUND receipt', async () => {
    await call('handoff'); const count = browser.calls.length;
    await expect(world.webUi().invoke!('control', 'recreate-space', [])).rejects.toThrow('只有确认');
    expect(browser.calls).toHaveLength(count);
    await world.webUi().invoke!('control', 'resume', []);
    browser.next = { error: 'task space not found: 1', code: 'EGO_TASK_SPACE_NOT_FOUND', uncertain: true }; await call('tabs');
    const after = browser.calls.length;
    expect(world.status().spaceMissing).toBe(false);
    await expect(world.webUi().invoke!('control', 'recreate-space', [])).rejects.toThrow('只有确认');
    expect(browser.calls).toHaveLength(after);
  });
  it('backs off automatic recovery while its helper is offline, then recovers without a panel action', async () => {
    vi.useFakeTimers();
    browser.replies = [{ error: 'task space not found: 1' }, { error: 'helper offline', code: 'EGO_HELPER_UNAVAILABLE' }];
    expect((await call('tabs')).text).toContain('Automatic Space recovery failed');
    expect(world.status()).toMatchObject({ spaceId: 1, code: 'EGO_TASK_SPACE_NOT_FOUND', spaceMissing: true, halted: true, autoRecovering: true });
    const count = browser.calls.length;
    browser.next = { error: 'helper still offline', code: 'EGO_HELPER_UNAVAILABLE' };
    await vi.advanceTimersByTimeAsync(4999); await (world as any).queue; expect(browser.calls).toHaveLength(count);
    await vi.advanceTimersByTimeAsync(1); await (world as any).queue; expect(browser.calls).toHaveLength(count + 1);
    expect(world.status().reason).toBe('EGO_TASK_SPACE_NOT_FOUND: task space not found: 1\nhelper still offline');
    browser.next = { spaceId: 8, value: { pages: [] } };
    await vi.advanceTimersByTimeAsync(9999); await (world as any).queue; expect(browser.calls).toHaveLength(count + 1);
    await vi.advanceTimersByTimeAsync(1); await (world as any).queue;
    expect(world.status()).toMatchObject({ spaceId: 8, connected: true, halted: false, autoRecovering: false });
    await vi.advanceTimersByTimeAsync(120000); expect(browser.calls).toHaveLength(count + 2);
  });
  it('keeps the manual recovery fallback but refuses to claim an occupied name', async () => {
    vi.useFakeTimers();
    browser.replies = [{ error: 'task space not found: 1' }, { error: 'helper offline', code: 'EGO_HELPER_UNAVAILABLE' }];
    await call('tabs');
    browser.next = { error: 'name belongs to the operator', code: 'EGO_TASK_SPACE_NAME_IN_USE', uncertain: false };
    await expect(world.webUi().invoke!('control', 'recreate-space', [])).rejects.toThrow('NAME_IN_USE');
    expect(world.status()).toMatchObject({ spaceId: 1, code: 'EGO_TASK_SPACE_NAME_IN_USE', halted: true, spaceMissing: false });
    expect(browser.calls.at(-1)?.op).toBe('connect');
    const count = browser.calls.length;
    await vi.advanceTimersByTimeAsync(120000); await (world as any).queue; await call('tabs');
    expect(browser.calls).toHaveLength(count);
  });
  it('stops pending recovery if establishing the replacement has uncertain effects', async () => {
    vi.useFakeTimers();
    browser.replies = [{ error: 'task space not found: 1' }, { spaceId: 9, error: 'connection interrupted', uncertain: true }];
    await call('tabs');
    expect(world.status()).toMatchObject({ spaceId: 1, halted: true, spaceMissing: false, autoRecovering: false, code: 'UNCERTAIN' });
    const count = browser.calls.length;
    await vi.advanceTimersByTimeAsync(120000); await (world as any).queue;
    expect((await call('tabs')).text).toContain('operator must resume'); expect(browser.calls).toHaveLength(count);
  });
  it('caps retry backoff at 60 seconds instead of looping on every tool call', async () => {
    vi.useFakeTimers();
    const offline = { error: 'helper offline', code: 'EGO_HELPER_UNAVAILABLE' };
    browser.replies = [{ error: 'task space not found: 1' }, ...Array.from({ length: 8 }, () => offline)];
    await call('tabs');
    let count = browser.calls.length;
    for (const delay of [5000, 10000, 20000, 40000, 60000, 60000]) {
      await call('tabs'); expect(browser.calls).toHaveLength(count);
      await vi.advanceTimersByTimeAsync(delay - 1); await (world as any).queue; expect(browser.calls).toHaveLength(count);
      await vi.advanceTimersByTimeAsync(1); await (world as any).queue; expect(browser.calls).toHaveLength(++count);
    }
  });
  it('does not start recovery after the World is stopped during a missing-Space response', async () => {
    vi.useFakeTimers();
    let reply!: (value: BridgeReceipt) => void, started!: () => void;
    const pending = new Promise<BridgeReceipt>(resolve => { reply = resolve; });
    const invoked = new Promise<void>(resolve => { started = resolve; });
    browser.run = async (op, args) => { browser.calls.push({ op, args }); started(); return pending; };
    const result = call('tabs'); await invoked;
    const stopping = world.stop(); reply({ error: 'task space not found: 1' });
    expect((await result).failed).toBe(true); await stopping;
    const count = browser.calls.length;
    await vi.advanceTimersByTimeAsync(120000); expect(browser.calls).toHaveLength(count);
    expect(world.status()).toMatchObject({ running: false, connected: false, autoRecovering: false });
  });
  it('recovers a missing id discovered during startup, and migrates the old persisted missing stop', async () => {
    await world.stop();
    browser.replies = [{ error: 'task space not found: 1' }, { spaceId: 7, value: { pages: [] } }];
    await world.start(host()); expect(world.status()).toMatchObject({ spaceId: 7, connected: true, halted: false });
    await world.stop();
    await writeFile(join(dir, 'ego', 'space.json'), JSON.stringify({ spaceName: world.status().spaceName, spaceId: 3,
      halted: true, spaceMissing: true, code: 'EGO_TASK_SPACE_NOT_FOUND', reason: 'EGO_TASK_SPACE_NOT_FOUND: task space not found: 3' }));
    const count = browser.calls.length;
    await world.start(host());
    expect(browser.calls).toHaveLength(count + 1);
    expect(browser.calls.at(-1)).toMatchObject({ op: 'connect', args: { spaceId: undefined } });
    expect(world.status()).toMatchObject({ connected: true, halted: false, spaceMissing: false });
  });
  it.each(['EGO_TASK_SPACE_INACTIVE', 'EGO_TASK_HOST_DISCONNECTED', 'EGO_TASK_SPACE_NAME_IN_USE'])('never recreates for %s', async (code: string) => {
    vi.useFakeTimers(); browser.next = { error: code, code }; await call('tabs');
    const count = browser.calls.length;
    await vi.advanceTimersByTimeAsync(120000); await (world as any).queue;
    await world.stop(); await world.start(host()); await call('tabs');
    expect(browser.calls).toHaveLength(count); expect(world.status().autoRecovering).toBe(false);
  });
  it('cancels recovery retries when the World or helper is explicitly stopped', async () => {
    vi.useFakeTimers();
    browser.replies = [{ error: 'task space not found: 1' }, { error: 'helper offline', code: 'EGO_HELPER_UNAVAILABLE' }];
    await call('tabs');
    vi.spyOn((world as any).helper, 'stop').mockResolvedValue(undefined);
    await world.webUi().invoke!('control', 'stop-helper', []);
    let count = browser.calls.length;
    await vi.advanceTimersByTimeAsync(120000); await (world as any).queue; expect(browser.calls).toHaveLength(count);
    browser.next = { error: 'helper offline', code: 'EGO_HELPER_UNAVAILABLE' };
    await world.stop(); await world.start(host()); expect(world.status().autoRecovering).toBe(true);
    await world.stop(); count = browser.calls.length;
    await vi.advanceTimersByTimeAsync(120000); expect(browser.calls).toHaveLength(count);
  });
  it('withdraws old scenes and stops watching when a Space is automatically re-established', async () => {
    vi.useFakeTimers(); await call('video', { page: 'p1', action: 'watch' });
    for (let i = 0; i < 15; i++) { await vi.advanceTimersByTimeAsync(1000); await (world as any).queue; }
    expect(deferred.length).toBeGreaterThan(0);
    browser.replies = [{ error: 'task space not found: 1' }, { spaceId: 7, value: { pages: [] } }];
    await call('tabs'); expect(world.status()).toMatchObject({ spaceId: 7, connected: true, watching: null });
    for (const scene of deferred) expect(await scene.render()).toBeNull();
    const count = browser.calls.length;
    await vi.advanceTimersByTimeAsync(120000); await (world as any).queue; expect(browser.calls).toHaveLength(count);
  });
  it('lets the operator reconnect after administrator rejection without a nonexistent Space id', async () => {
    browser.next = { error: 'ego lite closed the connection because ego-browser is running as administrator', uncertain: true };
    await call('tabs'); expect(world.status()).toMatchObject({ halted: false, connected: false, code: 'EGO_CLIENT_ELEVATED' });
    await world.webUi().invoke!('control', 'connect', []);
    expect(world.status()).toMatchObject({ halted: false, connected: true, reason: '' });
  });
  it('migrates a 0.1.0 elevated-client UNCERTAIN stop and connects again', async () => {
    await world.stop(); await mkdir(join(dir, 'ego'), { recursive: true });
    await writeFile(join(dir, 'ego', 'space.json'), JSON.stringify({ spaceName: world.status().spaceName, halted: true,
      reason: 'UNCERTAIN: ego-browser exited 9: ego lite closed the connection because ego-browser is running as administrator' }));
    await world.start(host()); expect(world.status()).toMatchObject({ halted: false, connected: true });
  });
  it('does not discard a user takeover stop when its resume fails because the helper is offline', async () => {
    await call('handoff'); browser.next = { error: 'helper offline', code: 'EGO_HELPER_UNAVAILABLE', uncertain: false };
    await expect(world.webUi().invoke!('control', 'resume', [])).rejects.toThrow('helper offline');
    expect(world.status()).toMatchObject({ halted: true, code: 'EGO_TASK_SPACE_USER_IN_CONTROL' });
    const count = browser.calls.length; await world.stop(); await world.start(host()); expect(browser.calls.length).toBe(count);
  });
  it('stops all subsequent calls after user takeover', async () => {
    browser.next = { error: 'operator took over', code: 'EGO_TASK_SPACE_USER_IN_CONTROL' };
    expect((await call('tabs')).failed).toBe(true);
    const count = browser.calls.length;
    expect((await call('open', { url: 'example.com' })).failed).toBe(true);
    expect(browser.calls.length).toBe(count);
  });
  it('persists a hard stop across World restart', async () => {
    browser.next = { error: 'browser effects may still finish', uncertain: true };
    await call('tabs'); await world.stop();
    const count = browser.calls.length;
    await world.start(host()); await call('tabs');
    expect(browser.calls.length).toBe(count);
  });
  it('permits only the operator panel to resume, without restarting watching', async () => {
    await call('handoff');
    expect(world.tools().some(t => t.name === 'ego_resume')).toBe(false);
    await world.webUi().invoke!('control', 'resume', []);
    expect((await call('tabs')).failed).toBeUndefined();
    expect(world.status().watching).toBe(null);
  });
  it('does not mistake an ordinary navigation error for a disconnected browser', async () => {
    browser.next = { error: 'page=p2: net::ERR_NAME_NOT_RESOLVED' };
    const result = await call('open', { url: 'unreachable.example' });
    expect(result.text).toContain('page=p2'); expect(result.failed).toBe(true);
    expect((await call('tabs')).failed).toBeUndefined();
  });
});

describe('host-only waiting', () => {
  it('waits twenty seconds without executing browser code or changing control', async () => {
    vi.useFakeTimers(); const count = browser.calls.length;
    const waiting = call('wait', { seconds: 20 }); let finished = false; void waiting.then(() => { finished = true; });
    await vi.advanceTimersByTimeAsync(15000); expect(finished).toBe(false);
    await vi.advanceTimersByTimeAsync(5000); const result = await waiting;
    expect(result.failed).toBeUndefined(); expect(result.text).toContain('"waitedSeconds":20');
    expect(browser.calls).toHaveLength(count); expect(world.status().halted).toBe(false);
  });
  it('does not block the browser queue or video sampling while waiting', async () => {
    vi.useFakeTimers(); await call('video', { page: 'p1', action: 'watch' }); const waiting = call('wait', { seconds: 20 });
    expect((await call('tabs')).failed).toBeUndefined();
    for (let i = 0; i < 20; i++) { await vi.advanceTimersByTimeAsync(1000); await (world as any).queue; }
    expect((await waiting).failed).toBeUndefined(); expect(deferred.length).toBeGreaterThan(0); expect(world.status().watching).toBe('p1');
  });
  it('cancels a host wait immediately when the World stops', async () => {
    vi.useFakeTimers(); const waiting = call('wait', { seconds: 60 }); await world.stop();
    expect((await waiting).failed).toBe(true); expect(vi.getTimerCount()).toBe(0);
  });
  it('honors caller cancellation without marking a browser operation uncertain', async () => {
    vi.useFakeTimers(); const controller = new AbortController(); const count = browser.calls.length;
    const waiting = world.tools().find(t => t.name === 'ego_wait')!.handler({ seconds: 20 }, { role: 'test', log: nullLogger(), signal: controller.signal });
    controller.abort(); expect(await waiting).toMatchObject({ failed: true }); expect(world.status().halted).toBe(false); expect(browser.calls).toHaveLength(count);
  });
  it('never clears an evaluation pause just because a host wait elapsed', async () => {
    vi.useFakeTimers(); browser.next = { code: 'EGO_PAGE_EVALUATION_TIMED_OUT', error: 'still pending', uncertain: true };
    await call('evaluate', { page: 'p1', expression: 'pending()' }); const count = browser.calls.length;
    const waiting = call('wait', { seconds: 20 }); await vi.advanceTimersByTimeAsync(20000); expect((await waiting).failed).toBeUndefined();
    expect(world.status().halted).toBe(true); expect(browser.calls).toHaveLength(count);
  });
  it.each([-1, 61, NaN, Infinity, '20', undefined])('rejects invalid host delay %s without invoking the browser', async (seconds: unknown) => {
    const count = browser.calls.length; expect((await call('wait', { seconds })).failed).toBe(true); expect(browser.calls).toHaveLength(count);
  });
});

describe('video observation lifetime', () => {
  // Let real receipt persistence finish between fake clock ticks, as it does at runtime.
  async function advance(ms: number) {
    while (ms > 0) { const step = Math.min(ms, 1000); await vi.advanceTimersByTimeAsync(step); await (world as any).queue; ms -= step; }
  }
  it('keeps the first watch frame local and explains that look does not collect a time window', async () => {
    const peek = await call('video', { page: 'p1', action: 'look' });
    expect(peek.text).toContain('"capture":"video-frame"'); expect(peek.text).toContain('"phase":"snapshot"'); expect(peek.text).toContain('does not wait');
    const start = await call('video', { page: 'p1', action: 'watch' });
    expect(start.text).toContain('"phase":"collecting"'); expect(start.text).toContain('"nextEvent":"ego.video.scene"');
    expect(start.blobs).toBeUndefined(); expect(start.text).not.toContain('"frameCount"'); expect(deferred).toHaveLength(0);
  });
  it('flushes a short final scene before 15 seconds, stops watching and leaves the scene deliverable', async () => {
    vi.useFakeTimers(); await call('video', { page: 'p1', action: 'watch' });
    await advance(5000); browser.ended = true;
    await advance(5000); expect(world.status().watching).toBe(null); expect(deferred).toHaveLength(1);
    const final = await deferred[0].render(); expect(final && typeof final !== 'string' && final.blobs).toHaveLength(1);
    expect(final && typeof final !== 'string' && final.text).toContain('"phase":"ended"');
    const count = browser.calls.length; await advance(60000); expect(browser.calls).toHaveLength(count);
    await call('navigate', { page: 'p1', url: 'https://example.com' }); expect(deferred[0].render()).toBe(null);
  });
  it('withdraws a queued final scene if the operator pauses before delivery', async () => {
    vi.useFakeTimers(); await call('video', { page: 'p1', action: 'watch' }); browser.time += 1; browser.ended = true;
    await advance(5000); expect(deferred).toHaveLength(1); expect(deferred[0].render()).not.toBe(null);
    await call('video', { page: 'p1', action: 'pause' }); expect(deferred[0].render()).toBe(null);
  });
  it('does not discard the last queued scene if playback ends without advancing past its final timestamp', async () => {
    vi.useFakeTimers(); await call('video', { page: 'p1', action: 'watch' }); await advance(15000);
    expect(deferred).toHaveLength(1);
    const time = (world as any).watch.since;
    browser.ended = true; browser.time = time;
    browser.next = { spaceId: 1, value: { found: true, time, source: 'video1', ended: true, paused: true } };
    await advance(5000);
    expect(world.status().watching).toBe(null); expect(deferred).toHaveLength(1); expect(deferred[0].render()).not.toBe(null);
  });
  it('keeps frame times in the header and image fallback even when long subtitles are truncated', async () => {
    cfg.maxChars = 100;
    browser.next = { spaceId: 1, value: { found: true, tracks: [{ text: '字幕'.repeat(10000) }], capture: 'video-mosaic', frameTimes: [1, 6, 11, 16], image: { base64: 'anBlZw==', mime: 'image/jpeg' } } };
    const result = await call('video', { page: 'p1', action: 'look' });
    expect(result.text.split('\n')[0]).toContain('frameCount=4 frameTimes=[1,6,11,16]'); expect(result.text).toContain('truncated=true');
    expect((result.blobs![0] as any).fallbackText).toContain('frameTimes=[1,6,11,16]');
  });
  it('samples four frames within each 15-second scene and sends only the mosaic', async () => {
    vi.useFakeTimers(); await call('video', { page: 'p1', action: 'watch' });
    const start = browser.calls.length;
    await advance(10000);
    expect(browser.calls.slice(start).map(c => c.args.action)).toEqual(['sample', 'sample']);
    expect(deferred).toHaveLength(0);
    await advance(5000);
    expect(browser.calls.slice(start).map(c => c.args.action)).toEqual(['sample', 'sample', 'look']);
    expect(browser.calls.at(-1)?.args.consumeFrames).toBe(true);
    expect(deferred).toHaveLength(1);
    const scene = await deferred[0].render(); expect(scene && typeof scene !== 'string' && scene.blobs).toHaveLength(1);
  });
  it('with one frame configured captures only at the delivery interval', async () => {
    cfg.video.maxFrames = 1; vi.useFakeTimers(); await call('video', { page: 'p1', action: 'watch' });
    const start = browser.calls.length;
    await advance(14999); expect(deferred).toHaveLength(0);
    await advance(1);
    expect(browser.calls.slice(start).every(c => c.args.action === 'look')).toBe(true); expect(deferred).toHaveLength(1);
  });
  it('returns real image bytes as an attachment instead of base64 in context text', async () => {
    const result = await call('video', { page: 'p1', action: 'look' });
    expect(Buffer.from((result.blobs![0] as any).bytes).toString()).toBe('jpeg');
    expect(result.text).not.toContain('anBlZw==');
  });
  it('invalidates a queued scene when paused before delivery', async () => {
    vi.useFakeTimers(); await call('video', { page: 'p1', action: 'watch' });
    await advance(15000);
    expect(deferred).toHaveLength(1); expect(deferred[0].render()).not.toBe(null);
    await call('video', { page: 'p1', action: 'pause' });
    expect(deferred[0].render()).toBe(null);
    const count = browser.calls.length; await advance(60000);
    expect(browser.calls.length).toBe(count);
  });
  it('stops polling when a page changes its video source', async () => {
    vi.useFakeTimers(); await call('video', { page: 'p1', action: 'watch' });
    browser.next = { spaceId: 1, value: { found: true, time: 0, source: 'new-video' } };
    await advance(15000);
    expect(world.status().watching).toBe(null); expect(deferred).toHaveLength(0);
  });
  it('keeps every completed mosaic in order while the bot is busy', async () => {
    vi.useFakeTimers(); await call('video', { page: 'p1', action: 'watch' });
    await advance(15000);
    await advance(15000);
    expect(deferred).toHaveLength(2); expect(deferred[0].render()).not.toBe(null); expect(deferred[1].render()).not.toBe(null);
    expect(deferred[0].render()).toBe(null);
  });
  it('pauses at a bounded scene backlog and resumes after delivery without resetting collection', async () => {
    vi.useFakeTimers(); await call('video', { page: 'p1', action: 'watch' });
    await advance(60000); expect(deferred).toHaveLength(4);
    expect(browser.calls.at(-1)?.args).toMatchObject({ action: 'pause', preserveFrames: true });
    const count = browser.calls.length; await advance(30000); expect(browser.calls).toHaveLength(count);
    expect(deferred[0].render()).not.toBe(null); await (world as any).queue;
    expect(browser.calls.at(-1)?.args.action).toBe('play'); expect(world.status().watching).toBe('p1');
    await advance(15000); expect(deferred).toHaveLength(5);
    for (const scene of deferred.slice(1)) expect(scene.render()).not.toBe(null);
  });
  it('does not resume playback from backlog delivery after an explicit pause', async () => {
    vi.useFakeTimers(); await call('video', { page: 'p1', action: 'watch' }); await advance(60000);
    await call('video', { page: 'p1', action: 'pause' });
    const count = browser.calls.length;
    for (const scene of deferred) expect(scene.render()).toBe(null);
    await (world as any).queue; await advance(30000); expect(browser.calls).toHaveLength(count);
  });
  it('does not let play bypass a full observation queue', async () => {
    vi.useFakeTimers(); await call('video', { page: 'p1', action: 'watch' }); await advance(60000);
    const count = browser.calls.length;
    const result = await call('video', { page: 'p1', action: 'play' });
    expect(result.text).toContain('resume automatically'); expect(browser.calls).toHaveLength(count);
  });
  it('stops collection if its first sample fails', async () => {
    const original = browser.run.bind(browser);
    browser.run = async (op, args) => args.action === 'sample' ? { error: 'first capture failed' } : original(op, args);
    expect((await call('video', { page: 'p1', action: 'watch' })).failed).toBe(true);
    expect(world.status().watching).toBe(null); expect(deferred).toHaveLength(0);
  });
  it('delivers nine actual frames per batch and shared boundaries despite slow receipts and enrichment', async () => {
    vi.useFakeTimers(); cfg.video.maxFrames = 9;
    let updatedAt = Date.now();
    const video = { tagName: 'VIDEO', currentSrc: 'video1', currentTime: 0, readyState: 4, videoWidth: 640, videoHeight: 360,
      duration: 600, paused: false, ended: false, textTracks: [], play() { this.paused = false; }, pause() { this.paused = true; } };
    const op = runInNewContext(`(${videoOperation.toString()})`, { Date, Image: class { async decode() {} }, document: {
      querySelectorAll: () => [video], createElement: () => ({ getContext: () => ({ drawImage() {}, fillRect() {}, fillText() {} }),
        toDataURL: () => 'data:image/jpeg;base64,anBlZw==' }),
    } });
    let delayed = false;
    browser.run = async (_operation, args) => {
      if (!video.paused) video.currentTime += (Date.now() - updatedAt) / 1000;
      updatedAt = Date.now();
      const value = await op(args);
      // Model a slow subtitle/danmaku response after the first mosaic has been captured.
      const delay = args.action === 'look' && !delayed ? (delayed = true, 11500) : 300;
      await new Promise(resolve => setTimeout(resolve, delay));
      return { value: { ...value, frameId: 'frame1' } };
    };
    const start = call('video', { page: 'p1', action: 'watch' });
    await vi.advanceTimersByTimeAsync(1000); expect((await start).blobs).toBeUndefined();
    await vi.advanceTimersByTimeAsync(45000);
    expect(deferred.length).toBeGreaterThanOrEqual(2);
    const batches = [];
    for (const scene of deferred.slice(0, 2)) {
      const rendered = await scene.render(); expect(rendered && typeof rendered !== 'string' && rendered.blobs).toHaveLength(1);
      if (!rendered || typeof rendered === 'string') throw new Error('Missing mosaic');
      batches.push(JSON.parse(rendered.text.slice(rendered.text.indexOf('\n', rendered.text.indexOf('totalChars=')) + 1)));
    }
    expect(batches.map(batch => batch.frameCount)).toEqual([9, 9]);
    expect(batches[0].frameTimes.at(-1)).toBe(batches[1].frameTimes[0]);
    expect(batches[0].frameTimes[0]).toBeCloseTo(0.3);
    expect(batches[0].frameTimes.at(-1) - batches[0].frameTimes[0]).toBeCloseTo(15, 1);
    expect(batches[0].frameTimes.every((t: number, i: number, times: number[]) => i === 0 || t > times[i - 1])).toBe(true);
    expect(batches[1].frameTimes.every((t: number, i: number, times: number[]) => i === 0 || t - times[i - 1] < 2)).toBe(true);
    const stopping = world.stop(); await vi.advanceTimersByTimeAsync(1000); await stopping;
  });
  it('invalidates an undelivered scene when the World stops', async () => {
    vi.useFakeTimers(); await call('video', { page: 'p1', action: 'watch' });
    await advance(15000);
    await world.stop(); expect(deferred[0].render()).toBe(null);
  });
  it('starts a new mosaic history for each explicit watch session', async () => {
    await call('video', { page: 'p1', action: 'watch' });
    expect(browser.calls.find(c => c.op === 'video' && c.args.action === 'play')?.args.resetFrames).toBe(true);
  });
  it('does not poll after an operator-controlled Space error', async () => {
    vi.useFakeTimers(); await call('video', { page: 'p1', action: 'watch' });
    browser.next = { error: 'inactive', code: 'EGO_TASK_SPACE_INACTIVE' };
    await advance(15000);
    const count = browser.calls.length; await advance(60000);
    expect(browser.calls.length).toBe(count); expect(deferred).toHaveLength(0);
  });
  it('serializes concurrent tool calls, including operations after an abort', async () => {
    let active = 0, max = 0;
    const original = browser.run.bind(browser);
    browser.run = async (op, args) => { active++; max = Math.max(max, active); await new Promise(r => setTimeout(r, 5)); const result = await original(op, args); active--; return result; };
    await Promise.all([call('tabs'), call('tabs'), call('tabs')]); expect(max).toBe(1);
  });
});
