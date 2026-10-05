import { sqliteTable, text, integer, uniqueIndex, index } from 'drizzle-orm/sqlite-core';

export const users = sqliteTable(
  'users',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    username: text('username').notNull(),
    passwordHash: text('password_hash').notNull(),
    role: text('role', { enum: ['admin', 'viewer'] }).notNull().default('admin'),
    /** Encrypted TOTP secret; set while enrolling, active once totpEnabled = true. */
    totpSecret: text('totp_secret'),
    totpEnabled: integer('totp_enabled', { mode: 'boolean' }).notNull().default(false),
    /** Last accepted TOTP time step, prevents code replay. */
    totpLastStep: integer('totp_last_step'),
    failedLogins: integer('failed_logins').notNull().default(0),
    lockedUntil: integer('locked_until'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [uniqueIndex('users_username_idx').on(t.username)],
);

export const recoveryCodes = sqliteTable(
  'recovery_codes',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    codeHash: text('code_hash').notNull(),
    usedAt: integer('used_at'),
  },
  (t) => [index('recovery_codes_user_idx').on(t.userId)],
);

export const sessions = sqliteTable(
  'sessions',
  {
    /** sha256 of the session token; the raw token only lives in the cookie. */
    id: text('id').primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: integer('created_at').notNull(),
    lastSeenAt: integer('last_seen_at').notNull(),
    expiresAt: integer('expires_at').notNull(),
    userAgent: text('user_agent'),
    ip: text('ip'),
  },
  (t) => [index('sessions_user_idx').on(t.userId)],
);

export const printers = sqliteTable('printers', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  url: text('url').notNull(),
  /** Encrypted Moonraker API key. */
  apiKey: text('api_key'),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: integer('created_at').notNull(),
});

export const auditLog = sqliteTable('audit_log', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  at: integer('at').notNull(),
  userId: integer('user_id'),
  action: text('action').notNull(),
  detail: text('detail'),
  ip: text('ip'),
});
