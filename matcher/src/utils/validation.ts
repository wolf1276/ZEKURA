import { z } from 'zod';

const UINT128_MAX = 340282366920938463463374607431768211455n;
const UINT64_MAX = 18446744073709551615n;

const hex32Schema = z
  .string()
  .regex(/^[0-9a-f]{64}$/, 'must be exactly 64 lowercase hex characters (32 bytes)');

/**
 * price/amount/expiresAt travel as decimal strings over JSON (they can
 * exceed Number.MAX_SAFE_INTEGER — Uint<128> on-chain) and are converted to
 * bigint here, bounded by the contract's actual field width.
 */
function bigintStringSchema(max: bigint, label: string) {
  return z
    .string()
    .regex(/^[0-9]+$/, `${label} must be a non-negative integer string`)
    .transform((s, ctx) => {
      const value = BigInt(s);
      if (value > max) {
        ctx.addIssue({ code: 'custom', message: `${label} exceeds the maximum representable value (${max})` });
        return z.NEVER;
      }
      return value;
    });
}

export const assetSchema = z.object({
  isLeft: z.boolean(),
  left: hex32Schema,
  right: hex32Schema,
});

export const sideSchema = z.enum(['BUY', 'SELL']);

export const createOrderSchema = z.object({
  id: hex32Schema,
  asset: assetSchema,
  side: sideSchema,
  price: bigintStringSchema(UINT128_MAX, 'price'),
  amount: bigintStringSchema(UINT128_MAX, 'amount'),
  commitment: hex32Schema,
  ownerId: hex32Schema,
  signature: hex32Schema,
  expiresAt: bigintStringSchema(UINT64_MAX, 'expiresAt'),
});

export type CreateOrderInput = z.infer<typeof createOrderSchema>;

export const orderIdParamSchema = z.object({
  id: hex32Schema,
});

export { hex32Schema };
