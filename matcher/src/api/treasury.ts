import type { FastifyInstance, FastifyReply } from 'fastify';

import type { TreasuryRepository } from '../db/repositories/TreasuryRepository.js';
import type { PricingConfig } from '../ppm/PricingEngine.js';
import type { TreasuryClient } from '../ppm/TreasuryClient.js';
import type { TreasuryEvent } from '../types/Treasury.js';
import { treasuryAssetQuerySchema, treasuryHistoryQuerySchema } from '../utils/validation.js';

export interface TreasuryRoutesDeps {
  readonly treasuryClient: TreasuryClient;
  readonly treasuryRepo: TreasuryRepository;
  readonly pricingConfig: PricingConfig;
}

function eventToJSON(event: TreasuryEvent) {
  return {
    id: event.id,
    kind: event.kind,
    assetKey: event.assetKey,
    amount: event.amount.toString(),
    actor: event.actor,
    txId: event.txId,
    createdAt: event.createdAt,
  };
}

/** 'empty' | 'healthy' | 'elevated' | 'critical' — a coarse label the Settings/Overview/Treasury pages render directly, never a raw utilization number dressed up as more precision than it is. */
function riskStatus(balance: bigint, reserved: bigint): string {
  if (balance <= 0n) return 'empty';
  const utilizationBps = (reserved * 10_000n) / balance;
  if (utilizationBps >= 8_000n) return 'critical';
  if (utilizationBps >= 5_000n) return 'elevated';
  return 'healthy';
}

/**
 * Read-only Treasury/PPM routes — no admin auth required, since Treasury
 * balances/reservations are already public on-chain ledger state (unlike
 * order details, which stay off-chain and confidential). See api/admin.ts
 * for the funding writes.
 */
export function registerTreasuryRoutes(app: FastifyInstance, deps: TreasuryRoutesDeps): void {
  app.get('/treasury/balance', async (request, reply: FastifyReply) => {
    const parsed = treasuryAssetQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'validation_failed', issues: parsed.error.issues });
    }
    const onChainAssetKey = parsed.data.assetKey;
    const liquidity = await deps.treasuryClient.getLiquidity(onChainAssetKey);
    return reply.code(200).send({
      assetKey: onChainAssetKey,
      balance: liquidity.balance.toString(),
      reserved: liquidity.reserved.toString(),
      available: liquidity.available.toString(),
    });
  });

  app.get('/treasury/history', async (request, reply: FastifyReply) => {
    const parsed = treasuryHistoryQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'validation_failed', issues: parsed.error.issues });
    }
    const events = deps.treasuryRepo.listRecent(parsed.data.limit, parsed.data.kind);
    return reply.code(200).send({ events: events.map(eventToJSON) });
  });

  app.get('/ppm/status', async (request, reply: FastifyReply) => {
    const parsed = treasuryAssetQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'validation_failed', issues: parsed.error.issues });
    }
    const onChainAssetKey = parsed.data.assetKey;
    const liquidity = await deps.treasuryClient.getLiquidity(onChainAssetKey);
    return reply.code(200).send({
      assetKey: onChainAssetKey,
      balance: liquidity.balance.toString(),
      reserved: liquidity.reserved.toString(),
      available: liquidity.available.toString(),
      riskStatus: riskStatus(liquidity.balance, liquidity.reserved),
      config: {
        baseSpreadBps: deps.pricingConfig.baseSpreadBps,
        maxExposureFraction: deps.pricingConfig.maxExposureFraction,
        inventorySkewBps: deps.pricingConfig.inventorySkewBps,
        quoteTtlSeconds: deps.pricingConfig.quoteTtlSeconds.toString(),
      },
    });
  });
}
