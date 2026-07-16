import { randomBytes } from 'node:crypto';

import { addressFromKey, verifySignature } from '@midnight-ntwrk/ledger-v8';

/**
 * Wallet-allowlist + signed-challenge admin auth. No session/password store
 * — an "authorized administrator" is simply a wallet address in
 * `allowedAddresses`, and proving control of it is a real digital signature
 * over a short-lived, single-use server-issued nonce, using the exact same
 * signing/verification primitives (@midnight-ntwrk/ledger-v8's signData/
 * verifySignature) the wallet SDK already uses elsewhere in this repo (see
 * ../../../../src/wallet.ts's UnshieldedKeystore). This is deliberately a
 * real signature scheme rather than the on-chain witness+commitment pattern
 * (contracts/exchange.compact's deriveOwnerId/deriveAdminId) — HTTP requests
 * aren't ZK circuits, and a real signature is the correct tool for proving
 * control of a wallet address outside one, not a workaround for it.
 *
 * In-memory only, matching this Matcher's existing single-process
 * concurrency model (see ARCHITECTURE.md) — a challenge does not survive a
 * process restart, which is fine: the admin just requests a new one.
 */
export interface AdminChallenge {
  readonly nonce: string;
  readonly expiresAt: number;
}

export interface AdminAuthConfig {
  readonly allowedAddresses: ReadonlySet<string>;
  readonly challengeTtlMs?: number;
  readonly now?: () => number;
}

const DEFAULT_CHALLENGE_TTL_MS = 5 * 60 * 1000;

export class AdminAuth {
  private readonly allowedAddresses: ReadonlySet<string>;
  private readonly challengeTtlMs: number;
  private readonly now: () => number;
  private readonly challenges = new Map<string, AdminChallenge>();

  constructor(config: AdminAuthConfig) {
    this.allowedAddresses = config.allowedAddresses;
    this.challengeTtlMs = config.challengeTtlMs ?? DEFAULT_CHALLENGE_TTL_MS;
    this.now = config.now ?? (() => Date.now());
  }

  isAllowed(address: string): boolean {
    return this.allowedAddresses.has(address);
  }

  /** Returns null for an address that isn't on the allowlist — never issues a challenge to an unrecognized address, so a scan of this endpoint can't be used to enumerate anything. */
  issueChallenge(address: string): AdminChallenge | null {
    if (!this.isAllowed(address)) return null;
    const challenge: AdminChallenge = { nonce: randomBytes(32).toString('hex'), expiresAt: this.now() + this.challengeTtlMs };
    this.challenges.set(address, challenge);
    return challenge;
  }

  /**
   * Verifies and consumes (single-use) a challenge response. `publicKey`
   * must both (a) sign the nonce and (b) hash to `address` via
   * addressFromKey — the second check is what stops a caller from signing
   * with an unrelated key and merely *claiming* an allowlisted address.
   * Returns the authenticated address on success, null on any failure —
   * deliberately undifferentiated (expired/missing/wrong-key/bad-signature
   * all look the same to the caller) so this can't be used to probe which
   * failure mode applies.
   */
  verify(address: string, publicKey: string, signature: string): string | null {
    if (!this.isAllowed(address)) return null;
    const challenge = this.challenges.get(address);
    if (!challenge) return null;
    if (this.now() > challenge.expiresAt) {
      this.challenges.delete(address);
      return null;
    }
    if (addressFromKey(publicKey) !== address) return null;

    const nonceBytes = new Uint8Array(Buffer.from(challenge.nonce, 'hex'));
    let signatureValid: boolean;
    try {
      signatureValid = verifySignature(publicKey, nonceBytes, signature);
    } catch {
      signatureValid = false;
    }
    if (!signatureValid) return null;

    this.challenges.delete(address);
    return address;
  }
}
