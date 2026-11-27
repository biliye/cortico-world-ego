/** Protobuf reader adapted from Cortico / cortico-world-browser (MIT, 2026 Phantivia).
 * See THIRD_PARTY_NOTICES.md. Kept local so Coo does not need built-in Worlds. */
export function decodeDanmakuSegment(buf) {
  function fields(bytes) {
    let i = 0;
    function integer() {
      let n = 0n;
      for (let k = 0; k < 10 && i < bytes.length; k++) {
        const b = bytes[i++]; n |= BigInt(b & 127) << BigInt(k * 7);
        if (!(b & 128)) return n;
      }
      throw new Error('Truncated protobuf integer');
    }
    const out = [];
    while (i < bytes.length) {
      const key = integer(), field = Number(key >> 3n), wire = Number(key & 7n);
      if (!field) throw new Error('Invalid protobuf field');
      if (wire === 0) out.push({ field, n: integer() });
      else if (wire === 2) {
        const len = Number(integer()), end = i + len;
        if (!Number.isSafeInteger(end) || end > bytes.length) throw new Error('Truncated protobuf bytes');
        out.push({ field, bytes: bytes.subarray(i, end) }); i = end;
      } else if (wire === 1 || wire === 5) {
        i += wire === 1 ? 8 : 4;
        if (i > bytes.length) throw new Error('Truncated protobuf scalar');
      } else throw new Error('Unsupported protobuf wire type');
    }
    return out;
  }
  const pick = (list, field) => list.findLast(f => f.field === field);
  const text = new TextDecoder('utf-8', { fatal: true }), out = [];
  for (const item of fields(buf)) {
    if (item.field !== 1 || !item.bytes) continue;
    const el = fields(item.bytes), progress = pick(el, 2)?.n, content = pick(el, 7)?.bytes;
    if (progress === undefined || !content) continue;
    const t = Number(progress) / 1000;
    if (!Number.isFinite(t) || t < 0) continue;
    let value;
    try { value = text.decode(content); } catch { continue; }
    if (!value.trim() || /[\u0000-\u001f]/.test(value)) continue;
    out.push({ id: String(pick(el, 1)?.n ?? `${progress}:${value}`), time: t, mode: Number(pick(el, 3)?.n ?? 0), text: value.slice(0, 500) });
    if (out.length >= 20000) break;
  }
  return out;
}

/** Serialized into the Bilibili page with the standalone decoder and selection function. */
export async function bilibiliDanmaku({ time, since }, decode, select) {
  const info = window.__INITIAL_STATE__?.videoData ?? window.__INITIAL_STATE__?.epInfo;
  const part = Number(new URL(location.href).searchParams.get('p') ?? 1);
  const cid = info?.pages?.[part - 1]?.cid ?? info?.cid ?? window.__INITIAL_STATE__?.cid;
  const base = { source: 'bilibili-history-danmaku', screenOverlay: false, from: since, to: time, comments: [] };
  if (!Number.isSafeInteger(Number(cid)) || Number(cid) <= 0) return { ...base, status: 'unavailable', reason: 'missing-video-cid' };
  let cache = window.__corticoEgoDanmaku;
  if (!cache || cache.cid !== String(cid)) cache = window.__corticoEgoDanmaku = { cid: String(cid), segments: new Map() };
  // Reuse only URLs actually requested by this player's current CID. No guessed signed APIs.
  const urls = new Map();
  for (const r of performance.getEntriesByType('resource')) {
    try {
      const u = new URL(r.name);
      if (u.protocol === 'https:' && u.hostname === 'api.bilibili.com' && /\/seg\.so$/.test(u.pathname) && u.searchParams.get('oid') === String(cid)) {
        const index = Number(u.searchParams.get('segment_index'));
        if (Number.isInteger(index) && index > 0) urls.set(index, u.href);
      }
    } catch { /* unrelated resource */ }
  }
  const first = Math.floor(since / 360) + 1, last = Math.floor(time / 360) + 1;
  const now = Date.now();
  const indices = first < last ? [last - 1, last] : [last];
  const segments = await Promise.allSettled(indices.map(async index => {
    let saved = cache.segments.get(index);
    if (!saved || now - saved.at > 60000) {
      if (!urls.has(index)) throw new Error(`Danmaku segment ${index} has not been observed in this page`);
      const response = await fetch(urls.get(index), { credentials: 'include', signal: AbortSignal.timeout(6000) });
      if (!response.ok) throw new Error(`Danmaku HTTP ${response.status}`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.length > 3 * 1024 * 1024) throw new Error('Danmaku segment exceeds 3 MiB');
      saved = { at: now, lines: decode(bytes) };
      cache.segments.set(index, saved);
    }
    return saved.lines.filter(l => l.time >= since && l.time <= time);
  }));
  for (const key of cache.segments.keys()) if (key < last - 1 || key > last) cache.segments.delete(key);
  const errors = segments.flatMap(segment => segment.status === 'rejected' ? [segment.reason.message] : []);
  const lines = segments.flatMap(segment => segment.status === 'fulfilled' ? segment.value : []);
  const sorted = [...new Map(lines.map(line => [line.id, line])).values()].sort((a, b) => a.time - b.time);
  const ids = sorted.filter(line => /^[1-9]\d{0,18}$/.test(line.id)).map(line => line.id);
  // Bound the extra traffic for dense windows while retaining candidates throughout the clip.
  const candidates = ids.length <= 80 ? ids
    : Array.from({ length: 80 }, (_, index) => ids[Math.round(index * (ids.length - 1) / 79)]);
  const likes = new Map();
  const lookupLikes = async batch => {
    const url = new URL('https://api.bilibili.com/x/v2/dm/thumbup/stats');
    url.searchParams.set('oid', String(cid));
    url.searchParams.set('ids', batch.join(','));
    const response = await fetch(url.href, { credentials: 'include', redirect: 'error', signal: AbortSignal.timeout(2200) });
    if (!response.ok) return;
    const result = await response.json();
    if (result?.code !== 0) return;
    for (const id of batch) {
      const count = result.data?.[id]?.likes;
      if (Number.isSafeInteger(count) && count >= 0) likes.set(id, count);
    }
  };
  await Promise.allSettled([candidates.slice(0, 40), candidates.slice(40)].filter(batch => batch.length).map(lookupLikes));
  const selected = select(sorted.map(line => likes.has(line.id) ? { ...line, likes: likes.get(line.id) } : line));
  return { ...base, ...selected, cid, status: errors.length ? lines.length ? 'partial' : 'unavailable' : 'available',
    truncated: selected.truncated || first < last - 1, ...(errors.length ? { errors } : {}) };
}
