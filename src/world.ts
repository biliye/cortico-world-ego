import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ToolDef, ToolOutcome, World, WorldHost, WorldWebUiDecl } from 'cortico/core/types.ts';
import { nowIso } from 'cortico/core/util.ts';
import { CliBridge, type EgoBridge, type BridgeReceipt } from './bridge.ts';
import { bounded, egoConfigGroup, type EgoConfigSection } from './config.ts';
import { EGO_TOOL_DECLS } from './tools.ts';
const ENV_PROMPT_FILE = fileURLToPath(new URL('./ENV_PROMPT.md', import.meta.url));
const STOP_CODES = /EGO_TASK_SPACE_(USER_IN_CONTROL|INACTIVE|NAME_IN_USE|NOT_FOUND|NOT_SELECTED|UNAVAILABLE)|EGO_TASK_HOST_DISCONNECTED/;
interface Watch { page: string; frameId?: string; selector?: string; index?: number; since?: number; source?: string; generation: number }
interface SavedState { spaceId?: number; halted: boolean; reason: string }
export interface EgoWorldOptions {
  cfg: EgoConfigSection; timezone: string; dataDir: string; botDir: string; bridge?: EgoBridge;
}
export class EgoWorld implements World {
  readonly id = 'ego';
  private readonly bridge: EgoBridge;
  private readonly spaceName: string;
  private readonly stateFile: string;
  private saved: SavedState = { halted: false, reason: '' };
  private host?: WorldHost;
  private running = false;
  private connected = false;
  private queue: Promise<unknown> = Promise.resolve();
  private lifetime = new AbortController();
  private timer?: ReturnType<typeof setTimeout>;
  private watch?: Watch;
  private generation = 0;
  private sceneToken = 0;
  private pendingScene?: { token: number; outcome: ToolOutcome };
  constructor(private readonly options: EgoWorldOptions) {
    this.spaceName = options.cfg.spaceName || `Cortico-${createHash('sha256').update(options.botDir).digest('hex').slice(0, 12)}`;
    this.stateFile = join(options.dataDir, 'ego', 'space.json');
    this.bridge = options.bridge ?? new CliBridge({ cliFile: options.cfg.cliFile, dataDir: options.dataDir,
      timeoutMs: () => bounded(options.cfg.requestTimeoutMs, 5000, 120000, 45000) });
  }
  envPromptVars(): Record<string, string> { return { 'ego.spaceName': this.spaceName }; }
  tools(): ToolDef[] {
    return EGO_TOOL_DECLS.map(spec => ({ ...spec, handler: (args, ctx) => this.serial(async () => {
      if (!this.running) return { text: 'Ego World is stopped.', failed: true };
      if (this.saved.halted) return { text: `Ego paused: ${this.saved.reason}\nThe operator must resume in the World panel.`, failed: true };
      ctx.signal?.throwIfAborted();
      try { return await this.invokeTool(spec.name.slice(4), args, ctx.signal); }
      catch (error) { return { text: error instanceof Error ? error.message : String(error), failed: true }; }
    }) }));
  }
  webUi(language = 'zh'): WorldWebUiDecl {
    const zh = language.startsWith('zh');
    return {
      label: zh ? 'Ego 浏览器' : 'Ego Browser',
      lamps: [{ label: 'Ego', state: !this.running ? 'offline' : this.saved.halted ? 'error' : this.connected ? 'online' : 'loading', hint: this.saved.reason || this.spaceName }],
      badges: [{ label: 'Space', value: this.saved.spaceId ?? '—' }, { label: zh ? '观看' : 'Watching', value: this.watch?.page ?? '—' }],
      config: [egoConfigGroup(language)], panels: [{ id: 'control', title: zh ? '浏览器控制' : 'Browser control' }],
      promptDocs: [{ key: 'worlds.ego.envPrompt', title: zh ? 'Ego · 环境提示词' : 'Ego · Environment prompt', description: zh ? '浏览器使用时机与观看范围。' : 'Browser usage and video observation scope.', path: ENV_PROMPT_FILE,
        role: 'envPrompt', vars: [{ name: 'ego.spaceName', description: zh ? '本部署的 Space 名称' : 'This deployment’s Space name' }] }],
      invoke: (panel, method) => {
        if (panel !== 'control') throw new Error('Unknown panel');
        if (method === 'status') return Promise.resolve(this.status());
        return this.serial(async () => {
          if (!this.running) throw new Error(zh ? '请先启用 World' : 'Enable the World first');
          if (method === 'resume') {
            if (!this.saved.spaceId) throw new Error(zh ? '尚未连接，请先点连接' : 'Connect first');
            // No model tool reaches the takeover operation.
            await this.command('resume', {}, undefined, true);
            this.saved.halted = false; this.saved.reason = ''; this.connected = true;
            await this.save(); await this.event('state', 'The operator resumed this Ego Space.', true);
          } else if (method === 'connect') {
            if (this.saved.halted) throw new Error(this.saved.reason);
            await this.connect();
          } else if (method === 'handoff') await this.handoff();
          else if (method === 'pause') {
            const watch = this.watch; this.cancelWatch();
            if (watch && !this.saved.halted) await this.command('video', { ...watch, action: 'pause' });
          } else throw new Error('Unknown method');
          return this.status();
        });
      },
    };
  }
  status() { return { running: this.running, connected: this.connected, ...this.saved, spaceName: this.spaceName, watching: this.watch?.page ?? null }; }
  async start(host: WorldHost): Promise<void> {
    this.host = host; this.running = true; this.lifetime = new AbortController();
    try {
      const saved = JSON.parse(await readFile(this.stateFile, 'utf8'));
      if (saved.spaceName === this.spaceName) this.saved = { spaceId: saved.spaceId, halted: !!saved.halted, reason: String(saved.reason ?? '') };
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { this.saved = { halted: true, reason: `Cannot read Ego state: ${String(error)}` }; } }
    if (this.saved.halted) { await this.event('state', `Ego paused: ${this.saved.reason}`, true); return; }
    await this.serial(async () => {
      try { await this.connect(); }
      catch (error) { this.connected = false; await this.event('state', `Ego connection failed: ${String(error)}`, true); }
    });
  }
  async stop(): Promise<void> {
    const watch = this.watch; this.running = false; this.cancelWatch(); this.lifetime.abort();
    await this.queue.catch(() => {});
    // Do not touch a Space after user takeover or an uncertain command outcome.
    if (watch && !this.saved.halted && this.connected) {
      try { await this.bridge.run('video', { spaceId: this.saved.spaceId, ...watch, action: 'pause' }); }
      catch { /* Space remains externally visible; status does not claim successful pause. */ }
    }
    this.connected = false; this.host = undefined;
  }
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.queue.then(fn, fn); this.queue = result.catch(() => {}); return result;
  }
  private async save(): Promise<void> {
    await mkdir(join(this.options.dataDir, 'ego'), { recursive: true });
    await writeFile(this.stateFile, JSON.stringify({ ...this.saved, spaceName: this.spaceName }), { mode: 0o600 });
  }
  private async connect(): Promise<void> {
    await this.command('connect', {}); this.connected = true;
    await this.save(); await this.event('state', `Ego connected. Space ${this.saved.spaceId} (${this.spaceName}).`, true);
  }
  private async command(operation: string, args: Record<string, unknown>, signal?: AbortSignal, operatorResume = false): Promise<any> {
    if (this.saved.halted && !operatorResume) throw new Error(`Ego paused: ${this.saved.reason}`);
    signal?.throwIfAborted();
    const combined = signal ? AbortSignal.any([signal, this.lifetime.signal]) : this.lifetime.signal;
    const receipt: BridgeReceipt = await this.bridge.run(operation, { ...args, restoreMinimized: this.options.cfg.restoreMinimized, spaceId: this.saved.spaceId, spaceName: this.spaceName }, combined);
    if (receipt.spaceId) { this.saved.spaceId = receipt.spaceId; await this.save(); }
    if (receipt.error) {
      if (receipt.uncertain || STOP_CODES.test(receipt.code ?? receipt.error)) {
        this.saved.halted = true; this.saved.reason = `${receipt.code ?? 'UNCERTAIN'}: ${receipt.error}`; this.cancelWatch(); this.connected = false;
        await this.save(); await this.event('state', `Ego stopped: ${this.saved.reason}`, true);
      }
      throw new Error(`${receipt.code ? `${receipt.code}: ` : ''}${receipt.error}`);
    }
    return receipt.value;
  }
  private async handoff(): Promise<ToolOutcome> {
    this.cancelWatch(); await this.command('handoff', {});
    this.saved.halted = true; this.saved.reason = 'Control was handed to the operator.'; this.connected = false;
    await this.save(); await this.event('state', this.saved.reason, true);
    return { text: this.saved.reason };
  }
  private cancelWatch(): void { this.generation++; if (this.timer) clearTimeout(this.timer); this.timer = undefined; this.watch = undefined; this.pendingScene = undefined; }
  private async invokeTool(operation: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<ToolOutcome> {
    const args = validate(operation, input);
    if (operation === 'handoff') return this.handoff();
    if ((operation === 'close' || operation === 'navigate') && this.watch?.page === args.page) this.cancelWatch();
    if (operation !== 'video') {
      const value = await this.command(operation, args, signal);
      return this.outcome(value, operation === 'read' ? Number(args.offset ?? 0) : 0, Number(args.maxChars ?? this.options.cfg.maxChars));
    }
    const action = String(args.action);
    if (['pause', 'seek', 'exit', 'watch'].includes(action)) this.cancelWatch();
    const videoArgs = { ...args, maxFrames: bounded(this.options.cfg.video.maxFrames, 1, 9, 4), frameWidth: bounded(this.options.cfg.video.frameWidth, 240, 1280, 640) };
    const value = await this.command('video', { ...videoArgs, resetFrames: action === 'watch' || action === 'exit', action: action === 'watch' ? 'play' : action === 'exit' ? 'pause' : action }, signal);
    if (!value.found) return { text: `offset=0\n${JSON.stringify(value)}`, ...(action === 'inspect' ? {} : { failed: true as const }) };
    if (!['inspect', 'look'].includes(action)) await this.event('video.state', JSON.stringify({ page: args.page, action, time: value.time, paused: value.paused }), true);
    if (action !== 'watch') return this.outcome(value);
    const watch: Watch = { page: String(args.page), frameId: value.frameId, selector: args.selector as string | undefined, index: args.index as number | undefined,
      since: value.time, source: value.source, generation: this.generation };
    this.watch = watch;
    const scene = await this.command('video', { ...videoArgs, action: 'look', frameId: value.frameId }, signal);
    watch.since = scene.time;
    this.schedule(watch);
    return this.outcome(scene);
  }
  private schedule(watch: Watch): void {
    if (!this.running || this.saved.halted || this.watch !== watch) return;
    this.timer = setTimeout(() => {
      void this.serial(async () => {
        if (!this.running || this.watch !== watch || this.generation !== watch.generation || this.saved.halted) return;
        try {
          const value = await this.command('video', { ...watch, action: 'look', maxFrames: bounded(this.options.cfg.video.maxFrames, 1, 9, 4), frameWidth: bounded(this.options.cfg.video.frameWidth, 240, 1280, 640) });
          if (!this.running || this.watch !== watch || this.generation !== watch.generation) return;
          if (!value.found || value.paused || value.ended || value.source !== watch.source) {
            this.cancelWatch(); await this.event('video.state', `Watching stopped: ${JSON.stringify({ page: watch.page, found: value.found, paused: value.paused, ended: value.ended, sourceChanged: value.source !== watch.source })}`, true); return;
          }
          if (value.time !== watch.since) {
            watch.since = value.time;
            const token = ++this.sceneToken;
            this.pendingScene = { token, outcome: this.outcome(value) };
            this.host?.pushDeferred({ type: 'ego.video.scene', origin: 'external', senderKey: this.id,
              render: () => {
                if (!this.running || this.watch !== watch || this.generation !== watch.generation || this.saved.halted || this.pendingScene?.token !== token) return null;
                const outcome = this.pendingScene.outcome;
                return { text: `page=${watch.page}\n${outcome.text}`, blobs: outcome.blobs };
              },
            }, { trigger: 'debounce' });
          }
          this.schedule(watch);
        } catch (error) {
          this.cancelWatch(); await this.event('video.state', `Video observation stopped: ${String(error)}`, true);
        }
      });
    }, bounded(this.options.cfg.video.intervalMs, 10000, 120000, 15000));
    this.timer.unref?.();
  }
  private outcome(value: any, offset = 0, maxChars = this.options.cfg.maxChars): ToolOutcome {
    const image = value && typeof value === 'object' ? value.image : undefined;
    const content = image ? { ...value, image: undefined } : value;
    const text = typeof content === 'string' ? content : JSON.stringify(content) ?? 'null';
    offset = bounded(offset, 0, text.length, 0);
    const limit = bounded(maxChars, 100, 60000, 16000);
    const end = Math.min(text.length, offset + limit);
    const result: ToolOutcome = { text: `offset=${offset} end=${end} totalChars=${text.length} truncated=${end < text.length}\n${text.slice(offset, end)}` };
    if (image?.base64 && /^image\/(jpeg|png)$/.test(image.mime)) result.blobs = [{ bytes: Buffer.from(image.base64, 'base64'), mime: image.mime, name: 'ego-frame.jpg', fallbackText: `Ego image: ${value.capture ?? 'page viewport'}; time=${value.time ?? 'n/a'} s. Image understanding requires a vision-capable model.` }];
    if (image?.mime && this.host?.modelFacts?.accepts(image.mime) === false) result.text += '\nThe configured model does not accept this image MIME. It can read the returned subtitles; choose a vision-capable model to interpret the frames.';
    return result;
  }
  private async event(type: string, text: string, internal = false): Promise<void> {
    await this.host?.pushEvent({ type: `ego.${type}`, source: this.id, senderKey: this.id, ts: nowIso(this.options.timezone), text, ...(internal ? { origin: 'internal' as const } : {}) }, { trigger: 'flush' });
  }
}
export function normalizeUrl(input: string): string {
  const url = /^BV[0-9A-Za-z]+$/.test(input) ? `https://www.bilibili.com/video/${input}` : /^[a-z][a-z0-9+.-]*:/i.test(input) ? input : `https://${input}`;
  const parsed = new URL(url);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('Only HTTP(S) URLs without embedded credentials are supported.');
  return parsed.href;
}
function validate(operation: string, input: Record<string, unknown>): Record<string, unknown> {
  const args = { ...input };
  const spec = EGO_TOOL_DECLS.find(t => t.name === `ego_${operation}`)!;
  const properties = spec.parameters.properties as Record<string, { type?: string }>;
  for (const key of spec.parameters.required as string[]) {
    if (args[key] === undefined) throw new Error(`${key} is required.`);
    if (properties[key]?.type === 'string' && (typeof args[key] !== 'string' || (key !== 'text' && !String(args[key]).trim()))) throw new Error(`${key} must be a non-empty string.`);
  }
  if (args.page && !/^p[1-9][0-9]*$/.test(String(args.page))) throw new Error('Invalid page label; use ego_tabs.');
  if (args.url !== undefined) args.url = normalizeUrl(String(args.url).trim());
  for (const key of ['time', 'since', 'offset', 'maxChars', 'index', 'deltaY', 'x', 'y']) {
    if (args[key] !== undefined && (typeof args[key] !== 'number' || !Number.isFinite(args[key]))) throw new Error(`${key} must be a finite number.`);
  }
  for (const key of ['time', 'since', 'offset', 'index']) if (Number(args[key]) < 0) throw new Error(`${key} must be >= 0.`);
  if (operation === 'video') {
    if (!['inspect', 'play', 'pause', 'seek', 'look', 'watch', 'exit'].includes(String(args.action))) throw new Error('Invalid video action.');
    if (args.action === 'seek' && args.time === undefined) throw new Error('seek requires time in seconds.');
  }
  if (operation === 'bilibili' && (!['search', 'related', 'comments'].includes(String(args.action)) || (args.action === 'search' && (typeof args.query !== 'string' || !args.query.trim())))) throw new Error('Invalid Bilibili action or missing search query.');
  return args;
}
