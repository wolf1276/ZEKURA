import type Database from 'better-sqlite3';

/**
 * orders / matches / settlements per the brief, with indexes on
 * orders(asset, side, status, createdAt). price/amount/expiresAt are
 * stored as decimal-string TEXT — Uint<128> exceeds SQLite's 64-bit
 * INTEGER range, so every numeric field that mirrors a contract Uint field
 * is kept as TEXT end-to-end and parsed back to bigint in the repository
 * layer (see repositories/OrderRepository.ts).
 */
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS orders (
  id            TEXT PRIMARY KEY,
  asset_is_left INTEGER NOT NULL CHECK (asset_is_left IN (0, 1)),
  asset_left    TEXT NOT NULL,
  asset_right   TEXT NOT NULL,
  asset_key     TEXT NOT NULL,
  side          TEXT NOT NULL CHECK (side IN ('BUY', 'SELL')),
  price         TEXT NOT NULL,
  amount        TEXT NOT NULL,
  commitment    TEXT NOT NULL,
  owner_id      TEXT NOT NULL,
  signature     TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('OPEN', 'MATCHED', 'SETTLING', 'FILLED', 'CANCELLED', 'EXPIRED', 'FAILED')),
  created_at    INTEGER NOT NULL,
  expires_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_orders_asset      ON orders(asset_key);
CREATE INDEX IF NOT EXISTS idx_orders_side       ON orders(side);
CREATE INDEX IF NOT EXISTS idx_orders_status     ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at);

CREATE TABLE IF NOT EXISTS matches (
  id            TEXT PRIMARY KEY,
  buy_order_id  TEXT NOT NULL REFERENCES orders(id),
  sell_order_id TEXT NOT NULL REFERENCES orders(id),
  asset_key     TEXT NOT NULL,
  price         TEXT NOT NULL,
  amount        TEXT NOT NULL,
  matched_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_matches_buy_order  ON matches(buy_order_id);
CREATE INDEX IF NOT EXISTS idx_matches_sell_order ON matches(sell_order_id);

CREATE TABLE IF NOT EXISTS settlements (
  id         TEXT PRIMARY KEY,
  match_id   TEXT NOT NULL REFERENCES matches(id),
  status     TEXT NOT NULL CHECK (status IN ('PENDING', 'SUCCESS', 'FAILED')),
  tx_id      TEXT,
  error      TEXT,
  attempts   INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_settlements_match  ON settlements(match_id);
CREATE INDEX IF NOT EXISTS idx_settlements_status ON settlements(status);
`;

export function applySchema(db: Database.Database): void {
  db.exec(SCHEMA_SQL);
}
