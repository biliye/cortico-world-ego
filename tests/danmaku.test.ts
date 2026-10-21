import { afterEach, expect, it, vi } from 'vitest';
import { bilibiliDanmaku, decodeDanmakuSegment } from '../src/bilibili-danmaku.mjs';

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
function fixture(urls: string[], body: Uint8Array) {
  const win = { __INITIAL_STATE__: { videoData: { cid: 123 } } };
  vi.stubGlobal('window', win); vi.stubGlobal('location', { href: 'https://www.bilibili.com/video/BVfixture' });
  vi.stubGlobal('performance', { getEntriesByType: () => urls.map(name => ({ name })) });
  const fetch = vi.fn(async (_url: string, _options?: unknown) => ({ ok: true, arrayBuffer: async () => body.buffer }));
  vi.stubGlobal('fetch', fetch); return { fetch, win };
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
  const read = () => bilibiliDanmaku({ time: 15, since: 10 }, decodeDanmakuSegment);
  expect(await read()).toMatchObject({ status: 'available', totalInRange: 1, comments: [{ text: '当前弹幕', time: 11 }], screenOverlay: false });
  await read(); expect(f.fetch).toHaveBeenCalledTimes(1); expect(f.fetch.mock.calls[0][0]).toBe(url(123));
  f.win.__INITIAL_STATE__.videoData.cid = 999;
  await read(); expect(f.fetch).toHaveBeenCalledTimes(2); expect(f.fetch.mock.calls[1][0]).toBe(url(999));
});
it('reports unavailable requests and preserves actual network failure instead of inventing empty success', async () => {
  const f = fixture([url(999)], segment([]));
  expect(await bilibiliDanmaku({ time: 15, since: 0 }, decodeDanmakuSegment)).toMatchObject({ status: 'unavailable', comments: [] });
  expect(f.fetch).not.toHaveBeenCalled();
  fixture([url(123)], segment([])).fetch.mockRejectedValue(new Error('CORS blocked'));
  expect(await bilibiliDanmaku({ time: 15, since: 0 }, decodeDanmakuSegment)).toMatchObject({ status: 'unavailable', errors: ['CORS blocked'] });
});
it('merges boundary segments, deduplicates ids and spreads at most 12 comments over the interval', async () => {
  const lines: Array<[bigint, number, string]> = Array.from({ length: 30 }, (_, i) => [BigInt(i + 1), 350 + i / 2, `弹幕 ${i}`]);
  const f = fixture([url(123, 1), url(123, 2)], segment(lines));
  const result = await bilibiliDanmaku({ time: 370, since: 350 }, decodeDanmakuSegment);
  expect(result.status).toBe('available'); expect('totalInRange' in result && result.totalInRange).toBe(30); expect(result.comments).toHaveLength(12);
  expect(result.comments[0].text).toBe('弹幕 0'); expect(result.comments.at(-1)?.text).toBe('弹幕 29'); expect(f.fetch).toHaveBeenCalledTimes(2);
});
