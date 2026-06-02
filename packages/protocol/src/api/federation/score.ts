/**
 * Federation contract — score-api wire shapes (T2.1).
 *
 * score-api (a.k.a. score-mibera) is the freeside-platform building that
 * owns numeric scoring + factor breakdowns for wallets. Per registry.yaml
 * `score-api` is at `https://score.0xhoneyjar.xyz` (`rename: done`). The
 * Hono-based service exposes `GET /v1/wallets/:address` returning a rich
 * `WalletProfile` shape.
 *
 * Source of truth (discovery findings — see t2.1 build notes):
 *
 *   - The local checkout at `~/Documents/GitHub/score-api/` is a Hono service
 *     with a real HTTP surface. Route: `src/routes/wallets.ts` line ~120,
 *     `wallets.get("/:address", zValidator("param", addressSchema), …)`.
 *     Returns the `WalletProfile` interface defined at
 *     `src/types/api.types.ts:25`.
 *
 *   - We hand-author the Zod schema mirror here (rather than vendor the
 *     score-api types package — it doesn't publish one) because:
 *     (a) score-api is `private: true` in its own package.json — no npm
 *         distribution.
 *     (b) The `WalletProfile` shape is wide (~30 fields) but stable in
 *         shape; identity-api only consumes a small subset for the
 *         `/v1/profile` compose at T2.3 (effectively the per-dimension
 *         scores + tiers + percentiles).
 *     (c) Identity-api's contract surface need not match every field — we
 *         declare `.passthrough()` so undeclared fields don't reject the
 *         response. New score-api fields are silent additions; their
 *         consumption is a separate decision at T2.2's compose layer.
 *
 *   - score-api requires `X-API-Key` auth on `/v1/*` per `authMiddleware`
 *     in `src/middleware/auth.ts`. The adapter takes the key via env
 *     (`SCORE_API_KEY`) and injects it as the `X-API-Key` header. v1: a
 *     single static key per-deployment — secret-rotation is a T3+ concern.
 *
 * Per Pattern B (T1.10) these Zod schemas live alongside other api/* shapes.
 *
 * Source: PRD v3.0 §4.5 (FR-P2 score compose), SDD §5.4, registry.yaml,
 * `~/Documents/GitHub/score-api/src/types/api.types.ts:25-100`,
 * `~/Documents/GitHub/score-api/src/routes/wallets.ts`.
 */

import { z } from "zod"

// ─── enums (mirror score-api/api.types.ts) ──────────────────────────────────

/**
 * Tier enum for the V8 "Badges & Tiers" surface. Mirrors `CrowdTier` at
 * `~/Documents/GitHub/score-api/src/types/api.types.ts:99-104`.
 */
export const ScoreCrowdTierSchema = z.enum([
  "curious",
  "initiated",
  "devoted",
  "front_row",
  "all_night",
  "eternal",
])
export type ScoreCrowdTier = z.infer<typeof ScoreCrowdTierSchema>

/**
 * Rank-based sovereign tier. Mirrors `EliteTier` at api.types.ts:107.
 */
export const ScoreEliteTierSchema = z.enum(["godfather", "veteran"])
export type ScoreEliteTier = z.infer<typeof ScoreEliteTierSchema>

/**
 * Trust classification surface from V6 scoring. Mirrors `TrustClassification`
 * at api.types.ts (in the wallet-activity block).
 */
export const ScoreTrustClassificationSchema = z.enum([
  "normal",
  "banned_robotic",
  "banned_cluster",
  "flagged_single_factor",
  "flagged_burst",
])
export type ScoreTrustClassification = z.infer<typeof ScoreTrustClassificationSchema>

// ─── HTTP path schema ───────────────────────────────────────────────────────

/**
 * Path-parameter schema for `GET /v1/wallets/:address`. Mirrors the
 * `addressSchema` validator at score-api/src/routes/wallets.ts line ~20.
 */
export const ScoreGetWalletPathSchema = z.object({
  address: z.string().regex(/^0x[a-fA-F0-9]{40}$/, "0x-prefixed 20-byte hex"),
})
export type ScoreGetWalletPath = z.infer<typeof ScoreGetWalletPathSchema>

// ─── HTTP response shape ────────────────────────────────────────────────────

/**
 * The wallet profile body for `GET /v1/wallets/:address`.
 *
 * Mirrors `WalletProfile` from score-api/src/types/api.types.ts:25-98.
 *
 * `.passthrough()` (Zod 4 → `.loose()`) intentionally allows
 * forward-compatible additions on the score-api side — we capture the
 * fields T2.2's compose-fan-out cares about; new fields don't break the
 * adapter. Field omission (missing field) DOES reject as `parse_error`
 * to catch backwards-incompatible score-api changes.
 *
 * NOTE on Zod version: this repo's protocol package pins zod ^4.4.3 (see
 * packages/protocol/package.json). In Zod 4 the v3 `.passthrough()` is
 * called `.loose()` and the default object-mode is `.strict()`. We use
 * `.loose()` to permit unknown fields.
 */
export const ScoreGetWalletRespSchema = z
  .object({
    wallet: z.string(),
    // Per-dimension scores (normalized 0-99). Nullable when the wallet has no
    // activity for that dimension.
    og_score: z.number().nullable(),
    nft_score: z.number().nullable(),
    onchain_score: z.number().nullable(),
    // Raw scores before piecewise normalization
    og_score_raw: z.number().nullable(),
    nft_score_raw: z.number().nullable(),
    onchain_score_raw: z.number().nullable(),
    // First/last activity timestamps (ISO 8601 strings, server-emitted)
    first_activity: z.string().nullable(),
    last_activity: z.string().nullable(),
    // Per-dimension factor counts (how many factors contributed)
    og_factor_count: z.number().nullable(),
    nft_factor_count: z.number().nullable(),
    onchain_factor_count: z.number().nullable(),
    // V7 Trust data — graduated trust (0.60-1.00)
    trust_filter: z.number(),
    trust_coefficient: z.number(),
    trust_classification: ScoreTrustClassificationSchema,
    flagged_for_review: z.boolean(),
    // V7 Breadth metrics (0-1, ecosystem coverage ratio)
    og_breadth: z.number().nullable(),
    nft_breadth: z.number().nullable(),
    onchain_breadth: z.number().nullable(),
    // V7 Breadth multipliers (0.70 + 0.30 × weighted_breadth)
    og_breadth_multiplier: z.number().nullable(),
    nft_breadth_multiplier: z.number().nullable(),
    onchain_breadth_multiplier: z.number().nullable(),
    // Raw leaderboard ranks (1 = top)
    og_rank: z.number().nullable(),
    nft_rank: z.number().nullable(),
    onchain_rank: z.number().nullable(),
    overall_rank: z.number().nullable(),
    total_ranked_wallets: z.number().nullable(),
    // Percentile rankings (0-100, higher = better)
    og_percentile: z.number().nullable(),
    nft_percentile: z.number().nullable(),
    onchain_percentile: z.number().nullable(),
    overall_percentile: z.number().nullable(),
    // V8 score-tier data
    combined_score: z.number().nullable(),
    crowd_tier: ScoreCrowdTierSchema.nullable(),
    crowd_tier_display: z.string().nullable(),
    elite_tier: ScoreEliteTierSchema.nullable(),
    elite_tier_display: z.string().nullable(),
    points_to_next_crowd_tier: z.number().nullable(),
    next_crowd_tier_display: z.string().nullable(),
    // V8 Badge summary
    badge_count: z.number().nullable(),
    pioneer_badge_count: z.number().nullable(),
  })
  .loose()
export type ScoreGetWalletResp = z.infer<typeof ScoreGetWalletRespSchema>

// ─── identity-resolve surface (bd-2wo.38.1) ─────────────────────────────────

/**
 * Request shape for score-api `POST /v1/identity/resolve` — the group-aware
 * onchain-name surface (distinct from the scores-only `GET /v1/wallets/:address`).
 *
 * Grounded against the score-api checkout 2026-06-01 (OQ-2 resolved):
 *   - `~/Documents/GitHub/score-api/src/routes/identity.ts:25-37`
 *     `const resolveSchema = z.object({ wallets: z.array(z.string()
 *       .regex(/^0x[a-fA-F0-9]{40}$/)).min(1).max(100) })`
 *   - Wallet-only: there is **no** `world_slug` param (resolution is purely
 *     wallet/group-based via the `resolve_wallet_group` RPC).
 *   - Auth-gated `X-API-Key` (score-api `src/index.ts:90 v1.use("*", authMiddleware)`).
 */
export const ScoreResolveIdentityReqSchema = z.object({
  wallets: z
    .array(z.string().regex(/^0x[a-fA-F0-9]{40}$/, "0x-prefixed 20-byte hex"))
    .min(1)
    .max(100),
})
export type ScoreResolveIdentityReq = z.infer<typeof ScoreResolveIdentityReqSchema>

/**
 * One resolved per-wallet identity record returned by score-api.
 *
 * Mirrors `ResolvedIdentity` at score-api `src/types/dynamic.types.ts:94-118`.
 * `display_name` is **never null** — score-api `computeDisplayName`
 * (`src/services/identity.service.ts:68-78`) self-truncates to the wallet when
 * no onchain name exists; the identity-api facade therefore gates its `score`
 * display tier on a REAL onchain name (beraname/ens_name/twitter_handle
 * non-null), not on `display_name` presence.
 *
 * `.loose()` mirrors `ScoreGetWalletRespSchema`: required fields detect a
 * backwards-incompatible score-api change (→ parse_error → degraded), unknown
 * additions pass through. `twitter_source` is modeled as a nullable string
 * (not a strict enum) so a new source value on the score-api side does not
 * reject — the facade does not consume it.
 */
export const ResolvedIdentitySchema = z
  .object({
    wallet: z.string(),
    ens_name: z.string().nullable(),
    beraname: z.string().nullable(),
    basename: z.string().nullable(),
    twitter_handle: z.string().nullable(),
    display_name: z.string(),
    pfp_url: z.string().nullable(),
    twitter_source: z.string().nullable(),
  })
  .loose()
export type ResolvedIdentity = z.infer<typeof ResolvedIdentitySchema>

/**
 * Response body for score-api `POST /v1/identity/resolve`.
 *
 * A **KEYED MAP** `{ identities: Record<lowercased-wallet, ResolvedIdentity> }`
 * — NOT an array (score-api `src/types/dynamic.types.ts:130-132`,
 * `src/routes/identity.ts:34 return c.json({ identities })`). Every requested
 * wallet is guaranteed present (empty-name fallback,
 * `src/services/identity.service.ts:253-261`). Consumers MUST look up by the
 * lowercased wallet address.
 */
export const ScoreResolveIdentityRespSchema = z
  .object({
    identities: z.record(z.string(), ResolvedIdentitySchema),
  })
  .loose()
export type ScoreResolveIdentityResp = z.infer<typeof ScoreResolveIdentityRespSchema>
