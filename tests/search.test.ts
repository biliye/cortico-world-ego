import { describe, expect, it, vi } from 'vitest';
import { EgoSearch } from '../src/search.ts';
import { isAllowedSearchAddress, type SearchRequest } from '../src/search-http.ts';
import { DEFAULT_SEARCH_SETTINGS, SEARCH_SECRETS, validateSearchSettings } from '../src/search-settings.ts';

const moegirl = 'zh.moegirl.org.cn';
const tavily = 'api.tavily.com';
const deepseek = 'api.deepseek.com';
const query = '不要停下来啊';
const wikiHit = { pageid: 42, title: '不要停下来啊', snippet: '<span class="searchmatch">不要停下来啊</span>' };
const pageUrl = 'https://zh.moegirl.org.cn/Example';
const wikiResult = { query: { search: [wikiHit] } };
const wikiPage = { query: { pages: [{ pageid: 42, fullurl: pageUrl, extract: '用来调侃角色继续行动的名场面。该台词出自某部动画。' }] } };
const clean = () => structuredClone(DEFAULT_SEARCH_SETTINGS);
const keyByName = (name: string) => name === SEARCH_SECRETS.tavily ? 'test-tavily' : 'test-deepseek';

describe('public search', () => {
  it('stops at a supported wiki explanation and includes the linked excerpt', async () => {
    const request = vi.fn<SearchRequest>(async url => url.searchParams.has('list') ? wikiResult : wikiPage);
    const search = new EgoSearch({ settings: clean, request, secret: keyByName });
    const outcome = await search.search({ query, mode: 'meme' }, AbortSignal.timeout(1000));
    expect(outcome).toMatchObject({
      status: 'available',
      meme: { title: query, url: pageUrl, meaningAndUsage: '用来调侃角色继续行动的名场面。', originEvidence: '该台词出自某部动画。' },
      attempts: [{ id: 'moegirl', status: 'matched' }],
    });
    expect(request.mock.calls.map(([url]) => url.hostname)).toEqual([moegirl, moegirl]);
    expect(request.mock.calls[0][1].key).toBeUndefined();
  });

  it('uses both fallbacks for a weak wiki hit and rate-limited Tavily', async () => {
    const settings = clean();
    settings.preferredDomains = ['community.example.org'];
    const request = vi.fn<SearchRequest>(async url => {
      if (url.hostname === moegirl) return url.searchParams.has('list') ? wikiResult : { query: { pages: [] } };
      if (url.hostname === tavily) throw new Error('HTTP 429');
      return { results: [{ title: query, url: 'https://community.example.org/quote', summary: `${query}源自一部动画。` }] };
    });
    const search = new EgoSearch({ settings: () => settings, request, secret: keyByName });
    const outcome = await search.search({ query, mode: 'meme' }, AbortSignal.timeout(1000));
    expect(outcome).toMatchObject({
      status: 'available', source: 'DeepSeek',
      attempts: [{ id: 'moegirl', status: 'weak' }, { id: 'tavily', status: 'error', reason: 'HTTP 429' }, { id: 'deepseek', status: 'matched' }],
    });
    expect(request.mock.calls[2][1]).toMatchObject({
      key: 'test-tavily', body: { include_domains: settings.preferredDomains, include_domains_mode: 'prefer' },
    });
    expect(request.mock.calls[3][1]).toMatchObject({ key: 'test-deepseek', body: { need_content: true } });
    expect(JSON.stringify(outcome)).not.toContain('test-deepseek');
  });

  it('uses anonymous OpenSearch and article excerpts when a Wiki restricts its Action API', async () => {
    const request = vi.fn<SearchRequest>(async (url, options) => {
      if (options.response === 'html') return '<div class="mw-parser-output"><p><script>这是脚本</script></p><p>这句台词出自动画。</p><p>通常指主角的名场景。</p></div>';
      if (url.searchParams.get('action') === 'opensearch') {
        return [query, [query, 'External link'], ['', ''], [pageUrl, 'https://example.org/other']];
      }
      return { error: { code: 'action-notallowed' } };
    });
    const search = new EgoSearch({ settings: clean, request });
    const outcome = await search.search({ query, mode: 'meme' }, AbortSignal.timeout(1000));
    expect(outcome).toMatchObject({
      status: 'available',
      meme: { url: pageUrl, meaningAndUsage: '通常指主角的名场景。', originEvidence: '这句台词出自动画。' },
    });
    expect(request).toHaveBeenCalledTimes(3);
    expect(request.mock.calls.every(([url]) => url.hostname === moegirl)).toBe(true);
  });

  it('uses the saved order, applies it on the next call, and skips unconfigured sources', async () => {
    const settings = clean();
    const request = vi.fn<SearchRequest>(async () => ({ results: [{ title: 'Example', url: 'https://example.org/1', content: 'A result' }] }));
    const search = new EgoSearch({ settings: () => settings, request, secret: keyByName });
    const signal = AbortSignal.timeout(1000);
    expect(await search.search({ query }, signal)).toMatchObject({ source: 'Tavily' });
    expect(request.mock.calls[0][0].hostname).toBe(tavily);
    const [first, second, third] = settings.sources;
    settings.sources = [{ ...second, enabled: false }, first, third];
    expect(await search.search({ query }, signal)).toMatchObject({ source: 'DeepSeek', attempts: [{ id: 'tavily', status: 'skipped' }, { id: 'deepseek', status: 'matched' }] });
    const noKeys = new EgoSearch({ settings: clean, request });
    expect(await noKeys.search({ query }, signal)).toMatchObject({
      status: 'unavailable', attempts: [{ id: 'tavily', status: 'skipped' }, { id: 'deepseek', status: 'skipped' }],
    });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('uses a specifically named custom Wiki and keeps uncertain evidence separate from misses', async () => {
    const settings = clean();
    settings.sources.splice(1, 0, { id: 'custom', kind: 'mediawiki', name: '自选 Wiki', endpoint: 'https://wiki.example.org/w/api.php', enabled: true });
    let empty = false;
    const request = vi.fn<SearchRequest>(async url => {
      if (empty) return { query: { search: [] } };
      return url.searchParams.has('list') ? wikiResult : { query: { pages: [] } };
    });
    const search = new EgoSearch({ settings: () => settings, request, secret: keyByName });
    const signal = AbortSignal.timeout(1000);
    expect(await search.search({ query, mode: 'meme', source: '自选 Wiki' }, signal)).toMatchObject({
      status: 'unverified', meme: { source: '自选 Wiki', url: 'https://wiki.example.org/w/index.php?curid=42', originEvidence: null },
    });
    expect(request.mock.calls.every(([url]) => url.hostname === 'wiki.example.org')).toBe(true);
    empty = true;
    expect(await search.search({ query, mode: 'meme', source: 'custom' }, signal)).toMatchObject({ status: 'no_match' });
  });

  it('returns competing origins and uses supplied context to resolve a close match', async () => {
    const request = vi.fn<SearchRequest>(async () => ({ results: [
      { title: '动画里的不要停下来啊', url: 'https://example.org/anime', content: '不要停下来啊出自动画。' },
      { title: '直播里的不要停下来啊', url: 'https://example.org/live', content: '不要停下来啊出自直播。' },
    ] }));
    const search = new EgoSearch({ settings: clean, request, secret: keyByName });
    const signal = AbortSignal.timeout(1000);
    expect(await search.search({ query, mode: 'meme', source: 'tavily' }, signal)).toMatchObject({
      status: 'ambiguous', alternatives: [{ url: 'https://example.org/live' }],
    });
    expect(await search.search({ query, mode: 'meme', source: 'tavily', context: '直播' }, signal)).toMatchObject({
      status: 'available', meme: { url: 'https://example.org/live' },
    });
  });

  it('reports distinct explanations without origins and omits unrelated web results', async () => {
    const request = vi.fn<SearchRequest>(async () => ({ results: [
      { title: '动画里的不要停下来啊', url: 'https://example.org/anime', content: '不要停下来啊通常指一段动画台词。' },
      { title: '直播里的不要停下来啊', url: 'https://example.org/live', content: '不要停下来啊用来调侃直播观众。' },
      { title: '无关结果', url: 'https://example.org/other', content: '用来表示一个其他概念。' },
    ] }));
    const search = new EgoSearch({ settings: clean, request, secret: keyByName });
    const signal = AbortSignal.timeout(1000);
    expect(await search.search({ query, mode: 'meme', source: 'tavily' }, signal)).toMatchObject({
      status: 'ambiguous', alternatives: [{ url: 'https://example.org/live', originEvidence: null }],
    });
    expect(await search.search({ query: '无相似结果', mode: 'meme', source: 'tavily' }, signal)).toMatchObject({
      status: 'no_match',
    });
  });

  it('cancels an in-flight request without trying the next provider', async () => {
    const abort = new AbortController();
    const request = vi.fn<SearchRequest>(async (_url, { signal }) => {
      abort.abort(new Error('Cancelled by caller'));
      signal.throwIfAborted();
    });
    const search = new EgoSearch({ settings: clean, request, secret: keyByName });
    await expect(search.search({ query }, abort.signal)).rejects.toThrow('Cancelled by caller');
    expect(request).toHaveBeenCalledTimes(1);
  });
});

describe('custom search settings', () => {
  it('returns independent defaults and flags only invalid saved settings', () => {
    const oldDeployment = new EgoSearch({ settings: () => undefined });
    expect(oldDeployment.panelState()).toMatchObject({ invalidSettings: false, settings: clean() });

    const invalid = clean();
    invalid.preferredDomains = ['not a domain'];
    const search = new EgoSearch({ settings: () => invalid });
    const draft = search.panelState();
    expect(draft).toMatchObject({ invalidSettings: true, settings: clean() });
    draft.settings.sources.shift();
    draft.settings.sources[0].enabled = false;
    draft.settings.preferredDomains.push('example.org');
    expect(search.panelState()).toMatchObject({
      invalidSettings: true,
      settings: { sources: [{ id: 'moegirl', enabled: true }, { id: 'tavily', enabled: true }, { id: 'deepseek', enabled: true }], preferredDomains: [] },
    });
    expect(invalid.preferredDomains).toEqual(['not a domain']);
  });

  it('preserves order and canonicalizes preferred domains', () => {
    const settings = clean();
    settings.sources.reverse();
    settings.preferredDomains = ['EXAMPLE.ORG.', 'example.org'];
    expect(validateSearchSettings(settings)).toEqual({ ...settings, preferredDomains: ['example.org'] });
  });

  it.each([
    'http://wiki.example.org/api.php', 'https://127.0.0.1/api.php', 'https://wiki.local/api.php',
    'https://wiki.example.org:8443/api.php', 'https://user:pass@wiki.example.org/api.php',
    'https://wiki.example.org/api.php?action=edit',
  ])('rejects unsupported API endpoints (%s)', endpoint => {
    const settings = clean();
    const source = settings.sources[0];
    if (source.kind !== 'mediawiki') throw new Error('Expected a wiki source');
    source.endpoint = endpoint;
    expect(() => validateSearchSettings(settings)).toThrow();
  });

  it('rejects local DNS addresses and allows public and transparent proxy routes', () => {
    for (const host of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '100.64.0.1', '::1', 'fc00::1', '::ffff:127.0.0.1', '2002:7f00:1::1']) {
      expect(isAllowedSearchAddress(host)).toBe(false);
    }
    expect(isAllowedSearchAddress('1.1.1.1')).toBe(true);
    expect(isAllowedSearchAddress('2606:4700:4700::1111')).toBe(true);
    expect(isAllowedSearchAddress('198.18.0.4')).toBe(true);
  });
});
