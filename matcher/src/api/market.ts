import type { FastifyInstance, FastifyReply } from 'fastify';

import type { Match } from '../matcher/Match.js';
import type { OrderBookLevel, OrderBookSnapshot } from '../orderbook/snapshot.js';
import type { OrderService } from '../services/OrderService.js';
import type { MarketStats } from '../types/MarketStats.js';
import { assetQuerySchema, statsQuerySchema, tradesQuerySchema } from '../utils/validation.js';

function levelToJSON(level: OrderBookLevel) {
  return { price: level.price.toString(), amount: level.amount.toString(), orderCount: level.orderCount };
}

function orderBookToJSON(snapshot: OrderBookSnapshot) {
  return { asset: snapshot.asset, bids: snapshot.bids.map(levelToJSON), asks: snapshot.asks.map(levelToJSON) };
}

function tradeToJSON(match: Match) {
  return {
    id: match.id,
    asset: match.asset,
    price: match.price.toString(),
    amount: match.amount.toString(),
    matchedAt: match.matchedAt,
  };
}

function statsToJSON(stats: MarketStats) {
  return {
    asset: stats.asset,
    lastPrice: stats.lastPrice?.toString() ?? null,
    openPrice: stats.openPrice?.toString() ?? null,
    high: stats.high?.toString() ?? null,
    low: stats.low?.toString() ?? null,
    volumeBase: stats.volumeBase.toString(),
    tradeCount: stats.tradeCount,
    changePct: stats.changePct,
  };
}

/**
 * Read-only market-data routes layered on top of the existing
 * orders/matches tables — no new persistence, no new WS message types.
 * A client is expected to fetch these once for the initial snapshot, then
 * keep them current itself from the Matcher's existing WS lifecycle events
 * (order.created/cancelled/expired for the orderbook, order.matched for the
 * trade tape/stats) — see API.md.
 */
export function registerMarketRoutes(app: FastifyInstance, orderService: OrderService): void {
  app.get('/orderbook', async (request, reply: FastifyReply) => {
    const parsed = assetQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'validation_failed', issues: parsed.error.issues });
    }
    return reply.code(200).send(orderBookToJSON(orderService.getOrderBookSnapshot(parsed.data.asset)));
  });

  app.get('/trades', async (request, reply: FastifyReply) => {
    const parsed = tradesQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'validation_failed', issues: parsed.error.issues });
    }
    const { asset, limit } = parsed.data;
    return reply.code(200).send({ trades: orderService.listRecentTrades(asset, limit).map(tradeToJSON) });
  });

  app.get('/stats', async (request, reply: FastifyReply) => {
    const parsed = statsQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'validation_failed', issues: parsed.error.issues });
    }
    const { asset, windowMs } = parsed.data;
    return reply.code(200).send(statsToJSON(orderService.getMarketStats(asset, windowMs)));
  });
}
