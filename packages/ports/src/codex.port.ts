/**
 * CodexPort — federation client interface for the mibera-codex building (T2.1).
 *
 * Per PRD v3.0 §4.5 + SDD §5.4 + the Mibera-dimensions doctrine: identity-api
 * stores ZERO per-token traits in its spine. The codex OWNS the canonical
 * 7-dimension Mibera profile (archetype / ancestor / element / sun-sign /
 * swag / drug / parcel + grail bindings). T2.2's compose orchestrator
 * (`/v1/profile`) fans out to the codex when a tokenId list is known; T3.1
 * (Mibera dimensions resolver) calls this port to decorate each Mibera token
 * the wallet holds.
 *
 * Read-only by contract: codex is canonical Mibera lore. We never write.
 *
 * Wire shape: see `@freeside-auth/protocol/api/federation/codex.ts` (sealed)
 * and the matching `codex.schema.json` (JSON Schema sibling).
 *
 * Adapter:
 *   - `HttpCodexAdapter` (T2.1 · @freeside-auth/adapters) — HTTP client
 *      that calls `POST /v1/mibera/batch`. Default baseUrl
 *      `https://codex.0xhoneyjar.xyz` (per registry.yaml) overridable via
 *      env `CODEX_API_URL`. No auth (codex beacon declares
 *      `pricing: free` + `auth: none`).
 *
 * Test seam:
 *   - `MockCodexPort` (T2.1 · @freeside-auth/adapters/__tests__) — in-
 *     process fixture-backed implementation for T2.2 + T3.1 tests.
 *
 * Transport caveat (see codex.ts provenance docstring): codex's PRIMARY
 * transport today is MCP, not plain HTTP. The port is transport-agnostic
 * — an alternate `McpCodexAdapter` could satisfy the same contract via
 * `@modelcontextprotocol/sdk` if/when we decide to ride MCP instead of
 * adding the HTTP wrapper. The port shape doesn't change.
 *
 * Source: PRD v3.0 §4.5 + §10, SDD §5.4 + §6, registry.yaml,
 * `~/Documents/GitHub/mibera-codex/src/types.ts:46-78`,
 * `~/Documents/GitHub/mibera-codex/src/lookups/mibera.ts`,
 * `~/Documents/GitHub/mibera-codex/beacon.yaml`.
 */

import type {
  CodexMiberaEntry,
  CodexGetMiberaBatchResp,
} from "@freeside-auth/protocol/api/federation/codex"
import type { FederationResult } from "./federation-result"
import type { PortCallOpts } from "./port-opts"

// ─── input shape ───────────────────────────────────────────────────────────

/**
 * Input to `getMiberaTraits`. Token IDs are integer-valued (Mibera supply is
 * 1..10000); the port accepts a list so T3.1 can fetch a wallet's full
 * holdings in one round-trip. Per the wire schema's max-100 cap, the caller
 * must batch-paginate for wallets holding >100 Mibera.
 *
 * Mibera codex maps tokenIds (numeric) to 7-dim profiles. The caller has
 * tokenIds as strings (the inventory-api wire shape ships them as strings —
 * EVM tokenIds CAN exceed JavaScript's safe-integer range, although Mibera
 * specifically maxes at 10000). The port accepts STRINGS and the adapter
 * coerces to numbers at the wire boundary (the codex JSONL keys numerics).
 */
export interface CodexGetMiberaTraitsInput {
  /**
   * Mibera tokenIds to fetch. STRING-shaped because the upstream
   * inventory-api delivers tokenIds as strings (per `InventoryContractHolding.
   * tokenIds: readonly string[]`). The adapter coerces to numbers at the
   * wire boundary; non-numeric strings rebound as `parse_error`.
   *
   * Cap: ≤100 per call (matches the codex wire-shape cap).
   */
  readonly tokenIds: readonly string[]
}

// ─── port ──────────────────────────────────────────────────────────────────

/**
 * The mibera-codex federation client port.
 *
 * One method today (`getMiberaTraits`); future expansion (grail-by-id,
 * zone-by-slug, archetype-by-name, all of the codex's lookup_*) would add
 * methods here. T2.2 + T3.1 currently only need `getMiberaTraits`; other
 * codex lookups stay deferred until the consumer surface needs them.
 */
export interface CodexPort {
  /**
   * Resolve per-tokenId Mibera 7-dim profiles for a batch of token IDs.
   *
   * Returns `CodexGetMiberaBatchResp = { miberas: CodexMiberaEntry[] }` on
   * success. Not-found token IDs are SILENTLY OMITTED from the response per
   * the wire-schema contract — the caller must dedupe against its request
   * set to detect missing IDs (typically by building a Map keyed on
   * `mibera.id`). This matches T3.1's iteration pattern: walk the wallet's
   * Mibera holdings, decorate the ones the codex knows, leave unknowns
   * undecorated (a codex-side coverage gap, not an error).
   *
   * Returns a `FederationFailure` on transport / parse error per the
   * standard discriminated-union contract.
   *
   * Per FR-P2: callers should pass `opts.signal` for the per-source timeout.
   * Per the wire-shape cap, callers must split `tokenIds` arrays >100 into
   * multiple calls.
   *
   * Why a single batch-call vs N parallel per-tokenId calls:
   *   - Codex's JSONL is in-process at the upstream — N calls would N×
   *     fan-out connections for 0 latency benefit.
   *   - A single round-trip is the strictly cheaper option, and the batch
   *     shape is what T3.1 will produce naturally (wallet's tokenIds is
   *     a list).
   */
  getMiberaTraits(
    input: CodexGetMiberaTraitsInput,
    opts?: PortCallOpts,
  ): Promise<FederationResult<CodexGetMiberaBatchResp>>
}

// Re-export the CodexMiberaEntry type for ergonomic single-import consumption
// (callers that import the port often want the row shape too).
export type { CodexMiberaEntry }
