/** Local synthetic media only. Uses the goal's existing Space, then finishes it on success. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { EgoWorld } from '../src/world.ts';
import { CliBridge } from '../src/bridge.ts';
import { EGO_DEFAULTS } from '../src/config.ts';
import { nullLogger } from 'cortico/core/util.ts';
import type { DeferredEventSpec, ToolOutcome, WorldHost } from 'cortico/core/types.ts';
const dir = resolve('.test-data', 'smoke-video-window');
await mkdir(dir, { recursive: true });
const evidence: Record<string, unknown> = { startedAt: new Date().toISOString(), steps: [] };
const steps = evidence.steps as any[];
const videoHtml = `<!doctype html><meta charset="utf-8"><title>Ego video fixture</title>
<h1>视频字幕验收</h1><video id="video" controls muted loop width="640"></video>
<script>
const c=document.createElement('canvas');c.width=640;c.height=360;const g=c.getContext('2d');
let n=0;const draw=setInterval(()=>{g.fillStyle=n%2?'#783dc7':'#137464';g.fillRect(0,0,640,360);g.fillStyle='#fff';g.font='36px sans-serif';g.fillText('EGO VIDEO FRAME '+n++,40,180);},100);
const chunks=[];const recorder=new MediaRecorder(c.captureStream(10),{mimeType:'video/webm'});
recorder.ondataavailable=e=>chunks.push(e.data);recorder.onstop=()=>{clearInterval(draw);const v=document.querySelector('video');v.src=URL.createObjectURL(new Blob(chunks,{type:'video/webm'}));const track=v.addTextTrack('subtitles','验收字幕','zh');track.mode='showing';track.addCue(new VTTCue(0,10,'紫色与绿色画面，Ego 字幕验收成功'));v.play().then(()=>window.fixtureReady=true);};
recorder.start();setTimeout(()=>recorder.stop(),3500);
</script>`;
const server = createServer((req, res) => {
  res.setHeader('content-type', 'text/html; charset=utf-8');
  if (req.url === '/video') res.end(videoHtml);
  else if (req.url === '/live') res.end(`<!doctype html><meta charset="utf-8"><title>Ego live video fixture</title><video controls muted width="640"></video><script>
const c=document.createElement('canvas');c.width=640;c.height=360;const g=c.getContext('2d');const start=performance.now();
setInterval(()=>{const t=(performance.now()-start)/1000;g.fillStyle=['#137464','#783dc7','#a33745','#2859ba'][Math.floor(t/4)%4];g.fillRect(0,0,640,360);g.fillStyle='#fff';g.font='36px sans-serif';g.fillText('EGO VIDEO '+t.toFixed(1)+' seconds',32,180);},100);
const v=document.querySelector('video');v.srcObject=c.captureStream(10);const tr=v.addTextTrack('subtitles','字幕验收','zh');tr.mode='showing';tr.addCue(new VTTCue(0,60,'Ego 15 秒内多帧采样验收'));v.play().then(()=>window.fixtureReady=true);
</script>`);
  else if (req.url === '/iframe') res.end(`<title>Cross origin video</title><h1>iframe fixture</h1><iframe width="800" height="550" src="http://localhost:${(server.address() as any).port}/video"></iframe>`);
  else res.end('<!doctype html><meta charset="utf-8"><title>Ego World smoke</title><h1>浏览器验收</h1><label>关键词 <input id="query"></label><button id="submit" onclick="document.querySelector(\'#result\').textContent=document.querySelector(\'#query\').value">提交</button><p id="result"></p><a id="popup" href="/popup" target="_blank">新开页面</a>');
});
await new Promise<void>(r => server.listen(0, r));
const port = (server.address() as any).port;
const cfg = structuredClone(EGO_DEFAULTS); cfg.enabled = true; cfg.spaceName = process.env.CORTICO_EGO_SMOKE_SPACE || `ego-video-window-${Date.now()}`;
const bridge = new CliBridge({ cliFile: cfg.cliFile, dataDir: dir, timeoutMs: () => 45000 });
const world = new EgoWorld({ cfg, dataDir: dir, botDir: dir, timezone: 'Asia/Shanghai', bridge });
const scenes: DeferredEventSpec[] = [];
const host = { log: nullLogger(), pushEvent: async (e: any) => { steps.push({ event: e.type, text: e.text }); return e; }, pushDeferred: (e: DeferredEventSpec) => { scenes.push(e); } } as unknown as WorldHost;
async function call(name: string, args: Record<string, unknown>): Promise<ToolOutcome> {
  const raw = await world.tools().find(t => t.name === `ego_${name}`)!.handler(args, { role: 'smoke', log: nullLogger() });
  const value = typeof raw === 'string' ? { text: raw } : raw;
  assert(!value.failed, `${name}: ${value.text}`);
  steps.push({ tool: name, text: value.text.slice(0, 1500), blobs: value.blobs?.length ?? 0 });
  console.log(`PASS ${name}`); return value;
}
function data(result: ToolOutcome) { return JSON.parse(result.text.slice(result.text.indexOf('\n') + 1)); }
try {
  await world.start(host); assert(world.status().connected, JSON.stringify(world.status()));
  const existing = data(await call('tabs', {}));
  for (const tab of existing) if (tab.page && tab.openedBy === 'agent' && /^http:\/\/(127\.0\.0\.1|localhost):\d+\//.test(tab.url)) await call('close', { page: tab.page });
  const opened = data(await call('open', { url: `http://127.0.0.1:${port}/` }));
  const page = opened.page; assert.match(page, /^p\d+$/);
  await call('fill', { page, selector: '#query', text: 'ego-中文-世界' });
  await call('click', { page, selector: '#submit' });
  assert.match((await call('read', { page })).text, /ego-中文-世界/);
  const popup = data(await call('click', { page, selector: '#popup' }));
  assert(popup.pages.length >= 2); steps.push({ popupLabels: popup.pages.map((p: any) => p.page) });
  await call('shot', { page });
  await call('navigate', { page, url: `http://127.0.0.1:${port}/video` });
  // Browser-side polling, not sleeps, waits for the synthetic recording and decoder.
  const ready = await bridge.run('evaluate', { spaceId: world.status().spaceId, page,
    expression: `(async()=>{const end=Date.now()+12000;while(Date.now()<end){if(window.fixtureReady&&document.querySelector('video').readyState>=2)return true;await new Promise(r=>setTimeout(r,100));}throw new Error('synthetic video not ready')})()` });
  assert(!ready.error, ready.error); assert.equal(ready.value, true);
  const look = await call('video', { page, action: 'look' });
  assert.equal(data(look).capture, 'video-frame'); assert.match(look.text, /Ego 字幕验收成功/);
  assert(look.blobs?.length); await writeFile(join(dir, 'video-frame.jpg'), (look.blobs![0] as any).bytes);
  await call('video', { page, action: 'pause' });
  const seek = data(await call('video', { page, action: 'seek', time: 1 })); assert(Math.abs(seek.time - 1) < 0.15);
  await call('navigate', { page, url: `http://127.0.0.1:${port}/live` });
  await call('video', { page, action: 'watch' });
  const deadline = Date.now() + 25000;
  while (!scenes.length && Date.now() < deadline) await new Promise(r => setTimeout(r, 100));
  assert(scenes.length > 0, 'No periodic scene received');
  const scene = await scenes[0].render(); assert(scene && typeof scene !== 'string' && scene.blobs?.length);
  const sceneData = JSON.parse(scene.text!.slice(scene.text!.indexOf('totalChars=') >= 0 ? scene.text!.indexOf('\n', scene.text!.indexOf('totalChars=')) + 1 : 0));
  assert.equal(sceneData.capture, 'video-mosaic'); assert.equal(sceneData.frameTimes.length, 4);
  assert(sceneData.frameTimes.at(-1) - sceneData.frameTimes[0] >= 10, 'Frames must span the current observation window');
  evidence.periodicScene = sceneData;
  await writeFile(join(dir, 'video-mosaic.jpg'), (scene.blobs[0] as any).bytes);
  await call('video', { page, action: 'pause' }); assert.equal(await scenes[0].render(), null);
  await call('navigate', { page, url: `http://127.0.0.1:${port}/iframe` });
  // Cross-origin iframe access is through Page CDP; parent DOM cannot see this video.
  const frameDeadline = Date.now() + 15000;
  let frame;
  do {
    frame = data(await call('video', { page, action: 'inspect' }));
    if (frame.found && frame.readyState >= 2) break;
    await new Promise(r => setTimeout(r, 500));
  } while (Date.now() < frameDeadline);
  assert(frame.found && frame.readyState >= 2, 'Cross-origin video not decoded');
  const iframeLook = await call('video', { page, action: 'look', frameId: frame.frameId });
  assert.equal(data(iframeLook).capture, 'video-frame'); assert.match(iframeLook.text, /Ego 字幕验收成功/);
  await call('close', { page });
  await world.stop();
  const finished = await bridge.run('finish', { spaceId: world.status().spaceId }); assert(!finished.error, finished.error);
  evidence.finished = finished.value; evidence.ok = true;
  console.log('PASS periodic observation, stale-scene cancellation, cross-origin video; task finished, protected tabs preserved');
} catch (error) { evidence.ok = false; evidence.error = String(error); process.exitCode = 1; console.error(error); }
finally {
  await world.stop(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r()));
  await writeFile(join(dir, 'result.json'), JSON.stringify(evidence, null, 2));
}
