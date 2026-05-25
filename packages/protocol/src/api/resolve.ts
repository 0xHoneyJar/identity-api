/**
 * /v1/resolve/* + /v1/identity/* + /v1/me response Zod schemas — shared
 * between server routes and the typed SDK (Pattern B from T1.10).
 *
 * The path-param schemas are colocated here for SDK callers that want to
 * validate inputs client-side before round-tripping. Server-side, the
 * resolve route handler also imports these so the regex/format rules are
 * literally the same object — one source of truth.
 *
 * Response shape rationale:
 *   - resolve.* return `{user_id}` on hit (or 404 on miss). We export
 *     ResolveHitRespSchema for callers that want runtime validation;
 *     `null` on miss is encoded at the client level (404 → null), so the
 *     SDK return type is `ResolveHit | null` not `ResolveHit | ErrorEnvelope`.
 *   - identity (FR-R4) returns the full SpineIdentityShape. We mirror its
 *     fields exactly so the SDK type is the wire type is the spine type.
 *     When `packages/protocol/identity-resolution.schema.json` is sealed
 *     (later T2 task), this schema becomes the JSON Schema source of truth
 *     and the route's jsonResponse(...) is asserted against it.
 */

import { z } from "zod"

// ─── path parameter schemas (FR-R1..R4) ─────────────────────────────────────

export const WalletAddressParamSchema = z
  .string()
  .regex(/^0x[a-fA-F0-9]{40}$/, "0x-prefixed 20-byte hex")

/**
 * Linked-account providers — mirrors the spine's CHECK constraint on
 * `linked_accounts.provider` (PRD §4.2). dynamic_user_id is a BACKFILL
 * provider — the resolve surface accepts it (so backfilled rows are
 * queryable), but `/v1/auth/verify` refuses to MINT new rows under it
 * (FR-A4 enforcement at the auth boundary, not the resolve boundary).
 */
export const ProviderParamSchema = z.enum(["discord", "telegram", "dynamic_user_id"])
export type ResolveProvider = z.infer<typeof ProviderParamSchema>

export const ExternalIdParamSchema = z.string().min(1)

export const WorldSlugParamSchema = z
  .string()
  .regex(/^[a-z0-9-]+$/, "lowercase, digits, hyphen only")

export const NymParamSchema = z
  .string()
  .regex(/^[a-zA-Z0-9_]+$/, "alphanum + underscore")
  .min(3)
  .max(20)

export const UserIdParamSchema = z.string().uuid()

// ─── response schemas (FR-R1..R4) ───────────────────────────────────────────

/**
 * The bare-hit shape for the three resolve endpoints. 200 on hit, 404 on
 * miss. The SDK translates 404 → `null` so callers don't have to handle
 * error envelopes for the negative case.
 */
export const ResolveHitRespSchema = z.object({
  user_id: z.string().uuid(),
})
export type ResolveHitResp = z.infer<typeof ResolveHitRespSchema>

// ─── Identity (FR-R4) — the full composite shape ────────────────────────────

/**
 * One row from wallet_links as the spine sees it. Mirrors
 * `@freeside-auth/ports#SpineWallet` exactly (which is itself the row
 * shape returned by PostgresSpineAdapter.getIdentity).
 *
 * We re-derive it via Zod here (instead of importing the ports' TS type)
 * because the SDK is vendor-distributed AS SOURCE — pulling `@freeside-
 * auth/ports` would drag the entire engine into the consumer's tree.
 * The protocol package is the narrow, ports-free import surface.
 */
export const IdentityWalletSchema = z.object({
  wallet_address: z.string(),
  chain_ids: z.array(z.string()).readonly(),
  is_primary: z.boolean(),
  verified_at: z.string(),
  unlinked_at: z.string().nullable(),
})
export type IdentityWallet = z.infer<typeof IdentityWalletSchema>

export const IdentityLinkedAccountSchema = z.object({
  provider: ProviderParamSchema,
  external_id: z.string(),
  verified_at: z.string(),
  unlinked_at: z.string().nullable(),
})
export type IdentityLinkedAccount = z.infer<typeof IdentityLinkedAccountSchema>

export const IdentityWorldIdentitySchema = z.object({
  world_slug: z.string(),
  nym: z.string(),
  joined_at: z.string(),
})
export type IdentityWorldIdentity = z.infer<typeof IdentityWorldIdentitySchema>

/**
 * Composite Identity (FR-R4 return shape).
 *
 * Returned by:
 *   - GET /v1/identity/:userId (the public spine read)
 *   - GET /v1/me              (the JWT-bearer self-view; convenience)
 *
 * Per SDD §5.3 the on-wire shape is 1:1 with `SpineIdentityShape` from
 * `@freeside-auth/ports`. Adding the Zod binding here proves the SDK
 * doesn't drift from that shape (Zod parse on the SDK side throws if the
 * server returns a row the SDK doesn't expect).
 */
export const IdentityRespSchema = z.object({
  user_id: z.string().uuid(),
  primary_wallet: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  wallets: z.array(IdentityWalletSchema).readonly(),
  linked_accounts: z.array(IdentityLinkedAccountSchema).readonly(),
  world_identities: z.array(IdentityWorldIdentitySchema).readonly(),
})
export type IdentityResp = z.infer<typeof IdentityRespSchema>
