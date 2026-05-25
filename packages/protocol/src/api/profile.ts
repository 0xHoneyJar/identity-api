/**
 * /v1/profile + /v1/mibera/dimensions request/response stubs (T2.3 + T3.2).
 *
 * The route handlers currently 501 — these schemas exist so the SDK can
 * expose the methods with the SAME typed surface they'll have post-T2.3 /
 * post-T3.2. Calling `client.profile.get(...)` today throws a runtime
 * IdentityApiError(501); calling it post-T2.3 returns the composed shape.
 *
 * Per FR-P3 (no-embed) the response shapes intentionally DO NOT carry
 * persisted-spine fields beyond identity — holdings/score/dimensions are
 * composed at read-time and surface as nested compose blocks. We leave
 * them loose (`z.unknown()` for the compose payloads) since the
 * downstream schemas (inventory-api, score-api, codex) are owned by
 * those buildings; the SDK author can swap in tighter types at vendor
 * time if they pull those package's protocol shapes too.
 */

import { z } from "zod"
import { UserIdParamSchema, WalletAddressParamSchema } from "./resolve"

// ─── /v1/profile (FR-P1, T2.3) ──────────────────────────────────────────────

/**
 * Query: world slug + ONE OF (userId, wallet). Validated client-side AND
 * server-side. Note: the existing route stub still declares this via
 * `.body(...)`; T1.10 doesn't move it to `.query(...)` (Hyper doesn't ship
 * that builder yet — see SDD T2.3 follow-up).
 */
export const ProfileQuerySchema = z.object({
  world: z.string().min(1),
  userId: UserIdParamSchema.optional(),
  wallet: WalletAddressParamSchema.optional(),
})
export type ProfileQuery = z.infer<typeof ProfileQuerySchema>

/**
 * Profile response shape (T2.3 will populate).
 *
 * `identity` is the spine row; `holdings`, `score`, and `content` are
 * compose payloads fanned out via per-source timeouts (FR-P2). Any source
 * that misses degrades INTO the `degraded[]` array; the response itself
 * stays a 200 (NFR-2 isolation).
 *
 * Until T2.3 ships, calling this endpoint yields IdentityApiError(501).
 */
export const ProfileRespSchema = z.object({
  identity: z.unknown(), // Identity-shaped; tightened in T2.3
  holdings: z.unknown().optional(),
  score: z.unknown().optional(),
  content: z.unknown().optional(),
  degraded: z.array(z.string()).optional(),
})
export type ProfileResp = z.infer<typeof ProfileRespSchema>

// ─── /v1/mibera/dimensions (FR-M1, G-6, T3.2) ───────────────────────────────

export const MiberaDimensionsQuerySchema = z.object({
  userId: UserIdParamSchema.optional(),
  wallet: WalletAddressParamSchema.optional(),
})
export type MiberaDimensionsQuery = z.infer<typeof MiberaDimensionsQuerySchema>

/**
 * Mibera dimensions response (T3.2 will populate the codex 7-dim shape).
 *
 * Per FR-M1: per-token 7-dim profile + grail. Until T3.2 lands the
 * response is intentionally `z.unknown()`-bodied so consumers can call
 * the method but get a runtime 501 with the typed error envelope.
 */
export const MiberaDimensionsRespSchema = z.object({
  user_id: z.string().uuid().optional(),
  primary_wallet: z.string().optional(),
  tokens: z.array(z.unknown()).optional(),
  degraded: z.array(z.string()).optional(),
})
export type MiberaDimensionsResp = z.infer<typeof MiberaDimensionsRespSchema>
