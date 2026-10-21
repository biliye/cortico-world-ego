/** A user-launched, non-elevated broker. All browser scripts are built by CliBridge. */
import { createServer, type IncomingMessage } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CliBridge, type EgoBridge } from './bridge.ts';
import { HELPER_PROTOCOL, HelperBridge } from './helper-bridge.ts';
import { isElevated } from './permissions.ts';
export { isElevated } from './permissions.ts';
const OPERATIONS = new Set(['connect', 'resume', 'tabs', 'handoff', 'finish', 'open', 'read', 'navigate', 'click', 'fill', 'press', 'scroll', 'evaluate', 'shot', 'close', 'video', 'bilibili']);
async function body(req: IncomingMessage): Promise<string> {
  let result = '';
  for await (const part of req) { result += part.toString('utf8'); if (Buffer.byteLength(result) > 128000) throw new Error('Request body exceeds 128 KB'); }
  return result;
}
export async function startHelper(options: { dir: string; cliFile?: string; timeoutMs?: number; bridge?: EgoBridge; checkElevated?: () => Promise<boolean> }) {
  if (await (options.checkElevated ?? isElevated)()) throw new Error('EGO_CLIENT_ELEVATED: 普通权限助手不能以管理员身份运行。请在文件资源管理器中双击启动脚本，不要从管理员命令行启动。');
  const dir = resolve(options.dir);
  await mkdir(dir, { recursive: true });
  if (await new HelperBridge(dir, () => 45000).probe()) throw new Error('EGO_HELPER_ALREADY_RUNNING: This directory already has a running helper.');
  const token = randomBytes(32).toString('hex');
  const bridge = options.bridge ?? new CliBridge({ cliFile: options.cliFile || 'ego-browser', dataDir: dir, timeoutMs: () => options.timeoutMs ?? 45000,
    runtimeUrl: new URL('../src/bridge-runtime.mjs', import.meta.url).href });
  let queue = Promise.resolve();
  let closeServer = async () => {};
  const server = createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json; charset=utf-8'); res.setHeader('cache-control', 'no-store');
    const reply = (status: number, value: unknown) => { res.writeHead(status); res.end(JSON.stringify(value)); };
    const auth = req.headers.authorization ?? '';
    const wanted = `Bearer ${token}`;
    if (req.headers.origin || !/^127\.0\.0\.1:\d+$/.test(req.headers.host ?? '')) return reply(403, { error: 'Local requests without Origin only' });
    if (Buffer.byteLength(auth) !== Buffer.byteLength(wanted) || !timingSafeEqual(Buffer.from(auth), Buffer.from(wanted))) return reply(401, { error: 'Unauthorized' });
    if (req.url === '/health' && req.method === 'GET') return reply(200, { protocol: HELPER_PROTOCOL, elevated: false, pid: process.pid });
    if (req.url === '/shutdown' && req.method === 'POST') {
      reply(200, { value: null }); void closeServer().catch(() => {}); return;
    }
    if (req.url !== '/run' || req.method !== 'POST') return reply(404, { error: 'Not found' });
    try {
      if (!req.headers['content-type']?.startsWith('application/json')) return reply(415, { error: 'JSON required' });
      const request = JSON.parse(await body(req));
      if (!OPERATIONS.has(request.operation) || !request.args || typeof request.args !== 'object' || Array.isArray(request.args)) return reply(400, { error: 'Unsupported operation or arguments' });
      const run = queue.then(() => bridge.run(request.operation, request.args));
      queue = run.then(() => {}, () => {});
      return reply(200, await run);
    } catch (error) { return reply(400, { error: String(error) }); }
  });
  await new Promise<void>((done, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', () => { server.off('error', fail); done(); }); });
  const port = (server.address() as { port: number }).port;
  const endpointFile = join(dir, 'endpoint.json');
  const temporary = join(dir, `endpoint-${process.pid}.json`);
  try {
    await writeFile(temporary, JSON.stringify({ protocol: HELPER_PROTOCOL, port, token, pid: process.pid }), { mode: 0o600 });
    await rename(temporary, endpointFile);
  } catch (error) {
    server.closeAllConnections(); await new Promise<void>(r => server.close(() => r()));
    await unlink(temporary).catch(() => {}); throw error;
  }
  let closing: Promise<void> | undefined;
  closeServer = () => closing ??= (async () => {
    server.closeIdleConnections(); await new Promise<void>(r => server.close(() => r()));
    try { if (JSON.parse(await readFile(endpointFile, 'utf8')).token === token) await unlink(endpointFile); } catch { /* Another helper may have replaced a stale endpoint. */ }
  })();
  return { port, close: closeServer };
}
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const value = (key: string) => { const i = args.indexOf(key); return i >= 0 ? args[i + 1] : undefined; };
  const dir = value('--dir'); if (!dir) throw new Error('Usage: node ego-helper.mjs --dir <helper directory> [--cli <ego-browser executable>]');
  const helper = await startHelper({ dir, cliFile: value('--cli') });
  console.log(`Ego ordinary-permission helper ready on 127.0.0.1:${helper.port}`);
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => void helper.close().then(() => process.exit(0)));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(String(error)); process.exitCode = 1; });
}
