import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    // Gives every test file its own DATA_DIR (and thus its own database).
    setupFiles: ['test/setup.ts'],
    env: {
      APP_SECRET: 'test-secret-test-secret-test-secret!',
      NODE_ENV: 'test',
      LOG_LEVEL: 'fatal',
      ORCA_BIN: path.resolve(import.meta.dirname, 'test/fake-orca.mjs'),
      ORCA_PROFILES: path.resolve(import.meta.dirname, '../../fixtures/orca-2.4.2/system'),
    },
  },
});
