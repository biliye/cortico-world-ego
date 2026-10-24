import { afterEach, expect, it, vi } from 'vitest';
import { runInNewContext } from 'node:vm';
import { execute } from '../src/bridge-runtime.mjs';

const video = { aid: 170001, bvid: 'BV17x411w7KC', title: '目标视频' };
const other = { aid: 455017605, bvid: 'BV1Q541167Qg', title: '另一条视频' };
const reply = { member: { uname: '读者' }, content: { message: '评论正文' }, like: 3 };
function fixture(url = `https://www.bilibili.com/video/${video.bvid}`) {
  const fetch = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ code: 0, data: video }) })
    .mockResolvedValue({ ok: true, json: async () => ({ code: 0, data: { replies: [reply] } }) });
  const page = { evaluate: vi.fn(async (fn: Function, args: unknown) => {
    // Run the serialized callback with only browser globals, as the real bridge does.
    return runInNewContext(`(${fn.toString()})(args)`, { args, location: new URL(url),
      window: { __INITIAL_STATE__: { videoData: other } }, URL, AbortSignal, fetch });
  }) };
  vi.stubGlobal('taskSpace', async () => ({ spaceId: 1, tabs: async () => [{ label: 'p1' }], page: () => page }));
  const read = async (args = {}) => {
    const result = await execute({ operation: 'bilibili', args: { page: 'p1', action: 'comments', ...args } });
    expect(result.error).toBeUndefined();
    return result.value;
  };
  return { fetch, read };
}
afterEach(() => vi.unstubAllGlobals());

it('uses an explicit bvid on a non-video Bilibili page and reports the actual request identity', async () => {
  const { fetch, read } = fixture('https://www.bilibili.com/');
  expect(await read({ bvid: video.bvid })).toMatchObject({ status: 'available', page: 'p1', pageUrl: 'https://www.bilibili.com/',
    targetSource: 'explicit', requestedTarget: { bvid: video.bvid }, video, comments: [{ user: '读者', text: '评论正文', likes: 3 }] });
  expect(fetch.mock.calls[0][0]).toContain(`view?bvid=${video.bvid}`);
  expect(fetch.mock.calls[1][0]).toContain(`oid=${video.aid}&`);
  expect(fetch.mock.calls.every(([, options]) => options.credentials === 'include')).toBe(true);
  expect(fetch.mock.calls[0][1].signal).toBe(fetch.mock.calls[1][1].signal);
});
it('uses an explicit aid instead of the video in the page URL', async () => {
  const { fetch, read } = fixture(`https://www.bilibili.com/video/${other.bvid}`);
  expect(await read({ aid: video.aid })).toMatchObject({ status: 'available', video, targetSource: 'explicit' });
  expect(fetch.mock.calls[0][0]).toContain(`view?aid=${video.aid}`);
});
it('resolves the current URL instead of stale initial page data', async () => {
  const { fetch, read } = fixture();
  expect(await read()).toMatchObject({ status: 'available', targetSource: 'page', video });
  expect(fetch.mock.calls[0][0]).toContain(`view?bvid=${video.bvid}`);
});
it('supports av URLs and ignores part/query parameters when choosing comments', async () => {
  const { fetch, read } = fixture(`https://www.bilibili.com/video/av${video.aid}/?p=2`);
  expect(await read()).toMatchObject({ status: 'available', video });
  expect(fetch.mock.calls[0][0]).toContain(`view?aid=${video.aid}`);
});
it.each(['https://www.bilibili.com/', 'https://search.bilibili.com/all', 'https://example.com/video/BV17x411w7KC'])('does not turn a missing target into an empty result on %s', async url => {
  const { fetch, read } = fixture(url);
  expect(await read()).toMatchObject({ status: 'target-unavailable', video: null, comments: [], reason: expect.any(String) });
  expect(fetch).not.toHaveBeenCalled();
});
it.each([{ aid: 0 }, { aid: '170001' }, { aid: 1.5 }, { aid: Number.MAX_SAFE_INTEGER + 1 }, { bvid: '' }, { bvid: 'bad' }, { bvid: null }])('rejects invalid explicit identifiers without falling back: %j', async args => {
  const { fetch, read } = fixture();
  expect(await read(args)).toMatchObject({ status: 'target-unavailable', video: null });
  expect(fetch).not.toHaveBeenCalled();
});
it('verifies both identifiers and never reads comments when they conflict', async () => {
  const { fetch, read } = fixture();
  expect(await read({ aid: other.aid, bvid: video.bvid })).toMatchObject({ status: 'target-unavailable', video: null,
    requestedTarget: { aid: other.aid, bvid: video.bvid }, reason: expect.stringContaining('does not match') });
  expect(fetch).toHaveBeenCalledTimes(1);
});
it('accepts two matching identifiers', async () => {
  const { read } = fixture();
  expect(await read({ aid: video.aid, bvid: video.bvid })).toMatchObject({ status: 'available', video });
});
it('refuses metadata for a different video even when only one id was requested', async () => {
  const { fetch, read } = fixture();
  fetch.mockReset().mockResolvedValue({ ok: true, json: async () => ({ code: 0, data: other }) });
  expect(await read()).toMatchObject({ status: 'target-unavailable', video: null });
  expect(fetch).toHaveBeenCalledTimes(1);
});
it.each([[], null])('labels a successful empty API list separately from failure: %j', async replies => {
  const { fetch, read } = fixture();
  fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ code: 0, data: { replies } }) });
  expect(await read()).toMatchObject({ status: 'empty', video, comments: [], reason: expect.stringContaining('does not prove') });
});
it.each([{}, { replies: {} }, null])('rejects malformed success payloads instead of silently returning empty: %j', async data => {
  const { fetch, read } = fixture();
  fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ code: 0, data }) });
  expect(await read()).toMatchObject({ status: 'error', video, error: expect.stringContaining('replies') });
});
it.each([
  { ok: false, status: 403 },
  { ok: true, json: async () => ({ code: -412, message: '请求被拦截' }) },
])('preserves HTTP/API failures together with the resolved video', async response => {
  const { fetch, read } = fixture();
  fetch.mockResolvedValueOnce(response);
  const result = await read();
  expect(result).toMatchObject({ status: 'error', video, comments: [] });
  expect(result.error).toBe(response.ok ? 'Bilibili API -412: 请求被拦截' : 'Bilibili HTTP 403');
});
it('preserves network errors and the target after metadata resolution', async () => {
  const { fetch, read } = fixture();
  fetch.mockRejectedValueOnce(new TypeError('Failed to fetch'));
  expect(await read()).toMatchObject({ status: 'error', video, error: expect.stringContaining('Failed to fetch') });
});
it('keeps requested and resolved identifiers distinct when metadata lookup fails', async () => {
  const { fetch, read } = fixture();
  fetch.mockReset().mockResolvedValue({ ok: true, json: async () => ({ code: -404, message: '视频不存在' }) });
  expect(await read({ aid: video.aid })).toMatchObject({ status: 'error', requestedTarget: { aid: video.aid }, video: null, error: 'Bilibili API -404: 视频不存在' });
  expect(fetch).toHaveBeenCalledTimes(1);
});
it('caps the returned list at ten comments', async () => {
  const { fetch, read } = fixture();
  fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ code: 0, data: { replies: Array(15).fill(reply) } }) });
  expect((await read()).comments).toHaveLength(10);
});
it.each(['search', 'related'])('preserves the array receipt for %s', async action => {
  const { fetch, read } = fixture();
  fetch.mockReset().mockResolvedValue({ ok: true, json: async () => ({ code: 0, data: action === 'search' ? { result: [video] } : [video] }) });
  expect(await read({ action, query: '搜索', bvid: video.bvid })).toEqual([expect.objectContaining({ bvid: video.bvid, title: video.title })]);
});
