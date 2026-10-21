import { build } from 'esbuild';
await build({ entryPoints: [new URL('../src/webui/client.ts', import.meta.url).pathname.replace(/^\/(\w:)/, '$1')], outfile: new URL('../dist/webui.js', import.meta.url).pathname.replace(/^\/(\w:)/, '$1'), bundle: true, format: 'esm', platform: 'browser', target: 'es2022', minify: true });
