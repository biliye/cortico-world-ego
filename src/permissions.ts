import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
// Git for Windows also ships a GNU whoami.exe; it rejects the Windows /groups flag.
const systemWhoami = (): string => {
  const root = process.env.SystemRoot ?? process.env.WINDIR;
  const system = root ? join(root, 'System32', 'whoami.exe') : '';
  return system && existsSync(system) ? system : 'whoami.exe';
};
export async function isElevated(): Promise<boolean> {
  if (process.platform === 'win32') {
    const { stdout } = await promisify(execFile)(systemWhoami(), ['/groups', '/fo', 'csv', '/nh'], { windowsHide: true });
    return /S-1-16-(12288|16384|20480)\b/.test(stdout);
  }
  return process.getuid?.() === 0;
}
