/**
 * credential-bridge-dynamic.ts — Dynamic backfill credential bridge (T1.7).
 *
 * BACKFILL-ONLY BRIDGE. NOT REACHABLE FROM THE LIVE AUTH PATH.
 *
 * Per PRD §3 D3-reframed + §4.3 FR-A4: "Drop Dynamic as the credential
 * source; SIWE-direct becomes primary. The identity layer (resolve →
 * canonical user → claims) is unchanged. `dynamic_user_id` survives only
 * as a backfill credential in `linked_accounts`."
 *
 * This bridge is consumed by the T4.4 one-time backfill migration that
 * walks mibera-db's `dynamic_users` / `midi_profiles` tables and lands
 * each `(dynamic_user_id, wallet_address)` pair into the identity-api
 * spine as:
 *   - a `users` row (if the wallet isn't already known)
 *   - a `wallet_links` row binding the wallet to that user
 *   - a `linked_accounts` row with provider='dynamic_user_id' and
 *     external_id = the verbatim dynamic_user_id string
 *
 * Crucial discipline — NO `@dynamic-labs/*` IMPORT IN THIS FILE:
 *
 *   The bridge processes ALREADY-EXTRACTED dynamic_user_id strings from
 *   a trusted backfill source row. It does NOT call Dynamic's SDK to
 *   validate live sessions, look up users, or perform any network I/O
 *   against Dynamic's services. The backfill source row IS the trust
 *   attestation — the migration runbook is what authorizes that the
 *   (dynamic_user_id, wallet) pair is correct.
 *
 *   This is enforced by `scripts/check-dynamic-quarantine.sh` which
 *   greps for `@dynamic-labs` in live-path source files AND in this
 *   bridge itself. If you find yourself wanting to add the SDK here,
 *   stop and reconsider — the bridge is a data shape, not a Dynamic
 *   client. Live-session validation against Dynamic is by definition
 *   OUT OF SCOPE because the live auth path uses SIWE, not Dynamic.
 *
 * Live-path eligibility: `usableInLivePath: false`. The route handler
 * at /v1/auth/verify MUST check this BEFORE invoking the bridge and
 * return 401 `scheme_not_allowed_in_live_path` instantly. The bridge
 * DEFENSIVELY still works if invoked (the T4.4 migration calls it
 * directly, not via the route), but the live path can never reach it.
 *
 * Input contract (T4.4 → this bridge):
 *   - `dynamicUserId`: opaque string from `dynamic_users.dynamic_user_id`
 *     or `midi_profiles.dynamic_user_id`. Validated as non-empty string
 *     ≤256 chars; no further shape constraints (Dynamic's own format
 *     can vary across product versions, and we accept whatever the
 *     backfill source has).
 *   - `walletAddress`: 0x-prefixed 20-byte hex. Comes from the same
 *     backfill row's wallet_address column.
 *
 * Output contract:
 *   - On success: `{ok: true, walletAddress, linkedAccount: {
 *       provider: 'dynamic_user_id', externalId: <the input>
 *     }}`. The walletAddress is lowercased to match spine normalization.
 *   - On rejection: `{ok: false, reason}` with a reason from
 *     `VerifyRejectionReason`. Only basic shape validation can fail
 *     here — there's no crypto to verify.
 */

import type {
  CredentialBridge,
  VerifyInput,
  VerifyResult,
} from "./credential-bridge"

// ─── shape constants ───────────────────────────────────────────────────────

/**
 * Maximum byte-length for a `dynamic_user_id` we'll accept. Dynamic's
 * documented ID format is a UUID-shaped string, but we keep a generous
 * upper bound so historical / legacy formats backfill cleanly. The
 * spine column (`linked_accounts.external_id`) is TEXT — no DB-side
 * length constraint forces this; the cap is a sanity guard.
 */
const MAX_DYNAMIC_USER_ID_LEN = 256

/** 0x-prefixed 20-byte hex (40 hex chars). */
const WALLET_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/

// ─── implementation ────────────────────────────────────────────────────────

export const dynamicCredentialBridge: CredentialBridge = {
  scheme: "dynamic_user_id",

  // ── THE LOAD-BEARING LINE ──────────────────────────────────────────────
  // BACKFILL ONLY. /v1/auth/verify will 401 instantly on any request
  // routed to this bridge — the live auth path can never reach the
  // verify() call below. T4.4 (midi_profiles backfill migration) is
  // the sole consumer.
  usableInLivePath: false,

  async verify(input: VerifyInput): Promise<VerifyResult> {
    // Defense-in-depth scheme narrow. Per the type system, the route
    // handler should never route a non-dynamic payload here, but the
    // runtime guard prevents misroute bugs from corrupting the spine
    // with garbage linked_accounts rows.
    if (input.scheme !== "dynamic_user_id") {
      return { ok: false, reason: "scheme_mismatch" }
    }

    // ── input validation ───────────────────────────────────────────────
    // Both inputs are caller-trusted (the backfill source attests
    // their correctness), but we shape-check defensively so a malformed
    // row in the backfill source doesn't corrupt the spine.

    const dynamicUserId = input.dynamicUserId
    if (
      typeof dynamicUserId !== "string" ||
      dynamicUserId.length === 0 ||
      dynamicUserId.length > MAX_DYNAMIC_USER_ID_LEN
    ) {
      return { ok: false, reason: "invalid_dynamic_user_id" }
    }

    const walletAddress = input.walletAddress
    if (typeof walletAddress !== "string" || !WALLET_ADDRESS_RE.test(walletAddress)) {
      return { ok: false, reason: "invalid_wallet_address" }
    }

    // ── success ────────────────────────────────────────────────────────
    // Return the (lowercased) wallet + a linkedAccount payload for the
    // backfill migration to mint into linked_accounts. Provider is the
    // canonical PRD §4 string 'dynamic_user_id' (matches the existing
    // `linked_accounts.provider` enum extension).
    return {
      ok: true,
      walletAddress: walletAddress.toLowerCase(),
      linkedAccount: {
        provider: "dynamic_user_id",
        externalId: dynamicUserId,
      },
    }
  },
}
