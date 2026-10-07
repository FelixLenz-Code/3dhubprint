import { sqliteTable, text, integer, real, uniqueIndex, index, primaryKey } from 'drizzle-orm/sqlite-core';

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
  /** Confirmed empty by a user; cleared whenever a print starts. Gates the queue. */
  bedClear: integer('bed_clear', { mode: 'boolean' }).notNull().default(false),
  /** Orca bed type (curr_bed_type) used for slicing; null = machine default. */
  bedType: text('bed_type'),
  /** Active Spoolman spool, when Moonraker does not track it itself. */
  spoolId: integer('spool_id'),
  /** JSON BedCheckSettings; null = off. */
  bedCheck: text('bed_check'),
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

export const slicerProfiles = sqliteTable('slicer_profiles', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  kind: text('kind', { enum: ['machine', 'process', 'filament'] }).notNull(),
  name: text('name').notNull(),
  version: integer('version').notNull(),
  current: integer('current', { mode: 'boolean' }).notNull().default(true),
  parent: text('parent'),
  systemPrinter: text('system_printer'),
  /** JSON: fully resolved Orca settings. */
  settings: text('settings').notNull(),
  /** JSON: ProfileSummary. */
  summary: text('summary').notNull(),
  sourceFile: text('source_file'),
  createdAt: integer('created_at').notNull(),
});

export const printerProfiles = sqliteTable(
  'printer_profiles',
  {
    printerId: integer('printer_id')
      .notNull()
      .references(() => printers.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: ['machine', 'process', 'filament'] }).notNull(),
    profileName: text('profile_name').notNull(),
  },
  (t) => [primaryKey({ columns: [t.printerId, t.kind, t.profileName] })],
);

export const models = sqliteTable('models', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  filename: text('filename').notNull(),
  format: text('format', { enum: ['stl', '3mf', 'obj'] }).notNull(),
  storedPath: text('stored_path').notNull(),
  size: integer('size').notNull(),
  sha256: text('sha256').notNull(),
  triangles: integer('triangles').notNull(),
  sizeX: real('size_x').notNull(),
  sizeY: real('size_y').notNull(),
  sizeZ: real('size_z').notNull(),
  source: text('source').notNull().default('upload'),
  sourceUrl: text('source_url'),
  license: text('license'),
  author: text('author'),
  createdAt: integer('created_at').notNull(),
});

export const jobs = sqliteTable('jobs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  modelId: integer('model_id')
    .notNull()
    .references(() => models.id),
  printerId: integer('printer_id').references(() => printers.id, { onDelete: 'set null' }),
  machineProfileId: integer('machine_profile_id').notNull(),
  processProfileId: integer('process_profile_id').notNull(),
  filamentProfileId: integer('filament_profile_id').notNull(),
  copies: integer('copies').notNull().default(1),
  autoOrient: integer('auto_orient', { mode: 'boolean' }).notNull().default(false),
  autoPrint: integer('auto_print', { mode: 'boolean' }).notNull().default(false),
  status: text('status', {
    enum: [
      'queued',
      'slicing',
      'sliced',
      'uploading',
      'uploaded',
      'waiting',
      'printing',
      'done',
      'print_failed',
      'print_cancelled',
      'failed',
      'cancelled',
    ],
  }).notNull(),
  error: text('error'),
  log: text('log'),
  gcodePath: text('gcode_path'),
  gcodeName: text('gcode_name'),
  printerPath: text('printer_path'),
  estimatedTime: real('estimated_time'),
  filamentMm: real('filament_mm'),
  filamentG: real('filament_g'),
  note: text('note'),
  /** JSON: SliceOverrides */
  overrides: text('overrides').notNull().default('{}'),
  /** Orca bed type the job was sliced for. */
  bedType: text('bed_type'),
  /** Let Orca arrange the parts; false = use the positions stored per model. */
  arrange: integer('arrange', { mode: 'boolean' }).notNull().default(true),
  /** Sliced for review in the job wizard; hidden until saved, removed after a day. */
  draft: integer('draft', { mode: 'boolean' }).notNull().default(false),
  /** Edited copy of this job: the original is replaced when the draft is saved. */
  replaces: integer('replaces'),
  /** Position in the printer's queue while status = waiting. */
  queuePosition: integer('queue_position'),
  finishedAt: integer('finished_at'),
  createdBy: integer('created_by'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const jobModels = sqliteTable(
  'job_models',
  {
    jobId: integer('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    modelId: integer('model_id')
      .notNull()
      .references(() => models.id),
    copies: integer('copies').notNull().default(1),
    position: integer('position').notNull().default(0),
    /** JSON: ModelTransform (rotation, scale, bed positions); null = as uploaded. */
    transform: text('transform'),
  },
  (t) => [primaryKey({ columns: [t.jobId, t.modelId] })],
);

export const appSettings = sqliteTable('app_settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});

export const pushSubscriptions = sqliteTable('push_subscriptions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: integer('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  endpoint: text('endpoint').notNull(),
  p256dh: text('p256dh').notNull(),
  auth: text('auth').notNull(),
  userAgent: text('user_agent'),
  /** JSON: NotificationEvent[] */
  events: text('events').notNull(),
  failures: integer('failures').notNull().default(0),
  createdAt: integer('created_at').notNull(),
  lastSuccessAt: integer('last_success_at'),
});

/** Print history mirrored from Moonraker, for statistics and costs (also prints started elsewhere). */
export const prints = sqliteTable(
  'prints',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    printerId: integer('printer_id').references(() => printers.id, { onDelete: 'set null' }),
    /** Kept when the printer is removed. */
    printerName: text('printer_name').notNull(),
    moonrakerJobId: text('moonraker_job_id').notNull(),
    filename: text('filename').notNull(),
    status: text('status').notNull(),
    /** Unix ms */
    startTime: integer('start_time').notNull(),
    endTime: integer('end_time'),
    printDuration: real('print_duration').notNull(),
    totalDuration: real('total_duration').notNull(),
    filamentMm: real('filament_mm').notNull(),
    filamentG: real('filament_g'),
    material: text('material'),
    filamentName: text('filament_name'),
    color: text('color'),
    jobId: integer('job_id'),
    spoolId: integer('spool_id'),
    spoolName: text('spool_name'),
    /** Snapshot of the material price at print time; null = default price from the settings. */
    pricePerKg: real('price_per_kg'),
    priceSource: text('price_source', { enum: ['spool', 'profile', 'default'] }).notNull().default('default'),
    syncedAt: integer('synced_at').notNull(),
  },
  (t) => [uniqueIndex('prints_moonraker_idx').on(t.printerId, t.moonrakerJobId), index('prints_start_idx').on(t.startTime)],
);

export const bedReferences = sqliteTable('bed_references', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  printerId: integer('printer_id')
    .notNull()
    .references(() => printers.id, { onDelete: 'cascade' }),
  createdAt: integer('created_at').notNull(),
  source: text('source', { enum: ['manual', 'confirmed'] }).notNull(),
});
