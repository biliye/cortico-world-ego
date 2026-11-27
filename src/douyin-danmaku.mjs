/** Read time-based danmaku requests already made by the current Douyin video page. */
export async function douyinDanmaku({ time, since }, select) {
  const itemId = new URL(location.href).pathname.match(/^\/video\/(\d+)\/?$/)?.[1];
  const base = { source: 'douyin-video-danmaku', screenOverlay: false, from: since, to: time, comments: [] };
  if (!itemId) return { ...base, status: 'unavailable', reason: 'missing-douyin-video-id' };

  const from = Math.floor(since * 1000), to = Math.floor(time * 1000);
  const now = Date.now();
  const cacheUntil = now + 60000;
  let cache = window.__corticoEgoDouyinDanmaku;
  if (cache?.itemId !== itemId || !cache.windows) {
    cache = window.__corticoEgoDouyinDanmaku = { itemId, windows: new Map(), requests: new Map() };
  }
  for (const [key, entry] of cache.windows) if (entry.until <= now) cache.windows.delete(key);
  // Retain observed windows even after their entries disappear from Resource Timing.
  for (const resource of performance.getEntriesByType('resource')) {
    try {
      const url = new URL(resource.name);
      if (url.protocol !== 'https:' || !/(^|\.)douyin\.com$/.test(url.hostname) || url.port ||
          url.username || url.password || url.pathname !== '/aweme/v1/web/danmaku/get_v2/' ||
          url.searchParams.get('item_id') !== itemId) continue;
      const startValue = url.searchParams.get('start_time'), endValue = url.searchParams.get('end_time');
      if (!/^\d+$/.test(startValue ?? '') || !/^\d+$/.test(endValue ?? '')) continue;
      const start = Number(startValue), end = Number(endValue);
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end) continue;
      const key = `${start}:${end}`;
      cache.windows.delete(key);
      cache.windows.set(key, { start, end, url: url.href, until: cacheUntil });
    } catch { /* unrelated resource */ }
  }
  const windows = [...cache.windows.values()].filter(window => window.end >= from && window.start <= to)
    .sort((a, b) => a.start - b.start || b.end - a.end);
  while (cache.windows.size > 64) cache.windows.delete(cache.windows.keys().next().value);
  if (!windows.length) return { ...base, itemId, status: 'unavailable', reason: 'no-observed-danmaku-window' };

  const requested = windows.slice(0, 4);
  const windowLimit = requested.length < windows.length ? { windows: { observed: windows.length, used: requested.length } } : {};
  const results = await Promise.allSettled(requested.map(async ({ start, end, url }) => {
    const cached = cache.requests.get(url);
    if (cached && now < cached.until) return cached.result;
    // Keep the exact observed URL, including the player's parameters.
    const result = (async () => {
      const response = await fetch(url, { credentials: 'include', redirect: 'error', signal: AbortSignal.timeout(6000) });
      if (!response.ok) throw new Error(`Douyin danmaku HTTP ${response.status}`);
      const body = await response.text();
      if (body.length > 3 * 1024 * 1024) throw new Error('Douyin danmaku response exceeds 3 MiB');
      const data = JSON.parse(body);
      if (data?.status_code !== 0) throw new Error('Douyin danmaku request did not succeed');
      const rows = data.danmaku_list;
      if (!Array.isArray(rows) && !(rows === null && data.total === 0)) throw new Error('Douyin danmaku list missing');
      const lines = (rows ?? []).slice(0, 20000).flatMap(row => {
        if (row?.item_id != null && String(row.item_id) !== itemId) return [];
        const offset = row?.offset_time, text = row?.text;
        if (!Number.isSafeInteger(offset) || offset < 0 || typeof text !== 'string' ||
            !text.trim() || /[\u0000-\u001f]/.test(text)) return [];
        const id = typeof row.danmaku_id === 'string' && row.danmaku_id
          ? row.danmaku_id : Number.isSafeInteger(row.danmaku_id) ? String(row.danmaku_id) : `${offset}:${text}`;
        const likes = Number.isSafeInteger(row.digg_count) && row.digg_count >= 0 ? row.digg_count : undefined;
        return [{ id, time: offset / 1000, text: text.slice(0, 500), ...(likes !== undefined && { likes }) }];
      });
      const coveredStart = Number.isSafeInteger(data.start_time) ? Math.max(start, data.start_time) : start;
      const coveredEnd = Number.isSafeInteger(data.end_time) ? Math.min(end, data.end_time) : end;
      return { start: coveredStart, end: coveredEnd, lines: lines.filter(line => line.time * 1000 >= coveredStart - 0.01 &&
        line.time * 1000 <= coveredEnd + 0.01) };
    })();
    cache.requests.set(url, { until: cacheUntil, result });
    while (cache.requests.size > 6) cache.requests.delete(cache.requests.keys().next().value);
    try { return await result; }
    catch (error) {
      if (cache.requests.get(url)?.result === result) cache.requests.delete(url);
      throw error;
    }
  }));
  const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason.message] : []);
  const covered = results.flatMap(result => {
    if (result.status !== 'fulfilled') return [];
    const window = result.value;
    return Math.max(window.start, from) <= Math.min(window.end, to) ? [window] : [];
  });
  if (!covered.length) return { ...base, itemId, status: 'unavailable', ...windowLimit, ...(errors.length && { errors }) };
  let coveredThrough = from - 1;
  for (const window of covered.sort((a, b) => a.start - b.start)) {
    if (window.start > coveredThrough + 1) break;
    coveredThrough = Math.max(coveredThrough, window.end);
  }
  const selected = select(covered.flatMap(window => window.lines.filter(line => line.time >= since && line.time <= time)));
  return { ...base, ...selected, itemId, status: coveredThrough >= Math.max(from, to - 1) && !errors.length ? 'available' : 'partial',
    ...windowLimit, ...(errors.length && { errors }) };
}
