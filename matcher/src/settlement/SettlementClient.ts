/**
 * Settlement against the already-deployed exchange.compact contract.
 *
 * Deliberately split into two halves:
 *  - This file: pure logic (witness construction, error classification,
 *    the retry-relevant SettlementClient class) that never touches a
 *    wallet/provider/network and is fully unit-testable with fakes.
 *  - src/index.ts: the one place that wires up real Midnight SDK providers
 *    (findDeployedContract, the Matcher's own wallet) and hands this file
 *    an object satisfying SettleCircuitCaller + OnChainOrderReader. That
 *    live wiring mirrors ../../../src/cli.ts and ../../../src/deploy.ts
 *    exactly (findDeployedContract + callTx.<circuit>(...), confirmed
 *    against the Midnight docs MCP) and is exercised by the opt-in e2e
 *    script, not by `npm test`.
 */
import { CallTxFailedError } from '@midnight-ntwrk/midnight-js-contracts';
import type { TxStatus } from '@midnight-ntwrk/midnight-js-types';

import type { Order } from '../types/Order.js';
import { bytes32ToHex, hexToBytes32 } from '../utils/hex.js';
import type { Logger } from '../utils/logger.js';
import { toOrderDetailsValue } from '../utils/orderDetailsCodec.js';
// Type-only: erased at compile time, so this does not require the compiled
// contract's JS to be loaded here — only its .d.ts, exactly like the
// value/type split already used in ../../../src/cli.ts and ../deploy.ts.
import type { Witnesses } from '../../../contracts/managed/exchange/contract/index.js';

/** What SettlementClient needs from a connected contract handle. */
export interface SettleCircuitCaller {
  settle(buyOrderId: Uint8Array, sellOrderId: Uint8Array): Promise<{ public: { txId: string } }>;
}

export type OnChainOrderState = 'OPEN' | 'FILLED' | 'CANCELLED' | 'EXPIRED' | 'NOT_FOUND';

export interface OnChainOrderRecord {
  readonly state: OnChainOrderState;
  /** null iff state === 'NOT_FOUND'. */
  readonly commitment: string | null;
}

/**
 * Free (non-transactional) reads of the public order registry via the
 * indexer — used both by SettlementClient (re-checking state after a
 * failed settle()) and by services/OrderService.ts (verifying a disclosed
 * order's commitment against the on-chain record before trusting it; see
 * ARCHITECTURE.md's security model). Backed by
 * `publicDataProvider.queryContractState` + the compiled contract's
 * exported `ledger()` reader in src/index.ts — the same free-read
 * technique already used in ../../../src/cli.ts, never a paid getOrder()
 * transaction (see AUDIT.md P3-3).
 */
export interface OnChainOrderReader {
  getOrder(orderId: string): Promise<OnChainOrderRecord>;
}

export type SettlementAttemptResult =
  | { readonly outcome: 'success'; readonly txId: string }
  /** The transaction reached the chain and was evaluated (guaranteed or fallible phase) but did not succeed. */
  | { readonly outcome: 'callFailed'; readonly status: TxStatus; readonly message: string }
  /** Anything before that point failed (proof server, network, wallet balancing, etc.) — nothing was ever submitted. */
  | { readonly outcome: 'transientError'; readonly message: string };

/** Backs the orderDetails/orderBlinding witnesses — anything that can resolve a disclosed Order by id. */
export interface WitnessOrderSource {
  findById(orderId: string): Order | undefined;
}

/**
 * Builds the witnesses object for the compiled exchange contract. Per
 * AUDIT.md's threat model, the Matcher is disclosed full OrderDetails +
 * blinding but never an owner's ownerSecretKey; settle()'s own circuit body
 * only ever calls orderDetails/orderBlinding (never ownerSecretKey — that
 * witness is exclusive to cancelOrder), so ownerSecretKey throwing here is
 * safe and, if it were ever reached, is exactly the bug we want to fail
 * loudly on rather than silently return a wrong value for.
 */
export function buildExchangeWitnesses(source: WitnessOrderSource, treasuryAdminSecretHex: string): Witnesses<undefined> {
  const resolve = (orderIdBytes: Uint8Array): Order => {
    const id = bytes32ToHex(orderIdBytes);
    const order = source.findById(id);
    if (!order) {
      throw new Error(`No disclosed order details held for orderId ${id} — cannot satisfy settle()'s witnesses`);
    }
    return order;
  };
  const adminSecretBytes = hexToBytes32(treasuryAdminSecretHex);

  return {
    orderDetails: (context, orderIdBytes) => [context.privateState, toOrderDetailsValue(resolve(orderIdBytes))],
    orderBlinding: (context, orderIdBytes) => [context.privateState, hexToBytes32(resolve(orderIdBytes).signature)],
    ownerSecretKey: () => {
      throw new Error(
        'ownerSecretKey witness invoked during settle() — this should be unreachable (settle() never calls it) ' +
          'and the Matcher must never hold an owner secret key regardless (see AUDIT.md threat model).',
      );
    },
    // Unlike ownerSecretKey, this one is real: depositTreasury/withdrawTreasury/
    // addAdmin/removeAdmin are admin-gated circuits the Matcher submits on an
    // HTTP-authenticated admin's behalf (see api/admin.ts's challenge/signature
    // auth — the browser never sees this secret, only the Matcher process does).
    // reserveLiquidity/releaseLiquidity/settleWithProtocol never call this
    // witness at all (see contracts/exchange.compact — only the two admin
    // circuits do), so it sitting unused for every PPM-driven call is expected.
    adminSecretKey: (context) => [context.privateState, adminSecretBytes],
  };
}

/** Exported for reuse by ppm/TreasuryClient.ts — the same CallTxFailedError-vs-everything-else classification applies to any callTx.<circuit>() call, not just settle(). */
export function classifyThrown(error: unknown): SettlementAttemptResult {
  if (error instanceof CallTxFailedError) {
    return {
      outcome: 'callFailed',
      status: error.finalizedTxData.status,
      message: error.message,
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { outcome: 'transientError', message };
}

export class SettlementClient {
  constructor(
    private readonly caller: SettleCircuitCaller,
    private readonly onChainReader: OnChainOrderReader,
    private readonly logger: Logger,
  ) {}

  async settle(buyOrder: Pick<Order, 'id'>, sellOrder: Pick<Order, 'id'>): Promise<SettlementAttemptResult> {
    try {
      const tx = await this.caller.settle(hexToBytes32(buyOrder.id), hexToBytes32(sellOrder.id));
      return { outcome: 'success', txId: tx.public.txId };
    } catch (error) {
      const result = classifyThrown(error);
      this.logger.warn(
        { buyOrderId: buyOrder.id, sellOrderId: sellOrder.id, result },
        'settle() call did not succeed',
      );
      return result;
    }
  }

  async getOnChainState(orderId: string): Promise<OnChainOrderState> {
    return (await this.onChainReader.getOrder(orderId)).state;
  }
}
