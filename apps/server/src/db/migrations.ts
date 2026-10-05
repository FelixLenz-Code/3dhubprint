/** Append-only list of SQL migrations; index + 1 = schema version (PRAGMA user_version). */
export const migrations: string[] = [
  `
  CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'admin',
    totp_secret TEXT,
    totp_enabled INTEGER NOT NULL DEFAULT 0,
    totp_last_step INTEGER,
    failed_logins INTEGER NOT NULL DEFAULT 0,
    locked_until INTEGER,
    created_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX users_username_idx ON users (username COLLATE NOCASE);

  CREATE TABLE recovery_codes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code_hash TEXT NOT NULL,
    used_at INTEGER
  );
  CREATE INDEX recovery_codes_user_idx ON recovery_codes (user_id);

  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    user_agent TEXT,
    ip TEXT
  );
  CREATE INDEX sessions_user_idx ON sessions (user_id);

  CREATE TABLE printers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    url TEXT NOT NULL,
    api_key TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at INTEGER NOT NULL,
    user_id INTEGER,
    action TEXT NOT NULL,
    detail TEXT,
    ip TEXT
  );
  `,
  `
  CREATE TABLE slicer_profiles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    version INTEGER NOT NULL,
    current INTEGER NOT NULL DEFAULT 1,
    parent TEXT,
    system_printer TEXT,
    settings TEXT NOT NULL,
    summary TEXT NOT NULL,
    source_file TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX slicer_profiles_version_idx ON slicer_profiles (kind, name, version);
  CREATE INDEX slicer_profiles_current_idx ON slicer_profiles (kind, current);

  -- Assignments reference profile names so a re-imported (newer) version applies automatically.
  CREATE TABLE printer_profiles (
    printer_id INTEGER NOT NULL REFERENCES printers(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    profile_name TEXT NOT NULL,
    PRIMARY KEY (printer_id, kind, profile_name)
  );

  CREATE TABLE models (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    filename TEXT NOT NULL,
    format TEXT NOT NULL,
    stored_path TEXT NOT NULL,
    size INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    triangles INTEGER NOT NULL,
    size_x REAL NOT NULL,
    size_y REAL NOT NULL,
    size_z REAL NOT NULL,
    source TEXT NOT NULL DEFAULT 'upload',
    source_url TEXT,
    license TEXT,
    author TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX models_sha_idx ON models (sha256);

  CREATE TABLE jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    model_id INTEGER NOT NULL REFERENCES models(id),
    printer_id INTEGER REFERENCES printers(id) ON DELETE SET NULL,
    machine_profile_id INTEGER NOT NULL REFERENCES slicer_profiles(id),
    process_profile_id INTEGER NOT NULL REFERENCES slicer_profiles(id),
    filament_profile_id INTEGER NOT NULL REFERENCES slicer_profiles(id),
    copies INTEGER NOT NULL DEFAULT 1,
    auto_orient INTEGER NOT NULL DEFAULT 0,
    auto_print INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL,
    error TEXT,
    log TEXT,
    gcode_path TEXT,
    gcode_name TEXT,
    printer_path TEXT,
    estimated_time REAL,
    filament_mm REAL,
    filament_g REAL,
    note TEXT,
    created_by INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX jobs_status_idx ON jobs (status);
  `,
  `
  -- Several models per job (each with its own number of copies) and per-job setting overrides.
  CREATE TABLE job_models (
    job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    model_id INTEGER NOT NULL REFERENCES models(id),
    copies INTEGER NOT NULL DEFAULT 1,
    position INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (job_id, model_id)
  );
  CREATE INDEX job_models_model_idx ON job_models (model_id);
  INSERT INTO job_models (job_id, model_id, copies, position) SELECT id, model_id, copies, 0 FROM jobs;
  ALTER TABLE jobs ADD COLUMN overrides TEXT NOT NULL DEFAULT '{}';
  `,
  `
  -- Print queue: bed state per printer, queue order per job.
  ALTER TABLE printers ADD COLUMN bed_clear INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE jobs ADD COLUMN queue_position INTEGER;
  ALTER TABLE jobs ADD COLUMN finished_at INTEGER;

  CREATE TABLE app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE push_subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    endpoint TEXT NOT NULL,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    user_agent TEXT,
    events TEXT NOT NULL,
    failures INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    last_success_at INTEGER
  );
  CREATE UNIQUE INDEX push_subscriptions_endpoint_idx ON push_subscriptions (endpoint);
  `,
  `
  -- Bed type per printer/job, manual orientation and placement of parts.
  ALTER TABLE printers ADD COLUMN bed_type TEXT;
  ALTER TABLE jobs ADD COLUMN bed_type TEXT;
  ALTER TABLE jobs ADD COLUMN arrange INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE job_models ADD COLUMN transform TEXT;
  `,
];
