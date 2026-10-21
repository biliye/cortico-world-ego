import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
await build({ entryPoints: [new URL('../src/webui/client.ts', import.meta.url).pathname.replace(/^\/(\w:)/, '$1')], outfile: new URL('../dist/webui.js', import.meta.url).pathname.replace(/^\/(\w:)/, '$1'), bundle: true, format: 'esm', platform: 'browser', target: 'es2022', minify: true });
await build({ entryPoints: [fileURLToPath(new URL('../src/helper.ts', import.meta.url))], outfile: fileURLToPath(new URL('../dist/ego-helper.mjs', import.meta.url)), bundle: true, format: 'esm', platform: 'node', target: 'node22' });
