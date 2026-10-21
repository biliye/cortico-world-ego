import { expect, it } from 'vitest';
import { runInNewContext } from 'node:vm';
import { videoOperation } from '../src/video-page.mjs';

function fixture() {
  let now = 0;
  const video = { tagName: 'VIDEO', currentSrc: 'one', currentTime: 0, readyState: 4, videoWidth: 640, videoHeight: 360,
    duration: 120, paused: false, ended: false, textTracks: [], pause() { this.paused = true; } };
  const context = { Date: { now: () => now }, Image: class { async decode() {} },
    document: { querySelectorAll: () => [video], createElement: () => ({ width: 0, height: 0,
      getContext: () => ({ drawImage() {}, fillRect() {}, fillText() {} }), toDataURL: () => 'data:image/jpeg;base64,anBlZw==' }) } };
  const op = runInNewContext(`(${videoOperation.toString()})`, context);
  return { video, async capture(time: number, action = 'sample', extra = {}, wallTime = time) { now = wallTime * 1000; video.currentTime = time; return op({ action, maxFrames: 4, ...extra }); } };
}
it('assembles samples from one interval and retains only its boundary for the next interval', async () => {
  const f = fixture();
  await f.capture(0, 'look'); await f.capture(5); const sample = await f.capture(10);
  expect(sample.image).toBe(null); expect(sample.frameTimes).toEqual([0, 5, 10]);
  const first = await f.capture(15, 'look', { consumeFrames: true });
  expect(first.frameTimes).toEqual([0, 5, 10, 15]); expect(first.image.mime).toBe('image/jpeg'); expect(first.capture).toBe('video-mosaic'); expect(first.frameCount).toBe(4);
  await f.capture(20); await f.capture(25);
  expect((await f.capture(30, 'look', { consumeFrames: true })).frameTimes).toEqual([15, 20, 25, 30]);
});
it('does not retain stale frames after stalled polling, backward seek, pause or source changes', async () => {
  const f = fixture(); await f.capture(0, 'look');
  expect((await f.capture(40, 'look')).frameTimes).toEqual([40]);
  expect((await f.capture(3, 'look')).frameTimes).toEqual([3]);
  await f.capture(4, 'pause'); expect((await f.capture(5, 'look')).frameTimes).toEqual([5]);
  f.video.currentSrc = 'two'; expect((await f.capture(6, 'look')).frameTimes).toEqual([6]);
});
it('still captures a paused frame after the previous wall-clock window has expired', async () => {
  const f = fixture(); await f.capture(0, 'look');
  const scene = await f.capture(0, 'look', {}, 40);
  expect(scene.frameTimes).toEqual([0]); expect(scene.image.mime).toBe('image/jpeg'); expect(scene.capture).toBe('video-frame'); expect(scene.frameCount).toBe(1);
});
it('retains all nine unconsumed watch frames when command latency exceeds the nominal window', async () => {
  const f = fixture(), options = { maxFrames: 9, collecting: true };
  await f.capture(0, 'sample', options);
  for (let i = 1; i < 8; i++) await f.capture(i * 2.2, 'sample', options);
  const first = await f.capture(17.6, 'look', { ...options, consumeFrames: true });
  expect(first.frameCount).toBe(9); expect(first.frameTimes[0]).toBe(0);
  // A long enrichment call must not expire the boundary kept for the next batch.
  for (let i = 1; i < 8; i++) await f.capture(29.1 + i * 2.2, 'sample', options);
  const next = await f.capture(46.7, 'look', { ...options, consumeFrames: true });
  expect(next.frameCount).toBe(9); expect(next.frameTimes[0]).toBe(first.frameTimes.at(-1));
});
it('preserves the next batch boundary during delivery backpressure', async () => {
  const f = fixture(); await f.capture(0, 'sample', { collecting: true }); await f.capture(5, 'sample', { collecting: true });
  await f.capture(5, 'pause', { preserveFrames: true });
  const scene = await f.capture(10, 'look', { collecting: true }, 90);
  expect(scene.frameTimes).toEqual([0, 5, 10]);
});
it('holds playback after a watched scene capture without discarding the shared boundary', async () => {
  const f = fixture(); await f.capture(0, 'sample', { collecting: true });
  const scene = await f.capture(5, 'look', { collecting: true, consumeFrames: true, holdPlayback: true });
  expect(scene.frameTimes).toEqual([0, 5]); expect(scene.paused).toBe(false); expect(scene.playbackHeld).toBe(true); expect(f.video.paused).toBe(true);
  expect((await f.capture(10, 'sample', { collecting: true }, 30)).frameTimes).toEqual([5, 10]);
});
it('does not let an explicit look evict samples from the active watch batch', async () => {
  const f = fixture(), options = { collecting: true };
  await f.capture(0, 'sample', options);
  expect((await f.capture(2, 'look', { ...options, snapshotOnly: true })).frameTimes).toEqual([0, 2]);
  await f.capture(5, 'sample', options); await f.capture(10, 'sample', options);
  expect((await f.capture(15, 'look', { ...options, consumeFrames: true })).frameTimes).toEqual([0, 5, 10, 15]);
});
it('polls before a video-time target without capturing or consuming the shared boundary', async () => {
  const f = fixture(); await f.capture(0, 'sample', { collecting: true });
  const pending = await f.capture(3, 'look', { collecting: true, targetTime: 5, consumeFrames: true, holdPlayback: true });
  expect(pending.samplePending).toBe(true); expect(pending.image).toBe(null); expect(f.video.paused).toBe(false);
  expect((await f.capture(5, 'look', { collecting: true, targetTime: 5, consumeFrames: true })).frameTimes).toEqual([0, 5]);
});
it('flushes a late intermediate sample at the batch endpoint and holds playback for enrichment', async () => {
  const f = fixture(); await f.capture(0, 'sample', { collecting: true });
  const scene = await f.capture(20, 'sample', { collecting: true, targetTime: 5, batchEndTime: 20 });
  expect(scene.batchComplete).toBe(true); expect(scene.playbackHeld).toBe(true); expect(scene.image.mime).toBe('image/jpeg');
  expect(scene.frameTimes).toEqual([0, 20]);
  expect((await f.capture(25, 'sample', { collecting: true })).frameTimes).toEqual([20, 25]);
});
