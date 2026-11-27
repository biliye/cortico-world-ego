import { afterEach, expect, it, vi } from 'vitest';
import { bilibiliDanmaku, decodeDanmakuSegment } from '../src/bilibili-danmaku.mjs';
import { selectDanmaku } from '../src/danmaku-selection.mjs';
import { douyinDanmaku } from '../src/douyin-danmaku.mjs';

const bytes = (...parts: Uint8Array[]) => Uint8Array.from(parts.flatMap(p => [...p]));
function integer(value: number | bigint) {
  let n = BigInt(value); const out = [];
  do { const b = Number(n & 127n); n >>= 7n; out.push(b | (n ? 128 : 0)); } while (n);
  return Uint8Array.from(out);
}
const num = (key: number, value: number | bigint) => bytes(integer(key * 8), integer(value));
const blob = (key: number, value: Uint8Array) => bytes(integer(key * 8 + 2), integer(value.length), value);
function segment(lines: Array<[bigint, number, string]>) {
  return bytes(...lines.map(([id, t, text]) => blob(1, bytes(num(1, id), num(2, t * 1000), num(3, 1), blob(7, new TextEncoder().encode(text))))));
}
function fixture(urls: string[], body: Uint8Array, likes: Record<string, { likes: number }> | null = null) {
  const win = { __INITIAL_STATE__: { videoData: { cid: 123 } } };
  vi.stubGlobal('window', win); vi.stubGlobal('location', { href: 'https://www.bilibili.com/video/BVfixture' });
  vi.stubGlobal('performance', { getEntriesByType: () => urls.map(name => ({ name })) });
  const fetch = vi.fn(async (url: string, _options?: unknown) => url.includes('/thumbup/stats')
    ? { ok: true, json: async () => likes ? { code: 0, data: likes } : { code: -400 } }
    : { ok: true, arrayBuffer: async () => body.buffer });
  vi.stubGlobal('fetch', fetch);
  return { fetch, win, segmentCalls: () => fetch.mock.calls.map(([url]) => url).filter(url => url.includes('/seg.so?')) };
}
const url = (cid: number, index = 1) => `https://api.bilibili.com/x/v2/dm/web/seg.so?oid=${cid}&segment_index=${index}`;
afterEach(() => vi.unstubAllGlobals());
it('decodes timestamped UTF-8 danmaku and preserves large ids without integer rounding', () => {
  const result = decodeDanmakuSegment(segment([[9007199254740993n, 5, '弹幕验收：这里很精彩']]));
  expect(result).toEqual([{ id: '9007199254740993', time: 5, mode: 1, text: '弹幕验收：这里很精彩' }]);
  expect(() => decodeDanmakuSegment(Uint8Array.from([10, 255]))).toThrow('Truncated');
});
it('reads only observed current-CID requests, filters the scene range and reuses its bounded cache', async () => {
  const f = fixture([url(999), 'https://unrelated.example/seg.so?oid=123&segment_index=1', url(123)], segment([[1n, 2, '旧时间'], [2n, 11, '当前弹幕'], [3n, 30, '未来时间']]));
  const read = () => bilibiliDanmaku({ time: 15, since: 10 }, decodeDanmakuSegment, selectDanmaku);
  expect(await read()).toMatchObject({ status: 'available', totalInRange: 1, comments: [{ text: '当前弹幕', time: 11 }], screenOverlay: false });
  await read(); expect(f.segmentCalls()).toEqual([url(123)]);
  f.win.__INITIAL_STATE__.videoData.cid = 999;
  await read(); expect(f.segmentCalls()).toEqual([url(123), url(999)]);
});
it('reports unavailable requests and preserves actual network failure instead of inventing empty success', async () => {
  const f = fixture([url(999)], segment([]));
  expect(await bilibiliDanmaku({ time: 15, since: 0 }, decodeDanmakuSegment, selectDanmaku)).toMatchObject({ status: 'unavailable', comments: [] });
  expect(f.fetch).not.toHaveBeenCalled();
  fixture([url(123)], segment([])).fetch.mockRejectedValue(new Error('CORS blocked'));
  expect(await bilibiliDanmaku({ time: 15, since: 0 }, decodeDanmakuSegment, selectDanmaku)).toMatchObject({ status: 'unavailable', errors: ['CORS blocked'] });
});
it('merges boundary segments, deduplicates ids and spreads at most 12 comments over the interval', async () => {
  const lines: Array<[bigint, number, string]> = Array.from({ length: 30 }, (_, i) => [BigInt(i + 1), 350 + i / 2, `弹幕 ${i}`]);
  const f = fixture([url(123, 1), url(123, 2)], segment(lines));
  const result = await bilibiliDanmaku({ time: 370, since: 350 }, decodeDanmakuSegment, selectDanmaku);
  expect(result.status).toBe('available'); expect('totalInRange' in result && result.totalInRange).toBe(30); expect(result.comments).toHaveLength(12);
  expect(result.comments[0].text).toBe('弹幕 0'); expect(result.comments.at(-1)?.text).toBe('弹幕 29'); expect(f.segmentCalls()).toEqual([url(123, 1), url(123, 2)]);
});
it('looks up likes only inside the video interval and keeps the most-liked copy within each second', async () => {
  const body = segment([[1n, 2, '区间外'], [2n, 11, ' 好  球 '], [3n, 11.5, '好 球'], [4n, 12, '好 球']]);
  const { fetch } = fixture([url(123)], body, { '2': { likes: 0 }, '3': { likes: 17 } });
  const result = await bilibiliDanmaku({ time: 15, since: 10 }, decodeDanmakuSegment, selectDanmaku);
  expect(result).toMatchObject({ status: 'available', likesStatus: 'partial', totalInRange: 3, truncated: true,
    comments: [{ id: '3', time: 11.5, likes: 17 }, { id: '4', time: 12 }] });
  const request = new URL(fetch.mock.calls[1][0]);
  expect(request.pathname).toBe('/x/v2/dm/thumbup/stats');
  expect(request.searchParams.get('ids')).toBe('2,3,4');
});
it('prioritizes high likes in dense seconds without losing coverage of later seconds', () => {
  const dense = Array.from({ length: 15 }, (_, i) => ({ id: String(i), time: 20 + i / 100, text: `弹幕 ${i}`, likes: i }));
  const later = { id: 'later', time: 21, text: '下一秒', likes: 0 };
  const result = selectDanmaku([...dense, later]);
  expect(result.likesStatus).toBe('available');
  expect(result.comments).toHaveLength(12);
  expect(result.comments).toContainEqual(dense[14]);
  expect(result.comments).not.toContainEqual(dense[0]);
  expect(result.comments.at(-1)).toEqual(later);
});
it('reports a partial Douyin interval and avoids repeating a cached request', async () => {
  const location = new URL('https://www.douyin.com/video/1234567890123456789');
  const request = 'https://www.douyin.com/aweme/v1/web/danmaku/get_v2/?item_id=1234567890123456789&start_time=0&end_time=9000';
  vi.stubGlobal('window', {});
  vi.stubGlobal('location', location);
  vi.stubGlobal('performance', { getEntriesByType: () => [{ name: request }, { name: request.replace('1234567890123456789', '12') }] });
  const fetch = vi.fn(async () => new Response(JSON.stringify({ status_code: 0,
    danmaku_list: [{ danmaku_id: '1', text: '弹幕', offset_time: 8000, digg_count: 7 }] })));
  vi.stubGlobal('fetch', fetch);
  const read = () => douyinDanmaku({ time: 10, since: 7 }, selectDanmaku);
  expect(await read()).toMatchObject({ status: 'partial', likesStatus: 'available', comments: [{ time: 8, likes: 7 }] });
  await read();
  expect(fetch).toHaveBeenCalledOnce();
  expect(fetch).toHaveBeenCalledWith(request, expect.objectContaining({ credentials: 'include', redirect: 'error' }));
  location.pathname = '/video/2';
  expect(await read()).toMatchObject({ status: 'unavailable', reason: 'no-observed-danmaku-window' });
});
