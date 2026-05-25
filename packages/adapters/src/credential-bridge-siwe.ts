/**
 * credential-bridge-siwe.ts — SIWE credential bridge (T1.7).
 *
 * The primary live-path credential bridge per PRD G-3 + D3-reframed:
 * wallet-first auth, SIWE (EIP-4361) as the headline scheme.
 *
 * Architecture: thin wrapper around `verifySignature` from T1.6 — no new
 * signature logic. The bridge SHAPE (per-scheme abstraction with a
 * live-path flag) is what's new; the recovery primitive is unchanged.
 *
 * Live-path eligibility: `usableInLivePath: true`. SIWE is the headline
 * scheme; the route handler at /v1/auth/verify dispatches to this bridge
 * for `scheme === 'siwe'` requests.
 *
 * Why a thin wrapper rather than reimplementing recovery?
 *   - `verifySignature` is the single source of truth for EOA signature
 *     recovery in this building. Reimplementing would mean two code
 *     paths to keep in sync — every recovery hardening (e.g., future
 *     ERC-1271 dispatch) would need a duplicate patch.
 *   - The T1.6 build notes (§Signature verifier) document the recovery
 *     choice (viem `recoverMessageAddress` + strict-format pre-check +
 *     catch-all to 401 not 500). This bridge inherits that posture
 *     verbatim — bug-class equivalence with the inline T1.6 verifier.
 *
 * SIWE message structure note: the bridge does NOT re-parse the SIWE
 * message in v1. The route handler at /v1/auth/verify already cross-
 * checks the verify body's wallet against `consumed.wallet_address`
 * (the nonce-bound wallet) BEFORE calling this bridge. The SIWE
 * message's `Address:` line MUST also match that wallet — but since the
 * message is signed AS BYTES (personal_sign envelope) and the recovery
 * succeeds iff the message was signed by `expectedAddress`, a wallet
 * that signed a SIWE message with a DIFFERENT `Address:` line would
 * fail recovery against the expected address. So the cross-check is
 * already enforced transitively. Adding an explicit re-parse is a
 * defense-in-depth nice-to-have, deferred to a follow-up.
 *
 * Why the deferral is safe:
 *   - The verbatim message comes from `consumed.message` (the nonce row,
 *     which the building itself constructed). The bridge receives the
 *     SAME message string that was signed — no caller can swap a
 *     different message in.
 *   - Recovery binds (message, signature, recoveredAddress) cryptographically.
 *   - The wallet-mismatch check at the route layer covers the only
 *     attack surface (a stolen nonce being verified under a different
 *     wallet's signature).
 *
 * Discipline (auth-highest-scrutiny):
 *   - Bridge NEVER emits audit events. The route handler owns audit
 *     emission (preserves the T1.6 single-source-of-emission invariant).
 *   - Bridge NEVER throws on caller input. All attacker-controlled-input
 *     failures map to `{ok: false}` so the route returns 401 (not 500).
 *   - Bridge returns `scheme_mismatch` reason if invoked with a non-SIWE
 *     payload — defense-in-depth; the type system should catch this
 *     first via the discriminated `VerifyInput`.
 */

import type {
  CredentialBridge,
  VerifyInput,
  VerifyResult,
} from "./credential-bridge"
import { verifySignature } from "./wallet-signature"

// ─── implementation ────────────────────────────────────────────────────────

/**
 * The SIWE bridge — a singleton (stateless; no per-instance config).
 *
 * Exposed as a `const` rather than a class because:
 *   - Stateless: nothing to construct.
 *   - Singletons keep registry construction trivial in the route handler
 *     (no `new SiweCredentialBridge()` boilerplate).
 *   - Future bridges that need config (e.g., an ERC-1271 bridge that
 *     needs an RPC URL) can become factory-functions returning a bridge
 *     object — same interface shape, different construction strategy.
 */
export const siweCredentialBridge: CredentialBridge = {
  scheme: "siwe",
  usableInLivePath: true,

  async verify(input: VerifyInput): Promise<VerifyResult> {
    // Type-narrow on the discriminator. The route handler shouldn't be
    // routing a non-SIWE payload to us, but defense-in-depth: refuse
    // explicitly rather than misinterpret the input shape.
    if (input.scheme !== "siwe") {
      return { ok: false, reason: "scheme_mismatch" }
    }

    // Delegate to the T1.6 recovery primitive. It returns:
    //   { ok: true, recoveredAddress }
    //   { ok: false, reason: 'malformed_signature' | 'signature_mismatch' | 'recover_error' }
    //
    // All three rejection reasons are members of VerifyRejectionReason,
    // so the map-through is a width subtype assignment with no
    // information loss.
    const result = await verifySignature({
      scheme: "siwe",
      message: input.message,
      signature: input.signature,
      expectedAddress: input.expectedAddress,
    })

    if (!result.ok) {
      return { ok: false, reason: result.reason }
    }

    // Successful SIWE recovery → return the wallet (lowercased to match
    // the spine's storage normalization at resolveByWallet).
    //
    // No `linkedAccount` is returned — SIWE proves possession of the EOA
    // and that IS the credential (wallet-first). There's no additional
    // external_id to mint into linked_accounts; that's the Dynamic
    // backfill bridge's territory (FR-A4).
    return {
      ok: true,
      walletAddress: result.recoveredAddress.toLowerCase(),
    }
  },
}
