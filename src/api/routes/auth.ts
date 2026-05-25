/**
 * Auth routes — wallet-first challenge/verify (SDD §5.2, FR-A1/A2).
 *
 * STUB: T1.1 stands these up with Zod request schemas wired so OpenAPI emit
 * + future typed-client codegen carry the shape from day one. Real impl
 * (nonce insert, SignatureVerifier dispatch, JWT mint, audit emit) lands
 * in T1.6 (bead arrakis-tptr).
 *
 * Notes:
 *   - Uses `withSession()` to bundle session + csrfGuard (L5 fix).
 *   - `.body(Schema)` is the load-bearing one-def claim — Hyper derives
 *     runtime validation, OpenAPI 3.1 fragment, typed-client method, and
 *     (when meta.mcp set) MCP tool, ALL from this single declaration.
 */

import { jsonResponse } from "@hyper/core"
import { z } from "zod"
import { applyWithSession, route } from "../../auth"

const NOT_IMPL_T1_6 = { error: "not_implemented", task: "T1.6", bead: "arrakis-tptr" } as const

// ---------------------------------------------------------------------------
// POST /v1/auth/challenge (FR-A1) — issue SIWE/EIP-191 nonce
// ---------------------------------------------------------------------------
const ChallengeReq = z.object({
  walletAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/, "must be a 0x-prefixed 20-byte hex"),
  scheme: z.enum(["siwe", "eip191"]).default("siwe"),
})

export const authChallenge = route
  .post("/v1/auth/challenge")
  .body(ChallengeReq)
  .meta({
    summary: "Issue a SIWE/EIP-191 challenge for a wallet",
    mcp: {
      title: "Issue auth challenge",
      description:
        "Mints a single-use nonce + signed-message envelope for a wallet. The wallet signs `message` and posts back to /v1/auth/verify. Per FR-A1.",
    },
  })
  .handle(() => jsonResponse(501, NOT_IMPL_T1_6))

// ---------------------------------------------------------------------------
// POST /v1/auth/verify (FR-A2) — verify signature, mint JWT + session
// ---------------------------------------------------------------------------
const VerifyReq = z.object({
  nonce: z.string().min(1),
  signature: z.string().regex(/^0x[a-fA-F0-9]+$/, "must be a 0x-prefixed hex signature"),
  walletAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
})

export const authVerify = applyWithSession(route.post("/v1/auth/verify"))
  .body(VerifyReq)
  .meta({
    summary: "Verify a wallet signature, mint JWT + encrypted-cookie session",
    mcp: {
      title: "Verify auth challenge",
      description:
        "Verifies the wallet signature against the nonce; on success returns a user_id and issues a JWT + encrypted-cookie session. Per FR-A2.",
    },
  })
  .handle(() => jsonResponse(501, NOT_IMPL_T1_6))
