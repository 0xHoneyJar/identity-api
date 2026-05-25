/**
 * POST /v1/link/verified-wallet — cycle-c redirect ingress (T4.1 / FR-C1).
 *
 * Service-to-service write — auth via `X-Service-Token` header (NOT a user
 * session). The SDK exposes a per-call `serviceToken` for callers; production
 * sets `LINK_SERVICE_TOKEN` env on identity-api side.
 *
 * Conflict policy is server-side per SDD §8.2 / D8 / cycle-c FR-L3:
 *   - both null                          → create user + link both
 *   - same user (idempotent)             → no-op
 *   - discord exists, wallet null        → link wallet to discord-user (latest-wins)
 *   - wallet exists, discord null        → link discord to wallet-user (latest-wins)
 *   - both exist, different users        → HARD FAIL cross_user_collision (409)
 *
 * OQ-2 seam: the resolver is injectable (`compose-link-verified-wallet.ts`
 * `ConflictResolver`). Swapping policy is a single-function-pointer change.
 */

import { z } from "zod"

export const LinkVerifiedWalletReqSchema = z.object({
  worldSlug: z.string().regex(/^[a-z0-9-]+$/),
  discordId: z.string().min(1),
  walletAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  dynamicUserId: z.string().min(1).optional(),
})
export type LinkVerifiedWalletReq = z.infer<typeof LinkVerifiedWalletReqSchema>

/**
 * 200 OK response — the successful link outcome.
 *
 * `conflict_resolved` is populated when the orchestrator applied a
 * latest-wins update (e.g., same-discord/new-wallet → wallet rebound).
 * `idempotent` is true when the request was a no-op (both inputs already
 * resolved to the same user).
 */
export const LinkVerifiedWalletRespSchema = z.object({
  ok: z.literal(true),
  user_id: z.string().uuid(),
  wallet_address: z.string(),
  idempotent: z.boolean(),
  conflict_resolved: z
    .enum(["wallet_rebound", "discord_rebound"])
    .nullable()
    .optional(),
})
export type LinkVerifiedWalletResp = z.infer<typeof LinkVerifiedWalletRespSchema>

/**
 * 409 conflict response — cross_user_collision is the only hard-fail.
 *
 * Returned when the wallet is already claimed by user A and the discord
 * by user B (A ≠ B). The route maps the engine's `ConflictDecision.collision`
 * decision to this shape. Audit `conflict_rejected` is emitted server-side
 * regardless of whether the caller catches the 409.
 */
export const LinkVerifiedWalletConflictSchema = z.object({
  ok: z.literal(false),
  conflict: z.literal("cross_user_collision"),
  message: z.string(),
})
export type LinkVerifiedWalletConflict = z.infer<typeof LinkVerifiedWalletConflictSchema>
