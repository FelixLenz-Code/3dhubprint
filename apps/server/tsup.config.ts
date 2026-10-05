import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  // Bundle the workspace package (shipped as TS source); keep npm deps external.
  noExternal: ['@printhub/shared'],
  clean: true,
  sourcemap: true,
});
