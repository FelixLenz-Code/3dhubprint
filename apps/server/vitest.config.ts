import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { env: { APP_SECRET: 'test-secret-test-secret-test-secret!', NODE_ENV: 'test' } },
});
