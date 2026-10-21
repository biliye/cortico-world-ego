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
