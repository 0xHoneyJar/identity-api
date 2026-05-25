/**
 * POST /v1/link/verified-wallet — cycle-c redirect ingress (T4.1 / FR-C1).
 *
 * Stub today (501); the SDK exposes the typed surface for forward-compat.
 *
 * NOTE: this endpoint is service-to-service (NOT a user session). The SDK
 * surface accepts a per-call `serviceToken` (header: `X-Service-Token` by
 * default) — the exact header is TBD in Sprint-1.x. The SDK keeps the
 * surface flexible by letting callers override the header name + value at
 * client-create time.
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
 * Response shape — T4.1 lands the real envelope (linked user_id + audit
 * jti). Until then the SDK surfaces 501 via IdentityApiError; callers
 * should code the catch-block now (errors are the only response shape
 * they'll see until T4.1).
 */
export const LinkVerifiedWalletRespSchema = z.object({
  user_id: z.string().uuid().optional(),
  wallet_address: z.string().optional(),
  audit_jti: z.string().optional(),
})
export type LinkVerifiedWalletResp = z.infer<typeof LinkVerifiedWalletRespSchema>
