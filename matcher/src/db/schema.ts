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
  -- The real, chain-wide unshielded token color of the traded asset —
  -- identical to OrderDetails.asset and the Treasury's assetKey (see
  -- contracts/exchange.compact and docs/ARCHITECTURE_TZKR_UNSHIELDED_MIGRATION.md).
  -- Previously split across asset_is_left/asset_left/asset_right (an
  -- Either<Bytes32,Bytes32> tuple) plus a separately-hashed asset_key column;
  -- now that an order's asset field *is* the Treasury key, one column
  -- suffices for both roles.
  asset_key     TEXT NOT NULL,
  side          TEXT NOT NULL CHECK (side IN ('BUY', 'SELL')),
  price         TEXT NOT NULL,
  amount        TEXT NOT NULL,
  commitment    TEXT NOT NULL,
  owner_id      TEXT NOT NULL,
  signature     TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('OPEN', 'MATCHED', 'SETTLING', 'FILLED', 'CANCELLED', 'EXPIRED', 'FAILED')),
  created_at    INTEGER NOT NULL,
  expires_at    TEXT NOT NULL,
  -- Optional real unshielded UserAddress (Bytes<32> hex) the order's owner
  -- supplies for protocol-liquidity payouts only (settleWithProtocol's BUY
  -- branch — see ppm/TreasuryClient.ts). OrderDetails.owner is a
  -- pseudonymous ZswapCoinPublicKey-shaped hash, not a real spendable
  -- address, so there's no on-chain binding between it and this field — an
  -- order with no payout_address simply can't be filled by the PPM (never
  -- settle()'d against another user order either; that path is unaffected
  -- and needs no address at all, since settle() moves no tokens).
  payout_address TEXT
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

-- Local mirror of the contract's on-chain treasuryHistory Map — one row per
-- confirmed DEPOSIT/WITHDRAW/RESERVE/RELEASE/EXECUTE, so Treasury history
-- reads (GET /treasury/history) don't need an indexer round-trip per
-- request. asset_key here is the on-chain deriveAssetKey(...) output
-- (Bytes<32> hex) — NOT the matcher's own off-chain assetKey() partition
-- string from types/Asset.ts, which is a different, unrelated key. actor
-- holds an admin id for DEPOSIT/WITHDRAW or a quoteId for
-- RESERVE/RELEASE/EXECUTE, matching the contract's own TreasuryTx.actor
-- field semantics.
CREATE TABLE IF NOT EXISTS treasury_events (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL CHECK (kind IN ('DEPOSIT', 'WITHDRAW', 'RESERVE', 'RELEASE', 'EXECUTE')),
  asset_key  TEXT NOT NULL,
  amount     TEXT NOT NULL,
  actor      TEXT NOT NULL,
  tx_id      TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_treasury_events_asset      ON treasury_events(asset_key);
CREATE INDEX IF NOT EXISTS idx_treasury_events_kind       ON treasury_events(kind);
CREATE INDEX IF NOT EXISTS idx_treasury_events_created_at ON treasury_events(created_at);

-- Local mirror of the contract's on-chain reservations Map, plus
-- matcher-only pricing context (order_id, the resting order this quote was
-- generated for) the chain doesn't need to know. order_id references
-- orders(id) but is nullable — a reservation can be released/expired before
-- ever being tied to a specific settleWithProtocol call.
CREATE TABLE IF NOT EXISTS ppm_reservations (
  quote_id   TEXT PRIMARY KEY,
  order_id   TEXT REFERENCES orders(id),
  asset_key  TEXT NOT NULL,
  amount     TEXT NOT NULL,
  price      TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  state      TEXT NOT NULL CHECK (state IN ('OPEN', 'RELEASED', 'EXECUTED')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ppm_reservations_state ON ppm_reservations(state);
CREATE INDEX IF NOT EXISTS idx_ppm_reservations_asset ON ppm_reservations(asset_key);
`;

/**
 * CREATE TABLE IF NOT EXISTS above only covers brand-new databases — an
 * existing dev database created before payout_address existed keeps its old
 * `orders` column list untouched by that statement. This makes the one
 * post-Treasury schema change idempotently forward-compatible without a
 * full migration framework.
 */
function migrateOrdersPayoutAddress(db: Database.Database): void {
  const columns = db.prepare('PRAGMA table_info(orders)').all() as Array<{ name: string }>;
  if (!columns.some((c) => c.name === 'payout_address')) {
    db.exec('ALTER TABLE orders ADD COLUMN payout_address TEXT');
  }
}

export function applySchema(db: Database.Database): void {
  db.exec(SCHEMA_SQL);
  migrateOrdersPayoutAddress(db);
}
