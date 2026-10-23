import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { CliBridge } from '../src/bridge.ts';
vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
let dir: string, child: EventEmitter & { stderr: EventEmitter; kill: ReturnType<typeof vi.fn> };
beforeEach(async () => {
  dir = await mkdtemp(join(process.cwd(), '.test-data-'));
  child = Object.assign(new EventEmitter(), { stderr: new EventEmitter(), kill: vi.fn() });
  vi.mocked(spawn).mockImplementation(() => { queueMicrotask(() => child.emit('spawn')); return child as any; });
});
afterEach(async () => {
  vi.clearAllMocks();
  if (!dir.startsWith(join(process.cwd(), '.test-data-'))) throw new Error('Unsafe cleanup');
  await rm(dir, { recursive: true, force: true });
});
it('marks an actual command deadline with a stable timeout code without claiming the operation was cancelled', async () => {
  const result = await new CliBridge({ cliFile: 'fixture.exe', dataDir: dir, timeoutMs: () => 5 }).run('read', { spaceId: 1, page: 'p1' });
  expect(result).toMatchObject({ code: 'EGO_COMMAND_TIMEOUT', uncertain: true }); expect(child.kill).toHaveBeenCalledOnce();
});
it('keeps cancellation distinct from a recoverable observation deadline', async () => {
  const result = await new CliBridge({ cliFile: 'fixture.exe', dataDir: dir, timeoutMs: () => 1000 }).run('read', {}, AbortSignal.timeout(20));
  expect(result.uncertain).toBe(true); expect(result.code).toBeUndefined(); expect(child.kill).toHaveBeenCalledOnce();
});
it('keeps a missing executable classified as a pre-execution setup failure', async () => {
  vi.mocked(spawn).mockImplementation(() => { queueMicrotask(() => child.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }))); return child as any; });
  expect(await new CliBridge({ cliFile: 'fixture.exe', dataDir: dir, timeoutMs: () => 1000 }).run('tabs', {})).toMatchObject({ code: 'EGO_CLI_NOT_FOUND', uncertain: false });
});
