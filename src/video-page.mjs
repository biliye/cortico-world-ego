/** Serialized into a frame's isolated world. All dependencies stay inside the function. */
export async function videoOperation(args) {
  const videos = [];
  function collect(root) {
    for (const el of root.querySelectorAll('*')) {
      if (el.tagName === 'VIDEO') videos.push(el);
      if (el.shadowRoot) collect(el.shadowRoot);
    }
  }
  collect(document);
  const v = args.selector ? document.querySelector(args.selector) : videos[args.index ?? 0];
  if (!v || v.tagName !== 'VIDEO') return { found: false, count: videos.length };
  let cache = globalThis.__corticoEgoVideo;
  if (!cache || cache.video !== v || cache.src !== v.currentSrc) {
    cache = globalThis.__corticoEgoVideo = { video: v, src: v.currentSrc, frames: [], lastTime: -1 };
  }
  if (args.snapshotOnly) cache = { ...cache, frames: [...cache.frames] };
  const clear = () => { cache.frames = []; cache.lastTime = -1; };
  if (args.resetFrames || (args.action === 'pause' && !args.preserveFrames)) clear();
  if (args.action === 'play') await v.play();
  else if (args.action === 'pause') v.pause();
  else if (args.action === 'seek') {
    if (!Number.isFinite(args.time) || args.time < 0) throw new Error('time must be finite and >= 0');
    clear(); v.currentTime = Number.isFinite(v.duration) ? Math.min(args.time, v.duration) : args.time;
    await new Promise((resolve, reject) => {
      if (!v.seeking) return resolve();
      const timer = setTimeout(() => { cleanup(); reject(new Error('Video seek did not settle in 5 seconds')); }, 5000);
      const cleanup = () => { clearTimeout(timer); v.removeEventListener('seeked', done); };
      const done = () => { cleanup(); resolve(); };
      v.addEventListener('seeked', done, { once: true });
    });
  } else if (args.action === 'exit') clear();
  const time = v.currentTime;
  if (time < cache.lastTime) clear();
  const batchComplete = args.collecting && Number.isFinite(args.batchEndTime) && time >= args.batchEndTime - 0.02;
  const action = batchComplete && args.action === 'sample' ? 'look' : args.action;
  const since = args.since <= time ? args.since : Math.max(0, time - 15);
  const tracks = [];
  for (const track of action === 'sample' ? [] : v.textTracks) {
    // Hidden loads cues without changing which subtitle track is drawn on screen.
    if (track.mode === 'disabled') track.mode = 'hidden';
    tracks.push({ language: track.language, label: track.label, kind: track.kind,
      subtitles: Array.from(track.cues ?? []).filter(c => c.startTime <= time && c.endTime >= since)
        .slice(-100).map(c => ({ from: c.startTime, to: c.endTime, text: String(c.text ?? '').slice(0, 2000) })) });
  }
  const result = { found: true, count: videos.length, time, duration: Number.isFinite(v.duration) ? v.duration : null,
    paused: v.paused, ended: v.ended, playbackRate: v.playbackRate, readyState: v.readyState, width: v.videoWidth, height: v.videoHeight,
    source: v.currentSrc, tracks, capture: null, image: null };
  // Hold the playhead while the host assembles/enriches a watched scene.
  if (args.collecting && Number.isFinite(args.targetTime) && time < args.targetTime - 0.02 && !v.ended) {
    result.samplePending = true; return result;
  }
  if (batchComplete) result.batchComplete = true;
  if (action === 'look' && (args.holdPlayback || batchComplete) && !v.paused && !v.ended) {
    v.pause(); result.playbackHeld = true;
  }
  if (action === 'look' || action === 'sample') {
    if (v.readyState < 2 || !v.videoWidth) result.captureNote = 'Video frame is not decoded yet.';
    else {
      try {
        const width = Math.max(240, Math.min(1280, args.frameWidth ?? 640));
        const height = Math.min(960, Math.round(width * v.videoHeight / v.videoWidth));
        const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
        const context = canvas.getContext('2d'); context.drawImage(v, 0, 0, width, height);
        const jpeg = canvas.toDataURL('image/jpeg', 0.7);
        const now = Date.now(), windowMs = Math.max(10000, Math.min(120000, args.windowMs ?? 15000));
        if (cache.lastTime !== time || !cache.frames.length) cache.frames.push({ time, jpeg, capturedAt: now });
        else cache.frames[cache.frames.length - 1] = { time, jpeg, capturedAt: now };
        // Unconsumed watch frames survive slow CLI/subtitle calls until the batch is assembled.
        cache.frames = (args.collecting ? cache.frames : cache.frames.filter(f => f.capturedAt >= now - windowMs - 1000))
          .slice(-Math.max(1, Math.min(9, args.maxFrames ?? 4)));
        cache.lastTime = time;
        result.frameTimes = cache.frames.map(f => f.time); result.frameCount = cache.frames.length;
        result.capture = 'video-sample';
        if (action === 'sample') return result;
        const cols = Math.min(3, cache.frames.length), rows = Math.ceil(cache.frames.length / cols);
        const grid = document.createElement('canvas'); grid.width = cols * width; grid.height = rows * (height + 26);
        const g = grid.getContext('2d'); g.fillStyle = '#111'; g.fillRect(0, 0, grid.width, grid.height);
        for (let i = 0; i < cache.frames.length; i++) {
          const f = cache.frames[i], image = new Image(); image.src = f.jpeg; await image.decode();
          const x = (i % cols) * width, y = Math.floor(i / cols) * (height + 26);
          g.drawImage(image, x, y, width, height); g.fillStyle = '#fff'; g.font = '18px sans-serif'; g.fillText(`${f.time.toFixed(2)} s`, x + 8, y + height + 20);
        }
        result.image = { base64: grid.toDataURL('image/jpeg', 0.75).split(',')[1], mime: 'image/jpeg' };
        result.capture = cache.frames.length > 1 ? 'video-mosaic' : 'video-frame'; result.frameTimes = cache.frames.map(f => f.time);
        // Keep the boundary frame as the start of the next observation window.
        if (args.consumeFrames || batchComplete) cache.frames = cache.frames.slice(-1);
      } catch (error) { result.captureNote = `Video pixels unavailable: ${error.message}`; }
    }
  }
  return result;
}
