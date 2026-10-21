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
  const clear = () => { cache.frames = []; cache.lastTime = -1; };
  if (args.resetFrames) clear();
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
  const since = args.since ?? Math.max(0, time - 15);
  const tracks = [];
  for (const track of v.textTracks) {
    // Hidden loads cues without changing which subtitle track is drawn on screen.
    if (track.mode === 'disabled') track.mode = 'hidden';
    tracks.push({ language: track.language, label: track.label, kind: track.kind,
      subtitles: Array.from(track.cues ?? []).filter(c => c.startTime <= time && c.endTime >= since)
        .slice(-100).map(c => ({ from: c.startTime, to: c.endTime, text: String(c.text ?? '').slice(0, 2000) })) });
  }
  const result = { found: true, count: videos.length, time, duration: Number.isFinite(v.duration) ? v.duration : null,
    paused: v.paused, ended: v.ended, readyState: v.readyState, width: v.videoWidth, height: v.videoHeight,
    source: v.currentSrc, tracks, capture: null, image: null };
  if (args.action === 'look') {
    if (v.readyState < 2 || !v.videoWidth) result.captureNote = 'Video frame is not decoded yet.';
    else {
      try {
        const width = Math.max(240, Math.min(1280, args.frameWidth ?? 640));
        const height = Math.min(960, Math.round(width * v.videoHeight / v.videoWidth));
        const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
        const context = canvas.getContext('2d'); context.drawImage(v, 0, 0, width, height);
        const jpeg = canvas.toDataURL('image/jpeg', 0.7);
        if (cache.lastTime !== time) cache.frames.push({ time, jpeg });
        cache.frames = cache.frames.slice(-Math.max(1, Math.min(9, args.maxFrames ?? 4)));
        cache.lastTime = time;
        const cols = Math.min(3, cache.frames.length), rows = Math.ceil(cache.frames.length / cols);
        const grid = document.createElement('canvas'); grid.width = cols * width; grid.height = rows * (height + 26);
        const g = grid.getContext('2d'); g.fillStyle = '#111'; g.fillRect(0, 0, grid.width, grid.height);
        for (let i = 0; i < cache.frames.length; i++) {
          const f = cache.frames[i], image = new Image(); image.src = f.jpeg; await image.decode();
          const x = (i % cols) * width, y = Math.floor(i / cols) * (height + 26);
          g.drawImage(image, x, y, width, height); g.fillStyle = '#fff'; g.font = '18px sans-serif'; g.fillText(`${f.time.toFixed(2)} s`, x + 8, y + height + 20);
        }
        result.image = { base64: grid.toDataURL('image/jpeg', 0.75).split(',')[1], mime: 'image/jpeg' };
        result.capture = 'video-mosaic'; result.frameTimes = cache.frames.map(f => f.time);
      } catch (error) { result.captureNote = `Video pixels unavailable: ${error.message}`; }
    }
  }
  return result;
}
