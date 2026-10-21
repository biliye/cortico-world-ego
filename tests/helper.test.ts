import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { startHelper } from '../src/helper.ts';
import { AutoBridge, HelperBridge, readEndpoint } from '../src/helper-bridge.ts';
import { normalizeFailure } from '../src/failures.ts';
import type { EgoBridge } from '../src/bridge.ts';
let dir: string, close: (() => Promise<void>) | undefined;
const denied = 'ego lite closed the connection because ego-browser is running as administrator. Run ego-browser from a terminal that is not elevated.';
beforeEach(async () => { dir = await mkdtemp(join(process.cwd(), '.test-data-')); close = undefined; });
afterEach(async () => { await close?.(); if (!dir.startsWith(join(process.cwd(), '.test-data-'))) throw new Error('Unsafe cleanup'); await rm(dir, { recursive: true, force: true }); });
it('classifies the exact administrator rejection as a pre-execution connection failure', () => {
  expect(normalizeFailure({ error: `UNCERTAIN: ego-browser exited 9: ${denied}`, uncertain: true })).toMatchObject({ code: 'EGO_CLIENT_ELEVATED', uncertain: false });
  expect(normalizeFailure({ error: 'ego-browser exited 9: connection lost', uncertain: true }).uncertain).toBe(true);
});
it('does not replace a real user-control stop with an administrator error quoted in diagnostics', () => {
  expect(normalizeFailure({ code: 'EGO_TASK_SPACE_USER_IN_CONTROL', error: `User control. Earlier error: ${denied}`, uncertain: true }).code).toBe('EGO_TASK_SPACE_USER_IN_CONTROL');
});
it('refuses to start an elevated helper before creating the endpoint', async () => {
  await expect(startHelper({ dir, checkElevated: async () => true })).rejects.toThrow('EGO_CLIENT_ELEVATED');
  await expect(readFile(join(dir, 'endpoint.json'))).rejects.toMatchObject({ code: 'ENOENT' });
});
it('authenticates local requests and rejects cross-origin requests and unknown operations', async () => {
  let called = 0;
  const helper = await startHelper({ dir, checkElevated: async () => false, bridge: { run: async () => { called++; return { value: null }; } } }); close = helper.close;
  const { port, token } = await readEndpoint(dir);
  const url = `http://127.0.0.1:${port}`;
  expect((await fetch(`${url}/health`)).status).toBe(401);
  expect((await fetch(`${url}/health`, { headers: { authorization: `Bearer ${token}`, origin: 'https://example.com' } })).status).toBe(403);
  expect((await fetch(`${url}/run`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ operation: 'node', args: {} }) })).status).toBe(400);
  expect(await new HelperBridge(dir, () => 1000).probe()).toBe(true);
  expect((await new HelperBridge(dir, () => 1000).run('tabs', {})).value).toBe(null); expect(called).toBe(1);
});
it('automatically uses the helper only after a definite elevated-client rejection', async () => {
  const ops: string[] = [];
  const ordinary: EgoBridge = { run: async (op) => { ops.push(op); return { value: 'ordinary' }; } };
  const elevated: EgoBridge = { run: async () => ({ error: denied, uncertain: true }) };
  const bridge = new AutoBridge(elevated, ordinary, 'auto');
  expect((await bridge.run('connect', {})).value).toBe('ordinary'); expect(bridge.selected).toBe('helper');
  expect(ops).toEqual(['connect']);
  const uncertain = new AutoBridge({ run: async () => ({ error: 'timed out', uncertain: true }) }, ordinary, 'auto');
  expect((await uncertain.run('click', {})).uncertain).toBe(true); expect(ops).toEqual(['connect']);
});
it('chooses the helper before launching any client when the host is elevated', async () => {
  let directCalls = 0;
  const bridge = new AutoBridge({ run: async () => { directCalls++; return { value: null }; } }, { run: async () => ({ value: 'ordinary-helper' }) }, 'auto', async () => true);
  expect((await bridge.run('connect', {})).value).toBe('ordinary-helper'); expect(directCalls).toBe(0);
});
it('keeps helper-unavailable failures retryable without dispatching a browser operation', async () => {
  const result = await new HelperBridge(dir, () => 1000).run('connect', {});
  expect(result).toMatchObject({ code: 'EGO_HELPER_UNAVAILABLE', uncertain: false });
});
it('supports an authenticated shutdown and removes its own endpoint', async () => {
  const service = await startHelper({ dir, checkElevated: async () => false, bridge: { run: async () => ({ value: null }) } }); close = service.close;
  const bridge = new HelperBridge(dir, () => 1000); await bridge.stop(); await service.close();
  expect(await bridge.probe()).toBe(false); await expect(readEndpoint(dir)).rejects.toMatchObject({ code: 'ENOENT' });
});
