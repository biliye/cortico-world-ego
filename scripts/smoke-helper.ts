/** Exercises the generated ordinary-user launcher, actual Ego transport and styled panel fixture. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { prepareHelperLauncher } from '../src/helper-launcher.ts';
import { HelperBridge, AutoBridge, readEndpoint } from '../src/helper-bridge.ts';
import { isElevated } from '../src/helper.ts';
const dir = resolve('.test-data', 'helper-fix');
const helperDir = join(dir, '普通权限助手');
await mkdir(dir, { recursive: true });
const result: Record<string, unknown> = { steps: [], hostElevated: await isElevated() };
const steps = result.steps as string[];
assert.equal(result.hostElevated, false, 'Run the test launcher from an ordinary-permission process');
const { launcherFile } = await prepareHelperLauncher(helperDir, 'ego-browser');
const encoded = (await readFile(launcherFile, 'ascii')).match(/-EncodedCommand ([A-Za-z0-9+/=]+)/)![1];
// Executes the exact PowerShell payload from the generated .cmd; starts helper hidden.
await promisify(execFile)('powershell.exe', ['-NoLogo', '-NoProfile', '-EncodedCommand', encoded], { windowsHide: true, timeout: 15000 });
const helper = new HelperBridge(helperDir, () => 45000);
const deadline = Date.now() + 12000;
while (!await helper.probe() && Date.now() < deadline) await new Promise(r => setTimeout(r, 100));
assert(await helper.probe(), 'Generated helper launcher did not become ready; inspect helper.stderr.log');
const endpoint = await readEndpoint(helperDir);
result.helperPid = endpoint.pid; result.helperElevated = false; steps.push('generated hidden launcher started a non-elevated helper');
const elevatedMessage = 'ego lite closed the connection because ego-browser is running as administrator. Run ego-browser from a terminal that is not elevated.';
const bridge = new AutoBridge({ run: async () => ({ error: elevatedMessage, uncertain: true }) }, helper, 'auto');
const spaceName = 'ego-helper-ui-fix-20261021';
let spaceId: number | undefined;
const fixture = await build({ stdin: { resolveDir: process.cwd(), loader: 'ts', contents: `
  import {createWebUi} from '../../cortico/src/web/client/ui/index.ts';
  import bundle from './src/webui/client.ts';
  const controller=new AbortController(); const memo={get:(_,v)=>v,set(){}};
  const state={running:true,connected:false,halted:false,reason:${JSON.stringify(elevatedMessage)},code:'EGO_HELPER_REQUIRED',spaceName:'Cortico-test',watching:null,connectionMode:'auto',transport:'helper',helperOnline:false,helperDir:${JSON.stringify(helperDir)},launcherFile:'',canPrepareHelper:true};
  const fixture=window.fixture={state,calls:[],refresh:null};
    const ctx={root:document.querySelector('#fixture-root'),signal:controller.signal,memo,language:'zh',
    ui:createWebUi({memo,signal:controller.signal,overlayHost:document.body}),
    interval(fn){fixture.refresh=fn;return{dispose(){}}},refresh:async()=>{},
    invoke:async(method)=>{fixture.calls.push(method);
      if(method==='prepare-helper'){state.launcherFile=${JSON.stringify(launcherFile)};state.helperOnline=true;}
      if(method==='connect'){state.helperOnline=true;state.connected=true;state.spaceId=7;state.reason='';state.code=undefined;}
      if(method==='handoff'){state.halted=true;state.connected=false;state.code='EGO_TASK_SPACE_USER_IN_CONTROL';}
      if(method==='resume'){state.halted=false;state.connected=true;state.code=undefined;}
      return structuredClone(state);
    }};
  bundle.panels.control.mount(ctx); window.fixtureReady=true;
` }, bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022' });
const styles = await readFile(resolve('../../cortico/dist/web/styles.css'));
const server = createServer((req, res) => {
  if (req.url === '/fixture.js') { res.setHeader('content-type', 'text/javascript'); res.end(fixture.outputFiles[0].text); }
  else if (req.url === '/styles.css') { res.setHeader('content-type', 'text/css'); res.end(styles); }
  else if (req.url === '/browser') { res.setHeader('content-type', 'text/html; charset=utf-8'); res.end('<title>Helper browser test</title><label>验收值<input id="value"></label><button id="save" onclick="document.querySelector(\'#out\').textContent=document.querySelector(\'#value\').value">提交</button><p id="out"></p>'); }
  else { res.setHeader('content-type', 'text/html; charset=utf-8'); res.end('<!doctype html><html lang="zh"><meta charset="utf-8"><title>Ego 设置修复验收</title><link rel="stylesheet" href="/styles.css"><style>body{padding:24px;display:block;height:auto;font:14px/1.6 var(--sans,system-ui)}#fixture-root{max-width:1000px;margin:0 auto;display:block;height:auto}ol{padding-left:24px;line-height:1.9}.mono{overflow-wrap:anywhere}button{cursor:pointer}</style><div id="fixture-root" class="panelslot"></div><script type="module" src="/fixture.js"></script></html>'); }
});
await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
async function run(operation: string, args: Record<string, unknown>) {
  const receipt = await bridge.run(operation, { ...args, spaceId, spaceName, restoreMinimized: true });
  assert(!receipt.error, `${operation}: ${receipt.error}`); spaceId = receipt.spaceId ?? spaceId; return receipt.value;
}
let passed = false;
try {
  const connectedSpace = await run('connect', {}); result.spaceId = spaceId; assert.equal(bridge.selected, 'helper'); console.log(`Ego test Space ${spaceId}`);
  const existing = connectedSpace.pages.find((item: any) => item.page && item.openedBy === 'agent');
  const page = existing?.page ?? (await run('open', { url: `${origin}/browser` })).page;
  if (existing) await run('navigate', { page, url: `${origin}/browser` });
  await run('fill', { page, selector: '#value', text: '普通权限助手-中文验收' });
  await run('click', { page, selector: '#save' });
  assert.match(await run('read', { page }), /普通权限助手-中文验收/); steps.push('helper executed real Ego open/fill/click/read');
  await run('navigate', { page, url: origin });
  const state = await run('evaluate', { page, expression: `({ready:window.fixtureReady,title:document.querySelector('[role=status]')?.textContent,buttons:[...document.querySelectorAll('button')].filter(b=>!b.closest('details:not([open])')).map(b=>b.textContent),rawVisible:[...document.querySelectorAll('pre')].some(e=>!e.closest('details:not([open])'))})` });
  assert(state.ready); assert.equal(state.title, '需要启动普通权限助手'); assert(!state.rawVisible); assert(!state.buttons.includes('交还 bot')); assert(!state.buttons.includes('暂停视频观看'));
  await run('click', { page, selector: "loc=role:button[name='生成启动脚本']" });
  const shot = await run('shot', { page }); await writeFile(join(dir, 'setup-panel.png'), Buffer.from(shot.image.base64, 'base64'));
  await run('click', { page, selector: "loc=role:button[name='连接浏览器']" });
  const connected = await run('evaluate', { page, expression: `({title:document.querySelector('[role=status]').textContent,buttons:[...document.querySelectorAll('button')].filter(b=>b.offsetParent!==null).map(b=>b.textContent),unstyled:[...document.querySelectorAll('button')].some(b=>!b.classList.contains('btn')),overflow:document.documentElement.scrollWidth>innerWidth})` });
  assert.equal(connected.title, '浏览器已连接'); assert(!connected.unstyled); assert(!connected.overflow); assert(!connected.buttons.includes('连接浏览器')); assert(connected.buttons.includes('我要操作浏览器'));
  const online = await run('shot', { page }); await writeFile(join(dir, 'connected-panel.png'), Buffer.from(online.image.base64, 'base64'));
  await run('click', { page, selector: "loc=role:button[name='我要操作浏览器']" });
  const paused = await run('evaluate', { page, expression: `({title:document.querySelector('[role=status]').textContent,buttons:[...document.querySelectorAll('button')].filter(b=>b.offsetParent!==null).map(b=>b.textContent)})` });
  assert.equal(paused.title, '浏览器由你操作'); assert(paused.buttons.includes('交还 bot')); assert(!paused.buttons.includes('连接浏览器'));
  await run('click', { page, selector: "loc=role:button[name='交还 bot']" });
  steps.push('styled panel: helper setup, connect, correct visible controls, handoff and resume');
  result.finished = await run('finish', {}); passed = true; result.ok = true;
} catch (error) { result.ok = false; result.error = String(error); console.error(error); process.exitCode = 1; }
finally {
  server.closeAllConnections(); await new Promise<void>(r => server.close(() => r()));
  try { process.kill(endpoint.pid, 'SIGTERM'); } catch { /* Test helper already stopped. */ }
  try { if ((await readEndpoint(helperDir)).pid === endpoint.pid) await unlink(join(helperDir, 'endpoint.json')); } catch { /* Helper cleaned its own endpoint. */ }
  await writeFile(join(dir, 'result.json'), JSON.stringify(result, null, 2));
  console.log(passed ? 'PASS helper launcher, real Ego transport and styled control panel' : 'FAIL; same test Space retained for diagnosis');
}
