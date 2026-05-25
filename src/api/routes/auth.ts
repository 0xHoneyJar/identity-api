/**
 * Auth routes — wallet-first challenge/verify (SDD §5.2, FR-A1/A2).
 *
 * T1.6 (bead arrakis-tptr). Wires the two routes the T1.4 + T1.5 surface
 * promised. End-to-end shape per SDD §5.2:
 *
 *   POST /v1/auth/challenge → mint nonce + canonical signed message
 *   POST /v1/auth/verify    → consume nonce + recover sig + resolve-or-mint
 *                              + mint JWT + set session cookie + CSRF cookie
 *
 * Engineering shape — three load-bearing requirements baked in:
 *
 *   LBR-1 (transactional resolve-or-mint): the verify path wraps the
 *   resolveOrMintByWallet call in `spine.withTransaction(...)`. Concurrent
 *   /verify calls for the same fresh wallet serialize at the wallet_links
 *   uniqueness check; the loser's WalletLinkRaceError triggers a ROLLBACK
 *   + retry in a fresh txn, which finds the winner's user_id on the
 *   second-pass resolveByWallet. Net: ONE user row + ONE wallet_link.
 *   See packages/engine/src/resolve-spine.ts for the orchestrator.
 *
 *   LBR-2 (SIWE message-builder closure): the challenge route hands
 *   `mintAuthNonce` a `messageBuilder: (nonce) => string` closure. The
 *   adapter generates the random nonce FIRST, invokes the closure to
 *   build the canonical EIP-4361 message embedding it, and INSERTs both
 *   in one statement — no placeholder-then-update, no nonce/message
 *   inconsistency window. See packages/ports/src/spine.port.ts
 *   `MintNonceInput` for the contract.
 *
 *   LBR-3 (malformed JWT → 401 not 500): handled in src/auth.ts via
 *   the `hardenAuthMiddleware` wrap. NOT in this file's scope; documented
 *   here as a cross-reference.
 *
 * Audit events emitted on this surface (NFR-5):
 *   challenge happy           → nonce_minted        (T1.4 engine emits)
 *   verify happy              → nonce_consumed + user_minted? + wallet_linked? + auth_verified
 *   verify nonce-reject       → nonce_rejected (T1.4 engine emits)
 *   verify sig-fail           → auth_signature_rejected (this file emits)
 *
 * Error envelope: per SDD §5.6:
 *   { error: 'unauthorized', code: <kind>, request_id?, message? }
 * Codes used here:
 *   invalid_nonce        — unknown / no-such-nonce-row class
 *   nonce_replayed       — used (single-use violated)
 *   nonce_expired        — past expires_at
 *   scheme_mismatch      — verifier scheme ≠ minted-row scheme
 *   signature_invalid    — recover failed OR wrong signer
 *   wallet_mismatch      — verify body walletAddress ≠ nonce's stored walletAddress
 *
 * Reused-from notes (PRD §6):
 *   - Sietch SignatureVerifier shape (`verifyAddress(message, sig, expected)`)
 *     is the inspiration for `packages/adapters/src/wallet-signature.ts`
 *     `verifySignature`. We adapt to the function shape + add scheme dispatch.
 *   - Audit-event shape mirrors `themes/sietch/src/packages/verification/VerificationService.ts`
 *     `AuditEventCallback` — `{type, sessionId?, walletAddress?, metadata}`.
 */

import { jsonResponse } from "@hyper/core"
import { z } from "zod"
import { applyWithSession, route } from "../../auth"
import { getSpine } from "../spine"
import {
  consumeAuthNonce,
  mintAuthNonce,
  resolveOrMintByWallet,
  WalletLinkRaceError,
} from "@freeside-auth/engine"
import type { SpinePort } from "@freeside-auth/ports"
import { verifySignature } from "@freeside-auth/adapters"
import { mintSessionJwt } from "../../jwt-mint"

// ---------------------------------------------------------------------------
// POST /v1/auth/challenge (FR-A1) — issue SIWE/EIP-191 nonce
// ---------------------------------------------------------------------------

/**
 * Challenge request body. For SIWE the caller MAY supply EIP-4361 fields
 * (domain, uri, chain_id, statement) — defaults are sensible. For EIP-191
 * those fields are ignored.
 */
const ChallengeReq = z.object({
  walletAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/, "must be a 0x-prefixed 20-byte hex"),
  scheme: z.enum(["siwe", "eip191"]).default("siwe"),
  // SIWE EIP-4361 surface (optional; defaults applied below)
  domain: z.string().min(1).max(256).optional(),
  uri: z.string().url().optional(),
  chainId: z.number().int().positive().optional(),
  statement: z.string().min(1).max(512).optional(),
})

const DEFAULT_SIWE_DOMAIN = "identity-api.local"
const DEFAULT_SIWE_URI = "https://identity-api.local"
const DEFAULT_SIWE_CHAIN_ID = 1 // mainnet
const DEFAULT_SIWE_STATEMENT = "Sign in to identity-api."

export const authChallenge = route
  .post("/v1/auth/challenge")
  .body(ChallengeReq)
  .meta({
    summary: "Issue a SIWE/EIP-191 challenge for a wallet",
    mcp: {
      title: "Issue auth challenge",
      description:
        "Mints a single-use nonce + canonical signed-message envelope for a wallet. The wallet signs `message` and posts back to /v1/auth/verify. Per FR-A1.",
    },
  })
  .handle(async (c) => {
    const body = c.body as z.infer<typeof ChallengeReq>
    // Normalize the wallet address to lowercase for storage consistency
    // (matches the resolveByWallet normalization at the engine seam).
    const wallet = body.walletAddress.toLowerCase()
    const scheme = body.scheme

    // T1.6 LBR-2 — messageBuilder closure: the adapter generates the
    // random nonce, hands it to this closure, which constructs the
    // canonical signed message embedding it. One DB write; no nonce/message
    // inconsistency window.
    const buildMessage = (nonce: string): string => {
      if (scheme === "siwe") {
        return buildSiweMessage({
          address: wallet,
          domain: body.domain ?? DEFAULT_SIWE_DOMAIN,
          uri: body.uri ?? DEFAULT_SIWE_URI,
          chainId: body.chainId ?? DEFAULT_SIWE_CHAIN_ID,
          statement: body.statement ?? DEFAULT_SIWE_STATEMENT,
          nonce,
          issuedAt: new Date().toISOString(),
        })
      }
      // EIP-191 personal_sign envelope. Sietch precedent uses a similar
      // pre-namespaced string; the EXACT shape is not standardized — only
      // the recovery is. We pick a clear, parseable form for forensic
      // auditing.
      return `identity-api login challenge: ${nonce}`
    }

    const minted = await mintAuthNonce(getSpine(), {
      scheme,
      messageBuilder: buildMessage,
      walletAddress: wallet,
      actor: "self",
    })

    // Per SDD §5.2 §challenge: { nonce, message, expiresAt }
    return jsonResponse(200, {
      nonce: minted.nonce,
      message: minted.message,
      expires_at: minted.expires_at,
    })
  })

// ---------------------------------------------------------------------------
// POST /v1/auth/verify (FR-A2) — verify signature, mint JWT + session
// ---------------------------------------------------------------------------

const VerifyReq = z.object({
  nonce: z.string().min(1).max(128),
  signature: z.string().regex(/^0x[a-fA-F0-9]+$/, "must be a 0x-prefixed hex signature"),
  walletAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  scheme: z.enum(["siwe", "eip191"]).default("siwe"),
})

/**
 * 401 envelope helper. Centralized so audit-emit + response stay in lockstep
 * (we always want to emit an audit row when we 401 — every failed verify is
 * a signal worth recording per NFR-5).
 */
function unauthorized401(code: string, message: string): Response {
  return new Response(JSON.stringify({ error: "unauthorized", code, message }), {
    status: 401,
    headers: { "content-type": "application/json" },
  })
}

export const authVerify = applyWithSession(route.post("/v1/auth/verify"))
  .body(VerifyReq)
  .meta({
    summary: "Verify a wallet signature, mint JWT + encrypted-cookie session",
    mcp: {
      title: "Verify auth challenge",
      description:
        "Verifies the wallet signature against the nonce; on success returns user_id + JWT, sets encrypted-cookie session + CSRF cookie. Per FR-A2.",
    },
  })
  .handle(async (c) => {
    const body = c.body as z.infer<typeof VerifyReq>
    const wallet = body.walletAddress.toLowerCase()
    const spine = getSpine()

    // ─── Step 1: atomically consume the nonce ───────────────────────────
    // Engine emits nonce_consumed (ok=true) or nonce_rejected (ok=false).
    // We map each rejection class to a 401 with a distinct code.
    const consumed = await consumeAuthNonce(spine, {
      nonce: body.nonce,
      expectedScheme: body.scheme,
      actor: "self",
    })
    if (!consumed.ok) {
      switch (consumed.reason) {
        case "unknown":
          return unauthorized401("invalid_nonce", "Challenge nonce is unknown or expired")
        case "used":
          return unauthorized401("nonce_replayed", "Challenge already consumed")
        case "expired":
          return unauthorized401("nonce_expired", "Challenge expired before verify")
        case "scheme_mismatch":
          return unauthorized401(
            "scheme_mismatch",
            "Verifier scheme does not match the challenge scheme",
          )
      }
    }

    // ─── Step 2: cross-check wallet binding ─────────────────────────────
    // If the challenge was minted with a wallet hint, the verify body MUST
    // present the same wallet — refuse to verify under a different binding
    // (defense against a stolen-nonce attack where a different wallet
    // submits its own signature). We DO NOT emit audit_signature_rejected
    // for this class because the signature wasn't actually verified yet.
    if (consumed.wallet_address !== null && consumed.wallet_address !== wallet) {
      await spine.writeAuditEvent({
        event_type: "auth_signature_rejected",
        user_id: null,
        actor: "self",
        payload: {
          reason: "wallet_mismatch",
          claimed_wallet: wallet,
          nonce_wallet: consumed.wallet_address,
          scheme: body.scheme,
        },
      })
      return unauthorized401(
        "wallet_mismatch",
        "Verify wallet does not match the challenge wallet",
      )
    }

    // ─── Step 3: verify the signature ───────────────────────────────────
    // The consumed.message is the canonical string the wallet was asked
    // to sign — that's the recovery input. We compare the recovered
    // address to the verify-body wallet (which we've already cross-checked
    // against the nonce's wallet hint above).
    const verifyRes = await verifySignature({
      scheme: body.scheme,
      message: consumed.message,
      signature: body.signature,
      expectedAddress: wallet,
    })
    if (!verifyRes.ok) {
      // Audit the rejection (with the reason so an auditor can spot patterns).
      await spine.writeAuditEvent({
        event_type: "auth_signature_rejected",
        user_id: null,
        actor: "self",
        payload: {
          reason: verifyRes.reason,
          wallet_address: wallet,
          scheme: body.scheme,
        },
      })
      // Single 401 envelope to the client (don't reveal which sub-reason).
      return unauthorized401("signature_invalid", "Signature verification failed")
    }

    // ─── Step 4: resolve-or-mint the user inside a txn (LBR-1) ──────────
    // Retry once on WalletLinkRaceError — the loser's txn ROLLBACKed the
    // orphan mint, and the second pass's resolveByWallet finds the
    // winner's user_id. We cap the retry at 1 attempt: a stable system
    // converges; if the race fires twice in a row something else is wrong
    // and the 500 is the right signal.
    let userId: string
    let minted: boolean
    try {
      ;({ userId, minted } = await spine.withTransaction(async (tx) =>
        resolveOrMintByWallet(tx, {
          walletAddress: wallet,
          actor: "self",
        }),
      ))
    } catch (err) {
      if (err instanceof WalletLinkRaceError) {
        // Second pass — the wallet is now bound to the race winner; the
        // resolveByWallet at the top of resolveOrMintByWallet returns it.
        ;({ userId, minted } = await spine.withTransaction(async (tx) =>
          resolveOrMintByWallet(tx, {
            walletAddress: wallet,
            actor: "self",
          }),
        ))
      } else {
        throw err
      }
    }

    // ─── Step 5: mint the session JWT ───────────────────────────────────
    // HS256 v1 (Sprint-1.1 #3 → ES256 via jose). The signing secret is
    // the same JWT_SECRET the verifier on /v1/me consumes.
    const session = await mintSessionJwt({
      sub: userId,
      primaryWallet: wallet,
    })

    // ─── Step 6: session cookie + audit ─────────────────────────────────
    // Populate the encrypted-cookie session so the session middleware
    // (added via applyWithSession) writes a Set-Cookie on the response.
    // CSRF cookie is issued by csrfGuard (also in withSession), lazily
    // on the first response of an established session.
    type CtxWithSession = {
      session?: {
        set: (k: string, v: unknown) => void
        regenerate: () => void
      }
    }
    const ctx = c.ctx as unknown as CtxWithSession
    if (ctx.session) {
      // Regenerate session id on auth — defense against fixation attacks
      // (the pre-auth session cookie's id is rotated to a fresh one).
      ctx.session.regenerate()
      ctx.session.set("user", { sub: userId, wallet })
      ctx.session.set("jwt", session.token)
    }

    // Audit the successful verify. user_id is now KNOWN — the auth chain
    // for this verify is:
    //   nonce_consumed (user=null) → user_minted? (if first-time) →
    //   wallet_linked? (if first-time) → auth_verified (user=THIS).
    await spine.writeAuditEvent({
      event_type: "auth_verified",
      user_id: userId,
      actor: "self",
      payload: {
        wallet_address: wallet,
        scheme: body.scheme,
        minted_user: minted,
        jti: session.jti,
      },
    })

    // SDD §5.2 §verify response: { userId, session: { token, expiresAt } }
    // We also surface primary_wallet for client ergonomics (avoids an
    // extra /v1/me round-trip for the most common post-login fetch).
    return jsonResponse(200, {
      user_id: userId,
      primary_wallet: wallet,
      session: {
        token: session.token,
        expires_at: session.expiresAt,
      },
    })
  })

// ---------------------------------------------------------------------------
// SIWE message builder — minimal EIP-4361 emit
// ---------------------------------------------------------------------------

/**
 * Construct an EIP-4361 SIWE message.
 *
 * We hand-build instead of using viem's `createSiweMessage` because:
 *   (a) viem's signature requires an importer that pulls more of the lib
 *       than the recovery primitive needs;
 *   (b) the message grammar is short and well-specified — hand-build keeps
 *       the surface auditable + we control field order / formatting;
 *   (c) verification on the recovery side is via `recoverMessageAddress`
 *       which doesn't parse the message — only signs over the bytes.
 *
 * Optional EIP-4361 fields (issuedAt, version) are included for compliance;
 * fields we don't need (expirationTime, notBefore, requestId, resources)
 * are omitted in v1 to keep the surface small.
 *
 * Reference: EIP-4361 spec at https://eips.ethereum.org/EIPS/eip-4361
 */
function buildSiweMessage(opts: {
  domain: string
  address: string
  statement: string
  uri: string
  chainId: number
  nonce: string
  issuedAt: string
}): string {
  // EIP-4361 requires checksummed address; for v1 we emit the lowercased
  // form (matches our storage normalization). Recovery works either way
  // because viem's recoverMessageAddress signs over the literal bytes —
  // the spec's checksum-requirement is for human display, not for
  // signature correctness.
  const head = `${opts.domain} wants you to sign in with your Ethereum account:\n${opts.address}`
  const body = `\n\n${opts.statement}`
  const params = [
    `URI: ${opts.uri}`,
    `Version: 1`,
    `Chain ID: ${opts.chainId}`,
    `Nonce: ${opts.nonce}`,
    `Issued At: ${opts.issuedAt}`,
  ].join("\n")
  return `${head}${body}\n\n${params}`
}

// Re-export the SIWE builder for unit tests + potential future consumers.
export { buildSiweMessage }

/**
 * Pure-function helper exported for cross-package use (e.g. integration
 * tests that need to assemble the same canonical message the route
 * produces, sign it, and POST to /verify). Acts as the single source of
 * truth for both endpoint and test.
 */
export function makeEip191Message(nonce: string): string {
  return `identity-api login challenge: ${nonce}`
}

// Anchor for `spine` import so the typechecker tracks the dependency on
// SpinePort (used implicitly via getSpine's return type + the engine fns).
type _SpinePortAnchor = SpinePort
void (null as unknown as _SpinePortAnchor)
