// Persistence + canonical metadata for the Zekura Test Token (tZKR).
//
// The tZKR deployment record lives in its OWN file (.midnight-tzkr.json),
// deliberately separate from .midnight-state.json's `deployments` map — that
// map is the exchange contract's address and must never be clobbered by the
// token deploy. Mirrors network.ts's atomic-write / load-or-default shape.

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { NetworkId } from './network';

// Canonical, source-of-truth token identity. Purely off-chain display
// metadata now — the real unshielded tZKR contract (contracts/tzkr-token.compact)
// carries no on-chain name/symbol/decimals (real unshielded tokens have no
// on-chain metadata at all; see docs/ARCHITECTURE_TZKR_UNSHIELDED_MIGRATION.md).
// Every UI surface (README, web, matcher) should agree with these.
export const TZKR_TOKEN_NAME = 'Zekura Test Token';
export const TZKR_TOKEN_SYMBOL = 'tZKR';
export const TZKR_TOKEN_DECIMALS = 6;

export const TZKR_STATE_FILE_NAME = '.midnight-tzkr.json';

export interface TzkrDeploymentRecord {
  address: string;
  deployer: string;
  ownerAccountId: string;
  // The real, chain-wide unshielded token color (hex, Bytes<32>) minted by
  // this contract — populated after the first successful mint (src/mint-tzkr.ts
  // reads it back from the ledger's `token_color` field). This, not the
  // contract address, is what every other surface (Exchange OrderDetails.asset,
  // Treasury assetKey, wallet unshielded balance lookups) actually uses.
  // Absent until the first mint has landed.
  color?: string;
  deployedAt: string;
}

export interface TzkrState {
  version: 1;
  deployments: Partial<Record<NetworkId, TzkrDeploymentRecord>>;
}

function statePath(cwd = process.cwd()): string {
  return path.join(cwd, TZKR_STATE_FILE_NAME);
}

export function loadTzkrState(cwd = process.cwd()): TzkrState | null {
  const p = statePath(cwd);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf-8')) as TzkrState;
}

export function getTzkrDeployment(network: NetworkId, cwd = process.cwd()): TzkrDeploymentRecord | null {
  return loadTzkrState(cwd)?.deployments?.[network] ?? null;
}

export function recordTzkrDeployment(
  network: NetworkId,
  record: Omit<TzkrDeploymentRecord, 'deployedAt'>,
  cwd = process.cwd(),
): void {
  const existing = loadTzkrState(cwd) ?? { version: 1 as const, deployments: {} };
  existing.deployments = {
    ...existing.deployments,
    [network]: { ...record, deployedAt: new Date().toISOString() },
  };
  const p = statePath(cwd);
  const tmp = `${p}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, `${JSON.stringify(existing, null, 2)}\n`);
  fs.renameSync(tmp, p);
}

/**
 * Merges the real minted color into an existing deployment record, without
 * disturbing its deployedAt/deployer/address/ownerAccountId. Called by
 * src/mint-tzkr.ts once it reads token_color back from the ledger after a
 * successful mint.
 */
export function recordTzkrColor(network: NetworkId, color: string, cwd = process.cwd()): void {
  const existing = loadTzkrState(cwd);
  const current = existing?.deployments?.[network];
  if (!existing || !current) {
    throw new Error(`No tZKR deployment recorded for ${network} — cannot record its color`);
  }
  existing.deployments = { ...existing.deployments, [network]: { ...current, color } };
  const p = statePath(cwd);
  const tmp = `${p}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, `${JSON.stringify(existing, null, 2)}\n`);
  fs.renameSync(tmp, p);
}
