import { describe, expect, it } from 'vitest';
import { parseEnv } from '../src/config.js';

const SECRET = 'x'.repeat(40);

describe('parseEnv', () => {
  it('treats empty values from the installer .env as unset', () => {
    const env = parseEnv({ APP_SECRET: SECRET, PUBLIC_URL: '', TRUSTED_PROXIES: '', PORT: '' });
    expect(env.PUBLIC_URL).toBeUndefined();
    expect(env.TRUSTED_PROXIES).toBe('');
    expect(env.PORT).toBe(8080);
  });

  it('still rejects invalid values', () => {
    expect(() => parseEnv({ APP_SECRET: SECRET, PUBLIC_URL: 'kein-url' })).toThrow();
    expect(() => parseEnv({ APP_SECRET: 'kurz' })).toThrow();
  });
});
