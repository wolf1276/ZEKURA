/**
 * Browser-side wiring for calling the already-compiled exchange.compact
 * contract (contracts/managed/exchange/) with a Lace-connected wallet.
 *
 * Follows the exact conventions already established and working in this
 * repo (src/cli.ts, src/deploy.ts, matcher/src/index.ts):
 * `CompiledContract.make/.withWitnesses/.withCompiledFileAssets` +
 * `findDeployedContract(providers, {...}).callTx.<circuit>(...)`. Only the
 * providers differ: instead of a headless seed-based wallet, `walletProvider`
 * / `midnightProvider` are backed by the connected Lace `ConnectedAPI`
 * (`balanceUnsealedTransaction` / `submitTransaction` — this is the Lace
 * approval pop-up), and `zkConfigProvider` fetches the compiled ZK artifacts
 * over HTTP instead of from the local filesystem.
 *
 * `createOrder(orderId, commitment)` never touches the
 * orderDetails/orderBlinding/ownerSecretKey witnesses (confirmed by reading
 * contracts/exchange.compact and the witness stubs already used the same
 * way in src/cli.ts/src/deploy.ts) — this client only ever needs to prove
 * that one circuit.
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

// Relative import into the already-compiled, already-committed contract
// output — the single source of truth also used by src/cli.ts,
// src/deploy.ts, and matcher/src/index.ts. Nothing here modifies the
// contract; this just bundles its existing JS output into the browser build.
import * as Exchange from "../../../../contracts/managed/exchange/contract/index.js";
import type {
  Contract as ExchangeContractType,
  Witnesses as ExchangeWitnesses,
} from "../../../../contracts/managed/exchange/contract/index.js";

const PROOF_SERVER_URL =
  process.env.NEXT_PUBLIC_PROOF_SERVER_URL?.trim() || "http://127.0.0.1:6300";

// Never actually dereferenced by findDeployedContract/callTx (confirmed by
// inspecting @midnight-ntwrk/midnight-js-contracts — it only reads
// providers.zkConfigProvider by circuit id); kept only for structural parity
// with the identical CompiledContract setup in src/cli.ts / src/deploy.ts.
const EXCHANGE_ASSETS_PATH = "contracts/managed/exchange";

// createOrder(orderId, commitment) never calls any witness — see the file
// header. These stubs mirror the exact ones already used in
// src/cli.ts/src/deploy.ts for the same reason.
const exchangeWitnesses: ExchangeWitnesses<undefined> = {
  orderDetails: () => {
    throw new Error(
      "orderDetails witness not implemented in the browser client — createOrder never invokes it (see contracts/exchange.compact).",
    );
  },
  orderBlinding: () => {
    throw new Error(
      "orderBlinding witness not implemented in the browser client — createOrder never invokes it.",
    );
  },
  ownerSecretKey: () => {
    throw new Error(
      "ownerSecretKey witness not implemented in the browser client — createOrder never invokes it.",
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
 * Builds the MidnightProviders backed by a live Lace connection.
 * `walletProvider.balanceTx` / `midnightProvider.submitTx` route through
 * `connectedApi.balanceUnsealedTransaction` / `connectedApi.submitTransaction`
 * — this is the Lace approval pop-up ("request wallet signature").
 */
async function buildContractProviders(
  connectedApi: ConnectedAPI,
  configuration: Configuration,
  shielded: ConnectedWalletShieldedKeys,
): Promise<MidnightProviders<"createOrder", PrivateStateId, unknown>> {
  const zkConfigProvider = new FetchZkConfigProvider<"createOrder">(
    `${window.location.origin}/zk/exchange`,
  );

  // Lace does not implement getProvingProvider() (confirmed via the
  // Midnight docs MCP) — feature-detect and fall back to a local proof
  // server, per the documented "Where wallets diverge" guidance. Other
  // connector-compatible wallets (e.g. 1AM) do implement it.
  const proofProvider =
    typeof connectedApi.getProvingProvider === "function"
      ? createProofProvider(
          await connectedApi.getProvingProvider(zkConfigProvider.asKeyMaterialProvider()),
        )
      : httpClientProofProvider(PROOF_SERVER_URL, zkConfigProvider);

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
 * Lace wallet: builds the call, proves it, has the wallet balance + sign it
 * (the approval pop-up), and submits it — returning once the wallet has
 * relayed it to the network.
 */
export async function submitCreateOrder(params: {
  connectedApi: ConnectedAPI;
  configuration: Configuration;
  shielded: ConnectedWalletShieldedKeys;
  contractAddress: string;
  orderId: Uint8Array;
  commitment: Uint8Array;
}): Promise<{ txId: string }> {
  const providers = await buildContractProviders(
    params.connectedApi,
    params.configuration,
    params.shielded,
  );

  const deployed = await findDeployedContract(providers, {
    compiledContract: compiledExchangeContract,
    contractAddress: params.contractAddress,
  });

  const result = await deployed.callTx.createOrder(params.orderId, params.commitment);
  return { txId: result.public.txId };
}
