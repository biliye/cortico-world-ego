import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BridgeReceipt, EgoBridge } from './bridge.ts';
import { normalizeFailure } from './failures.ts';
import { isElevated } from './permissions.ts';
export const HELPER_PROTOCOL = 3;
export type HelperStatus = 'offline' | 'ready' | 'incompatible';
export interface HelperEndpoint { protocol: number; port: number; token: string; pid: number }
export async function readEndpoint(dir: string): Promise<HelperEndpoint> {
  const endpoint = JSON.parse(await readFile(join(dir, 'endpoint.json'), 'utf8')) as HelperEndpoint | null;
  if (!endpoint || !Number.isSafeInteger(endpoint.protocol) || endpoint.protocol < 1 || !Number.isSafeInteger(endpoint.pid) || endpoint.pid < 1
    || !Number.isInteger(endpoint.port) || endpoint.port < 1 || endpoint.port > 65535
    || typeof endpoint.token !== 'string' || !/^[a-f0-9]{64}$/.test(endpoint.token)) throw new Error('Invalid Ego helper endpoint file');
  return endpoint;
}
export class HelperBridge implements EgoBridge {
  constructor(readonly dir: string, private readonly timeoutMs: () => number) {}
  async probe(): Promise<boolean> {
    return await this.status() === 'ready';
  }
  async status(): Promise<HelperStatus> {
    try { return await this.endpointStatus(await readEndpoint(this.dir)); }
    catch { return 'offline'; }
  }
  private async endpointStatus(endpoint: HelperEndpoint): Promise<HelperStatus> {
    try {
      const response = await fetch(`http://127.0.0.1:${endpoint.port}/health`, { headers: { authorization: `Bearer ${endpoint.token}` }, signal: AbortSignal.timeout(2000) });
      if (!response.ok) return 'offline';
      const value = await response.json() as { protocol: number; elevated: boolean; pid: number };
      if (!value || value.pid !== endpoint.pid || value.elevated !== false || !Number.isSafeInteger(value.protocol) || value.protocol < 1) return 'offline';
      return value.protocol === HELPER_PROTOCOL && endpoint.protocol === HELPER_PROTOCOL ? 'ready' : 'incompatible';
    } catch { return 'offline'; }
  }
  async stop(): Promise<void> {
    const endpoint = await readEndpoint(this.dir);
    const response = await fetch(`http://127.0.0.1:${endpoint.port}/shutdown`, { method: 'POST',
      headers: { authorization: `Bearer ${endpoint.token}`, connection: 'close' }, signal: AbortSignal.timeout(5000) });
    await response.text();
    if (!response.ok) throw new Error(`Could not stop Ego helper: HTTP ${response.status}`);
  }
  async run(operation: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<BridgeReceipt> {
    let endpoint: HelperEndpoint;
    try { endpoint = await readEndpoint(this.dir); }
    catch (error) { return { error: String(error), code: 'EGO_HELPER_UNAVAILABLE', uncertain: false }; }
    // Check availability before submitting any browser operation.
    const status = endpoint.protocol === HELPER_PROTOCOL ? await this.endpointStatus(endpoint) : 'incompatible';
    if (status === 'incompatible') return { error: 'The Ego helper protocol is incompatible. Stop the old helper if running, regenerate its launcher and start the new helper.', code: 'EGO_HELPER_VERSION', uncertain: false };
    if (status === 'offline') return { error: 'The ordinary-permission Ego helper is not running. Start its launcher from File Explorer.', code: 'EGO_HELPER_UNAVAILABLE', uncertain: false };
    try {
      signal?.throwIfAborted();
      const timeout = AbortSignal.timeout(this.timeoutMs() + 5000);
      const response = await fetch(`http://127.0.0.1:${endpoint.port}/run`, {
        method: 'POST', headers: { authorization: `Bearer ${endpoint.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ operation, args }), signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      const receipt = await response.json() as BridgeReceipt;
      if (response.status === 400 && receipt?.error === 'Unsupported operation or arguments' && ['upload', 'download'].includes(operation)) {
        return { error: 'The running Ego helper does not support file transfer. Stop it, regenerate its launcher and start it again.', code: 'EGO_HELPER_VERSION', uncertain: false };
      }
      if (!response.ok || !receipt || typeof receipt !== 'object' || (!('value' in receipt) && !receipt.error)) throw new Error(`Ego helper HTTP ${response.status}: invalid receipt`);
      return normalizeFailure(receipt);
    } catch (error) { return { error: `Ego helper connection interrupted: ${String(error)}`, code: !signal?.aborted && (error as Error).name === 'TimeoutError' ? 'EGO_COMMAND_TIMEOUT' : undefined, uncertain: true }; }
  }
}
export class AutoBridge implements EgoBridge {
  selected: 'direct' | 'helper' = 'direct';
  private checkedElevation = false;
  constructor(private readonly direct: EgoBridge, private readonly helper: EgoBridge, private readonly mode: 'auto' | 'direct' | 'helper', private readonly checkElevated = isElevated) {
    if (mode === 'helper') this.selected = 'helper';
  }
  async run(operation: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<BridgeReceipt> {
    if (this.mode === 'auto' && !this.checkedElevation) {
      this.checkedElevation = true;
      try { if (await this.checkElevated()) this.selected = 'helper'; } catch { /* Ego remains the authority when the OS probe is unavailable. */ }
    }
    if (this.selected === 'helper') return this.helper.run(operation, args, signal);
    const receipt = normalizeFailure(await this.direct.run(operation, args, signal));
    if (this.mode !== 'auto' || receipt.code !== 'EGO_CLIENT_ELEVATED') return receipt;
    // The explicit pre-execution rejection is the only automatic transport fallback.
    this.selected = 'helper';
    const result = await this.helper.run(operation, args, signal);
    if (result.code === 'EGO_HELPER_UNAVAILABLE') return { ...result, code: 'EGO_HELPER_REQUIRED', error: `${receipt.error}\nStart the ordinary-permission helper, then reconnect.` };
    return result;
  }
}
