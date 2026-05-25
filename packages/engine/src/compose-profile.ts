/**
 * compose-profile.ts — read-time compose orchestrator for /v1/profile (T2.2).
 *
 * The brain of FR-P1 / FR-P2 / FR-P3 / D6 / D8. Takes a wallet or user_id,
 * resolves the spine identity, and fans out to the three federation ports
 * (inventory + score + codex) with per-source AbortController timeouts +
 * per-source in-memory circuit-breakers. Returns a sealed `ProfileResp`
 * with `degraded[]` populated for any source that missed.
 *
 * **Doctrine** (per CLAUDE.md + PRD §3 D6/D8 + SDD §6):
 *
 *   - **No-embed (D8 / FR-P3)**: the orchestrator ASSEMBLES live; it NEVER
 *     persists holdings / score / codex into the spine. Read-only fan-out.
 *
 *   - **Graceful degrade (NFR-2 / FR-P2)**: any downstream failing → that
 *     source omitted from the response + listed in `degraded[]`. Spine /
 *     auth still succeed. The response is ALWAYS 200; a 5xx propagates
 *     only when the spine itself fails (and the spine is the SoR — its
 *     failure is a real outage, not a graceful-degrade case).
 *
 *   - **Per-source timeouts (FR-P2 / NFR-1)** owned by THIS orchestrator,
 *     not the adapters. Per-call AbortController cleared on completion.
 *
 *   - **Promise.all, not Promise.allSettled**: T2.1's discriminated-union
 *     contract on every federation port resolves on success AND failure.
 *     allSettled would wrap each into `{status, value|reason}` and require
 *     unwrapping — pointless boilerplate given we already get
 *     `FederationResult<T>` as the awaited value. The PRD §4.5 FR-P2 text
 *     says "Promise.allSettled" — that's a vestige of the early design
 *     before the union-type contract; SDD §6.3 pseudocode shows allSettled
 *     too, but the union-result design supersedes (documented in
 *     t2.2-compose-orchestrator-notes.md).
 *
 *   - **Phase 1 / Phase 2 fan-out**: inventory + score are parallel
 *     (Promise.all — both keyed by walletAddress, no inter-dep). Codex
 *     needs the wallet's Mibera tokenIds from inventory, so it sequences
 *     after Phase 1. Per SDD §6.1 topology: `INV → CX` belt.
 *
 *   - **Audit emit (NFR-5)**: emits `profile_composed` on success;
 *     `profile_compose_degraded` when degraded[] is non-empty. The audit
 *     payload carries user_id + degraded[] + actor. No PII / wire bodies.
 *
 * Source: PRD v3.0 §4.5 (FR-P1..P4) + §3 D6/D8, SDD §6 (full compose
 * design), T2.1 build notes §6 (T2.2 integration sketch).
 */

import type {
  CodexPort,
  FederationFailure,
  FederationFailureKind,
  FederationResult,
  InventoryPort,
  ScorePort,
  SpinePort,
} from "@freeside-auth/ports"
import type {
  CodexGetMiberaBatchResp,
  IdentityResp,
  InventoryContractHolding,
  InventoryGetHoldingsResp,
  ProfileResp,
  ScoreGetWalletResp,
} from "@freeside-auth/protocol/api"
import type { AuditActor } from "./resolve-spine"
import type { CircuitBreaker } from "./circuit-breaker"
import { withTimeout } from "./with-timeout"

// ─── public types ──────────────────────────────────────────────────────────

/**
 * Dependencies required by `composeProfile`.
 *
 * Three federation ports + the spine + three circuit-breakers (one per
 * federation source — the spine has no breaker because spine failures are
 * real 5xx, not graceful-degrade cases per the NFR-2 doctrine above).
 *
 * Wiring (T2.3 route handler):
 *   - `spine`     ← `getSpine()` (singleton from src/api/spine.ts)
 *   - `inventory` ← `getInventory()` (T2.1 singleton from src/api/inventory.ts)
 *   - `score`     ← `getScore()` (T2.1 singleton from src/api/score.ts)
 *   - `codex`     ← `getCodex()` (T2.1 singleton from src/api/codex.ts)
 *   - `breakers`  ← module-level singletons created once per process
 *                   (in-memory state — single-Railway-instance per NFR-3)
 */
export interface ComposeProfileDeps {
  readonly spine: SpinePort
  readonly inventory: InventoryPort
  readonly score: ScorePort
  readonly codex: CodexPort
  readonly breakers: {
    readonly inventory: CircuitBreaker
    readonly score: CircuitBreaker
    readonly codex: CircuitBreaker
  }
}

/**
 * Per-call options.
 *
 * Timeout defaults are pinned to SDD §6.2:
 *   - inventory: 500ms
 *   - score:     300ms
 *   - codex:     400ms
 *
 * Worst-case sequential time ≈ max(T_inv, T_score) + T_codex = 500 + 400 =
 * 900ms; well within the NFR-1 800ms p95 target under typical sub-timeout
 * latency (most calls finish before the timeout fires).
 *
 * `actor` is forwarded into the audit emit; defaults to "system" if a
 * route handler doesn't supply session context.
 */
export interface ComposeProfileOpts {
  readonly perInventoryTimeoutMs?: number
  readonly perScoreTimeoutMs?: number
  readonly perCodexTimeoutMs?: number
  readonly actor?: AuditActor
}

/** Input: either {userId} or {walletAddress} (discriminated). */
export type ComposeProfileInput =
  | { readonly userId: string; readonly walletAddress?: never }
  | { readonly walletAddress: string; readonly userId?: never }

// ─── constants ─────────────────────────────────────────────────────────────

/**
 * Mibera contract address (chainId 80094 / Berachain). Source-of-truth:
 * `~/Documents/GitHub/inventory-api/src/inventory.ts:18` (`MIBERA_CONTRACT`).
 *
 * Used by `extractMiberaTokens` to filter the wallet's holdings down to the
 * Mibera collection before sending tokenIds to codex. Codex would silently
 * omit non-Mibera tokenIds anyway (its wire schema is Mibera-specific), but
 * filtering at the source saves a round-trip-sized request body for wallets
 * holding many non-Mibera NFTs.
 *
 * Matched case-insensitively; the inventory wire-shape may return lower or
 * checksummed case depending on upstream behavior.
 */
const MIBERA_CONTRACT = "0x6666397DFe9a8c469BF65dc744CB1C733416c420".toLowerCase()

const DEFAULT_INVENTORY_TIMEOUT_MS = 500
const DEFAULT_SCORE_TIMEOUT_MS = 300
const DEFAULT_CODEX_TIMEOUT_MS = 400

/** Per-source label used in degraded[] strings (e.g., "inventory:timeout"). */
type SourceLabel = "inventory" | "score" | "codex"

// ─── the orchestrator ──────────────────────────────────────────────────────

/**
 * Compose a Profile by joining the spine identity with live federation
 * fan-out to inventory + score + codex.
 *
 * Flow (per SDD §6 topology):
 *
 *   1. Resolve {walletAddress, userId, identity}:
 *      - {userId} input → spine.getIdentity(userId) → identity.primary_wallet
 *      - {walletAddress} input → spine.resolveByWallet(walletAddress) →
 *        userId → spine.getIdentity(userId)
 *      Spine calls have NO timeout: spine = SoR; failure here = real 5xx
 *      propagated as a thrown error. Caller's route handler maps it to
 *      the canonical error envelope.
 *
 *   2. Phase 1 (parallel): fan out inventory + score, each guarded by
 *      `breaker.isOpen()` check + per-source AbortController. Both are
 *      keyed by walletAddress, neither needs the other's output.
 *
 *   3. Record breaker outcomes per result (success / failure).
 *
 *   4. Phase 2 (conditional on Phase 1 inventory): if holdings ok AND
 *      Mibera tokenIds non-empty, call codex.getMiberaTraits. If holdings
 *      degraded OR no Mibera tokens, codex is SKIPPED (no inputs).
 *
 *   5. Record codex breaker outcome.
 *
 *   6. Build degraded[] from any non-ok results (format:
 *      `<source>:<reason>`, e.g., `"inventory:timeout"`).
 *
 *   7. Assemble ProfileResp; omit fields whose source missed.
 *
 *   8. Emit audit: `profile_composed` on full success;
 *      `profile_compose_degraded` when degraded[] is non-empty.
 *
 *   9. Return.
 *
 * Throws ONLY when the spine raises (lookup failed, DB down, identity
 * truly absent for an unresolvable user). Federation failures never throw.
 *
 * The caller (T2.3 route handler) maps:
 *   - returned ProfileResp → 200 OK (degraded[] optional)
 *   - thrown "user_not_found" → 404
 *   - other thrown → 500 (real upstream spine outage)
 */
export async function composeProfile(
  deps: ComposeProfileDeps,
  input: ComposeProfileInput,
  opts: ComposeProfileOpts = {},
): Promise<ProfileResp> {
  // ─── 1. Resolve identity from spine (no timeout — SoR) ────────────────
  const { identity, walletAddress } = await resolveSpineIdentity(deps.spine, input)

  const actor: AuditActor = opts.actor ?? "system"
  const invMs = opts.perInventoryTimeoutMs ?? DEFAULT_INVENTORY_TIMEOUT_MS
  const scoreMs = opts.perScoreTimeoutMs ?? DEFAULT_SCORE_TIMEOUT_MS
  const codexMs = opts.perCodexTimeoutMs ?? DEFAULT_CODEX_TIMEOUT_MS

  const degraded: string[] = []

  // ─── 2. Phase 1: parallel inventory + score ─────────────────────────────
  //
  // Per source: check breaker → if open, short-circuit with
  // circuit_open; else attempt the call with a per-source AbortController.
  // The breaker check + the call happen in the SAME tick so the
  // Promise.all participants are independent.
  const invHandle = withTimeout(invMs)
  const scoreHandle = withTimeout(scoreMs)
  const inventoryPromise: Promise<FederationResult<InventoryGetHoldingsResp>> = deps
    .breakers.inventory.isOpen()
    ? Promise.resolve(circuitOpenFailure("inventory"))
    : deps.inventory.getHoldings({ walletAddress }, { signal: invHandle.signal })
  const scorePromise: Promise<FederationResult<ScoreGetWalletResp>> = deps.breakers.score.isOpen()
    ? Promise.resolve(circuitOpenFailure("score"))
    : deps.score.getScore({ walletAddress }, { signal: scoreHandle.signal })
  const [holdingsRes, scoreRes] = await Promise.all([inventoryPromise, scorePromise])
  // Clear timers regardless of outcome (success completed faster than timeout,
  // or breaker short-circuited).
  invHandle.clear()
  scoreHandle.clear()

  // ─── 3. Record Phase 1 breaker outcomes ─────────────────────────────────
  recordOutcome(deps.breakers.inventory, holdingsRes)
  recordOutcome(deps.breakers.score, scoreRes)

  // Collect degraded labels for Phase 1.
  if (!holdingsRes.ok) {
    degraded.push(labelFor("inventory", holdingsRes.reason.kind))
  }
  if (!scoreRes.ok) {
    degraded.push(labelFor("score", scoreRes.reason.kind))
  }

  // ─── 4. Phase 2: conditional codex call ─────────────────────────────────
  //
  // Need: holdingsRes.ok AND Mibera tokenIds non-empty.
  // Skip without degraded entry when: holdings degraded (caller can't fault
  // us for skipping when the input is missing — the degraded[] entry for
  // inventory already explains the parent miss) OR holdings ok but no
  // Mibera tokens (a non-degraded skip; the wallet simply holds none).
  let codexRes: FederationResult<CodexGetMiberaBatchResp> | undefined
  if (holdingsRes.ok) {
    const tokens = extractMiberaTokens(holdingsRes.data.holdings)
    if (tokens.length > 0) {
      const codexHandle = withTimeout(codexMs)
      codexRes = deps.breakers.codex.isOpen()
        ? circuitOpenFailure<CodexGetMiberaBatchResp>("codex")
        : await deps.codex.getMiberaTraits({ tokenIds: tokens }, { signal: codexHandle.signal })
      codexHandle.clear()
      recordOutcome(deps.breakers.codex, codexRes)
      if (!codexRes.ok) {
        degraded.push(labelFor("codex", codexRes.reason.kind))
      }
    }
  }
  // If holdings degraded OR tokens empty → codexRes stays undefined; the
  // codex slot is OMITTED from the response. We do NOT push a degraded[]
  // entry in those skip cases (per the rationale above).

  // ─── 5. Assemble ProfileResp ────────────────────────────────────────────
  const resp: ProfileResp = {
    identity,
    ...(holdingsRes.ok ? { holdings: holdingsRes.data } : {}),
    ...(scoreRes && scoreRes.ok ? { score: scoreRes.data } : {}),
    ...(codexRes && codexRes.ok ? { codex: codexRes.data } : {}),
    ...(degraded.length > 0 ? { degraded } : {}),
  }

  // ─── 6. Audit emit ──────────────────────────────────────────────────────
  await deps.spine.writeAuditEvent({
    event_type: degraded.length > 0 ? "profile_compose_degraded" : "profile_composed",
    user_id: identity.user_id,
    actor,
    payload: {
      wallet_address: walletAddress,
      input_kind: "userId" in input && input.userId ? "userId" : "walletAddress",
      degraded,
    },
  })

  return resp
}

// ─── internals ─────────────────────────────────────────────────────────────

/**
 * Resolve `{identity, walletAddress}` from the spine.
 *
 * Two input shapes:
 *   - {userId}: getIdentity directly; walletAddress = identity.primary_wallet.
 *   - {walletAddress}: resolveByWallet → getIdentity; walletAddress = input verbatim.
 *
 * Throws:
 *   - "user_not_found"     when getIdentity returns null
 *   - "wallet_not_resolved" when resolveByWallet returns null
 *   - "primary_wallet_missing" when getIdentity has null primary_wallet
 *     and the input was {userId} (we have no wallet to fan out with)
 *
 * The route handler at T2.3 maps these to 404 envelopes; the spine errors
 * up to the route layer propagate as 5xx (NFR-2 isolates compose
 * downstreams; the spine is the SoR substrate, not a compose downstream).
 */
async function resolveSpineIdentity(
  spine: SpinePort,
  input: ComposeProfileInput,
): Promise<{ identity: IdentityResp; walletAddress: string }> {
  if ("userId" in input && input.userId) {
    const identity = await spine.getIdentity(input.userId)
    if (!identity) throw new Error("user_not_found")
    const wallet = identity.primary_wallet
    if (!wallet) {
      // A user exists in the spine but has no primary wallet — pre-T1.6
      // mint state should never produce this, but defensively we treat it
      // as "no wallet to fan out with."
      throw new Error("primary_wallet_missing")
    }
    return { identity: identity as IdentityResp, walletAddress: wallet }
  }
  // walletAddress branch
  const walletAddress = input.walletAddress!
  const userId = await spine.resolveByWallet(walletAddress)
  if (!userId) throw new Error("wallet_not_resolved")
  const identity = await spine.getIdentity(userId)
  if (!identity) throw new Error("user_not_found")
  return { identity: identity as IdentityResp, walletAddress }
}

/**
 * Synthesize a `circuit_open` FederationResult — used when the breaker is
 * open and we skip the HTTP attempt entirely.
 *
 * Generic over `TData` so the call site can type-narrow the union to the
 * specific port's response type.
 */
function circuitOpenFailure<TData>(source: SourceLabel): FederationResult<TData> {
  return {
    ok: false,
    reason: {
      kind: "circuit_open",
      message: `[${source}] circuit breaker is open — skipping call`,
      context: { source },
    } satisfies FederationFailure,
  }
}

/**
 * Record outcome to the breaker — success closes / failure ticks counter.
 *
 * `circuit_open` failures (synthesized when the breaker was already open)
 * are NOT recorded — they're an internal short-circuit, not a wire-level
 * data point about the upstream's health.
 */
function recordOutcome(
  breaker: CircuitBreaker,
  result: FederationResult<unknown>,
): void {
  if (result.ok) {
    breaker.recordSuccess()
    return
  }
  if (result.reason.kind === "circuit_open") {
    // Don't feed the breaker its own synthesized outcome.
    return
  }
  // Special case: `not_found` for score-api is the typical "wallet has no
  // scoring data yet" path (per ScorePort docstring). It's a legitimate
  // upstream response, not a health signal — don't tick the breaker on
  // 404s. Same logic applies to any 404 in v1: a 404 means the upstream
  // is healthy enough to respond with a typed 404 envelope.
  if (result.reason.kind === "not_found") {
    breaker.recordSuccess()
    return
  }
  breaker.recordFailure()
}

/**
 * Format a degraded[] entry: `<source>:<reason>`.
 *
 * Examples: `"inventory:timeout"`, `"score:upstream_5xx"`, `"codex:circuit_open"`.
 *
 * Per the ProfileRespSchema docstring this is the v1 vocabulary; downstream
 * consumers can split-on-colon to recover (source, reason).
 */
function labelFor(source: SourceLabel, reason: FederationFailureKind): string {
  return `${source}:${reason}`
}

/**
 * Extract Mibera tokenIds from a wallet's holdings.
 *
 * Filters by contract address (case-insensitive) — the Mibera contract on
 * Berachain (`MIBERA_CONTRACT` above). Returns the flattened tokenIds
 * across all matching holding rows.
 *
 * Edge cases:
 *   - No Mibera contract holdings in the wallet → returns [].
 *   - Mibera contract holding with empty tokenIds[] (per inventory-api's
 *     known sonar-ownership gap; see
 *     `~/Documents/GitHub/inventory-api/docs/sonar-ownership-gap.md`) →
 *     contributes nothing. The codex phase is skipped (empty input).
 *     When upstream closes the gap, this lights up automatically.
 *   - tokenIds is a `readonly string[]` per the wire schema — we
 *     pass strings through to the codex port (it coerces to number at
 *     wire encoding per CodexGetMiberaTraitsInput docstring).
 *
 * Cap: codex's wire schema enforces ≤100 per request (CodexGetMiberaBatchReqSchema).
 * If a wallet holds >100 Mibera, the orchestrator truncates to the first 100.
 * Codex coverage of a partial set is still useful (UX layer renders a "more
 * available" indicator if it cares); paginated batch is a T3+ refinement.
 */
function extractMiberaTokens(
  holdings: ReadonlyArray<InventoryContractHolding>,
): readonly string[] {
  const tokens: string[] = []
  for (const h of holdings) {
    if (h.contractAddress.toLowerCase() !== MIBERA_CONTRACT) continue
    for (const id of h.tokenIds) {
      tokens.push(id)
      if (tokens.length >= 100) return tokens
    }
  }
  return tokens
}

// ─── exported test seams ───────────────────────────────────────────────────

/**
 * Internal-only — exported for the unit-test file. Lets tests assert the
 * Mibera-tokenId filter logic against synthesized InventoryContractHolding
 * fixtures without round-tripping through the orchestrator.
 */
export const __test = {
  extractMiberaTokens,
  MIBERA_CONTRACT,
  DEFAULT_INVENTORY_TIMEOUT_MS,
  DEFAULT_SCORE_TIMEOUT_MS,
  DEFAULT_CODEX_TIMEOUT_MS,
}
