import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
const framework = fileURLToPath(new URL('../../cortico/src/', import.meta.url));
export default defineConfig({
  resolve: { alias: [{ find: /^cortico\//, replacement: framework }] },
  server: { fs: { allow: [fileURLToPath(new URL('./', import.meta.url)), framework] } },
  test: { include: ['tests/**/*.test.ts'], testTimeout: 20000, pool: 'forks', env: { CORTICO_LANGUAGE: 'zh' } },
});
