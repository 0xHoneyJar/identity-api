/**
 * Federation contract — inventory-api wire shapes (T2.1).
 *
 * inventory-api is the freeside-platform building that owns wallet-holdings
 * resolution for registered collections (Mibera primary). It's the
 * Alchemy/Zapper/DeBank replacement for our own assets. Per ADR-008 §D-3
 * (composition direction), inventory-api consumes `freeside-sonar` +
 * `freeside-storage` and publishes a `holdings` belt for downstream
 * consumers — identity-api's `/v1/profile` (T2.3) is one of those consumers.
 *
 * Source of truth (discovery findings — see t2.1 build notes):
 *
 *   - The local checkout at `~/Documents/GitHub/inventory-api/` is currently
 *     a LIBRARY (`@freeside/inventory`, in-process npm package). It exposes
 *     `getHoldings(address: string, options?: GetHoldingsOptions)` returning
 *     `HoldingsResponse = { holdings: ContractHolding[], completeness: CompletenessEnvelope }`.
 *
 *   - The registry at `loa-freeside/packages/freeside-registry/registry.yaml`
 *     declares `inventory-api`'s beacon URL as `https://inventory.0xhoneyjar.xyz`
 *     (`rename: done`). That URL is the deployment target — the building
 *     graduates from library-in-process to standalone HTTP service in T2.2/T2.3's
 *     consumption epoch.
 *
 *   - There is no `/v1/holdings/:address` route in the local checkout YET
 *     (it's a library); the wire schema below mirrors the LIBRARY's response
 *     shape verbatim under the assumption that the HTTP graduation will expose
 *     it as `GET /v1/holdings/:address` (the conventional REST shape and the
 *     simplest HTTP wrapping of the library function). When the HTTP service
 *     ships, the path + query-shape may move — this schema is the sealed
 *     surface; only the URL config in the adapter has to change.
 *
 *   - The decision NOT to vendor the library directly (which would couple
 *     identity-api to the LIBRARY interface) is doctrinal: per PRD §4.5 FR-P3
 *     (no-embed) inventory-api lives in its own building, and identity-api
 *     reads it over the wire. Treating it as a wire-bound dependency keeps
 *     the federation seam at the HTTP boundary even when both buildings ship
 *     from the same operator.
 *
 * Per Pattern B (T1.10) these Zod schemas live alongside the other api/* shapes
 * for consume-as-source SDK distribution. The federation/ subdir collects the
 * cross-building schemas (vs the auth/resolve/profile/link first-party shapes).
 *
 * Source: PRD v3.0 §4.5 (FR-P1..P4 compose contract), SDD §5.4 (federation
 * detail), registry.yaml, `~/Documents/GitHub/inventory-api/index.ts` +
 * `types.ts`.
 */

import { z } from "zod"

// ─── nested shapes ──────────────────────────────────────────────────────────

/**
 * Per-NFT attribute pair (OpenSea-shaped). Mirrors `Attribute` from
 * `~/Documents/GitHub/inventory-api/types.ts`.
 *
 * Surfaced to T3.1 (Mibera dimensions resolver) when it joins per-token
 * trait data, but for T2.1's wire-shape scope we keep it permissive (`value`
 * stays a string in the library; future numeric-trait support would loosen
 * to `z.union([z.string(), z.number()])`).
 */
export const InventoryAttributeSchema = z.object({
  trait_type: z.string(),
  value: z.string(),
})
export type InventoryAttribute = z.infer<typeof InventoryAttributeSchema>

/**
 * ACVP completeness envelope — the "provably complete as of block N" guarantee
 * inventory-api ships per its README. `complete: 'degraded'` signals the
 * underlying sonar/storage source was unreachable and the inventory rebuilt
 * from a cached fixture; consumers (T2.2 fan-out) should pass this through
 * verbatim into the `degraded[]` array.
 *
 * `as_of_block` is `0` (a sentinel) in degraded responses, not negative —
 * the library uses `as_of_block: 0` as the "no block was reached" signal.
 */
export const InventoryCompletenessSchema = z.object({
  as_of_block: z.number().int().nonnegative(),
  holder_count: z.number().int().nonnegative(),
  source: z.literal("sonar"),
  complete: z.union([z.literal(true), z.literal("degraded")]),
})
export type InventoryCompleteness = z.infer<typeof InventoryCompletenessSchema>

/**
 * Per-(contract, chain) holding row.
 *
 * `tokenIds` is the ENUMERATED list of tokenIds the wallet holds. Per the
 * inventory-api README known-gap (`docs/sonar-ownership-gap.md`), live mode
 * currently returns real `tokenCount` with `tokenIds: []` because the sonar
 * per-token ownership index is not yet published. T3.1 (Mibera dimensions
 * resolver) NEEDS the tokenIds populated to look up per-token traits from
 * codex — this is a known T3.x integration gap, NOT a T2.1 blocker (we wire
 * the contract; resolution waits for the sonar belt).
 */
export const InventoryContractHoldingSchema = z.object({
  contractAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  chainId: z.number().int().positive(),
  tokenCount: z.number().int().nonnegative(),
  tokenIds: z.array(z.string()).readonly(),
})
export type InventoryContractHolding = z.infer<typeof InventoryContractHoldingSchema>

// ─── HTTP request shape ─────────────────────────────────────────────────────

/**
 * Path-parameter schema for `GET /v1/holdings/:wallet`.
 *
 * 0x-prefixed 40-char hex EVM address. Non-EVM wallets are deferred — when
 * the inventory-api substrate adds chain-generic resolution, this loosens.
 */
export const InventoryGetHoldingsPathSchema = z.object({
  wallet: z.string().regex(/^0x[a-fA-F0-9]{40}$/, "0x-prefixed 20-byte hex"),
})
export type InventoryGetHoldingsPath = z.infer<typeof InventoryGetHoldingsPathSchema>

// ─── HTTP response shape ────────────────────────────────────────────────────

/**
 * The full HTTP response body for `GET /v1/holdings/:wallet`.
 *
 * Mirrors `HoldingsResponse` from `~/Documents/GitHub/inventory-api/types.ts`
 * 1:1 (the library is the source of truth; the HTTP wrapper is the
 * not-yet-existent transport).
 */
export const InventoryGetHoldingsRespSchema = z.object({
  holdings: z.array(InventoryContractHoldingSchema).readonly(),
  completeness: InventoryCompletenessSchema,
})
export type InventoryGetHoldingsResp = z.infer<typeof InventoryGetHoldingsRespSchema>
