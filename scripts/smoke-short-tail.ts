/** Regression for an ended video losing the frames collected before its first 15 s scene. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { EgoWorld } from '../src/world.ts';
import { CliBridge } from '../src/bridge.ts';
import { EGO_DEFAULTS } from '../src/config.ts';
import { nullLogger } from 'cortico/core/util.ts';
import type { DeferredEventSpec, ToolOutcome, WorldHost } from 'cortico/core/types.ts';
const dir = resolve('.test-data', 'smoke-short-tail'); await mkdir(dir, { recursive: true });
const evidence: Record<string, any> = { startedAt: new Date().toISOString(), events: [] };
const server = createServer((_req, res) => {
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.end(`<!doctype html><meta charset="utf-8"><title>Ego short tail fixture</title><video controls muted width="640"></video><script>
const c=document.createElement('canvas');c.width=640;c.height=360;const g=c.getContext('2d');let n=0;
const draw=setInterval(()=>{g.fillStyle=['#137464','#783dc7','#a33745','#2859ba'][Math.floor(n/8)%4];g.fillRect(0,0,640,360);g.fillStyle='#fff';g.font='36px sans-serif';g.fillText('SHORT VIDEO FRAME '+n++,32,180);},100);
const chunks=[],rec=new MediaRecorder(c.captureStream(10),{mimeType:'video/webm'});
rec.ondataavailable=e=>chunks.push(e.data);rec.onstop=()=>{clearInterval(draw);const v=document.querySelector('video');v.src=URL.createObjectURL(new Blob(chunks,{type:'video/webm'}));v.playbackRate=0.2;const tr=v.addTextTrack('subtitles','片尾验收','zh');tr.mode='hidden';tr.addCue(new VTTCue(0,60,'片尾已采样画面必须投递'));v.play().then(()=>window.fixtureReady=true);};rec.start();setTimeout(()=>rec.stop(),3500);
</script>`);
});
await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
const cfg = structuredClone(EGO_DEFAULTS); cfg.enabled = true; cfg.spaceName = process.env.CORTICO_EGO_SMOKE_SPACE || `ego-short-tail-${Date.now()}`;
const bridge = new CliBridge({ cliFile: cfg.cliFile, dataDir: dir, timeoutMs: () => 45000 });
const world = new EgoWorld({ cfg, dataDir: dir, botDir: dir, timezone: 'Asia/Shanghai', bridge });
const scenes: DeferredEventSpec[] = [];
const host = { log: nullLogger(), pushEvent: async (event: any) => { evidence.events.push({ type: event.type, text: event.text }); return event; }, pushDeferred: (event: DeferredEventSpec) => { scenes.push(event); } } as unknown as WorldHost;
async function call(name: string, args: Record<string, unknown> = {}): Promise<ToolOutcome> {
  const raw = await world.tools().find(t => t.name === `ego_${name}`)!.handler(args, { role: 'smoke', log: nullLogger() });
  const result = typeof raw === 'string' ? { text: raw } : raw; assert(!result.failed, result.text); return result;
}
const data = (value: ToolOutcome) => JSON.parse(value.text.slice(value.text.indexOf('\n') + 1));
try {
  await world.start(host); evidence.status = world.status(); console.log(JSON.stringify({ spaceId: world.status().spaceId, spaceName: cfg.spaceName }));
  assert(world.status().connected, JSON.stringify(world.status()));
  const page = data(await call('open', { url: `http://127.0.0.1:${(server.address() as any).port}/` })).page;
  const ready = await bridge.run('evaluate', { spaceId: world.status().spaceId, page, expression: `(async()=>{const end=Date.now()+12000;while(Date.now()<end){if(window.fixtureReady&&document.querySelector('video').readyState>=2)return true;await new Promise(r=>setTimeout(r,100));}throw new Error('video not decoded')})()` });
  assert(!ready.error, ready.error); assert.equal(ready.value, true);
  await call('video', { page, action: 'pause' }); await call('video', { page, action: 'seek', time: 2 });
  const preview = data(await call('video', { page, action: 'watch' }));
  assert.equal(preview.capture, 'video-frame'); assert.equal(preview.frameCount, 1); assert.equal(preview.observation.phase, 'collecting');
  evidence.preview = preview;
  const deadline = Date.now() + 23000;
  while (!scenes.length && Date.now() < deadline) await new Promise(r => setTimeout(r, 100));
  assert(scenes.length, 'No short-tail scene was delivered');
  const rendered = await scenes.at(-1)!.render(); assert(rendered && typeof rendered !== 'string' && rendered.blobs?.length);
  const final = JSON.parse(rendered.text!.slice(rendered.text!.indexOf('\n', rendered.text!.indexOf('totalChars=')) + 1));
  assert.equal(final.capture, 'video-mosaic'); assert(final.frameCount >= 2); assert.equal(final.frameTimes.length, final.frameCount);
  assert.equal(final.observation.phase, 'ended'); assert(final.ended); assert.equal(world.status().watching, null);
  evidence.final = final; await writeFile(join(dir, 'tail-mosaic.jpg'), (rendered.blobs[0] as any).bytes);
  await call('video', { page, action: 'pause' }); assert.equal(await scenes.at(-1)!.render(), null);
  await world.stop(); const finished = await bridge.run('finish', { spaceId: world.status().spaceId }); assert(!finished.error, finished.error);
  evidence.finished = finished.value; evidence.ok = true; console.log(JSON.stringify({ ok: true, frameTimes: final.frameTimes, frameCount: final.frameCount, phase: final.observation.phase, finished: finished.value }));
} catch (error) { evidence.ok = false; evidence.error = String(error); process.exitCode = 1; console.error(error); }
finally { await world.stop(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); await writeFile(join(dir, 'result.json'), JSON.stringify(evidence, null, 2)); }
