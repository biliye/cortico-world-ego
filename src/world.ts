import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import type { ToolDef, ToolOutcome, World, WorldHost, WorldWebUiDecl } from 'cortico/core/types.ts';
import { nowIso } from 'cortico/core/util.ts';
import { CliBridge, type EgoBridge, type BridgeReceipt, type EvaluationTimeout } from './bridge.ts';
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
const SPACE_RESET_HINT = 'Old page labels and refs are invalid; use ego_tabs and reopen needed pages. Video watching has not resumed. The failed operation was not replayed.';
interface SavedState { spaceId?: number; halted: boolean; reason: string; code?: string; spaceMissing?: boolean; uncertain?: boolean; observationTimeout?: boolean; evaluation?: EvaluationTimeout; evaluationRecoveryBlocked?: string; lastUnknownEvaluation?: EvaluationTimeout }
const UNKNOWN_EVALUATION_HINT = 'The timed-out script outcome remains unknown and it may still have late effects. Do not replay it automatically; inspect the current page and reconcile any submission before continuing. Video watching has not resumed.';
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
  private recoveryTimer?: ReturnType<typeof setTimeout>;
  private recoveryDelay = 5000;
  private recoveringSpace = false;
  private controlTimer?: ReturnType<typeof setTimeout>;
  private controlDelay = 2000;
  private controlGeneration = 0;
  private checkingControl = false;
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
    return EGO_TOOL_DECLS.map(spec => ({ ...spec, handler: (args, ctx) => spec.name === 'ego_wait' ? this.wait(args, ctx.signal) : this.serial(async () => {
      if (!this.running) return { text: 'Ego World is stopped.', failed: true };
      const diagnostic = this.isEvaluationDiagnostic(spec.name.slice(4));
      if (this.saved.halted && !diagnostic) return { text: `Ego paused: ${this.saved.reason}\n${this.canRecoverMissingSpace() && (this.recoveryTimer || this.recoveringSpace) ? 'Automatic Space recovery is pending. Keep Ego and its helper available; do not repeat browser operations.' : this.canCheckEvaluation() && (this.controlTimer || this.checkingControl) ? 'Automatic recovery is checking agent control and the timed-out page snapshot. No panel resume is needed when diagnosis succeeds. Do not replay the timed-out script.' : this.canCheckControl() && (this.controlTimer || this.checkingControl) ? 'Control is checked automatically. Return control in Ego when finished; the World panel is an alternative. Do not repeat browser operations.' : 'The operator must resume in the World panel.'}${this.canDiagnoseEvaluation() ? '\nego_tabs and ego_read are available for read-only diagnosis without resuming. Use ego_wait for simple delays; elapsed time alone does not clear this pause.' : ''}`, failed: true };
      if (!this.connected && !diagnostic) return { text: `Ego is not connected: ${this.saved.reason || 'Reconnect from the World panel.'}`, failed: true };
      ctx.signal?.throwIfAborted();
      try { return await this.invokeTool(spec.name.slice(4), args, ctx.signal); }
      catch (error) { return { text: error instanceof Error ? error.message : String(error), failed: true }; }
    }) }));
  }
  private async wait(args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolOutcome> {
    try {
      if (!this.running) throw new Error('Ego World is stopped.');
      if (typeof args.seconds !== 'number' || !Number.isFinite(args.seconds) || args.seconds < 0 || args.seconds > 60) throw new Error('seconds must be a finite number from 0 to 60.');
      const combined = signal ? AbortSignal.any([signal, this.lifetime.signal]) : this.lifetime.signal;
      combined.throwIfAborted();
      const delayMs = args.seconds * 1000;
      // Host-only waiting stays outside the browser queue so video sampling continues.
      await new Promise<void>((done, fail) => {
        const finish = () => { combined.removeEventListener('abort', abort); done(); };
        const timer = setTimeout(finish, delayMs);
        const abort = () => { clearTimeout(timer); combined.removeEventListener('abort', abort); fail(new Error('Ego host wait cancelled.')); };
        combined.addEventListener('abort', abort, { once: true });
        if (combined.aborted) abort();
      });
      return this.outcome({ waitedSeconds: args.seconds, browserScriptExecuted: false, halted: this.saved.halted,
        note: 'Waiting is not evidence that a browser operation finished. Background diagnosis may independently restore browser availability; the timed-out script outcome remains unknown.' });
    } catch (error) { return { text: error instanceof Error ? error.message : String(error), failed: true }; }
  }
  private canDiagnoseEvaluation(): boolean {
    return this.saved.halted && this.saved.code === 'EGO_PAGE_EVALUATION_TIMED_OUT' && Number.isSafeInteger(this.saved.spaceId) && this.saved.spaceId! > 0;
  }
  private isEvaluationDiagnostic(operation: string): boolean {
    return (operation === 'tabs' || operation === 'read') && this.canDiagnoseEvaluation();
  }
  private canCheckEvaluation(): boolean {
    return this.canDiagnoseEvaluation() && /^p[1-9][0-9]*$/.test(this.saved.evaluation?.page ?? '') && !this.saved.evaluationRecoveryBlocked;
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
        // Invalidate queued/in-flight probes before waiting for the serial command queue.
        if (method === 'stop-helper') { this.clearSpaceRecovery(); this.clearControlCheck(); }
        return this.serial(async () => {
          if (!this.running) throw new Error(zh ? '请先启用 World' : 'Enable the World first');
          if (method === 'prepare-helper') {
            const result = await prepareHelperLauncher(this.helperDir, this.options.cfg.cliFile);
            this.launcherFile = result.launcherFile;
          } else if (method === 'stop-helper') {
            this.clearSpaceRecovery();
            this.clearControlCheck();
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
            this.saved.halted = false; this.saved.reason = ''; this.saved.code = undefined; this.saved.spaceMissing = false; this.saved.uncertain = false; this.saved.observationTimeout = false; this.saved.evaluation = undefined; this.saved.evaluationRecoveryBlocked = undefined; this.connected = true;
            this.clearControlCheck();
            await this.save(); await this.event('state', 'The operator resumed this Ego Space.', true);
          } else if (method === 'connect') {
            if (this.saved.halted) throw new Error(this.saved.reason);
            await this.connect();
          } else if (method === 'recreate-space') {
            if (!this.saved.halted || !this.saved.spaceMissing || this.saved.code !== 'EGO_TASK_SPACE_NOT_FOUND' || !this.saved.spaceId) throw new Error(zh ? '只有确认旧浏览空间不存在时才能重新建立。' : 'Recreation requires a confirmed missing Space.');
            // Manual fallback. Do not forget the old id until Ego returns a new one.
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
    autoRecovering: this.running && this.canRecoverMissingSpace() && (!!this.recoveryTimer || this.recoveringSpace),
    checkingControl: this.running && this.canCheckControl() && (!!this.controlTimer || this.checkingControl),
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
          spaceMissing: saved.spaceMissing === true && previous.code === 'EGO_TASK_SPACE_NOT_FOUND',
          uncertain: saved.uncertain === true || (saved.uncertain !== false && previous.code === 'EGO_TASK_SPACE_USER_IN_CONTROL' && saved.reason !== 'Control was handed to the operator.'),
          observationTimeout: saved.observationTimeout === true && previous.code === 'EGO_COMMAND_TIMEOUT',
          evaluation: previous.code === 'EGO_PAGE_EVALUATION_TIMED_OUT' && saved.evaluation && typeof saved.evaluation === 'object' ? saved.evaluation : undefined,
          evaluationRecoveryBlocked: typeof saved.evaluationRecoveryBlocked === 'string' ? saved.evaluationRecoveryBlocked : undefined,
          lastUnknownEvaluation: saved.lastUnknownEvaluation && typeof saved.lastUnknownEvaluation === 'object' ? saved.lastUnknownEvaluation : undefined };
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { this.saved = { halted: true, reason: `Cannot read Ego state: ${String(error)}` }; } }
    if (this.saved.halted && !this.canRecoverMissingSpace()) { this.scheduleControlCheck(); await this.event('state', `Ego paused: ${this.saved.reason}`, true); return; }
    await this.serial(async () => {
      try { const missing = this.canRecoverMissingSpace(); await this.connect(missing, missing); }
      catch (error) { this.connected = false; await this.event('state', `Ego connection failed: ${String(error)}`, true); }
    });
  }
  async stop(): Promise<void> {
    const watch = this.watch; this.running = false; this.cancelWatch(); this.clearSpaceRecovery(); this.clearControlCheck(); this.lifetime.abort();
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
  private canCheckControl(): boolean {
    return this.saved.halted && Number.isSafeInteger(this.saved.spaceId) && this.saved.spaceId! > 0
      && ((this.saved.code === 'EGO_TASK_SPACE_USER_IN_CONTROL' && !this.saved.uncertain)
        || (this.saved.code === 'EGO_COMMAND_TIMEOUT' && this.saved.observationTimeout === true)
        || this.canCheckEvaluation());
  }
  private clearControlCheck(): void {
    this.controlGeneration++;
    if (this.controlTimer) clearTimeout(this.controlTimer);
    this.controlTimer = undefined; this.controlDelay = 2000;
  }
  private scheduleControlCheck(): void {
    if (!this.running || this.lifetime.signal.aborted || !this.canCheckControl() || this.controlTimer) return;
    const signal = this.lifetime.signal;
    const generation = this.controlGeneration;
    this.controlTimer = setTimeout(() => {
      this.controlTimer = undefined;
      void this.serial(async () => {
        if (!this.running || signal.aborted || generation !== this.controlGeneration || !this.canCheckControl()) return;
        this.checkingControl = true;
        try {
          const id = this.saved.spaceId;
          if (this.canCheckEvaluation()) {
            await this.checkEvaluationRecovery(id!, signal, generation);
            return;
          }
          const receipt = normalizeFailure(await this.bridge.run('control-status', { spaceId: id }, signal));
          if (!this.running || signal.aborted) return;
          if (!receipt.error && !receipt.uncertain && receipt.spaceId === id && receipt.value?.control === 'agent') {
            this.saved.halted = false; this.saved.reason = ''; this.saved.code = undefined; this.saved.uncertain = false; this.saved.observationTimeout = false;
            this.connected = true; this.clearControlCheck();
            await this.save(); await this.event('state', 'Ego confirmed agent control of the same Space. Browser operations are available again. The failed operation was not replayed; video watching has not resumed. Refresh the page snapshot before using refs.', true);
            return;
          }
          if (receipt.value?.control === 'inactive' || /EGO_TASK_SPACE_(INACTIVE|NOT_FOUND|NOT_SELECTED|NAME_IN_USE|UNAVAILABLE)|EGO_TASK_HOST_DISCONNECTED/.test(receipt.code ?? '')) {
            // A control check must never trigger the separate missing-Space recreation path.
            this.saved.code = receipt.code ?? 'EGO_TASK_SPACE_INACTIVE'; this.saved.reason = receipt.error ?? 'This Space is no longer assigned to the agent.';
            this.saved.observationTimeout = false; this.saved.spaceMissing = false; this.clearControlCheck(); await this.save();
            await this.event('state', `Ego remains paused: ${this.saved.code}: ${this.saved.reason}`, true); return;
          }
        } catch { /* Preserve the original stop. A failed observation cannot authorize resuming. */ }
        finally {
          this.checkingControl = false;
          if (generation === this.controlGeneration) this.scheduleControlCheck();
        }
      });
    }, this.controlDelay);
    this.controlTimer.unref?.(); this.controlDelay = Math.min(this.controlDelay * 2, 10000);
  }
  private async checkEvaluationRecovery(id: number, signal: AbortSignal, generation: number): Promise<void> {
    const active = () => this.running && !signal.aborted && generation === this.controlGeneration && this.canCheckEvaluation();
    const valid = (receipt: BridgeReceipt) => !receipt.error && !receipt.code && !receipt.uncertain && receipt.spaceId === id;
    const checkControl = async (): Promise<boolean> => {
      const receipt = normalizeFailure(await this.bridge.run('control-status', { spaceId: id }, signal));
      if (!active()) return false;
      if (receipt.value?.control === 'inactive' || /EGO_TASK_SPACE_(INACTIVE|NOT_FOUND|NOT_SELECTED|NAME_IN_USE|UNAVAILABLE)|EGO_TASK_HOST_DISCONNECTED/.test(receipt.code ?? '')) {
        // Keep the original timeout; never route an uncertain script into Space recreation.
        this.saved.evaluationRecoveryBlocked = receipt.code ?? 'EGO_TASK_SPACE_INACTIVE';
        this.clearControlCheck(); await this.save();
        await this.event('state', `Ego evaluation recovery remains paused: ${this.saved.evaluationRecoveryBlocked}. The original script outcome is still unknown.`, true);
        return false;
      }
      return valid(receipt) && receipt.value?.control === 'agent';
    };
    if (!await checkControl()) return;
    const receipt = normalizeFailure(await this.bridge.run('read', { spaceId: id, page: this.saved.evaluation!.page, fullPage: false }, signal));
    if (!active() || !valid(receipt) || typeof receipt.value !== 'string') return;
    // A snapshot alone cannot establish ownership if the operator took over during the read.
    if (!await checkControl() || !active()) return;
    const previous = { ...this.saved };
    this.saved.lastUnknownEvaluation = { ...this.saved.evaluation };
    this.saved.halted = false; this.saved.reason = ''; this.saved.code = undefined; this.saved.uncertain = false;
    this.saved.observationTimeout = false; this.saved.spaceMissing = false; this.saved.evaluation = undefined;
    this.saved.evaluationRecoveryBlocked = undefined;
    try { await this.save(); }
    catch (error) { this.saved = previous; throw error; }
    if (!this.running || signal.aborted || generation !== this.controlGeneration) {
      this.saved = previous; await this.save(); return;
    }
    this.connected = true; this.clearControlCheck();
    await this.event('state', `Ego automatically restored browser operations after confirming agent control of the same Space and reading page ${this.saved.lastUnknownEvaluation.page}. ${UNKNOWN_EVALUATION_HINT} Refresh the snapshot before using refs.`, true);
  }
  private canRecoverMissingSpace(): boolean {
    return this.saved.halted && this.saved.spaceMissing === true && this.saved.code === 'EGO_TASK_SPACE_NOT_FOUND'
      && typeof this.saved.spaceId === 'number' && Number.isSafeInteger(this.saved.spaceId) && this.saved.spaceId > 0;
  }
  private clearSpaceRecovery(): void {
    if (this.recoveryTimer) clearTimeout(this.recoveryTimer);
    this.recoveryTimer = undefined; this.recoveryDelay = 5000;
  }
  private scheduleSpaceRecovery(): void {
    if (!this.running || this.lifetime.signal.aborted || !this.canRecoverMissingSpace() || this.recoveryTimer) return;
    const signal = this.lifetime.signal;
    this.recoveryTimer = setTimeout(() => {
      this.recoveryTimer = undefined;
      void this.serial(async () => {
        if (signal.aborted || !this.running || !this.canRecoverMissingSpace()) return;
        try { await this.connect(true, true); }
        catch { /* connect retains the failure and schedules the next bounded retry. */ }
      });
    }, this.recoveryDelay);
    this.recoveryTimer.unref?.();
    this.recoveryDelay = Math.min(this.recoveryDelay * 2, 60000);
  }
  private async connect(byName = false, automatic = false, signal?: AbortSignal): Promise<void> {
    if (automatic) this.recoveringSpace = true;
    try {
      await this.command('connect', {}, signal, byName, byName);
      this.lifetime.signal.throwIfAborted(); signal?.throwIfAborted();
      this.connected = true; this.saved.halted = false; this.saved.reason = ''; this.saved.code = undefined; this.saved.spaceMissing = false; this.saved.uncertain = false; this.saved.observationTimeout = false; this.saved.evaluation = undefined; this.saved.evaluationRecoveryBlocked = undefined;
      this.clearControlCheck();
      this.clearSpaceRecovery();
      await this.save(); await this.event('state', `Ego connected. Space ${this.saved.spaceId} (${this.spaceName}).${byName ? ` ${automatic ? 'Automatically' : 'The operator'} re-established the missing Space by its dedicated name. ${SPACE_RESET_HINT}` : ''}${this.saved.lastUnknownEvaluation ? ` ${UNKNOWN_EVALUATION_HINT}` : ''}`, true);
    } catch (error) {
      if (!byName && this.canRecoverMissingSpace() && this.running && !this.lifetime.signal.aborted && !signal?.aborted) {
        await this.connect(true, true, signal); return;
      }
      if (automatic && !signal?.aborted) this.scheduleSpaceRecovery();
      throw error;
    } finally { if (automatic) this.recoveringSpace = false; }
  }
  private async command(operation: string, args: Record<string, unknown>, signal?: AbortSignal, operatorResume = false, byName = false): Promise<any> {
    const diagnostic = this.isEvaluationDiagnostic(operation);
    if (this.saved.halted && !operatorResume && !diagnostic) throw new Error(`Ego paused: ${this.saved.reason}`);
    signal?.throwIfAborted();
    const combined = signal ? AbortSignal.any([signal, this.lifetime.signal]) : this.lifetime.signal;
    const receipt: BridgeReceipt = normalizeFailure(await this.bridge.run(operation, { ...args, restoreMinimized: this.options.cfg.restoreMinimized, spaceId: byName ? undefined : this.saved.spaceId, spaceName: this.spaceName }, combined));
    // A failed diagnostic cannot erase, weaken or replace the original uncertain stop.
    if (diagnostic && (receipt.error || receipt.uncertain || receipt.spaceId !== this.saved.spaceId)) throw new Error(`Ego diagnostic failed: ${receipt.code ?? ''}: ${receipt.error ?? 'Uncertain or mismatched Space receipt'}. The original evaluation pause is unchanged.`);
    if (receipt.spaceId && !receipt.error) { this.saved.spaceId = receipt.spaceId; await this.save(); }
    if (receipt.error) {
      if (isConnectionFailure(receipt.code)) {
        if (operatorResume && this.saved.halted) {
          this.saved.reason = `${this.saved.reason.split('\n')[0]}\n${receipt.error}`; this.connected = false; await this.save();
          throw new Error(`${receipt.code}: ${receipt.error}`);
        }
        this.saved.halted = false; this.saved.reason = receipt.error; this.saved.code = receipt.code; this.cancelWatch(); this.connected = false;
        await this.save(); await this.event('state', `Ego connection unavailable: ${receipt.code}: ${receipt.error}`, true);
      } else if (receipt.uncertain || receipt.code === 'EGO_PAGE_EVALUATION_TIMED_OUT' || STOP_CODES.test(receipt.code ?? receipt.error)) {
        this.saved.halted = true; this.saved.reason = `${receipt.code ?? 'UNCERTAIN'}: ${receipt.error}`; this.saved.code = receipt.code ?? 'UNCERTAIN';
        this.saved.uncertain = receipt.uncertain === true || receipt.code === 'EGO_PAGE_EVALUATION_TIMED_OUT';
        this.saved.evaluation = receipt.code === 'EGO_PAGE_EVALUATION_TIMED_OUT' ? { ...receipt.evaluation, page: typeof args.page === 'string' ? args.page : receipt.evaluation?.page } : undefined;
        this.saved.evaluationRecoveryBlocked = receipt.code === 'EGO_PAGE_EVALUATION_TIMED_OUT' && combined.aborted ? 'The timed-out operation was cancelled.' : undefined;
        this.saved.observationTimeout = receipt.code === 'EGO_COMMAND_TIMEOUT' && ['tabs', 'read'].includes(operation) && !combined.aborted;
        this.clearControlCheck(); this.scheduleControlCheck();
        this.saved.spaceMissing = receipt.code === 'EGO_TASK_SPACE_NOT_FOUND' && !receipt.uncertain; this.cancelWatch(); this.connected = false;
        if (!this.saved.spaceMissing) this.clearSpaceRecovery();
        await this.save(); await this.event('state', `Ego stopped: ${this.saved.reason}`, true);
        if (this.canRecoverMissingSpace() && this.running && !combined.aborted) {
          this.scheduleSpaceRecovery();
          if (!byName && !operatorResume && operation !== 'connect') {
            try { await this.connect(true, true, signal); }
            catch (error) { throw new Error(`${receipt.code}: ${receipt.error}\nAutomatic Space recovery failed: ${String(error)}`); }
            throw new Error(`${receipt.code}: ${receipt.error}\nThe missing Space was automatically re-established. ${SPACE_RESET_HINT}`);
          }
        }
      }
      throw new Error(`${receipt.code ? `${receipt.code}: ` : ''}${receipt.error}${this.canCheckEvaluation() ? '\nAutomatic recovery will check control and the timed-out page snapshot. Do not replay the script; successful diagnosis restores browser tools without a panel resume.' : ''}`);
    }
    if (this.transport?.selected === 'helper') this.helperOnline = true;
    return receipt.value;
  }
  private async handoff(): Promise<ToolOutcome> {
    this.cancelWatch(); await this.command('handoff', {});
    this.saved.halted = true; this.saved.reason = 'Control was handed to the operator.'; this.saved.code = 'EGO_TASK_SPACE_USER_IN_CONTROL'; this.connected = false;
    this.saved.uncertain = false; this.saved.observationTimeout = false; this.clearControlCheck(); this.scheduleControlCheck();
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
      const diagnostic = this.isEvaluationDiagnostic(operation);
      const value = await this.command(operation, args, signal);
      const result = this.outcome(value, operation === 'read' ? Number(args.offset ?? 0) : 0, Number(args.maxChars ?? this.options.cfg.maxChars));
      if (operation === 'bilibili' && args.action === 'comments' && ['target-unavailable', 'error'].includes(value?.status)) result.failed = true;
      if (diagnostic) result.text += '\nRead-only diagnosis only. The page-evaluation pause remains; pending JavaScript may still produce late effects. Do not repeat the timed-out script. Background diagnosis restores operations only after control and page checks pass; reading alone does not clear this pause.';
      return result;
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
