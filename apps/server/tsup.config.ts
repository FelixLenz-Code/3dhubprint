import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  // Bundle the workspace package (shipped as TS source); keep npm deps external.
  noExternal: ['@printhub/shared'],
  // .mjs keeps the bundle ESM even where package.json loses "type" (pnpm deploy drops it).
  outExtension: () => ({ js: '.mjs' }),
  clean: true,
  sourcemap: true,
});
