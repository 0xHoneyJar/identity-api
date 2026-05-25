/**
 * /v1/auth/* request + response Zod schemas — shared between the server
 * routes and the typed SDK (Pattern B from T1.10 build notes).
 *
 * Why this lives in the protocol package, not in `src/api/routes/`:
 *
 *   The SDK at `packages/sdk` is vendored AS-SOURCE into downstream
 *   consumers (honey-road, Sietch, future worlds — per PRD v3.0 §11
 *   post-verify lock-ins). The consumer's `tsc` must produce full
 *   request/response typing on every `client.auth.challenge(...)` call
 *   without depending on the server runtime tree (which imports Hyper +
 *   spine adapters + engine — much heavier than a consumer should pull).
 *
 *   The protocol package, by design, contains ONLY sealed wire-format
 *   schemas — no runtime deps beyond Zod (already a peer of every
 *   freeside-auth consumer). Hoisting the request/response shapes here
 *   gives the SDK a single, narrow, vendoring-friendly import surface.
 *
 * Server-side: src/api/routes/auth.ts imports {ChallengeReqSchema,
 * VerifyReqSchema} from here and passes them to Hyper's `.body(...)` call.
 * The runtime Zod validator on the server is THE SAME object the SDK uses
 * for client-side type derivation — single source of truth.
 *
 * Backwards-compat: the local Zod schemas previously inlined at routes/auth.ts
 * are re-exported from here verbatim; the routes file now imports them.
 *
 * Naming: the `*Req`/`*Resp` suffix marks request/response variants. We
 * keep field names snake_case for response shapes (matches the on-wire
 * envelopes the route handlers emit via jsonResponse(...)). Request bodies
 * use camelCase (matches the existing route Zod definitions). Mixing is
 * intentional: requests are TS-author-facing, responses are wire-shaped.
 */

import { z } from "zod"

// ─── POST /v1/auth/challenge (FR-A1) ────────────────────────────────────────

/**
 * Challenge request body.
 *
 * For SIWE the caller MAY supply EIP-4361 fields (domain, uri, chainId,
 * statement) — defaults are sensible. For EIP-191 those fields are ignored.
 */
export const ChallengeReqSchema = z.object({
  walletAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/, "must be a 0x-prefixed 20-byte hex"),
  scheme: z.enum(["siwe", "eip191"]).default("siwe"),
  // SIWE EIP-4361 surface (optional; defaults applied by the server)
  domain: z.string().min(1).max(256).optional(),
  uri: z.string().url().optional(),
  chainId: z.number().int().positive().optional(),
  statement: z.string().min(1).max(512).optional(),
})

export type ChallengeReq = z.infer<typeof ChallengeReqSchema>

/**
 * Challenge response — the caller signs `message` with the wallet's
 * credential and POSTs `{nonce, signature, walletAddress, scheme}` back
 * to /v1/auth/verify. `expires_at` is ISO-8601 UTC, server-authoritative.
 */
export const ChallengeRespSchema = z.object({
  nonce: z.string().min(1),
  message: z.string().min(1),
  expires_at: z.string().datetime(),
})

export type ChallengeResp = z.infer<typeof ChallengeRespSchema>

// ─── POST /v1/auth/verify (FR-A2) ───────────────────────────────────────────

/**
 * Verify request body.
 *
 * `scheme` admits ONLY siwe|eip191 at the Zod boundary — the dynamic
 * credential bridge is BACKFILL-ONLY and structurally inaccessible from
 * this surface (per FR-A4 enforcement). Adding a new scheme requires
 * coordinated review against the live-path bridge registry.
 */
export const VerifyReqSchema = z.object({
  nonce: z.string().min(1).max(128),
  signature: z.string().regex(/^0x[a-fA-F0-9]+$/, "must be a 0x-prefixed hex signature"),
  walletAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  scheme: z.enum(["siwe", "eip191"]).default("siwe"),
})

export type VerifyReq = z.infer<typeof VerifyReqSchema>

/**
 * Verify response — the canonical user_id + session JWT.
 *
 * Side-effects on the wire (not in this schema): Set-Cookie headers for
 * the encrypted session (`idapi_sess=…; HttpOnly; SameSite=Lax; Secure`)
 * and the CSRF double-submit cookie (`csrf=…; SameSite=Lax; Secure`).
 * Consumers using cookie-based auth should let their HTTP client jar
 * absorb these automatically; consumers using bearer-token auth can
 * ignore them.
 *
 * `session.expires_at` is unix seconds (matches the JWT `exp` claim).
 * `primary_wallet` mirrors the auth-time wallet — useful so a typical
 * post-login client avoids an immediate /v1/me round-trip just to learn
 * the wallet it already presented.
 */
export const VerifyRespSchema = z.object({
  user_id: z.string().uuid(),
  primary_wallet: z.string(),
  session: z.object({
    token: z.string().min(1),
    expires_at: z.number().int(),
  }),
})

export type VerifyResp = z.infer<typeof VerifyRespSchema>
