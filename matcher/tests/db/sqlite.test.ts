import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { openDatabase } from '../../src/db/sqlite.js';

describe('openDatabase', () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('opens an in-memory database and applies the schema', () => {
    const db = openDatabase(':memory:');
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
    expect(tables.map((t) => t.name).sort()).toEqual([
      'bootstrap_prices',
      'matches',
      'orders',
      'ppm_reservations',
      'settlements',
      'treasury_events',
    ]);
    db.close();
  });

  it('creates the parent directory for a file-backed database and enables WAL journaling', () => {
    dir = mkdtempSync(join(tmpdir(), 'matcher-db-test-'));
    const dbPath = join(dir, 'nested', 'matcher.db');
    const db = openDatabase(dbPath);
    expect(existsSync(dbPath)).toBe(true);
    const mode = db.pragma('journal_mode', { simple: true });
    expect(mode).toBe('wal');
    db.close();
  });

  it('opens in readonly mode without error when requested', () => {
    dir = mkdtempSync(join(tmpdir(), 'matcher-db-test-'));
    const dbPath = join(dir, 'ro.db');
    openDatabase(dbPath).close();
    const readonlyDb = openDatabase(dbPath, { readonly: true });
    expect(() => readonlyDb.prepare('SELECT 1').get()).not.toThrow();
    readonlyDb.close();
  });
});
