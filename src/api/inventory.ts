/**
 * src/api/inventory.ts — singleton InventoryPort accessor for route handlers + the
 * compose orchestrator (T2.1).
 *
 * Mirrors `src/api/spine.ts` exactly: lazy build, env-driven config, test
 * seams `__setInventoryForTest()` / `__resetInventoryForTest()`.
 *
 * Production posture:
 *   - INVENTORY_API_URL is read on first `getInventory()` call (optional —
 *     when unset, falls back to DEFAULT_INVENTORY_BASE_URL per registry.yaml).
 *   - Per FR-P3 + T2.2 design: a missing INVENTORY_API_URL is NOT fatal at
 *     boot (unlike DATABASE_URL — the spine is required, federation is
 *     graceful-degrade). If the federation upstream is unreachable at
 *     compose time, T2.2's per-source timeout fires and the source surfaces
 *     in `degraded[]`; the /v1/profile request still completes with 200.
 *
 * Test posture:
 *   - `__setInventoryForTest(port)` installs a fake/mock InventoryPort
 *     (typically `MockInventoryPort` from
 *     `@freeside-auth/adapters/__tests__/mock-inventory`).
 *   - `__resetInventoryForTest()` clears the cache.
 *
 * Naming `__setInventoryForTest` (double-underscore prefix) matches the
 * spine.ts convention.
 *
 * Source: PRD v3.0 §4.5 (FR-P1..P4), SDD §5.4, T1.5 src/api/spine.ts pattern.
 */

import { HttpInventoryAdapter } from "@freeside-auth/adapters"
import type { InventoryPort } from "@freeside-auth/ports"

let _inventory: InventoryPort | null = null

/**
 * Build the singleton inventory adapter from env. Called on demand inside
 * `getInventory()`; do not call directly from route handlers.
 */
function buildInventoryFromEnv(): InventoryPort {
  const baseUrl = process.env.INVENTORY_API_URL
  return new HttpInventoryAdapter({
    ...(baseUrl ? { baseUrl } : {}),
  })
}

/**
 * Return the process-wide InventoryPort singleton, building it from env on
 * first call. Cached for the life of the process.
 *
 * Route handlers + compose orchestrators (T2.2/T2.3) call this inside
 * `.handle(...)` so module-evaluation of `src/api/routes/*.ts` doesn't
 * trigger any setup at import time.
 */
export function getInventory(): InventoryPort {
  if (!_inventory) _inventory = buildInventoryFromEnv()
  return _inventory
}

// ─── test seams ──────────────────────────────────────────────────────────

/** Install a custom InventoryPort (test only). */
export function __setInventoryForTest(port: InventoryPort): void {
  _inventory = port
}

/** Drop the cached InventoryPort (test only). Next getInventory() rebuilds. */
export function __resetInventoryForTest(): void {
  _inventory = null
}
