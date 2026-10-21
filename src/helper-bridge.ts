import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BridgeReceipt, EgoBridge } from './bridge.ts';
import { normalizeFailure } from './failures.ts';
import { isElevated } from './permissions.ts';
export const HELPER_PROTOCOL = 1;
export interface HelperEndpoint { protocol: number; port: number; token: string; pid: number }
export async function readEndpoint(dir: string): Promise<HelperEndpoint> {
  const endpoint = JSON.parse(await readFile(join(dir, 'endpoint.json'), 'utf8'));
  if (endpoint.protocol !== HELPER_PROTOCOL) throw new Error('EGO_HELPER_VERSION: Restart the helper shipped with this package.');
  if (!Number.isInteger(endpoint.port) || endpoint.port < 1 || endpoint.port > 65535 || !/^[a-f0-9]{64}$/.test(endpoint.token)) throw new Error('Invalid Ego helper endpoint file');
  return endpoint;
}
export class HelperBridge implements EgoBridge {
  constructor(readonly dir: string, private readonly timeoutMs: () => number) {}
  async probe(): Promise<boolean> {
    try {
      const endpoint = await readEndpoint(this.dir);
      const response = await fetch(`http://127.0.0.1:${endpoint.port}/health`, { headers: { authorization: `Bearer ${endpoint.token}` }, signal: AbortSignal.timeout(2000) });
      const value = await response.json() as { protocol?: number; elevated?: boolean };
      return response.ok && value.protocol === HELPER_PROTOCOL && value.elevated === false;
    } catch { return false; }
  }
  async stop(): Promise<void> {
    const endpoint = await readEndpoint(this.dir);
    const response = await fetch(`http://127.0.0.1:${endpoint.port}/shutdown`, { method: 'POST', headers: { authorization: `Bearer ${endpoint.token}` }, signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error(`Could not stop Ego helper: HTTP ${response.status}`);
  }
  async run(operation: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<BridgeReceipt> {
    let endpoint: HelperEndpoint;
    try { endpoint = await readEndpoint(this.dir); }
    catch (error) { return { error: String(error), code: String(error).includes('EGO_HELPER_VERSION') ? 'EGO_HELPER_VERSION' : 'EGO_HELPER_UNAVAILABLE', uncertain: false }; }
    // Check availability before submitting any browser operation.
    if (!await this.probe()) return { error: 'The ordinary-permission Ego helper is not running. Start its launcher from File Explorer.', code: 'EGO_HELPER_UNAVAILABLE', uncertain: false };
    try {
      signal?.throwIfAborted();
      const timeout = AbortSignal.timeout(this.timeoutMs() + 5000);
      const response = await fetch(`http://127.0.0.1:${endpoint.port}/run`, {
        method: 'POST', headers: { authorization: `Bearer ${endpoint.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ operation, args }), signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      const receipt = await response.json() as BridgeReceipt;
      if (!response.ok || !receipt || typeof receipt !== 'object' || (!('value' in receipt) && !receipt.error)) throw new Error(`Ego helper HTTP ${response.status}: invalid receipt`);
      return normalizeFailure(receipt);
    } catch (error) { return { error: `Ego helper connection interrupted: ${String(error)}`, uncertain: true }; }
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
