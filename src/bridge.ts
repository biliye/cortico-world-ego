/** Each CLI round has private input/output files; command text never goes through a shell. */
import { spawn } from 'node:child_process';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { normalizeFailure } from './failures.ts';
export interface EvaluationTimeout {
  page?: string; timeoutMs?: number; executionStopped?: boolean; pageResponsive?: boolean; mayHaveLateEffects?: boolean;
}
export interface BridgeReceipt {
  spaceId?: number;
  value?: any;
  error?: string;
  code?: string;
  uncertain?: boolean;
  evaluation?: EvaluationTimeout;
}
export interface EgoBridge {
  run(operation: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<BridgeReceipt>;
}
export class CliBridge implements EgoBridge {
  constructor(private readonly options: { cliFile: string; dataDir: string; timeoutMs: () => number; runtimeUrl?: string }) {}
  async run(operation: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<BridgeReceipt> {
    signal?.throwIfAborted();
    const dir = resolve(this.options.dataDir, 'ego', 'rounds');
    await mkdir(dir, { recursive: true });
    const id = randomUUID();
    const input = join(dir, `${id}.mjs`), output = join(dir, `${id}.json`), screenshotFile = join(dir, `${id}.png`);
    const runtime = this.options.runtimeUrl ?? new URL('./bridge-runtime.mjs', import.meta.url).href;
    const request = JSON.stringify({ operation, args: { ...args, screenshotFile } });
    await writeFile(input, `import { execute } from ${JSON.stringify(runtime)};\nimport { writeFile } from 'node:fs/promises';\nawait writeFile(${JSON.stringify(output)}, JSON.stringify(await execute(${request})), {mode:0o600});\n`, { mode: 0o600 });
    let stderr = '', launched = false;
    try {
      signal?.throwIfAborted();
      const file = this.options.cliFile || 'ego-browser';
      if (/\.(cmd|bat|ps1)$/i.test(file)) throw new Error('cliFile 必须是可执行文件（Windows 使用 ego-browser.exe），不能是 shell 脚本。');
      const code = `await import(${JSON.stringify(pathToFileURL(input).href)})`;
      await new Promise<void>((done, fail) => {
        const child = spawn(file, ['nodejs', '-e', code], { shell: false, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
        child.on('spawn', () => { launched = true; });
        let settled = false;
        const finish = (error?: Error) => {
          if (settled) return;
          settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
          if (error) fail(error); else done();
        };
        const abort = () => { child.kill(); finish(Object.assign(new Error('Ego 命令已取消；浏览器端可能仍有未完成操作。请在面板核对并恢复。'), { uncertain: true })); };
        const timer = setTimeout(() => { child.kill(); finish(Object.assign(new Error(`Ego command timed out after ${this.options.timeoutMs()}ms; browser-side effects may still finish. Check the Space before resuming.`), { uncertain: true, code: 'EGO_COMMAND_TIMEOUT' })); }, this.options.timeoutMs());
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
        child.stderr?.on('data', (chunk) => { if (stderr.length < 8000) stderr += chunk.toString(); });
        child.on('error', (error) => finish(error));
        child.on('close', (exitCode) => finish(exitCode === 0 ? undefined : new Error(`ego-browser exited ${exitCode}: ${stderr.trim()}`)));
      });
      const receipt = JSON.parse(await readFile(output, 'utf8')) as BridgeReceipt;
      if (!receipt || typeof receipt !== 'object' || (!('value' in receipt) && !receipt.error)) throw new Error('Invalid Ego receipt');
      return receipt;
    } catch (error) {
      return normalizeFailure({ error: error instanceof Error ? error.message : String(error), code: (error as { code?: string }).code === 'EGO_COMMAND_TIMEOUT' ? 'EGO_COMMAND_TIMEOUT' : undefined, uncertain: (error as { uncertain?: boolean }).uncertain ?? launched });
    } finally {
      await Promise.allSettled([unlink(input), unlink(output), unlink(screenshotFile)]);
    }
  }
}
