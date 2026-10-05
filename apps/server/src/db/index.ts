import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import * as schema from './schema.js';
import { migrations } from './migrations.js';

export function openDb(dataDir: string) {
  fs.mkdirSync(dataDir, { recursive: true });
  const sqlite = new Database(path.join(dataDir, 'printhub.db'));
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');
  migrate(sqlite);
  return { sqlite, db: drizzle(sqlite, { schema }) };
}

function migrate(sqlite: Database.Database) {
  const current = sqlite.pragma('user_version', { simple: true }) as number;
  for (let v = current; v < migrations.length; v++) {
    sqlite.transaction(() => {
      sqlite.exec(migrations[v]!);
      sqlite.pragma(`user_version = ${v + 1}`);
    })();
  }
}

export type Db = ReturnType<typeof openDb>['db'];
export { schema };
