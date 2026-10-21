import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
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
  async run(op: string, args: Record<string, unknown>): Promise<BridgeReceipt> {
    this.calls.push({ op, args });
    if (this.next) { const next = this.next; this.next = undefined; return next; }
    if (op === 'video') return { spaceId: 1, value: { found: true, time: this.time++, source: 'video1', frameId: 'frame1', paused: args.action === 'pause', image: args.action === 'look' ? { base64: Buffer.from('jpeg').toString('base64'), mime: 'image/jpeg' } : undefined } };
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
  it('returns real image bytes as an attachment instead of base64 in context text', async () => {
    const result = await call('video', { page: 'p1', action: 'look' });
    expect(Buffer.from((result.blobs![0] as any).bytes).toString()).toBe('jpeg');
    expect(result.text).not.toContain('anBlZw==');
  });
  it('invalidates a queued scene when paused before delivery', async () => {
    vi.useFakeTimers(); await call('video', { page: 'p1', action: 'watch' });
    await vi.advanceTimersByTimeAsync(15000); await (world as any).queue;
    expect(deferred).toHaveLength(1); expect(deferred[0].render()).not.toBe(null);
    await call('video', { page: 'p1', action: 'pause' });
    expect(deferred[0].render()).toBe(null);
    const count = browser.calls.length; await vi.advanceTimersByTimeAsync(60000);
    expect(browser.calls.length).toBe(count);
  });
  it('stops polling when a page changes its video source', async () => {
    vi.useFakeTimers(); await call('video', { page: 'p1', action: 'watch' });
    browser.next = { spaceId: 1, value: { found: true, time: 0, source: 'new-video' } };
    await vi.advanceTimersByTimeAsync(15000); await (world as any).queue;
    expect(world.status().watching).toBe(null); expect(deferred).toHaveLength(0);
  });
  it('keeps only the newest undelivered scene while the bot is busy', async () => {
    vi.useFakeTimers(); await call('video', { page: 'p1', action: 'watch' });
    await vi.advanceTimersByTimeAsync(15000); await (world as any).queue;
    await vi.advanceTimersByTimeAsync(15000); await (world as any).queue;
    expect(deferred).toHaveLength(2); expect(deferred[0].render()).toBe(null); expect(deferred[1].render()).not.toBe(null);
  });
  it('invalidates an undelivered scene when the World stops', async () => {
    vi.useFakeTimers(); await call('video', { page: 'p1', action: 'watch' });
    await vi.advanceTimersByTimeAsync(15000); await (world as any).queue;
    await world.stop(); expect(deferred[0].render()).toBe(null);
  });
  it('starts a new mosaic history for each explicit watch session', async () => {
    await call('video', { page: 'p1', action: 'watch' });
    expect(browser.calls.find(c => c.op === 'video' && c.args.action === 'play')?.args.resetFrames).toBe(true);
  });
  it('does not poll after an operator-controlled Space error', async () => {
    vi.useFakeTimers(); await call('video', { page: 'p1', action: 'watch' });
    browser.next = { error: 'inactive', code: 'EGO_TASK_SPACE_INACTIVE' };
    await vi.advanceTimersByTimeAsync(15000); await (world as any).queue;
    const count = browser.calls.length; await vi.advanceTimersByTimeAsync(60000);
    expect(browser.calls.length).toBe(count); expect(deferred).toHaveLength(0);
  });
  it('serializes concurrent tool calls, including operations after an abort', async () => {
    let active = 0, max = 0;
    const original = browser.run.bind(browser);
    browser.run = async (op, args) => { active++; max = Math.max(max, active); await new Promise(r => setTimeout(r, 5)); const result = await original(op, args); active--; return result; };
    await Promise.all([call('tabs'), call('tabs'), call('tabs')]); expect(max).toBe(1);
  });
});
