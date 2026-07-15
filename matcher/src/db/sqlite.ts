import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import Database from 'better-sqlite3';

import { applySchema } from './schema.js';

export interface OpenDatabaseOptions {
  readonly readonly?: boolean;
}

/**
 * Opens (creating if needed) the Matcher's SQLite database and applies the
 * schema idempotently. Pass ':memory:' for tests/ephemeral use.
 */
export function openDatabase(path: string, options: OpenDatabaseOptions = {}): Database.Database {
  if (path !== ':memory:') {
    const dir = dirname(path);
    if (dir && dir !== '.') mkdirSync(dir, { recursive: true });
  }

  const db = new Database(path, { readonly: options.readonly ?? false });
  db.pragma('foreign_keys = ON');
  if (path !== ':memory:') {
    db.pragma('journal_mode = WAL');
  }

  applySchema(db);
  return db;
}
