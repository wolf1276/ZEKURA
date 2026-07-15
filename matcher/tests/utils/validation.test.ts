import { describe, expect, it } from 'vitest';

import { createOrderSchema, orderIdParamSchema } from '../../src/utils/validation.js';

/** `byte` must be exactly 2 hex chars; repeats it to a full 32-byte (64 char) hex string. */
function hexFill(byte: string): string {
  return byte.repeat(32);
}

function validPayload(overrides: Record<string, unknown> = {}) {
  return {
    id: hexFill('01'),
    asset: { isLeft: true, left: hexFill('aa'), right: hexFill('00') },
    side: 'BUY',
    price: '1000',
    amount: '500',
    commitment: hexFill('cc'),
    ownerId: hexFill('bb'),
    signature: hexFill('dd'),
    expiresAt: '9999999999',
    ...overrides,
  };
}

describe('createOrderSchema', () => {
  it('accepts a well-formed payload and converts price/amount/expiresAt to bigint', () => {
    const result = createOrderSchema.safeParse(validPayload());
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.price).toBe(1000n);
      expect(result.data.amount).toBe(500n);
      expect(result.data.expiresAt).toBe(9999999999n);
    }
  });

  it('rejects a malformed hex32 field', () => {
    expect(createOrderSchema.safeParse(validPayload({ id: 'not-hex' })).success).toBe(false);
    expect(createOrderSchema.safeParse(validPayload({ commitment: 'AB'.repeat(32) })).success).toBe(false); // uppercase
    expect(createOrderSchema.safeParse(validPayload({ ownerId: 'a'.repeat(63) })).success).toBe(false); // short
  });

  it('rejects a non-numeric price/amount/expiresAt string', () => {
    expect(createOrderSchema.safeParse(validPayload({ price: '12.5' })).success).toBe(false);
    expect(createOrderSchema.safeParse(validPayload({ amount: '-5' })).success).toBe(false);
    expect(createOrderSchema.safeParse(validPayload({ expiresAt: 'soon' })).success).toBe(false);
  });

  it('rejects price/amount exceeding Uint<128> max', () => {
    const tooBig = (340282366920938463463374607431768211455n + 1n).toString();
    expect(createOrderSchema.safeParse(validPayload({ price: tooBig })).success).toBe(false);
  });

  it('rejects expiresAt exceeding Uint<64> max', () => {
    const tooBig = (18446744073709551615n + 1n).toString();
    expect(createOrderSchema.safeParse(validPayload({ expiresAt: tooBig })).success).toBe(false);
  });

  it('accepts exactly the Uint<128>/Uint<64> maxima (boundary)', () => {
    const result = createOrderSchema.safeParse(
      validPayload({ price: '340282366920938463463374607431768211455', amount: '340282366920938463463374607431768211455', expiresAt: '18446744073709551615' }),
    );
    expect(result.success).toBe(true);
  });

  it('rejects an invalid side', () => {
    expect(createOrderSchema.safeParse(validPayload({ side: 'HOLD' })).success).toBe(false);
  });

  it('rejects a missing required field', () => {
    const payload = validPayload();
    delete (payload as Record<string, unknown>).signature;
    expect(createOrderSchema.safeParse(payload).success).toBe(false);
  });
});

describe('orderIdParamSchema', () => {
  it('accepts a valid hex32 id param', () => {
    expect(orderIdParamSchema.safeParse({ id: hexFill('01') }).success).toBe(true);
  });

  it('rejects a malformed id param', () => {
    expect(orderIdParamSchema.safeParse({ id: 'short' }).success).toBe(false);
  });
});
