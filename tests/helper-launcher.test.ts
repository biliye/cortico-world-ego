import { afterEach, beforeEach, expect, it } from 'vitest';
import { build } from 'esbuild';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, open, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { HelperBridge, readEndpoint } from '../src/helper-bridge.ts';

const windows = it.runIf(process.platform === 'win32');
let root: string, helperDir: string, bundle: string, encoded: string;
const exec = promisify(execFile);
beforeEach(async () => {
  if (process.platform !== 'win32') return;
  root = await mkdtemp(join(process.cwd(), '.test-data-launcher-'));
  const fixture = join(root, "中文 包 & ' %");
  helperDir = join(fixture, "助手 data & ' %");
  bundle = join(fixture, 'dist', 'ego-helper.mjs');
  const module = join(fixture, 'src', 'launcher.mjs');
  await mkdir(join(fixture, 'dist'), { recursive: true });
  await build({ entryPoints: [resolve('src/helper-launcher.ts')], outfile: module, bundle: true, format: 'esm', platform: 'node', target: 'node22' });
  // Use native Node import so the fixture retains import.meta.url relative to its own bundle.
  const code = `const {prepareHelperLauncher}=await import(${JSON.stringify(pathToFileURL(module).href)});await prepareHelperLauncher(${JSON.stringify(helperDir)},'ego-browser');`;
  await exec(process.execPath, ['--input-type=module', '-e', code], { windowsHide: true });
  encoded = (await readFile(join(helperDir, 'start-ego-helper.cmd'), 'ascii')).match(/-EncodedCommand ([A-Za-z0-9+/=]+)/)![1];
});
afterEach(async () => {
  if (process.platform !== 'win32' || !root) return;
  const helper = new HelperBridge(helperDir, () => 1000);
  const endpoint = await readEndpoint(helperDir).catch(() => undefined);
  if (await helper.probe()) {
    await helper.stop();
  }
  if (endpoint) {
    // Only this test's generated fixture writes this isolated endpoint.
    for (let n = 0; n < 20; n++) {
      try { process.kill(endpoint.pid, 0); } catch { break; }
      await new Promise(r => setTimeout(r, 50));
    }
    try { process.kill(endpoint.pid); } catch { /* Already exited. */ }
  }
  if (!root.startsWith(join(process.cwd(), '.test-data-launcher-'))) throw new Error('Unsafe cleanup');
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});
async function launch(prefix = '') {
  const payload = prefix + Buffer.from(encoded, 'base64').toString('utf16le');
  const stdoutFile = join(root, 'launcher.stdout.log'), stderrFile = join(root, 'launcher.stderr.log');
  const stdout = await open(stdoutFile, 'w'), stderr = await open(stderrFile, 'w');
  let code: number | null;
  try {
    // File handles model a console launch; a surviving helper must not hold an execFile pipe open.
    code = await new Promise<number | null>((done, fail) => {
      const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-EncodedCommand', Buffer.from(payload, 'utf16le').toString('base64')], { windowsHide: true, stdio: ['ignore', stdout.fd, stderr.fd] });
      const timer = setTimeout(() => { child.kill(); fail(new Error('Launcher did not exit within 18 seconds')); }, 18000);
      child.once('error', error => { clearTimeout(timer); fail(error); });
      child.once('exit', value => { clearTimeout(timer); done(value); });
    });
  } finally { await stdout.close(); await stderr.close(); }
  return { code, stdout: await readFile(stdoutFile, 'utf8'), stderr: await readFile(stderrFile, 'utf8') };
}
windows('reports a missing helper bundle and preserves a startup diagnostic', async () => {
  const result = await launch();
  expect(result.code).toBe(1);
  expect(result.stdout).toContain('ego-helper.mjs');
  expect(await readFile(join(helperDir, 'launcher.log'), 'utf8')).toContain('ego-helper.mjs');
  await expect(readEndpoint(helperDir)).rejects.toMatchObject({ code: 'ENOENT' });
});
windows('explains that Node must be installed when it is absent from the ordinary-user PATH', async () => {
  await writeFile(bundle, 'throw new Error("must not start");');
  const result = await launch("$env:Path = ''\n");
  expect(result.code).toBe(1);
  expect(result.stdout).toContain('未找到 Node.js');
  expect(result.stdout).toContain('22');
});
windows('rejects an older Node before starting a hidden child', async () => {
  await writeFile(bundle, 'throw new Error("must not start");');
  const oldNode = join(root, 'old-node.ps1');
  await writeFile(oldNode, "Write-Output 'v20.19.0'\nexit 0\n");
  const result = await launch(`function Get-Command { [pscustomobject]@{Source='${oldNode.replace(/'/g, "''")}'} }\n`);
  expect(result.code).toBe(1);
  expect(result.stdout).toContain('v20.19.0');
  expect(result.stdout).toContain('22');
});
windows('shows a hidden child startup error instead of reporting success', async () => {
  await writeFile(bundle, "console.error('TEST_HELPER_STARTUP_CRASH');process.exitCode=7;");
  const result = await launch();
  expect(result.code).toBe(1);
  expect(result.stdout).toContain('TEST_HELPER_STARTUP_CRASH');
  expect(await readFile(join(helperDir, 'helper.stderr.log'), 'utf8')).toContain('TEST_HELPER_STARTUP_CRASH');
  await expect(readEndpoint(helperDir)).rejects.toMatchObject({ code: 'ENOENT' });
});
windows('starts the bundled ordinary-permission helper without touching a browser', async () => {
  await build({ entryPoints: [resolve('src/helper.ts')], outfile: bundle, bundle: true, format: 'esm', platform: 'node', target: 'node22' });
  const result = await launch();
  expect(result.code).toBe(0);
  expect(await new HelperBridge(helperDir, () => 1000).probe()).toBe(true);
  const endpoint = await readEndpoint(helperDir);
  expect(result.stdout + result.stderr).not.toContain(endpoint.token);
});
windows('requires authenticated readiness and does not launch or overwrite logs on a second run', async () => {
  await writeFile(bundle, `
    import {createServer} from 'node:http';
    import {writeFile,unlink} from 'node:fs/promises';
    import {join} from 'node:path';
    const dir=process.argv[process.argv.indexOf('--dir')+1],token='a'.repeat(64);
    const server=createServer((req,res)=>{
      if(req.headers.authorization!=='Bearer '+token){res.writeHead(401);res.end();return;}
      res.setHeader('content-type','application/json');
      res.end(JSON.stringify({protocol:2,elevated:false,pid:process.pid}));
      if(req.url==='/shutdown')server.close(()=>unlink(join(dir,'endpoint.json')));
    });
    server.listen(0,'127.0.0.1',async()=>{
      console.error('preserve-existing-log');
      // A partially written endpoint must not be mistaken for readiness.
      await writeFile(join(dir,'endpoint.json'),'{');
      setTimeout(async()=>{await writeFile(join(dir,'endpoint.json'),JSON.stringify({protocol:2,port:server.address().port,token,pid:process.pid}));},300);
    });
  `);
  const first = await launch();
  expect(first.code).toBe(0);
  expect(await new HelperBridge(helperDir, () => 1000).probe()).toBe(true);
  const endpoint = await readEndpoint(helperDir);
  expect(first.stdout + first.stderr).not.toContain(endpoint.token);
  const originalLog = await readFile(join(helperDir, 'helper.stderr.log'), 'utf8');
  expect(originalLog).toContain('preserve-existing-log');
  const second = await launch();
  expect(second.code).toBe(0);
  expect(second.stdout).toContain('已经在运行');
  expect((await readEndpoint(helperDir)).pid).toBe(endpoint.pid);
  expect(await readFile(join(helperDir, 'helper.stderr.log'), 'utf8')).toBe(originalLog);
});
