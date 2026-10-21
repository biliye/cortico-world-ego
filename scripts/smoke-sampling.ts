/** Real video-time sampling, temporary tuning and shared boundaries through a slow receipt. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { EgoWorld } from '../src/world.ts';
import { CliBridge } from '../src/bridge.ts';
import { EGO_DEFAULTS } from '../src/config.ts';
import { nullLogger } from 'cortico/core/util.ts';
import type { DeferredEventSpec, ToolOutcome, WorldHost } from 'cortico/core/types.ts';
const dir = resolve('.test-data', 'smoke-sampling'); await mkdir(dir, { recursive: true });
const evidence: Record<string, any> = { startedAt: new Date().toISOString(), events: [] };
const server = createServer((_req, res) => {
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.end(`<!doctype html><meta charset="utf-8"><title>Ego sampling fixture</title><video controls muted width="640"></video><script>
const c=document.createElement('canvas');c.width=640;c.height=360;const g=c.getContext('2d');let n=0;
const draw=setInterval(()=>{g.fillStyle=['#137464','#783dc7','#a33745','#2859ba'][Math.floor(n/20)%4];g.fillRect(0,0,640,360);g.fillStyle='#fff';g.font='32px sans-serif';g.fillText('SAMPLING FRAME '+n++,32,180);},100);
const chunks=[],rec=new MediaRecorder(c.captureStream(10),{mimeType:'video/webm'});rec.ondataavailable=e=>chunks.push(e.data);
rec.onstop=()=>{clearInterval(draw);const v=document.querySelector('video');v.src=URL.createObjectURL(new Blob(chunks,{type:'video/webm'}));const tr=v.addTextTrack('subtitles','采样验收','zh');tr.mode='hidden';tr.addCue(new VTTCue(0,60,'按实际批次范围读取字幕'));v.play().then(()=>{v.pause();window.fixtureReady=true;});};rec.start();setTimeout(()=>rec.stop(),34000);
</script>`);
});
await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
const cfg = structuredClone(EGO_DEFAULTS); cfg.enabled = true; cfg.spaceName = `ego-sampling-${Date.now()}`;
const expectedDefaults = structuredClone(cfg.video);
const bridge = new CliBridge({ cliFile: cfg.cliFile, dataDir: dir, timeoutMs: () => 60000 });
let delayed = false, finished = false;
const world = new EgoWorld({ cfg, dataDir: dir, botDir: dir, timezone: 'Asia/Shanghai', bridge: {
  async run(operation, args, signal) {
    const receipt = await bridge.run(operation, args, signal);
    if (operation === 'video' && (args.action === 'look' || receipt.value?.batchComplete) && !receipt.value?.samplePending && !delayed && !receipt.error) {
      delayed = true; assert.equal(receipt.value.playbackHeld, true);
      console.log('Mosaic captured; holding its receipt for 11.5 seconds.');
      await new Promise(r => setTimeout(r, 11500)); evidence.injectedDelayMs = 11500;
    }
    return receipt;
  },
} });
const scenes: DeferredEventSpec[] = [];
const host = { log: nullLogger(), pushEvent: async (event: any) => { evidence.events.push({ type: event.type, text: event.text }); return event; },
  pushDeferred: (event: DeferredEventSpec) => { scenes.push(event); console.log(`Mosaic ${scenes.length} queued.`); } } as unknown as WorldHost;
async function call(name: string, args: Record<string, unknown> = {}): Promise<ToolOutcome> {
  const raw = await world.tools().find(t => t.name === `ego_${name}`)!.handler(args, { role: 'smoke', log: nullLogger() });
  const result = typeof raw === 'string' ? { text: raw } : raw; assert(!result.failed, result.text); return result;
}
const data = (result: ToolOutcome) => JSON.parse(result.text.slice(result.text.indexOf('\n') + 1));
try {
  await world.start(host); assert(world.status().connected, JSON.stringify(world.status()));
  console.log(JSON.stringify({ spaceId: world.status().spaceId, spaceName: cfg.spaceName }));
  const page = data(await call('open', { url: `http://127.0.0.1:${(server.address() as any).port}/` })).page;
  console.log('Recording a finite 34-second local test video.');
  let ready = false; const readyDeadline = Date.now() + 45000;
  while (!ready && Date.now() < readyDeadline) {
    const result = await bridge.run('evaluate', { spaceId: world.status().spaceId, page, expression: 'Boolean(window.fixtureReady && document.querySelector("video").readyState >= 2)' });
    assert(!result.error, result.error); ready = result.value === true;
    if (!ready) await new Promise(r => setTimeout(r, 1000));
  }
  assert(ready, 'fixture not ready');
  const start = await call('video', { page, action: 'watch', windowSec: 20, frameIntervalSec: 10 });
  assert(!start.blobs?.length); assert.equal(data(start).observation.plannedFrames, 3); evidence.collecting = data(start);
  evidence.tune = data(await call('video', { page, action: 'tune', windowSec: 10, frameIntervalSec: 5 }));
  assert.equal(evidence.tune.observation.appliesAtBatch, 2);
  const deadline = Date.now() + 65000;
  while (scenes.length < 2 && Date.now() < deadline) await new Promise(r => setTimeout(r, 100));
  assert(scenes.length >= 2, 'Two mosaics were not queued');
  const batches = [];
  for (let i = 0; i < 2; i++) {
    const rendered = await scenes[i]!.render(); assert(rendered && typeof rendered !== 'string' && rendered.blobs?.length);
    const batch = JSON.parse(rendered.text.slice(rendered.text.indexOf('\n', rendered.text.indexOf('totalChars=')) + 1));
    assert.equal(batch.frameCount, 3); assert.equal(batch.capture, 'video-mosaic'); batches.push(batch);
    assert.equal(batch.observation.windowSec, i === 0 ? 20 : 10);
    assert.equal(batch.observation.frameIntervalSec, i === 0 ? 10 : 5);
    assert.equal(batch.observation.batch, i + 1);
    assert(batch.frameTimes.slice(1).every((t: number, j: number) => t > batch.frameTimes[j] && t - batch.frameTimes[j] < (i === 0 ? 12 : 7)));
    assert(Math.abs(batch.observation.actualVideoSpanSec - (i === 0 ? 20 : 10)) < 2);
    await writeFile(join(dir, `mosaic-${i + 1}.jpg`), (rendered.blobs[0] as any).bytes);
  }
  assert.equal(batches[0].frameTimes.at(-1), batches[1].frameTimes[0]); assert.deepEqual(cfg.video, expectedDefaults);
  evidence.batches = batches;
  await call('video', { page, action: 'pause' }); assert.equal(await scenes[0]!.render(), null);
  await world.stop(); const result = await bridge.run('finish', { spaceId: world.status().spaceId }); assert(!result.error, result.error);
  finished = true; evidence.finished = result.value; evidence.ok = true;
  console.log(JSON.stringify({ ok: true, frameTimes: batches.map(batch => batch.frameTimes), finished: result.value }));
} catch (error) { evidence.ok = false; evidence.error = String(error); process.exitCode = 1; console.error(error); }
finally {
  await world.stop();
  if (!finished && world.status().spaceId) evidence.cleanup = await bridge.run('finish', { spaceId: world.status().spaceId });
  server.closeAllConnections(); await new Promise<void>(r => server.close(() => r()));
  await writeFile(join(dir, 'result.json'), JSON.stringify(evidence, null, 2));
}
