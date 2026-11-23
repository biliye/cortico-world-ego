import { lookup } from 'node:dns';
import { request, type RequestOptions } from 'node:https';
import { BlockList, isIP } from 'node:net';

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const nonPublic = new BlockList();
for (const [network, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) nonPublic.addSubnet(network, bits, 'ipv4');
for (const [network, bits] of [
  ['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20],
] as const) nonPublic.addSubnet(network, bits, 'ipv6');
const globalIpv6 = new BlockList();
globalIpv6.addSubnet('2000::', 3, 'ipv6');

export function isAllowedSearchAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !nonPublic.check(address, 'ipv4');
  return family === 6 && globalIpv6.check(address, 'ipv6') && !nonPublic.check(address, 'ipv6');
}

export type SearchRequest = (url: URL, options: { key?: string; body?: object; signal: AbortSignal; response?: 'html' }) => Promise<unknown>;

export const requestSearch: SearchRequest = (url, { key, body, signal, response: format }) => new Promise((resolve, reject) => {
  const payload = body && JSON.stringify(body);
  const options: RequestOptions & { autoSelectFamily: false } = {
    method: payload ? 'POST' : 'GET',
    signal,
    agent: false,
    autoSelectFamily: false,
    headers: {
      accept: format === 'html' ? 'text/html' : 'application/json',
      'user-agent': 'cortico-world-ego (https://github.com/biliye/cortico-world-ego)',
      ...(payload && { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }),
      ...(key && { authorization: `Bearer ${key}` }),
    },
    // Resolve at connection time. The benchmark range is also used by local
    // DNS proxies, which still need to pass HTTPS certificate validation.
    lookup: (hostname, _options, callback) => {
      lookup(hostname, { all: true, order: 'ipv4first' }, (error, addresses) => {
        if (error) return callback(error, '', 4);
        const address = addresses.find(record => isAllowedSearchAddress(record.address));
        if (!address) {
          const error = Object.assign(new Error('The search endpoint only resolved to blocked addresses.'), { code: 'EGO_SEARCH_ADDRESS_BLOCKED' });
          return callback(error, '', 4);
        }
        callback(null, address.address, address.family);
      });
    },
  };
  const outgoing = request(url, options, response => {
    const status = response.statusCode ?? 0;
    if (status < 200 || status >= 300) {
      response.destroy();
      reject(new Error(`HTTP ${status}`));
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    response.on('error', reject);
    response.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_RESPONSE_BYTES) {
        reject(new Error('Search response exceeds 2 MiB.'));
        response.destroy();
      } else chunks.push(chunk);
    });
    response.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (format === 'html') { resolve(text); return; }
      try { resolve(JSON.parse(text) as unknown); }
      catch { reject(new Error('Search source returned invalid JSON.')); }
    });
  });
  outgoing.on('error', reject);
  outgoing.end(payload);
});
