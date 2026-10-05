import { z } from 'zod';
import path from 'node:path';

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().positive().default(8080),
  DATA_DIR: z.string().default('./data'),
  /**
   * 32+ chars. Used to encrypt stored secrets (printer API keys, TOTP secrets).
   * Changing it makes those secrets unreadable.
   */
  APP_SECRET: z.string().min(32, 'APP_SECRET muss mindestens 32 Zeichen lang sein'),
  /**
   * Comma-separated IPs/CIDRs of reverse proxies whose X-Forwarded-* headers are trusted,
   * e.g. "192.168.1.5". Empty = trust none.
   */
  TRUSTED_PROXIES: z.string().default(''),
  /** Public origin, e.g. https://drucker.example.de. Used for the TOTP issuer and origin checks. */
  PUBLIC_URL: z.string().url().optional(),
  /**
   * Set session cookies with the Secure flag. Defaults to true in production;
   * the app is expected to be reached via HTTPS through the reverse proxy.
   */
  COOKIE_SECURE: z
    .enum(['true', 'false', 'auto'])
    .default('auto'),
  SESSION_TTL_DAYS: z.coerce.number().int().positive().default(30),
  WEB_DIST: z.string().optional(),
  /** OrcaSlicer CLI; the Docker image ships it under /opt/orca. */
  ORCA_BIN: z.string().default('/opt/orca/AppRun'),
  ORCA_PROFILES: z.string().default('/opt/orca/resources/profiles'),
  ORCA_VERSION: z.string().default('2.4.2'),
  SLICE_TIMEOUT_MIN: z.coerce.number().positive().default(30),
  MAX_MODEL_MB: z.coerce.number().positive().default(300),
  /** Set by the Docker build (git tag or commit). */
  APP_VERSION: z.string().default('dev'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
});

/** Empty values (e.g. "PUBLIC_URL=" in .env) count as unset, so defaults and optionals apply. */
export function parseEnv(source: NodeJS.ProcessEnv) {
  return envSchema.parse(Object.fromEntries(Object.entries(source).filter(([, v]) => v !== undefined && v.trim() !== '')));
}

const env = parseEnv(process.env);

export const config = {
  ...env,
  isProd: env.NODE_ENV === 'production',
  dataDir: path.resolve(env.DATA_DIR),
  trustedProxies: env.TRUSTED_PROXIES.split(',').map((s) => s.trim()).filter(Boolean),
  cookieSecure:
    env.COOKIE_SECURE === 'auto' ? env.NODE_ENV === 'production' : env.COOKIE_SECURE === 'true',
  sessionTtlMs: env.SESSION_TTL_DAYS * 24 * 60 * 60 * 1000,
};
export type Config = typeof config;
