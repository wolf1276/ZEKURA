/**
 * Treasury/PPM circuit access, split the same way settlement/SettlementClient.ts
 * splits settle(): a free-read half (OnChainTreasuryReader — no transaction,
 * queried straight from the indexer) and a real-transaction half
 * (PpmCircuitCaller — reserveLiquidity/releaseLiquidity/
 * releaseExpiredLiquidity/settleWithProtocol/depositTreasury/withdrawTreasury,
 * wired to real callTx.<circuit>() calls in src/index.ts). Neither half
 * imports the SDK directly — src/index.ts implements both interfaces with
 * real Midnight SDK calls, exactly like SettleCircuitCaller/OnChainOrderReader.
 */
import type { TxStatus } from '@midnight-ntwrk/midnight-js-types';

import type { Hex32 } from '../types/Asset.js';
import { hexToBytes32 } from '../utils/hex.js';
import { classifyThrown } from '../settlement/SettlementClient.js';
import type { Logger } from '../utils/logger.js';

export interface TreasuryLiquidity {
  readonly balance: bigint;
  readonly reserved: bigint;
  readonly available: bigint;
}

/**
 * Free (non-transactional) read of one asset's Treasury liquidity via the
 * public indexer — same technique as settlement/SettlementClient.ts's
 * OnChainOrderReader, reading treasuryBalances/treasuryReserved directly off
 * the compiled contract's exported ledger() reader rather than spending a
 * transaction on a getTreasuryBalance()-shaped circuit (which the contract
 * deliberately doesn't have — see contracts/exchange.compact's comment on
 * why those read circuits were removed).
 */
export interface OnChainTreasuryReader {
  getLiquidity(assetKey: Hex32): Promise<TreasuryLiquidity>;
}

/** Either<ContractAddress, UserAddress> struct value, matching sendUnshielded's recipient parameter shape. */
export interface EitherAddressValue {
  readonly is_left: boolean;
  readonly left: { readonly bytes: Uint8Array };
  readonly right: { readonly bytes: Uint8Array };
}

const ZERO_32 = new Uint8Array(32);

/** Builds a settleWithProtocol recipient pointing at a real unshielded user address. */
export function userAddressRecipient(userAddressBytesHex: Hex32): EitherAddressValue {
  return { is_left: false, left: { bytes: ZERO_32 }, right: { bytes: hexToBytes32(userAddressBytesHex) } };
}

/** Placeholder recipient for SELL-side fills, where settleWithProtocol's circuit body never reads `recipient` (only the isBuy branch does — see the contract). */
export const UNUSED_RECIPIENT: EitherAddressValue = { is_left: true, left: { bytes: ZERO_32 }, right: { bytes: ZERO_32 } };

export interface PpmCircuitCaller {
  reserveLiquidity(
    quoteId: Uint8Array,
    assetKey: Uint8Array,
    amount: bigint,
    price: bigint,
    expiresAt: bigint,
  ): Promise<{ public: { txId: string } }>;
  releaseLiquidity(quoteId: Uint8Array): Promise<{ public: { txId: string } }>;
  releaseExpiredLiquidity(quoteId: Uint8Array): Promise<{ public: { txId: string } }>;
  settleWithProtocol(
    orderId: Uint8Array,
    quoteId: Uint8Array,
    recipient: EitherAddressValue,
  ): Promise<{ public: { txId: string } }>;
  /** Admin-gated on-chain circuits — only called from api/admin.ts, after AdminAuth verifies the HTTP caller controls an allowlisted wallet address. See src/index.ts for how the on-chain admin identity itself is composed. */
  depositTreasury(assetKey: Uint8Array, amount: bigint): Promise<{ public: { txId: string } }>;
  withdrawTreasury(assetKey: Uint8Array, amount: bigint, recipient: EitherAddressValue): Promise<{ public: { txId: string } }>;
}

export type TreasuryCallResult =
  | { readonly outcome: 'success'; readonly txId: string }
  | { readonly outcome: 'callFailed'; readonly status: TxStatus; readonly message: string }
  | { readonly outcome: 'transientError'; readonly message: string };

/** Thin wrapper applying the same try/classify/log shape SettlementClient.settle() uses, once per Treasury circuit. */
export class TreasuryClient {
  constructor(
    private readonly caller: PpmCircuitCaller,
    private readonly reader: OnChainTreasuryReader,
    private readonly logger: Logger,
  ) {}

  async reserveLiquidity(
    quoteId: Hex32,
    assetKey: Hex32,
    amount: bigint,
    price: bigint,
    expiresAt: bigint,
  ): Promise<TreasuryCallResult> {
    try {
      const tx = await this.caller.reserveLiquidity(hexToBytes32(quoteId), hexToBytes32(assetKey), amount, price, expiresAt);
      return { outcome: 'success', txId: tx.public.txId };
    } catch (error) {
      const result = classifyThrown(error) as TreasuryCallResult;
      this.logger.warn({ quoteId, assetKey, amount, price, result }, 'reserveLiquidity call did not succeed');
      return result;
    }
  }

  async releaseLiquidity(quoteId: Hex32): Promise<TreasuryCallResult> {
    try {
      const tx = await this.caller.releaseLiquidity(hexToBytes32(quoteId));
      return { outcome: 'success', txId: tx.public.txId };
    } catch (error) {
      const result = classifyThrown(error) as TreasuryCallResult;
      this.logger.warn({ quoteId, result }, 'releaseLiquidity call did not succeed');
      return result;
    }
  }

  async releaseExpiredLiquidity(quoteId: Hex32): Promise<TreasuryCallResult> {
    try {
      const tx = await this.caller.releaseExpiredLiquidity(hexToBytes32(quoteId));
      return { outcome: 'success', txId: tx.public.txId };
    } catch (error) {
      const result = classifyThrown(error) as TreasuryCallResult;
      this.logger.warn({ quoteId, result }, 'releaseExpiredLiquidity call did not succeed');
      return result;
    }
  }

  async settleWithProtocol(orderId: Hex32, quoteId: Hex32, recipient: EitherAddressValue): Promise<TreasuryCallResult> {
    try {
      const tx = await this.caller.settleWithProtocol(hexToBytes32(orderId), hexToBytes32(quoteId), recipient);
      return { outcome: 'success', txId: tx.public.txId };
    } catch (error) {
      const result = classifyThrown(error) as TreasuryCallResult;
      this.logger.warn({ orderId, quoteId, result }, 'settleWithProtocol call did not succeed');
      return result;
    }
  }

  async depositTreasury(assetKey: Hex32, amount: bigint): Promise<TreasuryCallResult> {
    try {
      const tx = await this.caller.depositTreasury(hexToBytes32(assetKey), amount);
      return { outcome: 'success', txId: tx.public.txId };
    } catch (error) {
      const result = classifyThrown(error) as TreasuryCallResult;
      this.logger.warn({ assetKey, amount, result }, 'depositTreasury call did not succeed');
      return result;
    }
  }

  async withdrawTreasury(assetKey: Hex32, amount: bigint, recipient: EitherAddressValue): Promise<TreasuryCallResult> {
    try {
      const tx = await this.caller.withdrawTreasury(hexToBytes32(assetKey), amount, recipient);
      return { outcome: 'success', txId: tx.public.txId };
    } catch (error) {
      const result = classifyThrown(error) as TreasuryCallResult;
      this.logger.warn({ assetKey, amount, result }, 'withdrawTreasury call did not succeed');
      return result;
    }
  }

  async getLiquidity(assetKey: Hex32): Promise<TreasuryLiquidity> {
    return this.reader.getLiquidity(assetKey);
  }
}
