/**
 * ScorePort — federation client interface for the score-api building (T2.1).
 *
 * Per PRD v3.0 §4.5 (FR-P1..P4) + SDD §5.4: identity-api stores ZERO numeric
 * scores in its spine. The `/v1/profile` read-time compose (T2.3) fans out
 * to the score-api building, which OWNS the V8 scoring formula + factor
 * breakdowns + tier surfaces (Mibera-themed). This port is the dependency-
 * inverted seam through which T2.2's compose orchestrator reaches score-api.
 *
 * Read-only by contract: identity-api NEVER writes scoring data. Scores
 * are computed upstream (Trigger.dev cloud jobs + Supabase materialized
 * views per score-api/README.md); we federate-read at compose time.
 *
 * Wire shape: see `@freeside-auth/protocol/api/federation/score.ts` (sealed)
 * and the matching `score.schema.json` (JSON Schema sibling).
 *
 * Adapter:
 *   - `HttpScoreAdapter` (T2.1 · @freeside-auth/adapters) — HTTP client
 *      that calls `GET /v1/wallets/:address`. Default baseUrl
 *      `https://score.0xhoneyjar.xyz` (per registry.yaml) overridable via
 *      env `SCORE_API_URL`. Authentication via the `X-API-Key` header
 *      (env `SCORE_API_KEY`); score-api's authMiddleware gates `/v1/*`.
 *
 * Test seam:
 *   - `MockScorePort` (T2.1 · @freeside-auth/adapters/__tests__) — in-
 *     process fixture-backed implementation for the T2.2 compose tests.
 *
 * Source: PRD v3.0 §4.5 + §10 (deps), SDD §5.4 + §6, registry.yaml,
 * `~/Documents/GitHub/score-api/src/routes/wallets.ts`.
 */

import type {
  ScoreGetWalletResp,
  ScoreResolveIdentityResp,
} from "@freeside-auth/protocol/api/federation/score"
import type { FederationResult } from "./federation-result"
import type { PortCallOpts } from "./port-opts"

// ─── input shape ───────────────────────────────────────────────────────────

/**
 * Input to `getScore`. Wallet address is 0x-prefixed 40-char hex (EVM).
 * Caller (T2.2 compose) is responsible for normalizing — score-api accepts
 * mixed case but stores lowercase in its internal queries.
 */
export interface ScoreGetScoreInput {
  /** 0x-prefixed 40-char EVM wallet address. */
  readonly walletAddress: string
}

/**
 * Input to `resolveIdentity` — a BATCH of wallet addresses (≤100). score-api
 * keys its response map by the LOWERCASED wallet; the caller is responsible
 * for normalizing before the call and for the lowercased lookup after.
 */
export interface ScoreResolveIdentityInput {
  /** 1..100 wallet addresses (0x-prefixed 40-char EVM). */
  readonly wallets: readonly string[]
}

// ─── port ──────────────────────────────────────────────────────────────────

/**
 * The score-api federation client port.
 *
 * One method today (`getScore`); future expansion (factor breakdowns,
 * leaderboard rank context, etc.) would add methods here. T2.2's compose
 * orchestrator calls only `getScore` for the `/v1/profile` shape; downstream
 * world-specific resolvers (T3+) may call additional surfaces.
 */
export interface ScorePort {
  /**
   * Resolve a wallet's score profile (V8 scoring: per-dimension + tiers +
   * percentiles + badges).
   *
   * Returns `ScoreGetWalletResp` on success (matches the sealed wire schema),
   * or a `FederationFailure` on any error.
   *
   * Per T2.2's compose contract: failures DO NOT throw — they return as
   * `{ ok: false, reason }` so the fan-out can continue without try/catch.
   * The compose layer aggregates failures into the response's `degraded[]`
   * array; identity-api's `/v1/profile` stays 200 OK even when the
   * score federation source missed.
   *
   * Per FR-P2: callers should pass `opts.signal` so a slow upstream cannot
   * tax the overall latency budget. The adapter forwards the signal to
   * `fetch`; abort → `{ ok: false, reason: { kind: 'timeout', ... } }`.
   *
   * 404 contract: score-api returns 404 when a wallet has no scoring data
   * yet (no on-chain history that triggered indexing). The adapter MUST
   * classify this as `{ ok: false, reason: { kind: 'not_found', ... } }`
   * — NOT as a 200 with a null-filled profile (that would erase the signal
   * for T2.2's degraded-handling). Whether T2.2 surfaces it as `degraded[]`
   * vs an empty `score:` block is the compose layer's decision; the port's
   * contract is faithful classification.
   */
  getScore(
    input: ScoreGetScoreInput,
    opts?: PortCallOpts,
  ): Promise<FederationResult<ScoreGetWalletResp>>

  /**
   * Batch-resolve a set of wallets to their group-aware onchain identities
   * (display_name / beraname / ens_name / twitter_handle) via score-api's
   * `POST /v1/identity/resolve` — distinct from `getScore`'s scores-only
   * `GET /v1/wallets/:address` surface (bd-2wo.38.1).
   *
   * Returns `ScoreResolveIdentityResp` (a KEYED MAP
   * `{ identities: Record<lowercased-wallet, ResolvedIdentity> }`) on success,
   * or a `FederationFailure` on any error.
   *
   * Same never-throws contract as `getScore`: failures DO NOT throw — they
   * return as `{ ok: false, reason }` so the `/v1/identity/resolve` merge
   * facade can mark the batch `degraded` and still answer 200. `opts.signal`
   * is forwarded to `fetch` for the per-source timeout budget; abort →
   * `{ ok: false, reason: { kind: 'timeout', ... } }`. 401 → `unauthorized`,
   * 404 → `not_found`, 429 → `rate_limited`, 5xx → `upstream_5xx`, schema
   * drift → `parse_error`.
   */
  resolveIdentity(
    input: ScoreResolveIdentityInput,
    opts?: PortCallOpts,
  ): Promise<FederationResult<ScoreResolveIdentityResp>>
}
