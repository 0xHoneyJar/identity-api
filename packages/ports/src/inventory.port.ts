/**
 * InventoryPort — federation client interface for the inventory-api building (T2.1).
 *
 * Per PRD v3.0 §4.5 (FR-P1..P4) + SDD §5.4: identity-api stores ZERO holdings
 * in its spine. The `/v1/profile` read-time compose (T2.3) fans out to the
 * inventory-api building, which OWNS holdings resolution for registered
 * collections (Mibera primary, per-world heterogeneity at T3+). This port is
 * the dependency-inverted seam through which T2.2's compose orchestrator
 * reaches inventory-api — adapters in `@freeside-auth/adapters` implement it.
 *
 * Read-only by contract: identity-api NEVER writes to inventory-api. Holdings
 * are owned upstream; we federate-read at compose time and let the response
 * round-trip into the `/v1/profile` body verbatim (with the ACVP completeness
 * envelope intact — the "provably complete as of block N" guarantee that
 * inventory-api ships is exactly what T2.3 surfaces).
 *
 * Wire shape: see `@freeside-auth/protocol/api/federation/inventory.ts`
 * (sealed) and the matching `inventory.schema.json` (JSON Schema sibling).
 *
 * Adapter:
 *   - `HttpInventoryAdapter` (T2.1 · @freeside-auth/adapters) — HTTP client
 *      that calls `GET /v1/holdings/:wallet`. Default baseUrl
 *      `https://inventory.0xhoneyjar.xyz` (per registry.yaml) overridable
 *      via env `INVENTORY_API_URL`.
 *
 * Test seam:
 *   - `MockInventoryPort` (T2.1 · @freeside-auth/adapters/__tests__) — in-
 *     process fixture-backed implementation for the T2.2 compose tests.
 *
 * Source: PRD v3.0 §4.5 + §10 (deps), SDD §5.4 + §6 (federation architecture),
 * packages/freeside-registry/registry.yaml (inventory-api beacon URL).
 */

import type { InventoryGetHoldingsResp } from "@freeside-auth/protocol/api/federation/inventory"
import type { FederationResult } from "./federation-result"
import type { PortCallOpts } from "./port-opts"

// ─── input shape ───────────────────────────────────────────────────────────

/**
 * Input to `getHoldings`. Wallet address is 0x-prefixed 40-char hex (EVM).
 * Per SDD §5.4 the caller (T2.2 compose) is responsible for normalizing case
 * before calling — the inventory-api server normalizes anyway (checksum-cast
 * on receive), but lowercase is the canonical-form invariant identity-api
 * uses across its own spine (see engine/resolve-spine.ts normalizeAddress).
 */
export interface InventoryGetHoldingsInput {
  /** 0x-prefixed 40-char EVM wallet address. */
  readonly walletAddress: string
}

// ─── port ──────────────────────────────────────────────────────────────────

/**
 * The inventory-api federation client port.
 *
 * One method today (`getHoldings`); future expansion (e.g., per-token
 * metadata, paginated NFT lists for richer profile views) would add methods
 * here. T2.2's compose orchestrator calls only `getHoldings` for the
 * `/v1/profile` shape; T3.1's Mibera dimensions resolver also uses
 * `getHoldings` (to discover the wallet's Mibera tokenIds before calling
 * `CodexPort.getMiberaTraits`).
 */
export interface InventoryPort {
  /**
   * Resolve a wallet's holdings across registered collections.
   *
   * Returns the `InventoryGetHoldingsResp` shape on success (matches the
   * sealed wire schema verbatim), or a `FederationFailure` on any error.
   *
   * Per T2.2's compose contract: failures DO NOT throw — they return as
   * `{ ok: false, reason }` so the fan-out can continue without try/catch.
   * The compose layer aggregates failures into the response's `degraded[]`
   * array; identity-api's `/v1/profile` stays 200 OK even when the
   * inventory federation source missed.
   *
   * Per FR-P2: callers should pass `opts.signal` (an AbortSignal from a
   * per-source timer) so a slow upstream cannot tax the overall latency
   * budget. The adapter forwards the signal to the underlying `fetch`;
   * abort → `{ ok: false, reason: { kind: 'timeout', ... } }`.
   */
  getHoldings(
    input: InventoryGetHoldingsInput,
    opts?: PortCallOpts,
  ): Promise<FederationResult<InventoryGetHoldingsResp>>
}
