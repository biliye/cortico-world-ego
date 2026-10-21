import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
export async function isElevated(): Promise<boolean> {
  if (process.platform === 'win32') {
    const { stdout } = await promisify(execFile)('whoami.exe', ['/groups', '/fo', 'csv', '/nh'], { windowsHide: true });
    return /S-1-16-(12288|16384|20480)\b/.test(stdout);
  }
  return process.getuid?.() === 0;
}
