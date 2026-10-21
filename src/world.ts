import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import type { ToolDef, ToolOutcome, World, WorldHost, WorldWebUiDecl } from 'cortico/core/types.ts';
import { nowIso } from 'cortico/core/util.ts';
import { CliBridge, type EgoBridge, type BridgeReceipt } from './bridge.ts';
import { bounded, egoConfigGroup, type EgoConfigSection } from './config.ts';
import { EGO_TOOL_DECLS } from './tools.ts';
import { AutoBridge, HelperBridge } from './helper-bridge.ts';
import { prepareHelperLauncher } from './helper-launcher.ts';
import { isConnectionFailure, normalizeFailure } from './failures.ts';
import { captureOptions, samplingOverride, samplingPlan, samplingSummary, targetOffset, type SamplingOverride, type SamplingPlan } from './sampling.ts';
const ENV_PROMPT_FILE = fileURLToPath(new URL('./ENV_PROMPT.md', import.meta.url));
const STOP_CODES = /EGO_TASK_SPACE_(USER_IN_CONTROL|INACTIVE|NAME_IN_USE|NOT_FOUND|NOT_SELECTED|UNAVAILABLE)|EGO_TASK_HOST_DISCONNECTED/;
interface Watch {
  page: string; frameId?: string; selector?: string; index?: number; since: number; source?: string; generation: number;
  nextSampleAt: number; batch: number; targetIndex: number; lastTime: number; playbackRate: number;
  plan: SamplingPlan; override?: SamplingOverride; pendingOverride?: SamplingOverride;
  completed?: boolean; backpressured?: boolean;
}
const MAX_PENDING_SCENES = 4;
interface SavedState { spaceId?: number; halted: boolean; reason: string; code?: string; spaceMissing?: boolean }
export interface EgoWorldOptions {
  cfg: EgoConfigSection; timezone: string; dataDir: string; botDir: string; bridge?: EgoBridge;
}
export class EgoWorld implements World {
  readonly id = 'ego';
  private readonly bridge: EgoBridge;
  private readonly spaceName: string;
  private readonly stateFile: string;
  private readonly helper: HelperBridge;
  private readonly helperDir: string;
  private readonly transport?: AutoBridge;
  private helperOnline = false;
  private launcherFile = '';
  private saved: SavedState = { halted: false, reason: '' };
  private host?: WorldHost;
  private running = false;
  private connected = false;
  private queue: Promise<unknown> = Promise.resolve();
  private lifetime = new AbortController();
  private timer?: ReturnType<typeof setTimeout>;
  private watch?: Watch;
  private generation = 0;
  private pendingScenes = new Set<{ page: string; outcome?: ToolOutcome }>();
  constructor(private readonly options: EgoWorldOptions) {
    this.spaceName = options.cfg.spaceName || `Cortico-${createHash('sha256').update(options.botDir).digest('hex').slice(0, 12)}`;
    this.stateFile = join(options.dataDir, 'ego', 'space.json');
    const timeoutMs = () => bounded(options.cfg.requestTimeoutMs, 5000, 120000, 45000);
    this.helperDir = options.cfg.helperDir || join(options.dataDir, 'ego', 'helper');
    this.helper = new HelperBridge(this.helperDir, timeoutMs);
    if (options.bridge) this.bridge = options.bridge;
    else {
      this.transport = new AutoBridge(new CliBridge({ cliFile: options.cfg.cliFile, dataDir: options.dataDir, timeoutMs }), this.helper, options.cfg.connectionMode || 'auto');
      this.bridge = this.transport;
    }
  }
  envPromptVars(): Record<string, string> { return { 'ego.spaceName': this.spaceName }; }
  tools(): ToolDef[] {
    return EGO_TOOL_DECLS.map(spec => ({ ...spec, handler: (args, ctx) => this.serial(async () => {
      if (!this.running) return { text: 'Ego World is stopped.', failed: true };
      if (this.saved.halted) return { text: `Ego paused: ${this.saved.reason}\nThe operator must resume in the World panel.`, failed: true };
      if (!this.connected) return { text: `Ego is not connected: ${this.saved.reason || 'Reconnect from the World panel.'}`, failed: true };
      ctx.signal?.throwIfAborted();
      try { return await this.invokeTool(spec.name.slice(4), args, ctx.signal); }
      catch (error) { return { text: error instanceof Error ? error.message : String(error), failed: true }; }
    }) }));
  }
  webUi(language = 'zh'): WorldWebUiDecl {
    const zh = language.startsWith('zh');
    return {
      label: zh ? 'Ego 浏览器' : 'Ego Browser',
      lamps: [{ label: 'Ego', state: !this.running ? 'offline' : this.saved.halted || this.saved.reason ? 'error' : this.connected ? 'online' : 'loading', hint: this.saved.reason || this.spaceName }],
      badges: [{ label: 'Space', value: this.saved.spaceId ?? '—' }, { label: zh ? '观看' : 'Watching', value: this.watch?.page ?? '—' }],
      config: [egoConfigGroup(language)], panels: [{ id: 'control', title: zh ? '浏览器控制' : 'Browser control' }],
      promptDocs: [{ key: 'worlds.ego.envPrompt', title: zh ? 'Ego · 环境提示词' : 'Ego · Environment prompt', description: zh ? '浏览器使用时机与观看范围。' : 'Browser usage and video observation scope.', path: ENV_PROMPT_FILE,
        role: 'envPrompt', vars: [{ name: 'ego.spaceName', description: zh ? '本部署的 Space 名称' : 'This deployment’s Space name' }] }],
      invoke: (panel, method) => {
        if (panel !== 'control') throw new Error('Unknown panel');
        if (method === 'status') return this.helper.probe().then(online => { this.helperOnline = online; return this.status(); });
        return this.serial(async () => {
          if (!this.running) throw new Error(zh ? '请先启用 World' : 'Enable the World first');
          if (method === 'prepare-helper') {
            const result = await prepareHelperLauncher(this.helperDir, this.options.cfg.cliFile);
            this.launcherFile = result.launcherFile;
          } else if (method === 'stop-helper') {
            await this.helper.stop(); this.helperOnline = false;
            if (this.transport?.selected === 'helper') {
              this.cancelWatch(); this.connected = false;
              if (!this.saved.halted) { this.saved.code = 'EGO_HELPER_UNAVAILABLE'; this.saved.reason = 'The operator stopped the ordinary-permission helper.'; await this.save(); }
            }
            await this.event('state', 'The operator stopped the ordinary-permission helper.', true);
          } else if (method === 'open-helper-folder') {
            if (!this.launcherFile || process.platform !== 'win32') throw new Error(zh ? '请先生成启动脚本' : 'Generate the launcher first');
            await new Promise<void>((done, fail) => {
              const child = spawn('explorer.exe', [this.helperDir], { windowsHide: true, stdio: 'ignore' });
              child.once('spawn', done); child.once('error', fail);
            });
          } else if (method === 'resume') {
            if (!this.saved.halted) throw new Error(zh ? '当前无需交还控制；连接失败请点重试连接。' : 'No control handoff to resume; retry the connection instead.');
            // No model tool reaches the takeover operation.
            await this.command(this.saved.spaceId ? 'resume' : 'connect', {}, undefined, true);
            this.saved.halted = false; this.saved.reason = ''; this.saved.code = undefined; this.saved.spaceMissing = false; this.connected = true;
            await this.save(); await this.event('state', 'The operator resumed this Ego Space.', true);
          } else if (method === 'connect') {
            if (this.saved.halted) throw new Error(this.saved.reason);
            await this.connect();
          } else if (method === 'recreate-space') {
            if (!this.saved.halted || !this.saved.spaceMissing || this.saved.code !== 'EGO_TASK_SPACE_NOT_FOUND' || !this.saved.spaceId) throw new Error(zh ? '只有确认旧浏览空间不存在时才能重新建立。' : 'Recreation requires a confirmed missing Space.');
            // Operator-only action. Do not forget the old id until Ego returns a new one.
            await this.connect(true);
          } else if (method === 'handoff') {
            if (!this.connected || this.saved.halted) throw new Error(zh ? '连接后才能接管浏览器' : 'Connect before taking control');
            await this.handoff();
          }
          else if (method === 'pause') {
            const watch = this.watch; this.cancelWatch();
            if (watch && !this.saved.halted) await this.command('video', { ...watch, action: 'pause' });
          } else throw new Error('Unknown method');
          return this.status();
        });
      },
    };
  }
  status() { return { running: this.running, connected: this.connected, ...this.saved, spaceName: this.spaceName, watching: this.watch?.page ?? null,
    sampling: this.watch ? this.samplingStatus(this.watch) : null,
    connectionMode: this.options.cfg.connectionMode || 'auto', transport: this.transport?.selected ?? 'direct',
    helperOnline: this.helperOnline, helperDir: this.helperDir, launcherFile: this.launcherFile, canPrepareHelper: process.platform === 'win32' }; }
  async start(host: WorldHost): Promise<void> {
    this.host = host; this.running = true; this.lifetime = new AbortController();
    try {
      const saved = JSON.parse(await readFile(this.stateFile, 'utf8'));
      if (saved.spaceName === this.spaceName) {
        const previous = normalizeFailure({ error: String(saved.reason ?? ''), code: saved.code, uncertain: !!saved.halted });
        this.saved = { spaceId: saved.spaceId, halted: isConnectionFailure(previous.code) ? false : !!saved.halted, reason: String(saved.reason ?? ''), code: previous.code,
          spaceMissing: saved.spaceMissing === true && previous.code === 'EGO_TASK_SPACE_NOT_FOUND' };
      }
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
  private async connect(byName = false): Promise<void> {
    await this.command('connect', {}, undefined, byName, byName); this.connected = true; this.saved.halted = false; this.saved.reason = ''; this.saved.code = undefined; this.saved.spaceMissing = false;
    await this.save(); await this.event('state', `Ego connected. Space ${this.saved.spaceId} (${this.spaceName}).${byName ? ' The operator re-established the missing Space by its dedicated name. Old page labels and refs are invalid; use ego_tabs and reopen needed pages. Video watching has not resumed.' : ''}`, true);
  }
  private async command(operation: string, args: Record<string, unknown>, signal?: AbortSignal, operatorResume = false, byName = false): Promise<any> {
    if (this.saved.halted && !operatorResume) throw new Error(`Ego paused: ${this.saved.reason}`);
    signal?.throwIfAborted();
    const combined = signal ? AbortSignal.any([signal, this.lifetime.signal]) : this.lifetime.signal;
    const receipt: BridgeReceipt = normalizeFailure(await this.bridge.run(operation, { ...args, restoreMinimized: this.options.cfg.restoreMinimized, spaceId: byName ? undefined : this.saved.spaceId, spaceName: this.spaceName }, combined));
    if (receipt.spaceId) { this.saved.spaceId = receipt.spaceId; await this.save(); }
    if (receipt.error) {
      if (isConnectionFailure(receipt.code)) {
        if (operatorResume && this.saved.halted) {
          this.saved.reason += `\n${receipt.error}`; this.connected = false; await this.save();
          throw new Error(`${receipt.code}: ${receipt.error}`);
        }
        this.saved.halted = false; this.saved.reason = receipt.error; this.saved.code = receipt.code; this.cancelWatch(); this.connected = false;
        await this.save(); await this.event('state', `Ego connection unavailable: ${receipt.code}: ${receipt.error}`, true);
      } else if (receipt.uncertain || STOP_CODES.test(receipt.code ?? receipt.error)) {
        this.saved.halted = true; this.saved.reason = `${receipt.code ?? 'UNCERTAIN'}: ${receipt.error}`; this.saved.code = receipt.code ?? 'UNCERTAIN';
        this.saved.spaceMissing = receipt.code === 'EGO_TASK_SPACE_NOT_FOUND' && !receipt.uncertain; this.cancelWatch(); this.connected = false;
        await this.save(); await this.event('state', `Ego stopped: ${this.saved.reason}`, true);
      }
      throw new Error(`${receipt.code ? `${receipt.code}: ` : ''}${receipt.error}`);
    }
    if (this.transport?.selected === 'helper') this.helperOnline = true;
    return receipt.value;
  }
  private async handoff(): Promise<ToolOutcome> {
    this.cancelWatch(); await this.command('handoff', {});
    this.saved.halted = true; this.saved.reason = 'Control was handed to the operator.'; this.saved.code = 'EGO_TASK_SPACE_USER_IN_CONTROL'; this.connected = false;
    await this.save(); await this.event('state', this.saved.reason, true);
    return { text: this.saved.reason };
  }
  private cancelWatch(): void {
    this.generation++; if (this.timer) clearTimeout(this.timer); this.timer = undefined; this.watch = undefined;
    for (const scene of this.pendingScenes) scene.outcome = undefined;
    this.pendingScenes.clear();
  }
  private async invokeTool(operation: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<ToolOutcome> {
    const args = validate(operation, input);
    if (operation === 'handoff') return this.handoff();
    if ((operation === 'close' || operation === 'navigate') && (this.watch?.page === args.page || [...this.pendingScenes].some(scene => scene.page === args.page))) this.cancelWatch();
    if (operation !== 'video') {
      const value = await this.command(operation, args, signal);
      return this.outcome(value, operation === 'read' ? Number(args.offset ?? 0) : 0, Number(args.maxChars ?? this.options.cfg.maxChars));
    }
    const action = String(args.action);
    // Resolve and validate before cancelling a previous watch or causing playback effects.
    const override = samplingOverride(args);
    if (action === 'tune') {
      const watch = this.watch;
      if (!watch || watch.page !== args.page) throw new Error('tune requires an active watch on the same page.');
      if (['frameId', 'selector', 'index'].some(key => args[key] !== undefined && args[key] !== watch[key as 'frameId' | 'selector' | 'index'])) throw new Error('tune cannot change the watched video; omit the video selector or start a new watch.');
      watch.pendingOverride = override;
      const observation = { phase: 'tuning', watching: true, ...this.samplingStatus(watch), appliesAtBatch: watch.batch + 1,
        note: 'Accepted for the next batch. The current batch and queued scenes are retained; the last frame becomes the next batch boundary.' };
      await this.event('video.state', JSON.stringify({ page: watch.page, action, observation }), true);
      return this.outcome({ observation });
    }
    if (action === 'play' && this.watch?.backpressured && this.watch.page === args.page) {
      return { text: 'Playback is waiting for queued mosaics to be delivered. It will resume automatically after delivery.' };
    }
    if (['pause', 'seek', 'exit', 'watch'].includes(action)) this.cancelWatch();
    const plan = action === 'watch' ? samplingPlan(this.options.cfg, override) : this.watch && this.watch.page === args.page ? this.watch.plan : samplingPlan(this.options.cfg);
    const videoArgs = { ...args, ...captureOptions(plan), collecting: action === 'watch' || this.watch?.page === args.page,
      snapshotOnly: action === 'look' && this.watch?.page === args.page };
    const value = await this.command('video', { ...videoArgs, resetFrames: action === 'watch' || action === 'exit', action: action === 'watch' ? 'play' : action === 'exit' ? 'pause' : action }, signal);
    if (!value.found) return { text: `offset=0\n${JSON.stringify(value)}`, ...(action === 'inspect' ? {} : { failed: true as const }) };
    if (!['inspect', 'look'].includes(action)) await this.event('video.state', JSON.stringify({ page: args.page, action, time: value.time, paused: value.paused }), true);
    if (action !== 'watch') {
      if (action === 'look') value.observation = { phase: 'snapshot', watching: this.watch?.page === args.page,
        note: 'look captures now; it does not wait to collect a time window. For several frames within 15 seconds, call watch once and wait for ego.video.scene. Repeated watch restarts sampling.' };
      return this.outcome(value);
    }
    const startedAt = Date.now();
    const watch: Watch = { page: String(args.page), frameId: value.frameId, selector: args.selector as string | undefined, index: args.index as number | undefined,
      since: value.time, source: value.source, generation: this.generation, nextSampleAt: startedAt, batch: 1, targetIndex: 1,
      lastTime: value.time, playbackRate: 1, plan, override };
    this.watch = watch;
    let scene;
    try { scene = await this.command('video', { ...videoArgs, action: 'sample', frameId: value.frameId }, signal); }
    catch (error) { this.cancelWatch(); throw error; }
    if (!this.running || this.watch !== watch || this.generation !== watch.generation) return { text: 'Video collection stopped before the first frame was ready.' };
    if (!scene.found || scene.paused || scene.ended || scene.source !== watch.source) {
      this.cancelWatch(); scene.observation = { phase: scene.ended ? 'ended' : 'stopped', watching: false, note: 'Playback stopped before the first collection window. Only the actually captured frames are returned.' };
      return this.outcome(scene);
    }
    watch.since = scene.time;
    this.updateTiming(watch, scene, startedAt);
    scene.observation = { phase: 'collecting', watching: true, intervalMs: plan.windowSec * 1000, ...samplingSummary(plan), batch: watch.batch,
      nextEvent: 'ego.video.scene', note: 'Collection started. The first frame stays in the local buffer; the completed mosaic arrives as ego.video.scene. Do not restart watch between samples.' };
    delete scene.image; delete scene.capture; delete scene.frameTimes; delete scene.frameCount;
    this.schedule(watch);
    return this.outcome(scene);
  }
  private samplingStatus(watch: Watch) {
    const next = samplingPlan(this.options.cfg, watch.pendingOverride ?? watch.override);
    return { batch: watch.batch, current: samplingSummary(watch.plan),
      pending: JSON.stringify(next) !== JSON.stringify(watch.plan) ? samplingSummary(next) : null };
  }
  private updateTiming(watch: Watch, value: any, startedAt: number): void {
    watch.lastTime = value.time;
    watch.playbackRate = typeof value.playbackRate === 'number' && value.playbackRate > 0 ? value.playbackRate : 1;
    const target = watch.since + targetOffset(watch.plan, watch.targetIndex);
    // Poll state during long gaps so a short tail/end or changed playback speed is noticed.
    // The page refuses to capture before targetTime; these checks do not add image frames.
    watch.nextSampleAt = startedAt + Math.min(5000, Math.max(100, (target - watch.lastTime) / watch.playbackRate * 1000));
  }
  private publishScene(watch: Watch, value: any, final = false): void {
    const times: number[] = value.frameTimes ?? [];
    value.observation = { phase: final ? 'ended' : 'scene', ...(final ? { watching: false } : {}), final, intervalMs: watch.plan.windowSec * 1000,
      ...samplingSummary(watch.plan), batch: watch.batch, actualVideoSpanSec: times.length ? times[times.length - 1]! - times[0]! : 0,
      maxActualGapSec: times.length > 1 ? Math.max(...times.slice(1).map((time, i) => time - times[i]!)) : 0,
      note: final ? 'Playback ended. These are the frames actually collected before the end; watching has stopped.' : 'Completed observation window. Use frameTimes in row-major order; the actual frame count can be below the configured maximum.' };
    const pending = { page: watch.page, outcome: this.outcome(value) as ToolOutcome | undefined };
    this.pendingScenes.add(pending);
    this.host?.pushDeferred({ type: 'ego.video.scene', origin: 'external', senderKey: this.id,
      render: () => {
        if (!this.running || (this.watch !== watch && !(watch.completed && this.watch === undefined)) || this.generation !== watch.generation || this.saved.halted || !pending.outcome) return null;
        const outcome = pending.outcome; pending.outcome = undefined; this.pendingScenes.delete(pending);
        if (watch.backpressured) void this.serial(() => this.resumeAfterDelivery(watch));
        return { text: `page=${watch.page}\n${outcome.text}`, blobs: outcome.blobs };
      },
    }, { trigger: 'debounce' });
  }
  private async resumeAfterDelivery(watch: Watch): Promise<void> {
    if (!this.running || this.saved.halted || this.watch !== watch || !watch.backpressured || this.pendingScenes.size >= MAX_PENDING_SCENES) return;
    try {
      const value = await this.command('video', { ...watch, action: 'play' });
      if (!value.found || value.ended || value.paused || value.source !== watch.source) { this.cancelWatch(); return; }
      watch.backpressured = false; this.updateTiming(watch, value, Date.now()); this.schedule(watch);
      await this.event('video.state', 'Scene delivery caught up; playback and observation resumed.', true);
    } catch (error) { this.cancelWatch(); await this.event('video.state', `Video observation stopped: ${String(error)}`, true); }
  }
  private schedule(watch: Watch): void {
    if (!this.running || this.saved.halted || this.watch !== watch) return;
    this.timer = setTimeout(() => {
      void this.serial(async () => {
        if (!this.running || this.watch !== watch || this.generation !== watch.generation || this.saved.halted) return;
        try {
          const observe = watch.targetIndex >= Math.max(1, watch.plan.plannedFrames - 1);
          const startedAt = Date.now();
          let value = await this.command('video', { ...watch, ...captureOptions(watch.plan), collecting: true,
            targetTime: watch.since + targetOffset(watch.plan, watch.targetIndex), batchEndTime: watch.since + watch.plan.windowSec,
            action: observe ? 'look' : 'sample', consumeFrames: observe, holdPlayback: observe });
          if (!this.running || this.watch !== watch || this.generation !== watch.generation) return;
          if (!value.found || (!value.ended && value.paused) || value.source !== watch.source || value.time < watch.lastTime - 0.02) {
            this.cancelWatch(); await this.event('video.state', `Watching stopped: ${JSON.stringify({ page: watch.page, found: value.found, paused: value.paused, ended: value.ended, sourceChanged: value.source !== watch.source })}`, true); return;
          }
          if (value.samplePending) { this.updateTiming(watch, value, startedAt); this.schedule(watch); return; }
          if (value.ended) {
            if (!observe && !value.batchComplete) value = await this.command('video', { ...watch, ...captureOptions(watch.plan), collecting: true, action: 'look', consumeFrames: true });
            if (!this.running || this.watch !== watch || this.generation !== watch.generation) return;
            if (!value.found || !value.ended || value.source !== watch.source) { this.cancelWatch(); return; }
            // Natural completion keeps its last scene deliverable. Explicit cancellation still invalidates it.
            watch.completed = true; this.watch = undefined; this.timer = undefined;
            if (value.time !== watch.since) this.publishScene(watch, value, true);
            await this.event('video.state', `Playback ended; final observation generated for page=${watch.page}.`, true);
            return;
          }
          const completed = observe || value.batchComplete;
          if (completed && value.time !== watch.since) {
            this.publishScene(watch, value);
          }
          if (completed) {
            watch.since = value.time; watch.batch++; watch.targetIndex = 1;
            if (watch.pendingOverride) { watch.override = watch.pendingOverride; watch.pendingOverride = undefined; }
            watch.plan = samplingPlan(this.options.cfg, watch.override);
          } else {
            watch.targetIndex++;
            // Skip targets already passed; never pretend catch-up frames reconstruct the past.
            while (watch.targetIndex < watch.plan.plannedFrames - 1 && watch.since + targetOffset(watch.plan, watch.targetIndex) <= value.time + 0.02) watch.targetIndex++;
          }
          this.updateTiming(watch, value, startedAt);
          if (completed && this.pendingScenes.size >= MAX_PENDING_SCENES) {
            watch.backpressured = true;
            if (!value.playbackHeld) await this.command('video', { ...watch, action: 'pause', preserveFrames: true });
            await this.event('video.state', 'Playback paused while completed mosaics wait for delivery. Observation resumes automatically after delivery; queued scenes are retained.', true);
            return;
          }
          if (value.playbackHeld) {
            const resumedAt = Date.now();
            const resumed = await this.command('video', { ...watch, action: 'play' });
            if (!resumed.found || resumed.paused || resumed.ended || resumed.source !== watch.source) { this.cancelWatch(); return; }
            this.updateTiming(watch, resumed, resumedAt);
          }
          this.schedule(watch);
        } catch (error) {
          this.cancelWatch(); await this.event('video.state', `Video observation stopped: ${String(error)}`, true);
        }
      });
    }, Math.max(0, watch.nextSampleAt - Date.now()));
    this.timer.unref?.();
  }
  private outcome(value: any, offset = 0, maxChars = this.options.cfg.maxChars): ToolOutcome {
    const image = value && typeof value === 'object' ? value.image : undefined;
    const frameTimes = Array.isArray(value?.frameTimes) ? value.frameTimes.filter((n: unknown) => typeof n === 'number' && Number.isFinite(n)).slice(0, 9) : undefined;
    const capture = frameTimes?.length && /^video-(mosaic|frame)$/.test(value.capture ?? '') ? frameTimes.length > 1 ? 'video-mosaic' : 'video-frame' : value?.capture;
    // Put frame metadata first and also in the untruncated header/attachment fallback.
    const content = image ? { capture, frameCount: frameTimes?.length, frameTimes, observation: value.observation, ...value, image: undefined } : value;
    if (image) { content.capture = capture; if (frameTimes) { content.frameCount = frameTimes.length; content.frameTimes = frameTimes; } }
    const text = typeof content === 'string' ? content : JSON.stringify(content) ?? 'null';
    offset = bounded(offset, 0, text.length, 0);
    const limit = bounded(maxChars, 100, 60000, 16000);
    const end = Math.min(text.length, offset + limit);
    const frameHeader = frameTimes ? ` frameCount=${frameTimes.length} frameTimes=${JSON.stringify(frameTimes)}` : '';
    const result: ToolOutcome = { text: `offset=${offset} end=${end} totalChars=${text.length} truncated=${end < text.length}${frameHeader}\n${text.slice(offset, end)}` };
    if (image?.base64 && /^image\/(jpeg|png)$/.test(image.mime)) result.blobs = [{ bytes: Buffer.from(image.base64, 'base64'), mime: image.mime, name: 'ego-frame.jpg', fallbackText: `Ego image: ${capture ?? 'page viewport'}; time=${value.time ?? 'n/a'} s.${frameHeader} Image understanding requires a vision-capable model.` }];
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
    if (!['inspect', 'play', 'pause', 'seek', 'look', 'watch', 'tune', 'exit'].includes(String(args.action))) throw new Error('Invalid video action.');
    if (args.action === 'seek' && args.time === undefined) throw new Error('seek requires time in seconds.');
  }
  if (operation === 'bilibili' && (!['search', 'related', 'comments'].includes(String(args.action)) || (args.action === 'search' && (typeof args.query !== 'string' || !args.query.trim())))) throw new Error('Invalid Bilibili action or missing search query.');
  return args;
}
