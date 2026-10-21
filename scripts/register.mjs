import { registerHooks } from 'node:module';
registerHooks({ resolve(specifier, context, next) {
  return next(specifier.startsWith('cortico/') ? new URL(`../../../cortico/src/${specifier.slice(8)}`, import.meta.url).href : specifier, context);
} });
