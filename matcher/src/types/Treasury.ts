import type { Hex32 } from './Asset.js';

/**
 * Mirrors the contract's TxKind enum. RESERVE/RELEASE/EXECUTE are
 * protocol-internal (PPM-driven); DEPOSIT/WITHDRAW are the only admin-gated
 * ones — see contracts/exchange.compact's Treasury module.
 */
export type TreasuryTxKind = 'DEPOSIT' | 'WITHDRAW' | 'RESERVE' | 'RELEASE' | 'EXECUTE';

export const TREASURY_TX_KINDS: readonly TreasuryTxKind[] = [
  'DEPOSIT',
  'WITHDRAW',
  'RESERVE',
  'RELEASE',
  'EXECUTE',
] as const;

/** Mirrors the contract's ReservationState enum. */
export type ReservationState = 'OPEN' | 'RELEASED' | 'EXECUTED';

export const RESERVATION_STATES: readonly ReservationState[] = ['OPEN', 'RELEASED', 'EXECUTED'] as const;

/**
 * Local mirror of one row from the contract's on-chain treasuryHistory Map.
 * `assetKey` here is the on-chain deriveAssetKey(...) output (Bytes<32> hex)
 * — NOT the matcher's own off-chain assetKey() partition string from
 * Asset.ts, which is a different, unrelated key (see schema.ts's comment on
 * the treasury_events table).
 */
export interface TreasuryEvent {
  readonly id: Hex32;
  readonly kind: TreasuryTxKind;
  readonly assetKey: Hex32;
  /** Uint<128> on-chain. */
  readonly amount: bigint;
  /** deriveAdminId(...) for DEPOSIT/WITHDRAW, quoteId for RESERVE/RELEASE/EXECUTE. */
  readonly actor: Hex32;
  readonly txId: string | null;
  /** Matcher-local receipt time, unix ms. */
  readonly createdAt: number;
}

/**
 * Local mirror of one row from the contract's on-chain reservations Map,
 * plus matcher-only pricing context (orderId) the chain doesn't need.
 */
export interface PpmReservation {
  readonly quoteId: Hex32;
  readonly orderId: Hex32 | null;
  readonly assetKey: Hex32;
  /** Uint<128> on-chain. */
  readonly amount: bigint;
  /** Uint<128> on-chain — the PPM's quoted price for this reservation. */
  readonly price: bigint;
  /** Uint<64> on-chain, unix seconds — compared via the contract's blockTimeGte. */
  readonly expiresAt: bigint;
  readonly state: ReservationState;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export function isReservationState(value: unknown): value is ReservationState {
  return typeof value === 'string' && (RESERVATION_STATES as readonly string[]).includes(value);
}
