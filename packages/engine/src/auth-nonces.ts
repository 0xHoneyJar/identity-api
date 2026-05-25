/**
 * auth-nonces.ts — engine-layer orchestrators for FR-A1 nonce lifecycle (T1.4).
 *
 * Mirrors the resolve-spine.ts shape: thin functions that take a `SpinePort`
 * (the dependency-inverted interface, NOT the concrete adapter) and pair the
 * port call with the NFR-5 audit emit. T1.6's /v1/auth/challenge and
 * /v1/auth/verify handlers import from here, NOT from the adapter directly,
 * so the engine seam stays the single point of audit policy.
 *
 * Audit policy (T1.4 contract for T1.6 to honor):
 *   - mintAuthNonce      → emits 'nonce_minted' on success (one row).
 *   - consumeAuthNonce   → emits 'nonce_consumed' on ok=true, OR
 *                          emits 'nonce_rejected' (with the reason in payload)
 *                          on ok=false. Exactly one audit row per call;
 *                          the reject row is the trail of failed attempts
 *                          per SDD §3.2 audit_events shape ("audit on every
 *                          link/unlink/primary-change/conflict" + the auth
 *                          flow's reject classes are conflict-class events).
 *
 * Why an engine layer (vs T1.6 calling the adapter directly):
 *   - T1.6 should not have two places to remember to emit audit events;
 *     the engine pairing is the single contract.
 *   - The mintAuthNonce return type (just the row data) is what T1.6's
 *     route handler wants verbatim; no orchestration logic is needed at the
 *     route layer for the happy path.
 *   - SDD §1.4 "Auth core" is described as engine-owned; adapter is L4 I/O.
 *
 * Source: PRD v3.0 §4.3 (FR-A1), SDD §2.2 (lifecycle) + §3.2 (audit_events
 * append) + §5.2 (endpoint detail) + §8.2 (conflict policy precedent for
 * audit-on-reject), T1.5 resolve-spine.ts (the canonical engine pattern).
 */

import type {
  SpinePort,
  SpineNonceScheme,
  MintNonceResult,
  ConsumeNonceResult,
} from "@freeside-auth/ports"
import type { AuditActor } from "./resolve-spine"

// ─── inputs ────────────────────────────────────────────────────────────────

/**
 * Mint input — the message the wallet will sign is the caller's
 * responsibility to build (SIWE builder in T1.6 for the EIP-4361 path;
 * EIP-191 builder for the legacy path). The engine layer doesn't choose
 * scheme or compose message text — it just persists what the caller hands
 * over and audits the mint.
 */
export interface MintAuthNonceOpts {
  readonly scheme: SpineNonceScheme
  readonly message: string
  /** Optional wallet hint stored on the row (NULLable per SDD §3.2). */
  readonly walletAddress?: string | null
  /** Override default 300s only when test/operator requires. */
  readonly ttlSec?: number
  /** Audit actor for the nonce_minted event (defaults to 'system'). */
  readonly actor?: AuditActor
}

/** Consume input — the verifier brings the nonce + the scheme it used. */
export interface ConsumeAuthNonceOpts {
  readonly nonce: string
  readonly expectedScheme: SpineNonceScheme
  /** Audit actor for the nonce_consumed / nonce_rejected event. */
  readonly actor?: AuditActor
}

// ─── orchestrators ─────────────────────────────────────────────────────────

/**
 * Mint a nonce + emit `nonce_minted` audit row.
 *
 * The audit row's payload contains the scheme + the (optional) wallet hint
 * + the absolute expiry. It does NOT contain the message text (potentially
 * long, low information value in the audit log) — callers debugging a
 * specific nonce can join on `auth_nonces.nonce` via the row id.
 *
 * Return shape is the verbatim adapter `MintNonceResult` so T1.6's route
 * handler can pass it straight to the response builder.
 */
export async function mintAuthNonce(
  spine: SpinePort,
  opts: MintAuthNonceOpts,
): Promise<MintNonceResult> {
  const result = await spine.mintNonce({
    scheme: opts.scheme,
    message: opts.message,
    walletAddress: opts.walletAddress ?? null,
    ttlSec: opts.ttlSec,
  })
  await spine.writeAuditEvent({
    event_type: "nonce_minted",
    // user_id intentionally null: pre-resolution flow; we don't know who
    // owns the wallet yet (and may never — challenge can be abandoned).
    user_id: null,
    actor: opts.actor ?? "system",
    payload: {
      scheme: opts.scheme,
      wallet_address: opts.walletAddress ?? null,
      expires_at: result.expires_at,
    },
  })
  return result
}

/**
 * Atomically consume a nonce + emit the right audit event.
 *
 * On success: `nonce_consumed` (the auth challenge was redeemed successfully).
 * On rejection: `nonce_rejected` with `reason` in payload so an auditor can
 * count rejection rates per class — useful for spotting replay or guessing
 * attacks (a spike in `unknown` reasons across a short window is a signal).
 *
 * Audit is always emitted (success OR reject), per NFR-5 "audit on every
 * link/unlink/primary-change/conflict" — the verify-attempt is conflict-class
 * for the auth surface.
 *
 * Returns the adapter's discriminated `ConsumeNonceResult` verbatim. T1.6's
 * /v1/auth/verify maps each rejection reason to the SDD §5.6 error envelope:
 *
 *   - unknown          → 401 CHALLENGE_EXPIRED (treated as missing; the
 *                        verifier should re-issue)
 *   - used             → 401 CHALLENGE_USED
 *   - expired          → 401 CHALLENGE_EXPIRED
 *   - scheme_mismatch  → 401 CHALLENGE_EXPIRED (verifier confused; safest
 *                        to refuse and force re-challenge under the right
 *                        scheme rather than leak which scheme the row used)
 *
 * The 401-mapping table is T1.6's call to encode; this engine layer simply
 * delivers the discriminant.
 */
export async function consumeAuthNonce(
  spine: SpinePort,
  opts: ConsumeAuthNonceOpts,
): Promise<ConsumeNonceResult> {
  const result = await spine.consumeNonce({
    nonce: opts.nonce,
    expectedScheme: opts.expectedScheme,
  })
  const actor = opts.actor ?? "system"
  if (result.ok) {
    await spine.writeAuditEvent({
      event_type: "nonce_consumed",
      // user_id still null here — the post-consume resolveOrMintByWallet
      // step in T1.6 is what binds the wallet to a user. The audit chain
      // for the verify flow is:
      //   nonce_consumed (user_id=null) → user_minted (if new) →
      //   wallet_linked (with user_id) → session_issued (with user_id).
      user_id: null,
      actor,
      payload: {
        scheme: opts.expectedScheme,
        wallet_address: result.wallet_address,
      },
    })
  } else {
    await spine.writeAuditEvent({
      event_type: "nonce_rejected",
      user_id: null,
      actor,
      payload: {
        scheme: opts.expectedScheme,
        reason: result.reason,
      },
    })
  }
  return result
}
