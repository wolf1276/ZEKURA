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

// The real, chain-wide unshielded token color (see types/Asset.ts) — a plain
// Bytes<32> hex string. Previously an {isLeft,left,right} tuple; simplified
// alongside contracts/exchange.compact's OrderDetails.asset field (see
// docs/ARCHITECTURE_TZKR_UNSHIELDED_MIGRATION.md).
export const assetSchema = hex32Schema;

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
  // Real unshielded UserAddress, opt-in — required only for this order to be
  // eligible for a protocol-liquidity fill on the BUY side (see
  // types/Order.ts's payoutAddress doc comment). Omitted/null orders can
  // still match/settle normally against another user order.
  payoutAddress: hex32Schema.nullish().transform((v) => v ?? null),
});

export type CreateOrderInput = z.infer<typeof createOrderSchema>;

export const orderIdParamSchema = z.object({
  id: hex32Schema,
});

/** Query-string form of assetSchema — same hex32 shape works directly in a query string, no boolean/tuple encoding needed anymore. */
export const assetQuerySchema = z.object({
  asset: hex32Schema,
});

const DAY_MS = 24 * 60 * 60 * 1000;

export const tradesQuerySchema = assetQuerySchema.extend({
  limit: z.coerce.number().int().min(1).max(500).default(50),
});

export const statsQuerySchema = assetQuerySchema.extend({
  /** Rolling window size, defaulting to 24h; capped at 7 days to bound the scan over `matches`. */
  windowMs: z.coerce.number().int().min(1000).max(7 * DAY_MS).default(DAY_MS),
});

// ─── Treasury / admin (see api/middleware/adminAuth.ts, api/admin.ts, api/treasury.ts) ───

/** Real wallet addresses/keys — not Bytes<32> ids, so these don't use hex32Schema. */
const walletAddressSchema = z.string().min(1);
const publicKeySchema = z.string().min(1);
const signatureSchema = z.string().min(1);

export const adminChallengeRequestSchema = z.object({
  address: walletAddressSchema,
});

export const adminAuthSchema = z.object({
  address: walletAddressSchema,
  publicKey: publicKeySchema,
  signature: signatureSchema,
});

const UINT128_MAX_TREASURY = UINT128_MAX;

export const adminDepositSchema = z.object({
  auth: adminAuthSchema,
  assetKey: hex32Schema,
  amount: bigintStringSchema(UINT128_MAX_TREASURY, 'amount'),
  /** Optional bootstrap reference price for a virgin asset with no trade history yet — see db/repositories/BootstrapPriceRepository.ts. Ignored once the asset has a real trade. */
  bootstrapPrice: bigintStringSchema(UINT128_MAX, 'bootstrapPrice').optional(),
});

export const adminWithdrawSchema = z.object({
  auth: adminAuthSchema,
  assetKey: hex32Schema,
  amount: bigintStringSchema(UINT128_MAX_TREASURY, 'amount'),
  /** encodeUserAddress(...) output, hex — where the withdrawn funds go. */
  recipientUserAddress: hex32Schema,
});

/**
 * Treasury/PPM balance routes are queried by the raw on-chain assetKey — the
 * same value as an order's own `asset` field (e.g. the real native tNIGHT
 * token type, or tZKR's minted color). Previously these were two distinct
 * keys (a raw token type vs. an order-shaped tuple hashed via
 * deriveAssetKey), requiring a union schema and a resolver — now that
 * OrderDetails.asset *is* the Treasury key directly, one flat schema covers
 * both call sites (see api/treasury.ts).
 */
export const treasuryAssetQuerySchema = z.object({ assetKey: hex32Schema });

export const treasuryHistoryQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(50),
  kind: z.enum(['DEPOSIT', 'WITHDRAW', 'RESERVE', 'RELEASE', 'EXECUTE']).optional(),
});

export { hex32Schema };
