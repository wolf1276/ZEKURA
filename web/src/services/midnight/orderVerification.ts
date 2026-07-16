/**
 * Read-only, wallet-free proof of the exchange contract's privacy invariant:
 * given an orderId, fetch its record directly from the live indexer and
 * return exactly what's public — `{commitment, state}` — nothing else,
 * because nothing else is ever written to the `orders` ledger (see
 * contracts/exchange.compact and AUDIT.md's Privacy Review).
 *
 * Same `queryContractState` + `Exchange.ledger(...).orders.lookup(...)`
 * pattern already used identically in matcher/src/index.ts's
 * `onChainReader.getOrder`, src/cli.ts's order lookup, and
 * scripts/e2e-check.ts — this is that pattern made reachable from the
 * browser for the frontend's privacy demo, not a new way of reading chain
 * state.
 */
import type { Configuration } from "@midnight-ntwrk/dapp-connector-api";
import { indexerPublicDataProvider } from "@midnight-ntwrk/midnight-js-indexer-public-data-provider";
import { toHex } from "@midnight-ntwrk/midnight-js-utils";

// Same compiled contract output every other on-chain read in this repo uses
// — see the header comment in exchangeContract.ts for why this relative
// import is the correct source of truth.
import * as Exchange from "../../../../contracts/managed/exchange/contract/index.js";

export type OnChainOrderState = "OPEN" | "FILLED" | "CANCELLED" | "EXPIRED";

export interface OnChainOrderRecord {
  /** The 32-byte commitment exactly as submitted to `createOrder` — the only trace of the order's contents that ever reaches the chain. */
  commitment: string;
  state: OnChainOrderState;
}

/**
 * Queries the indexer the wallet itself is configured against (per the
 * DApp Connector docs — see network/networkConfig.ts's header comment) for
 * `orderId`'s current ledger record. Returns `null` if the order isn't
 * found on-chain. Never touches a wallet, private state, or witnesses —
 * this is a plain public read, the same one anyone watching the chain could
 * make.
 */
export async function getOnChainOrder(
  configuration: Pick<Configuration, "indexerUri" | "indexerWsUri">,
  contractAddress: string,
  orderId: Uint8Array,
): Promise<OnChainOrderRecord | null> {
  const publicDataProvider = indexerPublicDataProvider(
    configuration.indexerUri,
    configuration.indexerWsUri,
    window.WebSocket as unknown as Parameters<typeof indexerPublicDataProvider>[2],
  );

  const contractState = await publicDataProvider.queryContractState(contractAddress);
  if (!contractState) return null;

  const ledgerState = Exchange.ledger(contractState.data);
  if (!ledgerState.orders.member(orderId)) return null;

  const record = ledgerState.orders.lookup(orderId);
  return {
    commitment: toHex(record.commitment),
    state: Exchange.OrderState[record.state] as OnChainOrderState,
  };
}
