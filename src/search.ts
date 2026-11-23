import { requestSearch, type SearchRequest } from './search-http.ts';
import {
  DEFAULT_SEARCH_SETTINGS, SEARCH_SECRETS, isWebSearchProvider, sourceLabel, validateSearchSettings,
  type SearchPanelState, type SearchSettings, type SearchSource,
} from './search-settings.ts';

const WEB_RESULTS = 5;
const PER_SOURCE_MS = 6500;
const TOTAL_MS = 20000;
type Mode = 'web' | 'meme';
type WikiSource = Extract<SearchSource, { kind: 'mediawiki' }>;
type Row = Record<string, unknown>;

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

interface MemeResult {
  title: string;
  url: string;
  meaningAndUsage: string | null;
  originEvidence: string | null;
  source: string;
}

interface Attempt {
  id: string;
  source: string;
  status: 'skipped' | 'empty' | 'weak' | 'matched' | 'error';
  reason?: string;
}

const entities: Record<string, string> = { amp: '&', apos: "'", gt: '>', lt: '<', nbsp: ' ', quot: '"' };

function cleanText(value: unknown, limit = 1800): string {
  if (typeof value !== 'string') return '';
  return value.slice(0, 6000).replace(/<[^>]*>/g, ' ').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (original, entity: string) => {
    if (!entity.startsWith('#')) return Object.hasOwn(entities, entity) ? entities[entity] : original;
    const code = entity[1]?.toLowerCase() === 'x' ? Number.parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ' ';
  }).replace(/\s+/g, ' ').trim().slice(0, limit);
}

function row(value: unknown): Row {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
}

function result(title: unknown, url: unknown, snippet: unknown): SearchResult | undefined {
  if (typeof url !== 'string' || url.length > 512) return;
  const parsed = URL.parse(url);
  if (!parsed || !['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return;
  const name = cleanText(title, 160);
  if (name) return { title: name, url: parsed.href, snippet: cleanText(snippet) };
}

function normalized(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}\p{Extended_Pictographic}]+/gu, '');
}

const originPattern = /(?:出自|源自|起源于|起源於|最早见于|最早見於|最早出现|最早出現|原为|原為|是.{0,100}的(?:名台[词詞]|经典台词|經典台詞)|originated|first appeared|comes from)/i;
const meaningPattern = /(?:指的是|通常指|一般指|用来|用來|用于|用於|用作|形容|调侃|調侃|谐音|諧音|网络用语|網絡用語|流行语|流行語|常见句式|常見句式|means|refers to|used to|catchphrase)/i;

function evaluateMeme(candidate: SearchResult, source: string, phrase: string, context: string) {
  const title = normalized(candidate.title);
  const query = normalized(phrase);
  const excerpt = candidate.snippet;
  const sentences = excerpt.split(/(?<=[。！？!?；;])|\.\s+/u).map(sentence => sentence.trim()).filter(Boolean);
  const mentions = sentences.map(sentence => normalized(sentence).includes(query));
  const nearMatch = sentences.filter((_sentence, idx) => mentions[idx] || mentions[idx - 1] || mentions[idx + 1]);
  const evidence = title === query ? sentences : nearMatch;
  const origin = evidence.find(sentence => originPattern.test(sentence));
  const usage = evidence.find(sentence => meaningPattern.test(sentence));
  const inTitle = title.includes(query);
  const contextWords = context.split(/[\s\p{P}]+/u).map(normalized).filter(word => word.length >= 2);
  const matchedContext = contextWords.some(word => normalized(`${candidate.title} ${excerpt}`).includes(word));
  const score = (title === query ? 4 : inTitle ? 3 : 0) + (nearMatch.length ? 2 : 0)
    + (usage ? 2 : 0) + (origin ? 2 : 0) + (matchedContext ? 2 : 0);
  const meme: MemeResult = {
    title: candidate.title, url: candidate.url, source,
    meaningAndUsage: (usage ?? evidence[0] ?? excerpt).slice(0, 380) || null,
    originEvidence: origin?.slice(0, 350) ?? null,
  };
  return { meme, score, related: inTitle || nearMatch.length > 0, strong: Boolean(usage || origin) && (title === query || nearMatch.length > 0) };
}

function interpretation(meme: MemeResult): string {
  return normalized(meme.originEvidence ?? meme.meaningAndUsage ?? '');
}

function searchText(value: unknown, label: string, limit: number, optional = false): string {
  if (value === undefined && optional) return '';
  if (typeof value !== 'string' || Array.from(value).length > limit || (!optional && !value.trim())) {
    throw new Error(`${label} must be ${optional ? 'at most' : '1 to'} ${limit} characters.`);
  }
  return value.trim();
}

function wikiUrl(endpoint: string, parameters: Record<string, string>): URL {
  const url = new URL(endpoint);
  url.search = new URLSearchParams({ format: 'json', formatversion: '2', action: 'query', ...parameters }).toString();
  return url;
}

function searchError(error: unknown, signal: AbortSignal): string {
  if (signal.aborted) return 'timed out';
  if (!(error instanceof Error)) return 'request failed';
  // Do not echo provider-controlled payloads, query strings or credentials.
  if (/^HTTP \d{3}$|^MediaWiki error: [a-z0-9_-]+$/i.test(error.message)) return error.message;
  const code = (error as NodeJS.ErrnoException).code;
  return code && /^[A-Z0-9_]+$/.test(code) ? code : 'request or response failed';
}

function wikiArticleExcerpt(value: unknown): string {
  if (typeof value !== 'string') return '';
  const article = value.search(/class=["'][^"']*\bmw-parser-output\b/i);
  if (article < 0) return '';
  const html = value.slice(article).replace(/<(script|style|sup)\b[^>]*>[\s\S]*?<\/\1>/gi, '');
  const paragraphs: string[] = [];
  for (const match of html.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)) {
    const text = cleanText(match[1], 420);
    if (text) paragraphs.push(text);
    if (paragraphs.length === 7) break;
  }
  return paragraphs.join(' ').slice(0, 1800);
}

export class EgoSearch {
  constructor(private readonly options: {
    settings: () => SearchSettings | undefined;
    secret?: (name: string) => string | undefined;
    request?: SearchRequest;
  }) {}

  panelState(): SearchPanelState {
    let settings = DEFAULT_SEARCH_SETTINGS;
    try { settings = this.settings(); } catch { /* A new save can replace invalid settings. */ }
    return {
      settings,
      configured: { tavily: Boolean(this.key('tavily')), deepseek: Boolean(this.key('deepseek')) },
    };
  }

  private settings(): SearchSettings {
    return validateSearchSettings(this.options.settings() ?? DEFAULT_SEARCH_SETTINGS);
  }

  private key(provider: keyof typeof SEARCH_SECRETS): string | undefined {
    return this.options.secret?.(SEARCH_SECRETS[provider])?.trim();
  }

  private async wikiOpenSearch(source: WikiSource, query: string, mode: Mode, signal: AbortSignal): Promise<SearchResult[]> {
    const request = this.options.request ?? requestSearch;
    const origin = new URL(source.endpoint).origin;
    const data = await request(wikiUrl(source.endpoint, {
      action: 'opensearch', search: query, namespace: '0', redirects: 'resolve', limit: String(WEB_RESULTS),
    }), { signal });
    if (row(data).error) throw new Error(`MediaWiki error: ${String(row(row(data).error).code)}`);
    if (!Array.isArray(data) || !Array.isArray(data[1]) || !Array.isArray(data[2]) || !Array.isArray(data[3])) {
      throw new Error('MediaWiki OpenSearch returned an invalid list.');
    }
    const [, titles, summaries, links] = data;
    const hits: SearchResult[] = titles.slice(0, WEB_RESULTS).flatMap((title, index) => {
      const hit = result(title, links[index], summaries[index]);
      return hit && new URL(hit.url).origin === origin ? [hit] : [];
    });
    if (mode === 'web') return hits;
    await Promise.all(hits.slice(0, 3).map(async hit => {
      try {
        const html = await request(new URL(hit.url), { signal, response: 'html' });
        const text = wikiArticleExcerpt(html);
        if (text) hit.snippet = text;
      } catch {
        // OpenSearch still supplied the title and link. Treat it as a lead.
      }
    }));
    return hits;
  }

  private async wiki(source: WikiSource, query: string, mode: Mode, signal: AbortSignal): Promise<SearchResult[]> {
    const request = this.options.request ?? requestSearch;
    let search: Row;
    try {
      search = row(await request(wikiUrl(source.endpoint, {
        list: 'search', srsearch: query, srnamespace: '0', srlimit: String(WEB_RESULTS), srprop: 'snippet',
      }), { signal }));
    } catch (error) {
      if (error instanceof Error && /^HTTP (401|403)$/.test(error.message)) return this.wikiOpenSearch(source, query, mode, signal);
      throw error;
    }
    const code = row(search.error).code;
    if (code === 'action-notallowed' || code === 'readapidenied' || code === 'permissiondenied') {
      return this.wikiOpenSearch(source, query, mode, signal);
    }
    if (search.error) throw new Error(`MediaWiki error: ${String(row(search.error).code)}`);
    const hits = row(search.query).search;
    if (!Array.isArray(hits)) throw new Error('MediaWiki response has no search list.');
    const matches = hits.slice(0, WEB_RESULTS).map(row).filter(hit => typeof hit.pageid === 'number' && Number.isSafeInteger(hit.pageid) && hit.pageid > 0);
    if (!matches.length) return [];

    // TextExtracts is optional on a MediaWiki install. The search snippets remain usable.
    let pages: Row[] = [];
    try {
      const data = row(await request(wikiUrl(source.endpoint, {
        pageids: matches.map(hit => hit.pageid).join('|'),
        prop: mode === 'meme' ? 'info|extracts' : 'info',
        inprop: 'url',
        ...(mode === 'meme' && { explaintext: '1', exlimit: String(matches.length), exchars: '950' }),
      }), { signal }));
      const records = row(data.query).pages;
      if (Array.isArray(records)) pages = records.map(row);
    } catch {
      signal.throwIfAborted();
    }
    const origin = new URL(source.endpoint).origin;
    return matches.flatMap(hit => {
      const info = pages.find(page => page.pageid === hit.pageid);
      const wikiPage = typeof info?.fullurl === 'string' ? URL.parse(info.fullurl) : null;
      const fallback = new URL('index.php', source.endpoint);
      fallback.searchParams.set('curid', String(hit.pageid));
      const url = wikiPage?.origin === origin ? wikiPage.href : fallback.href;
      const snippet = cleanText(hit.snippet, 500);
      const extract = cleanText(info?.extract, 1150);
      const combined = extract.includes(snippet) ? extract : [snippet, extract].filter(Boolean).join('。');
      return result(hit.title, url, combined) ?? [];
    });
  }

  private async web(provider: keyof typeof SEARCH_SECRETS, query: string, mode: Mode, preferredDomains: string[], key: string, signal: AbortSignal): Promise<SearchResult[]> {
    const request = this.options.request ?? requestSearch;
    const data = row(await request(new URL(provider === 'tavily' ? 'https://api.tavily.com/search' : 'https://api.deepseek.com/v1/tools/search'), {
      key, signal, body: provider === 'tavily' ? {
        query, max_results: WEB_RESULTS, search_depth: 'basic', include_answer: false, auto_parameters: false,
        ...(mode === 'meme' && preferredDomains.length && { include_domains: preferredDomains, include_domains_mode: 'prefer' }),
      } : { query, count: WEB_RESULTS, need_content: mode === 'meme' },
    }));
    if (!Array.isArray(data.results)) throw new Error('Search provider did not return a result list.');
    return data.results.slice(0, WEB_RESULTS).flatMap(value => {
      const item = row(value);
      const snippet = provider === 'tavily' ? item.content : [item.summary, item.content]
        .filter(value => typeof value === 'string' && value).join('\n');
      return result(item.title, item.url, snippet) ?? [];
    });
  }

  async search(args: Record<string, unknown>, signal: AbortSignal) {
    const mode = args.mode ?? 'web';
    if (mode !== 'web' && mode !== 'meme') throw new Error('mode must be web or meme.');
    const query = searchText(args.query, 'query', 128);
    const context = searchText(args.context, 'context', 120, true);
    if (mode === 'meme' && !normalized(query)) throw new Error('Use words, numbers or emoji to identify the meme.');
    const { sources, preferredDomains } = this.settings();
    const selected = args.source === undefined ? undefined : sources.find(source => source.id === args.source)
      ?? sources.find(source => sourceLabel(source) === args.source);
    if (args.source !== undefined && !selected) throw new Error(`Unknown search source. Configured IDs: ${sources.map(source => source.id).join(', ')}.`);
    const eligible = selected ? [selected] : sources.filter(source => mode === 'meme' || source.kind !== 'mediawiki');
    const attempts: Attempt[] = [];
    const total = AbortSignal.timeout(TOTAL_MS);
    const outbound = mode === 'meme' ? Array.from(`${query} ${context} ${/\p{Script=Han}/u.test(query) ? '梗 含义 出处' : 'meme meaning origin'}`).slice(0, 128).join('').trim() : query;
    let bestWeak: ReturnType<typeof evaluateMeme> | undefined;
    let searched = false;
    for (const source of eligible) {
      signal.throwIfAborted();
      const name = sourceLabel(source);
      const record = (status: Attempt['status'], reason?: string) => attempts.push({ id: source.id, source: name, status, ...(reason && { reason }) });
      if (total.aborted) { record('skipped', 'total search time limit reached'); break; }
      if (!source.enabled) { record('skipped', 'disabled'); continue; }
      const key = isWebSearchProvider(source.kind) ? this.key(source.kind) : undefined;
      if (source.kind !== 'mediawiki' && !key) { record('skipped', 'API key not configured'); continue; }
      const requestSignal = AbortSignal.any([signal, total, AbortSignal.timeout(PER_SOURCE_MS)]);
      try {
        const results = source.kind === 'mediawiki'
          ? await this.wiki(source, query, mode, requestSignal)
          : await this.web(source.kind, outbound, mode, preferredDomains, key!, requestSignal);
        signal.throwIfAborted();
        searched = true;
        if (!results.length) { record('empty'); continue; }
        if (mode === 'web') {
          record('matched');
          return { status: 'available', query, mode, source: name, results: results.map(hit => ({ ...hit, snippet: hit.snippet.slice(0, 500) })), attempts };
        }
        const ranked = results.map(hit => evaluateMeme(hit, name, query, context))
          .filter(hit => hit.related).sort((a, b) => b.score - a.score);
        if (!ranked.length) { record('empty', 'results did not mention the phrase'); continue; }
        const strong = ranked.filter(hit => hit.strong);
        const first = strong[0];
        if (!first) {
          record('weak');
          if (!bestWeak || ranked[0].score > bestWeak.score) bestWeak = ranked[0];
          continue;
        }
        record('matched');
        const alternatives = strong.slice(1).filter(hit => hit.score === first.score
          && normalized(hit.meme.title) !== normalized(first.meme.title)
          && interpretation(hit.meme) !== interpretation(first.meme)).slice(0, 2).map(hit => hit.meme);
        return {
          status: alternatives.length ? 'ambiguous' : 'available', query, mode, source: name,
          meme: first.meme, ...(alternatives.length && { alternatives }), attempts,
        };
      } catch (error) {
        signal.throwIfAborted();
        record('error', searchError(error, requestSignal));
      }
    }
    if (bestWeak) return { status: 'unverified', query, mode, meme: { ...bestWeak.meme, originEvidence: null }, attempts };
    return { status: searched ? 'no_match' : 'unavailable', query, mode, attempts };
  }
}
