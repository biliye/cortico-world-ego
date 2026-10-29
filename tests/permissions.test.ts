import { afterEach, expect, it } from 'vitest';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { isElevated } from '../src/permissions.ts';

const windows = it.runIf(process.platform === 'win32');
let dir: string | undefined;
let originalPath: string | undefined;
afterEach(async () => {
  if (originalPath !== undefined) { process.env.PATH = originalPath; originalPath = undefined; }
  if (dir && dir.startsWith(join(process.cwd(), '.test-data-permissions-'))) {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
  dir = undefined;
});
windows('keeps using the system whoami when PATH has a different whoami.exe first', async () => {
  dir = await mkdtemp(join(process.cwd(), '.test-data-permissions-'));
  // Any same-named program that rejects the Windows /groups flag reproduces the Git Bash install.
  await copyFile(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'where.exe'), join(dir, 'whoami.exe'));
  originalPath = process.env.PATH;
  process.env.PATH = dir + ';' + (originalPath ?? '');
  await expect(isElevated()).resolves.toEqual(expect.any(Boolean));
});
