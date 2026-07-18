/**
 * Browser-side wiring for calling the already-compiled exchange.compact
 * contract (contracts/managed/exchange/) with a connected Midnight DApp
 * Connector wallet (1AM, Lace, or any other
 * `@midnight-ntwrk/dapp-connector-api` implementation).
 *
 * Follows the exact conventions already established and working in this
 * repo (src/cli.ts, src/deploy.ts, matcher/src/index.ts):
 * `CompiledContract.make/.withWitnesses/.withCompiledFileAssets` +
 * `findDeployedContract(providers, {...}).callTx.<circuit>(...)`. Only the
 * providers differ: instead of a headless seed-based wallet, `walletProvider`
 * / `midnightProvider` are backed by the connected `ConnectedAPI`
 * (`balanceUnsealedTransaction` / `submitTransaction` — this is the wallet's
 * approval pop-up), and `zkConfigProvider` fetches the compiled ZK artifacts
 * over HTTP instead of from the local filesystem.
 *
 * `createOrder(orderId, commitment)` never touches the
 * orderDetails/orderBlinding/ownerSecretKey witnesses. `cancelOrder` and
 * `settleWithProtocol` do — both re-derive and verify the order's on-chain
 * commitment, so they need this profile's real persisted secret and the
 * order's real private details/blinding (see services/midnight/orderStore.ts
 * and ownerSecret.ts). `adminSecretKey` genuinely is never needed here —
 * Treasury admin actions are submitted by the Matcher, never the browser
 * (see matcher/src/api/admin.ts).
 */
import { CompiledContract } from "@midnight-ntwrk/compact-js";
import type { ConnectedAPI, Configuration } from "@midnight-ntwrk/dapp-connector-api";
import { findDeployedContract } from "@midnight-ntwrk/midnight-js-contracts";
import { FetchZkConfigProvider } from "@midnight-ntwrk/midnight-js-fetch-zk-config-provider";
import { httpClientProofProvider } from "@midnight-ntwrk/midnight-js-http-client-proof-provider";
import { indexerPublicDataProvider } from "@midnight-ntwrk/midnight-js-indexer-public-data-provider";
import type {
  MidnightProviders,
  PrivateStateId,
  PrivateStateProvider,
} from "@midnight-ntwrk/midnight-js-types";
import { createProofProvider } from "@midnight-ntwrk/midnight-js-types";
import { fromHex, toHex } from "@midnight-ntwrk/midnight-js-utils";
import { Transaction } from "@midnight-ntwrk/ledger-v8";
import { getOrCreateOwnerSecret } from "@/services/midnight/ownerSecret";
import { getOrderWitnessData } from "@/services/midnight/orderStore";

// Relative import into the already-compiled, already-committed contract
// output — the single source of truth also used by src/cli.ts,
// src/deploy.ts, and matcher/src/index.ts. Nothing here modifies the
// contract; this just bundles its existing JS output into the browser build.
import * as Exchange from "../../../../contracts/managed/exchange/contract/index.js";
import type {
  Contract as ExchangeContractType,
  Witnesses as ExchangeWitnesses,
} from "../../../../contracts/managed/exchange/contract/index.js";

// Never actually dereferenced by findDeployedContract/callTx (confirmed by
// inspecting @midnight-ntwrk/midnight-js-contracts — it only reads
// providers.zkConfigProvider by circuit id); kept only for structural parity
// with the identical CompiledContract setup in src/cli.ts / src/deploy.ts.
const EXCHANGE_ASSETS_PATH = "contracts/managed/exchange";

// orderDetails/orderBlinding read this profile's real locally-persisted
// record of the order being acted on (see services/midnight/orderStore.ts);
// createOrder never calls either, so they only ever fire for cancelOrder/
// settleWithProtocol. ownerSecretKey returns this profile's real persisted
// secret (services/midnight/ownerSecret.ts) — the same one every order this
// profile creates already embeds via deriveOwnerId, so it always matches.
const exchangeWitnesses: ExchangeWitnesses<undefined> = {
  orderDetails: (context, orderId) => {
    const entry = getOrderWitnessData(orderId);
    if (!entry) {
      throw new Error(
        "No locally-stored order details for this orderId — this browser profile did not create this order, or its local record was cleared.",
      );
    }
    return [context.privateState, entry.details];
  },
  orderBlinding: (context, orderId) => {
    const entry = getOrderWitnessData(orderId);
    if (!entry) {
      throw new Error(
        "No locally-stored order details for this orderId — this browser profile did not create this order, or its local record was cleared.",
      );
    }
    return [context.privateState, entry.blinding];
  },
  ownerSecretKey: (context) => [context.privateState, getOrCreateOwnerSecret()],
  adminSecretKey: () => {
    throw new Error(
      "adminSecretKey witness not implemented in the browser client — Treasury admin actions are submitted by the Matcher, never the browser (see matcher/src/api/admin.ts).",
    );
  },
};

const compiledExchangeContractBase = CompiledContract.make<ExchangeContractType<undefined>>(
  "exchange",
  Exchange.Contract,
);
const compiledExchangeContractWithWitnesses = CompiledContract.withWitnesses(
  compiledExchangeContractBase,
  exchangeWitnesses,
);
export const compiledExchangeContract = CompiledContract.withCompiledFileAssets(
  compiledExchangeContractWithWitnesses,
  EXCHANGE_ASSETS_PATH,
);

export const { pureCircuits } = Exchange;

/**
 * This contract has no private state (`Contract<undefined>`), and
 * createOrder is called without a `privateStateId`, so none of these
 * methods are ever actually invoked — it exists only to satisfy
 * `MidnightProviders`'s (non-optional) `privateStateProvider` field.
 */
function createNoopPrivateStateProvider(): PrivateStateProvider<PrivateStateId, unknown> {
  return {
    setContractAddress() {},
    async set() {},
    async get() {
      return null;
    },
    async remove() {},
    async clear() {},
    async setSigningKey() {},
    async getSigningKey() {
      return null;
    },
    async removeSigningKey() {},
    async clearSigningKeys() {},
    async exportPrivateStates() {
      throw new Error("No private state to export — the exchange contract keeps none.");
    },
    async importPrivateStates() {
      throw new Error("No private state to import — the exchange contract keeps none.");
    },
    async exportSigningKeys() {
      throw new Error("No signing keys to export in the browser client.");
    },
    async importSigningKeys() {
      throw new Error("No signing keys to import in the browser client.");
    },
  };
}

export interface ConnectedWalletShieldedKeys {
  shieldedCoinPublicKey: string;
  shieldedEncryptionPublicKey: string;
}

/**
 * Builds the MidnightProviders backed by a live connected-wallet session.
 * `walletProvider.balanceTx` / `midnightProvider.submitTx` route through
 * `connectedApi.balanceUnsealedTransaction` / `connectedApi.submitTransaction`
 * — this is the wallet's approval pop-up ("request wallet signature").
 */
async function buildContractProviders(
  connectedApi: ConnectedAPI,
  configuration: Configuration,
  shielded: ConnectedWalletShieldedKeys,
  proofServerUri: string,
): Promise<MidnightProviders<"createOrder", PrivateStateId, unknown>> {
  // FetchZkConfigProvider defaults its fetchFunc to cross-fetch's browser
  // export, which — when native fetch exists — is just the unbound
  // `window.fetch` reference. The provider then calls it as
  // `this.fetchFunc(...)`, a method call that rebinds `this` away from
  // Window and trips fetch's native "Illegal invocation" guard. Passing an
  // explicitly bound fetch sidesteps the bug entirely.
  const zkConfigProvider = new FetchZkConfigProvider<"createOrder">(
    `${window.location.origin}/zk/exchange`,
    window.fetch.bind(window),
  );

  // Lace does not implement getProvingProvider() (confirmed via the
  // Midnight docs MCP) — feature-detect and fall back to a local proof
  // server, per the documented "Where wallets diverge" guidance. Other
  // connector-compatible wallets (e.g. 1AM) do implement it. `proofServerUri`
  // comes from the active network's config (see network/networkConfig.ts) —
  // never hardcoded here.
  const proofProvider =
    typeof connectedApi.getProvingProvider === "function"
      ? createProofProvider(
          await connectedApi.getProvingProvider(zkConfigProvider.asKeyMaterialProvider()),
        )
      : httpClientProofProvider(proofServerUri, zkConfigProvider);

  return {
    privateStateProvider: createNoopPrivateStateProvider(),
    // indexerPublicDataProvider's third parameter is typed for the `ws`
    // package's Node-oriented WebSocket class (it defaults to it), but at
    // runtime it only ever needs a `new (url) => WebSocket`-shaped
    // constructor — the browser's native `WebSocket` satisfies that. Cast
    // to bridge the Node-oriented type, not to work around a runtime
    // incompatibility.
    publicDataProvider: indexerPublicDataProvider(
      configuration.indexerUri,
      configuration.indexerWsUri,
      window.WebSocket as unknown as Parameters<typeof indexerPublicDataProvider>[2],
    ),
    zkConfigProvider,
    proofProvider,
    walletProvider: {
      getCoinPublicKey: () => shielded.shieldedCoinPublicKey,
      getEncryptionPublicKey: () => shielded.shieldedEncryptionPublicKey,
      balanceTx: async (tx) => {
        const received = await connectedApi.balanceUnsealedTransaction(toHex(tx.serialize()));
        return Transaction.deserialize("signature", "proof", "binding", fromHex(received.tx));
      },
    },
    midnightProvider: {
      submitTx: async (tx) => {
        await connectedApi.submitTransaction(toHex(tx.serialize()));
        return tx.identifiers()[0];
      },
    },
  };
}

/**
 * Submits `createOrder(orderId, commitment)` on-chain through the connected
 * wallet: builds the call, proves it, has the wallet balance + sign it
 * (the approval pop-up), and submits it — returning once the wallet has
 * relayed it to the network.
 */
export async function submitCreateOrder(params: {
  connectedApi: ConnectedAPI;
  configuration: Configuration;
  shielded: ConnectedWalletShieldedKeys;
  /** Fallback local proof server, from the active network's config — see network/networkConfig.ts. */
  proofServerUri: string;
  contractAddress: string;
  orderId: Uint8Array;
  commitment: Uint8Array;
}): Promise<{ txId: string }> {
  const providers = await buildContractProviders(
    params.connectedApi,
    params.configuration,
    params.shielded,
    params.proofServerUri,
  );

  const deployed = await findDeployedContract(providers, {
    compiledContract: compiledExchangeContract,
    contractAddress: params.contractAddress,
  });

  const result = await deployed.callTx.createOrder(params.orderId, params.commitment);
  return { txId: result.public.txId };
}

/**
 * Submits `cancelOrder(orderId)` on-chain through the connected wallet — the
 * real on-chain half of cancelling an order (the Matcher's own DELETE
 * /orders/:id only ever updates its local off-chain view, see
 * matcher/API.md and app/api/matcher/orders/[id]/route.ts; without this
 * call the order's on-chain commitment stays OPEN forever). Requires this
 * profile to hold the order's real ownerSecretKey (see exchangeWitnesses
 * above) — the contract rejects anyone else's, per AUDIT.md's P0 fix.
 */
export async function submitCancelOrder(params: {
  connectedApi: ConnectedAPI;
  configuration: Configuration;
  shielded: ConnectedWalletShieldedKeys;
  proofServerUri: string;
  contractAddress: string;
  orderId: Uint8Array;
}): Promise<{ txId: string }> {
  const providers = await buildContractProviders(
    params.connectedApi,
    params.configuration,
    params.shielded,
    params.proofServerUri,
  );

  const deployed = await findDeployedContract(providers, {
    compiledContract: compiledExchangeContract,
    contractAddress: params.contractAddress,
  });

  const result = await deployed.callTx.cancelOrder(params.orderId);
  return { txId: result.public.txId };
}

/**
 * Submits `settleWithProtocol(orderId, quoteId, recipient)` on-chain through
 * the connected wallet — the "Approve Settlement" step a PPM fill requires
 * from the order's own owner (see contracts/exchange.compact's doc comment
 * on the NIGHT payment leg: receiveUnshielded always draws from whoever
 * submits, so the owner's own wallet must submit this, for both BUY and
 * SELL). `recipientAddressBytes` is this wallet's own real unshielded
 * address — the traded asset (BUY) or NIGHT payment (SELL) pays out there.
 */
export async function submitSettleWithProtocol(params: {
  connectedApi: ConnectedAPI;
  configuration: Configuration;
  shielded: ConnectedWalletShieldedKeys;
  proofServerUri: string;
  contractAddress: string;
  orderId: Uint8Array;
  quoteId: Uint8Array;
  recipientAddressBytes: Uint8Array;
}): Promise<{ txId: string }> {
  const providers = await buildContractProviders(
    params.connectedApi,
    params.configuration,
    params.shielded,
    params.proofServerUri,
  );

  const deployed = await findDeployedContract(providers, {
    compiledContract: compiledExchangeContract,
    contractAddress: params.contractAddress,
  });

  const recipient = {
    is_left: false,
    left: { bytes: new Uint8Array(32) },
    right: { bytes: params.recipientAddressBytes },
  };

  const result = await deployed.callTx.settleWithProtocol(params.orderId, params.quoteId, recipient);
  return { txId: result.public.txId };
}
