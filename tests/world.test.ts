import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
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
  time = 10;
  ended = false;
  async run(op: string, args: Record<string, unknown>): Promise<BridgeReceipt> {
    this.calls.push({ op, args });
    if (this.next) { const next = this.next; this.next = undefined; return next; }
    if (op === 'video') { const time = this.time++; return { spaceId: 1, value: { found: true, time, source: 'video1', frameId: 'frame1', ended: this.ended, paused: this.ended || args.action === 'pause',
      ...(args.action === 'look' ? { capture: 'video-mosaic', frameTimes: [time], image: { base64: Buffer.from('jpeg').toString('base64'), mime: 'image/jpeg' } } : {}) } }; }
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
  it('replaces a stale helper reason with the exact missing-Space failure and waits for the operator', async () => {
    (world as any).saved = { spaceId: 3, halted: false, reason: 'The operator stopped the ordinary-permission helper.', code: 'EGO_HELPER_UNAVAILABLE' };
    browser.next = { error: 'task space not found: 3', uncertain: false };
    const count = browser.calls.length;
    await expect(world.webUi().invoke!('control', 'connect', [])).rejects.toThrow('task space not found: 3');
    expect(world.status()).toMatchObject({ spaceId: 3, connected: false, halted: true, code: 'EGO_TASK_SPACE_NOT_FOUND', spaceMissing: true });
    expect(world.status().reason).not.toContain('operator stopped'); expect(browser.calls).toHaveLength(count + 1);
    expect((await call('tabs')).failed).toBe(true); expect(browser.calls).toHaveLength(count + 1);
    await world.stop(); await world.start(host()); expect(browser.calls).toHaveLength(count + 1);
  });
  it('lets only the operator reconnect by the configured name after a confirmed missing Space', async () => {
    browser.next = { error: 'task space not found: 1', uncertain: false }; await call('tabs');
    const previous = browser.calls.length;
    browser.next = { spaceId: 7, value: { pages: [] } };
    await world.webUi().invoke!('control', 'recreate-space', []);
    expect(browser.calls).toHaveLength(previous + 1);
    expect(browser.calls.at(-1)).toMatchObject({ op: 'connect', args: { spaceName: world.status().spaceName, spaceId: undefined } });
    expect(world.status()).toMatchObject({ spaceId: 7, connected: true, halted: false, spaceMissing: false, watching: null });
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
  it('preserves the missing id when its helper is offline and refuses to claim an occupied name', async () => {
    browser.next = { error: 'task space not found: 1', uncertain: false }; await call('tabs');
    browser.next = { error: 'helper offline', code: 'EGO_HELPER_UNAVAILABLE', uncertain: false };
    await expect(world.webUi().invoke!('control', 'recreate-space', [])).rejects.toThrow('helper offline');
    expect(world.status()).toMatchObject({ spaceId: 1, code: 'EGO_TASK_SPACE_NOT_FOUND', spaceMissing: true, halted: true });
    browser.next = { error: 'name belongs to the operator', code: 'EGO_TASK_SPACE_NAME_IN_USE', uncertain: false };
    await expect(world.webUi().invoke!('control', 'recreate-space', [])).rejects.toThrow('NAME_IN_USE');
    expect(world.status()).toMatchObject({ spaceId: 1, code: 'EGO_TASK_SPACE_NAME_IN_USE', halted: true, spaceMissing: false });
    expect(browser.calls.at(-1)?.op).toBe('connect');
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
    vi.useFakeTimers(); await call('video', { page: 'p1', action: 'watch' }); browser.ended = true;
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
    await advance(14999); expect(browser.calls).toHaveLength(start);
    await advance(1);
    expect(browser.calls.slice(start).map(c => c.args.action)).toEqual(['look']);
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
