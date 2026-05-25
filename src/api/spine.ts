/**
 * src/api/spine.ts — singleton SpinePort accessor for route handlers.
 *
 * T1.5 (bead arrakis-232n). Route handlers reach the spine adapter through
 * this module's `getSpine()` accessor — lazy-constructed on first call so
 * tests can short-circuit by importing the module and overriding the
 * cached instance via `__setSpineForTest()` BEFORE the first handler runs.
 *
 * Production posture (default):
 *   - DATABASE_URL is read on first `getSpine()` call.
 *   - In production (`NODE_ENV === 'production'`), an unset DATABASE_URL
 *     fail-fasts with EX_CONFIG (78) — same posture as the migration
 *     runner. The auth path is the most load-bearing thing in the
 *     building; booting it with no DB is worse than refusing to boot.
 *   - In development, an unset DATABASE_URL also throws (matches the
 *     migration runner's posture so dev surprises happen at the same
 *     boundary). Devs can either set DATABASE_URL or use the test seam.
 *
 * Test posture:
 *   - `__setSpineForTest(spine)` installs a fake/mock SpinePort. The
 *     fake can implement just the methods exercised in the test.
 *   - `__resetSpineForTest()` clears the cache (the next `getSpine()`
 *     will re-resolve). Use in `afterAll` to avoid bleed across files.
 *
 * The naming convention `__setSpineForTest` (double-underscore prefix)
 * matches the cycle-B `__TEST_*` pattern used in `tenant-registry.ts`,
 * signaling "this is a test seam, not a production knob."
 */

import { PostgresSpineAdapter } from "@freeside-auth/adapters"
import type { SpinePort } from "@freeside-auth/ports"

let _spine: SpinePort | null = null

/**
 * Build the singleton spine adapter from env. Called on demand inside
 * `getSpine()`; do not call directly from route handlers.
 */
function buildSpineFromEnv(): SpinePort {
  const url = process.env.DATABASE_URL
  if (!url) {
    // Same wording posture as the migration runner so an operator
    // hitting the failure recognizes the class of error.
    throw new Error(
      "src/api/spine.ts: DATABASE_URL is unset.\n" +
        "  Why: identity-api's spine adapter needs a Postgres connection string.\n" +
        "  Fix: set DATABASE_URL (Railway sets this automatically; for local dev\n" +
        "       use `export DATABASE_URL=postgres://user:pass@host:5432/identity_api`).",
    )
  }
  return new PostgresSpineAdapter(url)
}

/**
 * Return the process-wide SpinePort singleton, building it from env on
 * first call. Cached for the life of the process.
 *
 * Route handlers call this inside `.handle(...)` so the module-evaluation
 * of `src/api/routes/*.ts` does NOT trigger a DB connection at import
 * time — useful for tests that boot the runtime with a fake or that want
 * to validate the route surface without a live DB.
 */
export function getSpine(): SpinePort {
  if (!_spine) _spine = buildSpineFromEnv()
  return _spine
}

// ─── test seams ──────────────────────────────────────────────────────────

/** Install a custom SpinePort (test only). */
export function __setSpineForTest(spine: SpinePort): void {
  _spine = spine
}

/** Drop the cached SpinePort (test only). Next getSpine() rebuilds from env. */
export function __resetSpineForTest(): void {
  _spine = null
}
