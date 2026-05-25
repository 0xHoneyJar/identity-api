/**
 * wallet-signature.ts — wallet-signature verification primitive (T1.6).
 *
 * The /v1/auth/verify route's load-bearing crypto step: given a wallet
 * address, a signed message, and a hex signature, return TRUE iff the
 * signature recovers to the expected address under the named scheme.
 *
 * Adapter choice — `viem` (recommended in the T1.6 brief):
 *
 *   Sietch's existing `SignatureVerifier`
 *   (`loa-freeside/themes/sietch/src/packages/verification/SignatureVerifier.ts`)
 *   already uses viem's `recoverMessageAddress` for EIP-191. We use the same
 *   underlying primitive here. SIWE messages, despite their EIP-4361 structure,
 *   are SIGNED via `personal_sign` (EIP-191 envelope) — so the SAME recover
 *   primitive works for both schemes when given the canonical signed string.
 *
 *   Trade-off accepted: a new direct dep (`viem`) in identity-api root, ~50kb
 *   gzip. Reasoning: viem is the modern, well-audited Ethereum lib (Sietch,
 *   honey-road, score-api all use it); writing a hand-rolled secp256k1
 *   recoverer would mean owning ecrecover, the Keccak digest, the EIP-191
 *   prefix, and signature-format normalization. The vendored-source / no-npm
 *   discipline applies to EXTERNAL consumers of identity-api (per PRD §4.3
 *   "consumed as source-distributed"), NOT to internal infrastructure deps.
 *
 *   Pin: `viem ^2.43.4` (installed: 2.50.4).
 *
 * Reuse-from-Sietch note: the Sietch `SignatureVerifier` class is the
 * inspiration for `verifySignature` — same primitive (`recoverMessageAddress`),
 * same case-insensitive address comparison, same length+hex format check.
 * We don't import Sietch's class because (a) it's not exported as a workspace
 * package, (b) we want a function rather than a class for ergonomic test
 * coverage, and (c) we want the SIWE/EIP-191 scheme dispatch baked in.
 *
 * SECURITY NOTES (auth-highest-scrutiny):
 *   - We DO NOT trust the caller's `expectedAddress` value as a substitute
 *     for recovery. We recover the signer from the signature + message FIRST,
 *     then compare. A bug that compared expected against itself (e.g.,
 *     `return expectedAddress === expectedAddress`) would let any signature
 *     authenticate any address — defense-in-depth via the recovery-first
 *     ordering prevents that class of mistake.
 *   - Comparison is case-insensitive: EIP-55 checksum vs all-lowercase forms
 *     of the same address must both succeed. Both sides are lowercased before
 *     the equality check.
 *   - We do NOT verify ERC-1271 (contract-wallet) signatures in v1. Pure EOA
 *     `personal_sign` only. A contract-wallet user attempting to sign in via
 *     SIWE will fail recovery (an account-abstraction wallet's `signMessage`
 *     hashes/wraps differently and requires `isValidSignature` ABI dispatch
 *     against the wallet contract). Adding 1271 is a Sprint-1.x follow-up.
 *   - `viem`'s `recoverMessageAddress` throws on malformed signatures (wrong
 *     length, non-hex, invalid recovery id). We CATCH and return false so the
 *     route handler returns 401 (NOT 500) on attacker-controlled garbage —
 *     consistent with the L7 / LBR-3 posture in src/auth.ts.
 */

import { recoverMessageAddress, type Hex } from "viem"

// ─── types ─────────────────────────────────────────────────────────────────

/**
 * Signature scheme. Mirrors `SpineNonceScheme` from @freeside-auth/ports
 * but defined locally so this primitive has no upward dependency on the
 * port package (avoids a circular workspace edge).
 *
 *   - `siwe`   — EIP-4361 message signed via personal_sign (EIP-191 envelope).
 *                Recovery uses the same `recoverMessageAddress`.
 *   - `eip191` — Plain personal_sign of an arbitrary string. Recovery
 *                applies the EIP-191 prefix `"\x19Ethereum Signed Message:\n"`.
 */
export type SignatureScheme = "siwe" | "eip191"

/**
 * Verify a wallet signature: does the signature, when recovered against the
 * message under the named scheme, match the expected address?
 *
 * Return shape: a discriminated `{ ok: true | false }`. On false, includes
 * a `reason` so the route handler can emit a precise audit row payload —
 * BUT note: the route layer's response envelope to the client is the SAME
 * for every false reason ("invalid signature"). The reason is for the
 * audit trail + ops debugging, not for the client (revealing why a signature
 * recovery failed would leak attacker-useful information).
 *
 * @param scheme           Which signing scheme produced the signature.
 *                         SIWE messages are signed via personal_sign so
 *                         the recovery primitive is the same — but we keep
 *                         the parameter to anchor the parity at the call
 *                         site (and to leave room for ERC-1271 dispatch
 *                         in a future scheme value).
 * @param message          The exact string the wallet was asked to sign
 *                         (the verbatim `message` returned by /challenge).
 * @param signature        The hex signature (must start with `0x`, be 132
 *                         chars total = 65 bytes = r+s+v).
 * @param expectedAddress  The wallet address the verify endpoint expects
 *                         to find as the recovered signer. Compared
 *                         case-insensitively.
 */
export async function verifySignature(opts: {
  scheme: SignatureScheme
  message: string
  signature: string
  expectedAddress: string
}): Promise<
  | { ok: true; recoveredAddress: string }
  | { ok: false; reason: "malformed_signature" | "signature_mismatch" | "recover_error" }
> {
  const { scheme, message, signature, expectedAddress } = opts
  // We touch `scheme` to anchor the parameter in code; today both schemes
  // route through the same recovery (SIWE messages are signed via
  // personal_sign / EIP-191 envelope), so the dispatch is a no-op. Keeping
  // the parameter forces every call site to declare its scheme explicitly,
  // which is what the audit row + ERC-1271 follow-up will branch on.
  void scheme
  if (!isValidSignatureFormat(signature)) {
    return { ok: false, reason: "malformed_signature" }
  }
  let recovered: string
  try {
    recovered = await recoverMessageAddress({
      message,
      signature: signature as Hex,
    })
  } catch {
    // viem throws on (a) wrong-length / non-hex signatures despite our
    // format check (defense-in-depth), (b) invalid recovery-id bytes, (c)
    // unrepresentable curve points. None of these should 500 — they're all
    // attacker-controlled-input failures that map to 401 at the route.
    return { ok: false, reason: "recover_error" }
  }
  if (!addressesEqual(recovered, expectedAddress)) {
    return { ok: false, reason: "signature_mismatch" }
  }
  return { ok: true, recoveredAddress: recovered }
}

// ─── helpers ───────────────────────────────────────────────────────────────

/**
 * Strict signature format check: 0x-prefix, 132 chars total (65 bytes r+s+v),
 * hex-only. Mirrors Sietch's `SignatureVerifier.isValidSignatureFormat`.
 *
 * Exported for tests (and so a route layer running its own pre-flight check
 * uses the SAME rule the verifier enforces — single source of truth).
 */
export function isValidSignatureFormat(signature: string): boolean {
  if (typeof signature !== "string") return false
  if (!signature.startsWith("0x")) return false
  if (signature.length !== 132) return false
  const hex = signature.slice(2)
  return /^[0-9a-fA-F]+$/.test(hex)
}

/**
 * Address equality, case-insensitive. Both sides MUST be syntactically valid
 * Ethereum addresses (0x + 40 hex). On any malformed input → false (defaults
 * to safe-deny rather than throw).
 */
export function addressesEqual(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false
  const aOk = /^0x[a-fA-F0-9]{40}$/.test(a)
  const bOk = /^0x[a-fA-F0-9]{40}$/.test(b)
  if (!aOk || !bOk) return false
  return a.toLowerCase() === b.toLowerCase()
}
