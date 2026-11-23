export const SEARCH_SECRETS = {
  tavily: 'CORTICO_EGO_TAVILY_API_KEY',
  deepseek: 'CORTICO_EGO_DEEPSEEK_API_KEY',
} as const;

export type WebSearchProvider = keyof typeof SEARCH_SECRETS;
export type SearchSource =
  | { id: string; kind: 'mediawiki'; name: string; endpoint: string; enabled: boolean }
  | { id: WebSearchProvider; kind: WebSearchProvider; enabled: boolean };

export interface SearchSettings {
  sources: SearchSource[];
  preferredDomains: string[];
}

export interface SearchPanelState {
  settings: SearchSettings;
  configured: Record<WebSearchProvider, boolean>;
}

export const DEFAULT_SEARCH_SETTINGS: SearchSettings = {
  sources: [
    { id: 'moegirl', kind: 'mediawiki', name: '萌娘百科', endpoint: 'https://zh.moegirl.org.cn/api.php', enabled: true },
    { id: 'tavily', kind: 'tavily', enabled: true },
    { id: 'deepseek', kind: 'deepseek', enabled: true },
  ],
  preferredDomains: [],
};

export function sourceLabel(source: SearchSource): string {
  if (source.kind === 'mediawiki') return source.name;
  return source.kind === 'tavily' ? 'Tavily' : 'DeepSeek';
}

export function isWebSearchProvider(value: unknown): value is WebSearchProvider {
  return value === 'tavily' || value === 'deepseek';
}

function domainName(input: unknown): string {
  if (typeof input !== 'string') throw new Error('Enter a public domain name.');
  const value = input.trim().replace(/\.$/, '');
  if (!value || /[\s/\\:@?#%\[\]]/.test(value)) throw new Error('Enter a public domain name.');
  const hostname = new URL(`https://${value}`).hostname;
  if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$/.test(hostname)
    || /\.(?:localhost|local|internal|home|lan|test|invalid|example)$/.test(hostname)) {
    throw new Error('Enter a public domain name.');
  }
  return hostname;
}

function wikiEndpoint(input: unknown): string {
  if (typeof input !== 'string' || input.length > 512) throw new Error('Enter a MediaWiki API address.');
  const url = new URL(input.trim());
  if (url.protocol !== 'https:' || url.port || url.username || url.password || url.search || url.hash
    || !url.pathname.endsWith('/api.php')) {
    throw new Error('Use an HTTPS MediaWiki api.php address without query parameters or credentials.');
  }
  url.hostname = domainName(url.hostname);
  return url.href;
}

export function validateSearchSettings(input: unknown): SearchSettings {
  if (!input || typeof input !== 'object') throw new Error('Invalid search settings.');
  const { sources, preferredDomains } = input as Partial<SearchSettings>;
  if (!Array.isArray(sources) || sources.length > 10 || !Array.isArray(preferredDomains) || preferredDomains.length > 20) {
    throw new Error('Search settings allow up to 10 sources and 20 preferred domains.');
  }
  const ids = new Set<string>();
  const endpoints = new Set<string>();
  const cleanSources = sources.map((source): SearchSource => {
    if (!source || typeof source.id !== 'string' || !/^[a-z0-9-]{1,48}$/.test(source.id)
      || typeof source.enabled !== 'boolean' || ids.has(source.id)) {
      throw new Error('Each search source must have a unique ID and an enabled status.');
    }
    ids.add(source.id);
    if (source.kind === 'mediawiki') {
      const name = typeof source.name === 'string' ? source.name.trim() : '';
      if (!name || name.length > 60 || isWebSearchProvider(source.id)) throw new Error('Enter a name for each MediaWiki source.');
      const endpoint = wikiEndpoint(source.endpoint);
      if (endpoints.has(endpoint)) throw new Error('This MediaWiki API address is already listed.');
      endpoints.add(endpoint);
      return { id: source.id, kind: source.kind, name, endpoint, enabled: source.enabled };
    }
    if (!isWebSearchProvider(source.kind) || source.id !== source.kind) throw new Error('Unknown search provider.');
    return { id: source.kind, kind: source.kind, enabled: source.enabled };
  });
  if (!ids.has('tavily') || !ids.has('deepseek')) throw new Error('Tavily and DeepSeek must remain in the list. Use the checkboxes to disable them.');
  return { sources: cleanSources, preferredDomains: [...new Set(preferredDomains.map(domainName))] };
}
