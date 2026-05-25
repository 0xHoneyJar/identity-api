/**
 * compose-mibera-dimensions.ts — focused orchestrator for /v1/mibera/dimensions
 * (T3.1 · bead arrakis-8qpm).
 *
 * The /v1/mibera/dimensions route is the headline G-6 slice: honey-road
 * renders a holder's 7-dim Mibera profile sourced from `@0xhoneyjar/identity`
 * (this building's codex passthrough), NOT Alchemy. This orchestrator owns
 * the resolution.
 *
 * Why a focused helper instead of reusing `composeProfile`:
 *
 *   - /v1/mibera/dimensions does NOT need score (different vocabulary;
 *     surfacing it would be incidental).
 *   - The response shape is different: `{user_id, primary_wallet, tokens[],
 *     degraded[]}` vs ProfileResp's `{identity, holdings, score, codex,
 *     degraded[]}`. Reusing the orchestrator + post-projecting would force
 *     an unnecessary score round-trip on every call.
 *   - Different timeout budget: inventory + codex only → ~900ms ceiling
 *     drops to ~500+400=900ms (same), but the typical-case is cleaner.
 *
 * Shape:
 *   1. Resolve spine identity from {userId} or {walletAddress} input.
 *      Spine throws map to 404 envelopes at the route layer (same 3 kinds
 *      as compose-profile: user_not_found / wallet_not_resolved /
 *      primary_wallet_missing).
 *   2. Phase 1: inventory.getHoldings (per-source timeout + breaker).
 *      If degraded → degraded[] entry + skip Phase 2 (no Mibera input).
 *   3. Mibera filter: extract tokenIds for the Mibera contract.
 *      If empty → tokens=[], no degraded entry, return.
 *   4. Phase 2: codex.getMiberaTraits with the tokenIds (per-source
 *      timeout + breaker). If degraded → degraded[] entry.
 *   5. Build response. Tokens is `CodexMiberaEntry[]` VERBATIM from codex's
 *      wire schema (per bead "no re-derive": the trait shape IS what codex
 *      returns; identity-api does not re-shape it).
 *
 * **Codex shape is CodexMiberaEntry verbatim** (per codex.ts:140-169 +
 * t2.1-federation-ports-notes.md). The 7 dimensions in the bead text
 * ("archetype/ancestor/element/tarot/era/molecule/swag + grail") were the
 * operator's pre-grounding sketch; the codex's REAL shape is:
 *   archetype, ancestor, time_period, birthday, birth_coordinates,
 *   sun_sign, moon_sign, ascending_sign, element, swag_rank, swag_score,
 *   drug, parcel (optional), + cosmetics for avatar reconstruction.
 * "Verbatim no re-derive" means we surface the REAL shape, not the
 * pre-grounding sketch.
 *
 * Source: PRD v3.0 §4.5 (FR-M1/M3) + §3 D6/D8, SDD §5.4 + §6, bead
 * arrakis-8qpm text, packages/protocol/src/api/federation/codex.ts (the
 * verbatim source-of-truth for the trait shape).
 */

import type {
  CodexPort,
  FederationResult,
  InventoryPort,
  SpinePort,
} from "@freeside-auth/ports"
import type {
  CodexGetMiberaBatchResp,
  CodexMiberaEntry,
  InventoryGetHoldingsResp,
  MiberaDimensionsResp,
} from "@freeside-auth/protocol/api"
import type { AuditActor } from "./resolve-spine"
import type { CircuitBreaker } from "./circuit-breaker"
import {
  circuitOpenFailure,
  extractMiberaTokens,
  labelFor,
  recordOutcome,
  resolveSpineIdentity,
} from "./compose-profile"
import { withTimeout } from "./with-timeout"

// ─── public types ──────────────────────────────────────────────────────────

export interface ComposeMiberaDimensionsDeps {
  readonly spine: SpinePort
  readonly inventory: InventoryPort
  readonly codex: CodexPort
  readonly breakers: {
    readonly inventory: CircuitBreaker
    readonly codex: CircuitBreaker
  }
}

export interface ComposeMiberaDimensionsOpts {
  readonly perInventoryTimeoutMs?: number
  readonly perCodexTimeoutMs?: number
  readonly actor?: AuditActor
}

export type ComposeMiberaDimensionsInput =
  | { readonly userId: string; readonly walletAddress?: never }
  | { readonly walletAddress: string; readonly userId?: never }

// ─── defaults (pinned to SDD §6.2; mirror compose-profile.ts) ──────────────

const DEFAULT_INVENTORY_TIMEOUT_MS = 500
const DEFAULT_CODEX_TIMEOUT_MS = 400

// ─── the orchestrator ──────────────────────────────────────────────────────

/**
 * Compose a Mibera-dimensions response for the resolved spine identity.
 *
 * Throws ONLY when the spine raises (user_not_found / wallet_not_resolved /
 * primary_wallet_missing). Federation failures NEVER throw; they surface in
 * `degraded[]` per the NFR-2 / FR-P2 graceful-degrade doctrine.
 *
 * The caller (T3.1 route handler) maps:
 *   - returned MiberaDimensionsResp → 200 OK (degraded[] optional)
 *   - thrown 3-kind spine error → 404 envelope
 *   - other thrown → 500 via global error handler
 */
export async function composeMiberaDimensions(
  deps: ComposeMiberaDimensionsDeps,
  input: ComposeMiberaDimensionsInput,
  opts: ComposeMiberaDimensionsOpts = {},
): Promise<MiberaDimensionsResp> {
  // ─── 1. Resolve identity from spine (no timeout — SoR) ─────────────────
  const { identity, walletAddress } = await resolveSpineIdentity(deps.spine, input)

  const actor: AuditActor = opts.actor ?? "system"
  const invMs = opts.perInventoryTimeoutMs ?? DEFAULT_INVENTORY_TIMEOUT_MS
  const codexMs = opts.perCodexTimeoutMs ?? DEFAULT_CODEX_TIMEOUT_MS
  const degraded: string[] = []

  // ─── 2. Phase 1: inventory.getHoldings ──────────────────────────────────
  const invHandle = withTimeout(invMs)
  const holdingsRes: FederationResult<InventoryGetHoldingsResp> =
    deps.breakers.inventory.isOpen()
      ? circuitOpenFailure<InventoryGetHoldingsResp>("inventory")
      : await deps.inventory.getHoldings(
          { walletAddress },
          { signal: invHandle.signal },
        )
  invHandle.clear()
  recordOutcome(deps.breakers.inventory, holdingsRes)
  if (!holdingsRes.ok) {
    degraded.push(labelFor("inventory", holdingsRes.reason.kind))
  }

  // ─── 3. Phase 2: codex (conditional) ────────────────────────────────────
  //
  // Codex fires IFF inventory ok AND the wallet has Mibera tokenIds. The
  // skip-without-degraded rule from compose-profile applies here too:
  // - inventory degraded → codex SKIPPED, no codex degraded entry
  //   (inventory's entry already explains the parent miss).
  // - inventory ok + no Mibera → codex SKIPPED, tokens = []
  //   (the wallet simply holds none; not a failure).
  let codexRes: FederationResult<CodexGetMiberaBatchResp> | undefined
  let miberaTokens: readonly string[] = []
  if (holdingsRes.ok) {
    miberaTokens = extractMiberaTokens(holdingsRes.data.holdings)
    if (miberaTokens.length > 0) {
      const codexHandle = withTimeout(codexMs)
      codexRes = deps.breakers.codex.isOpen()
        ? circuitOpenFailure<CodexGetMiberaBatchResp>("codex")
        : await deps.codex.getMiberaTraits(
            { tokenIds: miberaTokens },
            { signal: codexHandle.signal },
          )
      codexHandle.clear()
      recordOutcome(deps.breakers.codex, codexRes)
      if (!codexRes.ok) {
        degraded.push(labelFor("codex", codexRes.reason.kind))
      }
    }
  }

  // ─── 4. Assemble response ───────────────────────────────────────────────
  //
  // Resolution of the "tokens vs no tokens vs codex degraded" shapes:
  //   - inventory degraded         → tokens omitted (no input to query)
  //   - inventory ok + no Mibera   → tokens = [] (explicit empty)
  //   - inventory ok + Mibera + codex degraded → tokens omitted
  //   - inventory ok + Mibera + codex ok → tokens = codex.miberas[]
  // Schema's `tokens` is `CodexMiberaEntry[]` (mutable). The codex wire
  // response's `miberas` is `.readonly()` per CodexGetMiberaBatchRespSchema;
  // spread to a fresh array so the assignment is variance-clean.
  let tokens: CodexMiberaEntry[] | undefined
  if (holdingsRes.ok) {
    if (miberaTokens.length === 0) {
      tokens = []
    } else if (codexRes && codexRes.ok) {
      tokens = [...codexRes.data.miberas]
    }
    // else: codex degraded → tokens stays undefined
  }
  // else: inventory degraded → tokens undefined

  const resp: MiberaDimensionsResp = {
    user_id: identity.user_id,
    primary_wallet: walletAddress,
    ...(tokens !== undefined ? { tokens } : {}),
    ...(degraded.length > 0 ? { degraded } : {}),
  }

  // ─── 5. Audit emit ──────────────────────────────────────────────────────
  await deps.spine.writeAuditEvent({
    event_type:
      degraded.length > 0 ? "mibera_dimensions_composed_degraded" : "mibera_dimensions_composed",
    user_id: identity.user_id,
    actor,
    payload: {
      wallet_address: walletAddress,
      input_kind: "userId" in input && input.userId ? "userId" : "walletAddress",
      mibera_token_count: miberaTokens.length,
      degraded,
    },
  })

  return resp
}
