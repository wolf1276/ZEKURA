/**
 * Single source of truth for every Midnight network Zekura can talk to.
 *
 * Endpoints below are documented at docs.midnight.network/relnotes/network
 * (Node RPC / Indexer / Faucet UI / Block explorers per environment) and
 * mirror the same values already used by ../../../src/network.ts (the CLI
 * side of this repo). Nothing here is invented.
 *
 * Runtime SDK calls (indexer, node, proof server) do NOT read `indexerUri` /
 * `nodeUri` from this file — per the DApp Connector docs ("DApps are
 * expected to follow [the wallet's] configuration... privacy standpoint"),
 * those come live from the connected wallet's `getConfiguration()` instead,
 * so a user's own wallet-configured endpoints are always respected. The
 * fields below exist so the rest of the app (labels, explorer links, the
 * proof-server fallback used only when a wallet has no `getProvingProvider`)
 * has exactly one place to look, and so this module fully documents what
 * network support exists — adding Mainnet later is one new entry here.
 *
 * To add Mainnet: add `'mainnet'` to `NETWORK_IDS` and one entry to
 * `NETWORK_CONFIGS` below. No other file needs to change.
 */

export type NetworkId = "preview" | "preprod";

export const NETWORK_IDS: readonly NetworkId[] = ["preview", "preprod"] as const;

export const DEFAULT_NETWORK_ID: NetworkId = "preprod";

export interface FaucetInfo {
  available: boolean;
  /** Short contextual copy shown next to the network in the UI. */
  message: string;
  url: string | null;
}

export interface NetworkConfig {
  id: NetworkId;
  label: string;
  /** Value passed to `InitialAPI.connect(networkId)` — wallet-defined for every id except 'mainnet' (docs.midnight.network/api-reference/dapp-connector). */
  walletNetworkId: string;
  indexerUri: string;
  indexerWsUri: string;
  nodeUri: string;
  /** Local proof server fallback, used only when the connected wallet has no `getProvingProvider()` (e.g. Lace). */
  proofServerUri: string;
  explorerUrl: string;
  faucet: FaucetInfo;
  /** Deployed exchange.compact address for this network, or null if not deployed yet — see web/README or the repo root README's Contract Address table. */
  contractAddress: string | null;
}

// Next.js only inlines NEXT_PUBLIC_* vars referenced as static
// `process.env.NEXT_PUBLIC_X` member expressions at build time — a dynamic
// `process.env[name]` lookup would silently resolve to `undefined` in the
// browser bundle, so every var is read as its own literal expression here.
const PROOF_SERVER_URL = process.env.NEXT_PUBLIC_PROOF_SERVER_URL?.trim() || "http://127.0.0.1:6300";

const CONTRACT_ADDRESS_PREVIEW =
  process.env.NEXT_PUBLIC_EXCHANGE_CONTRACT_ADDRESS_PREVIEW?.trim() || null;
const CONTRACT_ADDRESS_PREPROD =
  process.env.NEXT_PUBLIC_EXCHANGE_CONTRACT_ADDRESS_PREPROD?.trim() || null;

export const NETWORK_CONFIGS: Record<NetworkId, NetworkConfig> = {
  preview: {
    id: "preview",
    label: "Preview",
    walletNetworkId: "preview",
    indexerUri: "https://indexer.preview.midnight.network/api/v4/graphql",
    indexerWsUri: "wss://indexer.preview.midnight.network/api/v4/graphql/ws",
    nodeUri: "https://rpc.preview.midnight.network",
    proofServerUri: PROOF_SERVER_URL,
    explorerUrl: "https://preview.midnightexplorer.com/",
    faucet: {
      available: true,
      message: "Public faucet available.",
      url: "https://midnight-tmnight-preview.nethermind.dev/",
    },
    contractAddress: CONTRACT_ADDRESS_PREVIEW,
  },
  preprod: {
    id: "preprod",
    label: "Preprod",
    walletNetworkId: "preprod",
    indexerUri: "https://indexer.preprod.midnight.network/api/v4/graphql",
    indexerWsUri: "wss://indexer.preprod.midnight.network/api/v4/graphql/ws",
    nodeUri: "https://rpc.preprod.midnight.network",
    proofServerUri: PROOF_SERVER_URL,
    explorerUrl: "https://preprod.midnightexplorer.com/",
    faucet: {
      available: false,
      message: "Faucet currently unavailable.",
      url: null,
    },
    contractAddress: CONTRACT_ADDRESS_PREPROD,
  },
};

export function isNetworkId(value: unknown): value is NetworkId {
  return typeof value === "string" && (NETWORK_IDS as readonly string[]).includes(value);
}

export function getNetworkConfig(id: NetworkId): NetworkConfig {
  return NETWORK_CONFIGS[id];
}
