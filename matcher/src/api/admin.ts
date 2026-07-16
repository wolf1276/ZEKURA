import { randomUUID } from 'node:crypto';

import type { FastifyInstance, FastifyReply } from 'fastify';

import type { AdminAuth } from './middleware/adminAuth.js';
import type { TreasuryRepository } from '../db/repositories/TreasuryRepository.js';
import { userAddressRecipient, type TreasuryClient } from '../ppm/TreasuryClient.js';
import type { Hex32 } from '../types/Asset.js';
import type { Logger } from '../utils/logger.js';
import type { Broadcaster } from '../websocket/SocketServer.js';
import { adminChallengeRequestSchema, adminDepositSchema, adminWithdrawSchema } from '../utils/validation.js';

export interface AdminRoutesDeps {
  readonly adminAuth: AdminAuth;
  readonly treasuryClient: TreasuryClient;
  readonly treasuryRepo: TreasuryRepository;
  readonly broadcaster: Broadcaster;
  readonly logger: Logger;
  /** deriveAdminId(treasuryAdminSecretHex) — the same on-chain identity every admin-gated circuit call is actually authorized under (see src/index.ts). Recorded as the local treasury_events row's `actor`, matching the contract's own TreasuryTx.actor semantics; which *HTTP*-authenticated wallet address triggered a given call is logged separately (see below), not stored in this column. */
  readonly onChainAdminActorId: Hex32;
  readonly now?: () => number;
}

const DEPOSIT_ERROR_STATUS: Record<string, number> = {
  UNAUTHORIZED: 401,
  callFailed: 502,
  transientError: 503,
};

export function registerAdminRoutes(app: FastifyInstance, deps: AdminRoutesDeps): void {
  const now = deps.now ?? (() => Date.now());

  app.post('/admin/challenge', async (request, reply: FastifyReply) => {
    const parsed = adminChallengeRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'validation_failed', issues: parsed.error.issues });
    }
    const challenge = deps.adminAuth.issueChallenge(parsed.data.address);
    if (!challenge) {
      // Same response whether the address is simply not allowlisted or
      // anything else — see AdminAuth's own doc comment on why failures
      // here are deliberately undifferentiated.
      return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'Address is not an authorized administrator' });
    }
    return reply.code(200).send({ nonce: challenge.nonce, expiresAt: challenge.expiresAt });
  });

  app.post('/admin/treasury/deposit', async (request, reply: FastifyReply) => {
    const parsed = adminDepositSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'validation_failed', issues: parsed.error.issues });
    }
    const { auth, assetKey, amount } = parsed.data;
    const adminAddress = deps.adminAuth.verify(auth.address, auth.publicKey, auth.signature);
    if (!adminAddress) {
      return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'Invalid or expired admin credentials' });
    }

    const result = await deps.treasuryClient.depositTreasury(assetKey, amount);
    if (result.outcome !== 'success') {
      deps.logger.error({ adminAddress, assetKey, amount, result }, 'admin depositTreasury did not succeed');
      return reply.code(DEPOSIT_ERROR_STATUS[result.outcome] ?? 502).send({ error: result.outcome, message: result.message });
    }

    deps.treasuryRepo.insert({
      id: randomUUID(),
      kind: 'DEPOSIT',
      assetKey,
      amount,
      actor: deps.onChainAdminActorId,
      txId: result.txId,
      createdAt: now(),
    });
    deps.logger.info({ adminAddress, assetKey, amount, txId: result.txId }, 'admin deposited Treasury funds');
    deps.broadcaster.broadcast('treasury.deposited', { assetKey, amount: amount.toString(), txId: result.txId });

    return reply.code(200).send({ txId: result.txId });
  });

  app.post('/admin/treasury/withdraw', async (request, reply: FastifyReply) => {
    const parsed = adminWithdrawSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'validation_failed', issues: parsed.error.issues });
    }
    const { auth, assetKey, amount, recipientUserAddress } = parsed.data;
    const adminAddress = deps.adminAuth.verify(auth.address, auth.publicKey, auth.signature);
    if (!adminAddress) {
      return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'Invalid or expired admin credentials' });
    }

    const result = await deps.treasuryClient.withdrawTreasury(assetKey, amount, userAddressRecipient(recipientUserAddress));
    if (result.outcome !== 'success') {
      deps.logger.error({ adminAddress, assetKey, amount, result }, 'admin withdrawTreasury did not succeed');
      return reply.code(DEPOSIT_ERROR_STATUS[result.outcome] ?? 502).send({ error: result.outcome, message: result.message });
    }

    deps.treasuryRepo.insert({
      id: randomUUID(),
      kind: 'WITHDRAW',
      assetKey,
      amount,
      actor: deps.onChainAdminActorId,
      txId: result.txId,
      createdAt: now(),
    });
    deps.logger.info({ adminAddress, assetKey, amount, recipientUserAddress, txId: result.txId }, 'admin withdrew Treasury funds');
    deps.broadcaster.broadcast('treasury.withdrawn', { assetKey, amount: amount.toString(), txId: result.txId });

    return reply.code(200).send({ txId: result.txId });
  });
}
