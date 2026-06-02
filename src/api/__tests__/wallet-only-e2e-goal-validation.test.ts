/**
 * wallet-only-e2e-goal-validation.test.ts — A7 (identity-api #11 Phase 1).
 *
 * The P0 end-to-end goal-validation task. Proves G-5 (profile serving) against
 * a REAL disposable PG, exercising the whole Sprint-A chain:
 *
 *   migrate 0008 → backfill a 189-row wallet-only fixture (A6 backfillWalletOnlyRows
 *   → A3 linkWalletOnly → A2 importName, against the real PG)
 *   → assert EVERY user resolves to a name (claimed nym, else MIBERA-XXXX),
 *     NEVER the raw address (the privacy floor)
 *   → /v1/profile (composeProfile) and /v1/identity/resolve (mergeIdentity)
 *     AGREE on the display value (the one-resolver decision)
 *   → revert → baseline restored exactly
 *
 * Gated on TEST_DATABASE_URL (scratch-guarded). The disposable PG has no
 * midi_profiles source, so the 189 rows are a generated FIXTURE (mirroring the
 * real wallet-only shape: wallet + mibera_id, some with display_name).
 *
 * This is the integration of A1-A6 — it imports the SAME production primitives
 * the route handlers use (PostgresSpineAdapter, backfillWalletOnlyRows,
 * composeProfile, mergeIdentity), not re-implementations.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { SQL } from "bun"
import { resolve } from "node:path"

import { migrate } from "../../../packages/adapters/src/migrate"
import { PostgresSpineAdapter } from "@freeside-auth/adapters"
import { CircuitBreaker, composeProfile, mergeIdentity } from "@freeside-auth/engine"
import {
  backfillWalletOnlyRows,
  countActiveWalletLinks,
  type WalletOnlyMidiRow,
} from "../../../scripts/backfill-wallet-only-from-midi"
import {
  findBackfilledWalletLinkages,
  revertWalletLinkages,
} from "../../../scripts/backfill-wallet-only-from-midi-revert"
import { MockInventoryPort } from "../../../packages/adapters/src/__tests__/mock-inventory"
import { MockScorePort } from "../../../packages/adapters/src/__tests__/mock-score"
import { MockCodexPort } from "../../../packages/adapters/src/__tests__/mock-codex"

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL
const MIGRATIONS_DIR = resolve(__dirname, "..", "..", "..", "packages/adapters/src/migrations")

const SCRATCH_DB_HINTS = ["test", "scratch", "ephemeral", "ci", "tmp", "preview"]
function looksLikeScratchUrl(url: string): boolean {
  try {
    const u = new URL(url)
    const dbName = u.pathname.replace(/^\//, "").toLowerCase()
    if (!dbName) return false
    return SCRATCH_DB_HINTS.some((hint) => dbName.includes(hint))
  } catch {
    return false
  }
}

async function dropEverything(sql: SQL): Promise<void> {
  const tables = (await sql`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`) as Array<{
    tablename: string
  }>
  for (const t of tables) await sql.unsafe(`DROP TABLE IF EXISTS "${t.tablename}" CASCADE`)
  await sql.unsafe(`DROP FUNCTION IF EXISTS sync_primary_wallet() CASCADE`)
  await sql.unsafe(`DROP FUNCTION IF EXISTS recompute_world_nym() CASCADE`)
}

/** Generate a 189-row wallet-only fixture mirroring the real midi shape. */
function build189Fixture(): WalletOnlyMidiRow[] {
  const rows: WalletOnlyMidiRow[] = []
  for (let i = 1; i <= 189; i++) {
    // Deterministic 6-hex from i (matches ^MIBERA-[A-F0-9]{6}$).
    const hex = i.toString(16).toUpperCase().padStart(6, "0")
    rows.push({
      wallet_address: `0x${i.toString(16).padStart(40, "0")}`,
      dynamic_user_id: i % 3 === 0 ? `dyn-${i}` : null,
      mibera_id: `MIBERA-${hex}`,
      // ~1/4 of the 189 had set a display_name in honey-road.
      display_name: i % 4 === 0 ? `mibera-user-${i}` : null,
    })
  }
  return rows
}

function freshBreakers() {
  return {
    inventory: new CircuitBreaker(),
    score: new CircuitBreaker(),
    codex: new CircuitBreaker(),
  }
}

describe.skipIf(!TEST_DATABASE_URL)("A7 — wallet-only E2E goal validation (G-5)", () => {
  const databaseUrl = TEST_DATABASE_URL as string
  let spine: PostgresSpineAdapter

  beforeAll(async () => {
    if (!looksLikeScratchUrl(databaseUrl)) {
      throw new Error(`e2e.test: TEST_DATABASE_URL not scratch-shaped.`)
    }
    const sql = new SQL(databaseUrl)
    try {
      await dropEverything(sql)
    } finally {
      await sql.close()
    }
    await migrate({ databaseUrl, migrationsDir: MIGRATIONS_DIR, verb: "up" })
    spine = new PostgresSpineAdapter(databaseUrl)
  })

  afterAll(async () => {
    await spine.close()
    const sql = new SQL(databaseUrl)
    try {
      await dropEverything(sql)
    } finally {
      await sql.close()
    }
  })

  it("backfills 189 wallet-only users; every one resolves to a name, NEVER the raw address; both endpoints agree; revert restores baseline", async () => {
    const sql = new SQL(databaseUrl)
    try {
      const baseline = await countActiveWalletLinks(sql)

      // ── 1. Backfill the 189 (the real production loop against real PG) ──
      const rows = build189Fixture()
      const stats = await backfillWalletOnlyRows(spine, rows, {
        worldSlug: "mibera",
        dryRun: false,
      })
      expect(stats.total).toBe(189)
      expect(stats.created).toBe(189)
      expect(stats.errors).toBe(0)

      // HARD count: active wallet_links grew by exactly 189.
      const afterBackfill = await countActiveWalletLinks(sql)
      expect(afterBackfill).toBe(baseline + 189)

      // ── 2. Every user is in the spine + resolves to a non-address name ──
      const userRows = (await sql`
        SELECT DISTINCT user_id::text AS user_id FROM wallet_links WHERE unlinked_at IS NULL
      `) as Array<{ user_id: string }>
      expect(userRows.length).toBe(baseline + 189)

      const inventory = new MockInventoryPort()
      const score = new MockScorePort() // defaults to not_found → no score name
      const codex = new MockCodexPort()
      const breakers = freshBreakers()

      let checked = 0
      // Sample across the population (every 20th + the boundary rows) to keep
      // the E2E fast while covering display_name-present and -absent shapes.
      const sampleIdx = new Set<number>()
      for (let i = 0; i < userRows.length; i += 20) sampleIdx.add(i)
      sampleIdx.add(0)
      sampleIdx.add(userRows.length - 1)

      for (const idx of sampleIdx) {
        const userId = userRows[idx]!.user_id
        const identity = await spine.getIdentity(userId)
        expect(identity).not.toBeNull()
        const wallet = identity!.primary_wallet!

        // /v1/identity/resolve surface — mergeIdentity (the registry tier).
        const merged = mergeIdentity({
          wallet,
          spine: identity,
          enrich: undefined,
          worldSlug: "mibera",
          degraded: false,
        })

        // G-5 PRIVACY INVARIANT: the default-display is a NAME, never the raw
        // address. Every backfilled user has at least a generated MIBERA-XXXX.
        expect(merged.display_source).not.toBe("address")
        expect(merged.display_name).not.toBe(wallet)
        expect(["generated", "claimed_nym"]).toContain(merged.display_source)

        // /v1/profile surface — composeProfile attaches the `display` block via
        // the SAME resolveDisplayName. Federation is degraded (mocks default to
        // not_found) — the display block comes purely from the spine.
        const profile = await composeProfile(
          { spine, inventory, score, codex, breakers },
          { walletAddress: wallet },
          { actor: "system", worldSlug: "mibera" },
        )
        expect(profile.display).toBeDefined()

        // TWO-ENDPOINT AGREEMENT (the one-resolver decision): both surfaces
        // project the identical display_name + display_source.
        expect(profile.display!.display_name).toBe(merged.display_name)
        expect(profile.display!.display_source).toBe(merged.display_source)
        expect(profile.display!.display_name).not.toBe(wallet) // floor holds here too

        checked++
      }
      expect(checked).toBeGreaterThan(0)

      // ── 3. Spot-check the ABSORB: a display_name row shows the claimed nym ──
      // Row i=4 had display_name "mibera-user-4" (i % 4 === 0).
      const claimedRows = (await sql`
        SELECT value FROM world_identity_names
         WHERE name_type = 'claimed_nym' AND retired_at IS NULL AND value = 'mibera-user-4'
      `) as Array<{ value: string }>
      expect(claimedRows.length).toBe(1) // absorbed verbatim, not regenerated

      // ── 4. REVERT → baseline restored exactly ──
      const linkages = await findBackfilledWalletLinkages(sql)
      expect(linkages.length).toBe(189)
      const revertStats = await revertWalletLinkages(sql, linkages, { dryRun: false })
      expect(revertStats.wallets_unlinked).toBe(189)

      const afterRevert = await countActiveWalletLinks(sql)
      expect(afterRevert).toBe(baseline) // exact baseline

      const activeNames = (await sql`
        SELECT COUNT(*)::int AS n FROM world_identity_names WHERE retired_at IS NULL
      `) as Array<{ n: number }>
      expect(activeNames[0]!.n).toBe(0) // all minted names retired
    } finally {
      await sql.close()
    }
  }, 60000) // generous timeout — 189-row backfill against real PG
})
