/**
 * credential-bridge-eip191.ts — EIP-191 credential bridge (T1.7).
 *
 * Sibling to the SIWE bridge: same uniform shape, different scheme tag.
 * EIP-191 is the plain `personal_sign` envelope used by clients that
 * don't speak SIWE — e.g., the Sietch precedent shape
 * `"identity-api login challenge: <nonce>"`.
 *
 * Architecture parity with SIWE: thin wrapper around `verifySignature`
 * (T1.6). The recovery primitive is identical for both schemes (SIWE
 * messages are signed via personal_sign — the EIP-191 envelope IS the
 * underlying signature mechanism for both). The bridge SHAPE is what
 * separates them, plus the scheme tag for audit-row precision.
 *
 * Live-path eligibility: `usableInLivePath: true`. EIP-191 is supported
 * alongside SIWE per FR-A1; the route handler at /v1/auth/verify
 * dispatches to this bridge for `scheme === 'eip191'` requests.
 *
 * Why split into a separate file rather than parameterize SIWE?
 *   - File-per-scheme makes each bridge grep-discoverable by name
 *     (`credential-bridge-<scheme>.ts` matches `CredentialScheme`).
 *   - Future scheme-specific work (e.g., a SIWE message re-parser or
 *     an EIP-191 prefix variant) lands in the right file without
 *     touching the sibling.
 *   - The quarantine script (`scripts/check-dynamic-quarantine.sh`)
 *     lists allowed live-path files by name; one file per scheme keeps
 *     the allow-list explicit and audit-friendly.
 *
 * Discipline mirrors the SIWE bridge:
 *   - Bridge NEVER emits audit events.
 *   - Bridge NEVER throws on caller input.
 *   - Bridge returns `scheme_mismatch` reason if invoked with non-EIP-191
 *     payload (defense-in-depth against caller-routing bugs).
 */

import type {
  CredentialBridge,
  VerifyInput,
  VerifyResult,
} from "./credential-bridge"
import { verifySignature } from "./wallet-signature"

// ─── implementation ────────────────────────────────────────────────────────

export const eip191CredentialBridge: CredentialBridge = {
  scheme: "eip191",
  usableInLivePath: true,

  async verify(input: VerifyInput): Promise<VerifyResult> {
    // Defense-in-depth scheme narrow.
    if (input.scheme !== "eip191") {
      return { ok: false, reason: "scheme_mismatch" }
    }

    const result = await verifySignature({
      scheme: "eip191",
      message: input.message,
      signature: input.signature,
      expectedAddress: input.expectedAddress,
    })

    if (!result.ok) {
      return { ok: false, reason: result.reason }
    }

    // Same shape as SIWE: lowercased wallet, no linkedAccount.
    return {
      ok: true,
      walletAddress: result.recoveredAddress.toLowerCase(),
    }
  },
}
