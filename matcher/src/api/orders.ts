import type { FastifyInstance, FastifyReply } from 'fastify';

import type { OrderService, PendingProtocolQuote, ProtocolFill } from '../services/OrderService.js';
import type { Match } from '../matcher/Match.js';
import type { Order } from '../types/Order.js';
import { createOrderSchema, orderIdParamSchema } from '../utils/validation.js';

function orderToJSON(order: Order) {
  return {
    id: order.id,
    asset: order.asset,
    side: order.side,
    price: order.price.toString(),
    amount: order.amount.toString(),
    commitment: order.commitment,
    ownerId: order.ownerId,
    status: order.status,
    createdAt: order.createdAt,
    expiresAt: order.expiresAt.toString(),
    payoutAddress: order.payoutAddress ?? null,
  };
}

function matchToJSON(match: Match) {
  return {
    id: match.id,
    buyOrderId: match.buyOrderId,
    sellOrderId: match.sellOrderId,
    asset: match.asset,
    price: match.price.toString(),
    amount: match.amount.toString(),
    matchedAt: match.matchedAt,
  };
}

function protocolFillToJSON(fill: ProtocolFill) {
  return {
    quoteId: fill.quoteId,
    price: fill.price.toString(),
    amount: fill.amount.toString(),
    txId: fill.txId,
  };
}

function pendingProtocolQuoteToJSON(quote: PendingProtocolQuote) {
  return {
    quoteId: quote.quoteId,
    price: quote.price.toString(),
    amount: quote.amount.toString(),
    expiresAt: quote.expiresAt.toString(),
  };
}

const SUBMIT_ERROR_STATUS: Record<string, number> = {
  DUPLICATE: 409,
  SIGNATURE_INVALID: 422,
  NOT_ON_CHAIN: 422,
  COMMITMENT_MISMATCH: 422,
  NOT_OPEN_ON_CHAIN: 422,
  EXPIRED: 422,
};

const CANCEL_ERROR_STATUS: Record<string, number> = {
  NOT_FOUND: 404,
  NOT_CANCELLABLE: 409,
};

export function registerOrderRoutes(app: FastifyInstance, orderService: OrderService): void {
  app.post('/orders', async (request, reply: FastifyReply) => {
    const parsed = createOrderSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'validation_failed', issues: parsed.error.issues });
    }

    const result = await orderService.submitOrder(parsed.data);
    if (!result.ok) {
      return reply.code(SUBMIT_ERROR_STATUS[result.code] ?? 400).send({ error: result.code, message: result.message });
    }

    return reply.code(201).send({
      order: orderToJSON(result.order),
      match: result.match ? matchToJSON(result.match) : null,
      protocolFill: result.protocolFill ? protocolFillToJSON(result.protocolFill) : null,
      pendingProtocolQuote: result.pendingProtocolQuote ? pendingProtocolQuoteToJSON(result.pendingProtocolQuote) : null,
    });
  });

  app.delete('/orders/:id', async (request, reply: FastifyReply) => {
    const parsed = orderIdParamSchema.safeParse(request.params);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'validation_failed', issues: parsed.error.issues });
    }

    const result = orderService.cancelOrder(parsed.data.id);
    if (!result.ok) {
      return reply.code(CANCEL_ERROR_STATUS[result.code] ?? 400).send({ error: result.code, message: result.message });
    }
    return reply.code(200).send({ order: orderToJSON(result.order) });
  });

  app.get('/orders/open', async () => {
    // Reconcile any pending protocol fills whose settleWithProtocol has landed
    // on-chain before listing — keeps the open list from showing an order the
    // chain already considers FILLED.
    await orderService.reconcileAllPendingProtocolFills();
    return { orders: orderService.listOpen().map(orderToJSON) };
  });

  app.get('/orders/:id', async (request, reply: FastifyReply) => {
    const parsed = orderIdParamSchema.safeParse(request.params);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'validation_failed', issues: parsed.error.issues });
    }

    // Reconciled read: if the owner's wallet just submitted settleWithProtocol,
    // this fetch is what materializes the fill locally (see the web settlement
    // hook, which re-fetches GET /orders/:id right after the wallet resolves).
    const order = await orderService.getOrderReconciled(parsed.data.id);
    if (!order) {
      return reply.code(404).send({ error: 'NOT_FOUND', message: `No such order: ${parsed.data.id}` });
    }
    return reply.code(200).send({ order: orderToJSON(order) });
  });
}
