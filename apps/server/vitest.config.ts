import { defineConfig } from 'vitest/config';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export default defineConfig({
  test: {
    env: {
      APP_SECRET: 'test-secret-test-secret-test-secret!',
      NODE_ENV: 'test',
      LOG_LEVEL: 'fatal',
      DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'printhub-it-')),
    },
  },
});
