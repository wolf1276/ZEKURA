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

/** Query-string form of assetSchema — GET requests have no JSON body, so `isLeft` travels as the string "true"/"false" instead of a boolean. */
export const assetQuerySchema = z.object({
  isLeft: z.enum(['true', 'false']).transform((v) => v === 'true'),
  left: hex32Schema,
  right: hex32Schema,
});

const DAY_MS = 24 * 60 * 60 * 1000;

export const tradesQuerySchema = assetQuerySchema.extend({
  limit: z.coerce.number().int().min(1).max(500).default(50),
});

export const statsQuerySchema = assetQuerySchema.extend({
  /** Rolling window size, defaulting to 24h; capped at 7 days to bound the scan over `matches`. */
  windowMs: z.coerce.number().int().min(1000).max(7 * DAY_MS).default(DAY_MS),
});

export { hex32Schema };
