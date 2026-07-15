import { CallTxFailedError } from '@midnight-ntwrk/midnight-js-contracts';
import { FailEntirely, FailFallible } from '@midnight-ntwrk/midnight-js-types';
import { describe, expect, it, vi } from 'vitest';

import {
  buildExchangeWitnesses,
  SettlementClient,
  type OnChainOrderReader,
  type SettleCircuitCaller,
} from '../../src/settlement/SettlementClient.js';
import { computeCommitmentHex, toOrderDetailsValue } from '../../src/utils/orderDetailsCodec.js';
import type { Order } from '../../src/types/Order.js';
import { createLogger } from '../../src/utils/logger.js';

const logger = createLogger('test', { level: 'silent' });

function hexFill(byte: string): string {
  return byte.repeat(32);
}

const buyId = hexFill('01');
const sellId = hexFill('02');

function makeFinalizedTxData(status: typeof FailEntirely | typeof FailFallible) {
  return {
    tx: {} as never,
    status,
    txId: 'tx-1' as never,
    identifiers: [],
    txHash: 'hash' as never,
    blockHash: 'block' as never,
    blockHeight: 1,
    blockTimestamp: 0,
    blockAuthor: null,
    indexerId: 1,
    protocolVersion: 1,
    fees: {} as never,
    segmentStatusMap: undefined,
    unshielded: {} as never,
  };
}

describe('SettlementClient', () => {
  it('returns success with the txId on a successful settle() call', async () => {
    const caller: SettleCircuitCaller = { settle: vi.fn().mockResolvedValue({ public: { txId: 'tx-abc' } }) };
    const reader: OnChainOrderReader = { getOrder: vi.fn() };
    const client = new SettlementClient(caller, reader, logger);

    const result = await client.settle({ id: buyId }, { id: sellId });
    expect(result).toEqual({ outcome: 'success', txId: 'tx-abc' });
    expect(caller.settle).toHaveBeenCalledTimes(1);
  });

  it('classifies a CallTxFailedError (guaranteed-phase) as callFailed with its status', async () => {
    const error = new CallTxFailedError(makeFinalizedTxData(FailEntirely), 'settle' as never);
    const caller: SettleCircuitCaller = { settle: vi.fn().mockRejectedValue(error) };
    const reader: OnChainOrderReader = { getOrder: vi.fn() };
    const client = new SettlementClient(caller, reader, logger);

    const result = await client.settle({ id: buyId }, { id: sellId });
    expect(result).toEqual({ outcome: 'callFailed', status: FailEntirely, message: error.message });
  });

  it('classifies a CallTxFailedError (fallible-phase) as callFailed with its status', async () => {
    const error = new CallTxFailedError(makeFinalizedTxData(FailFallible), 'settle' as never);
    const caller: SettleCircuitCaller = { settle: vi.fn().mockRejectedValue(error) };
    const reader: OnChainOrderReader = { getOrder: vi.fn() };
    const client = new SettlementClient(caller, reader, logger);

    const result = await client.settle({ id: buyId }, { id: sellId });
    expect(result).toEqual({ outcome: 'callFailed', status: FailFallible, message: error.message });
  });

  it('classifies any non-CallTxFailedError throw (network/proof-server) as transientError', async () => {
    const caller: SettleCircuitCaller = { settle: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')) };
    const reader: OnChainOrderReader = { getOrder: vi.fn() };
    const client = new SettlementClient(caller, reader, logger);

    const result = await client.settle({ id: buyId }, { id: sellId });
    expect(result).toEqual({ outcome: 'transientError', message: 'ECONNREFUSED' });
  });

  it('classifies a thrown non-Error value (e.g. a rejected string) as transientError via String() coercion', async () => {
    const caller: SettleCircuitCaller = { settle: vi.fn().mockRejectedValue('raw string rejection') };
    const reader: OnChainOrderReader = { getOrder: vi.fn() };
    const client = new SettlementClient(caller, reader, logger);

    const result = await client.settle({ id: buyId }, { id: sellId });
    expect(result).toEqual({ outcome: 'transientError', message: 'raw string rejection' });
  });

  it('getOnChainState delegates to the reader', async () => {
    const caller: SettleCircuitCaller = { settle: vi.fn() };
    const reader: OnChainOrderReader = { getOrder: vi.fn().mockResolvedValue({ state: 'OPEN', commitment: 'x' }) };
    const client = new SettlementClient(caller, reader, logger);
    expect(await client.getOnChainState(buyId)).toBe('OPEN');
  });
});

describe('buildExchangeWitnesses', () => {
  function sampleOrder(overrides: Partial<Order> = {}): Order {
    return {
      id: buyId,
      asset: { isLeft: true, left: hexFill('aa'), right: hexFill('00') },
      side: 'BUY',
      price: 1_000n,
      amount: 500n,
      commitment: '',
      ownerId: hexFill('bb'),
      signature: hexFill('cc'),
      status: 'OPEN',
      createdAt: Date.now(),
      expiresAt: 9_999_999_999n,
      ...overrides,
    };
  }

  it('orderDetails/orderBlinding resolve exactly what a disclosed order would produce', () => {
    const order = sampleOrder();
    const witnesses = buildExchangeWitnesses({ findById: (id) => (id === order.id ? order : undefined) });

    const idBytes = new Uint8Array(Buffer.from(order.id, 'hex'));
    const ctx = { privateState: undefined } as never;

    const [, details] = witnesses.orderDetails(ctx, idBytes);
    expect(details).toEqual(toOrderDetailsValue(order));

    const [, blinding] = witnesses.orderBlinding(ctx, idBytes);
    expect(Buffer.from(blinding).toString('hex')).toBe(order.signature);

    // Sanity: the witnesses reproduce a commitment identical to what the order was created with.
    const recomputed = computeCommitmentHex(toOrderDetailsValue(order), order.signature);
    expect(recomputed).toHaveLength(64);
  });

  it('orderDetails throws for an orderId the Matcher was never disclosed', () => {
    const witnesses = buildExchangeWitnesses({ findById: () => undefined });
    const idBytes = new Uint8Array(Buffer.from(hexFill('ff'), 'hex'));
    expect(() => witnesses.orderDetails({ privateState: undefined } as never, idBytes)).toThrow();
  });

  it('ownerSecretKey always throws — the Matcher must never hold one (see AUDIT.md threat model)', () => {
    const witnesses = buildExchangeWitnesses({ findById: () => undefined });
    expect(() => witnesses.ownerSecretKey({ privateState: undefined } as never)).toThrow();
  });
});
