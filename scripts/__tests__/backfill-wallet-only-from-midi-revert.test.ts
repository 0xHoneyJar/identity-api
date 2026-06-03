/**
 * backfill-wallet-only-from-midi-revert.test.ts — A6 revert (the down op).
 *
 * Verifies the revert loop against a real scratch PG (TEST_DATABASE_URL-gated,
 * scratch-guarded). The revert soft-unlinks actor='backfill-wallet' linkages +
 * retires the minted names, idempotent via unlinked_at IS NULL / retired_at IS
 * NULL — so a backfill → revert round-trip restores the baseline exactly.
 *
 * Why a real PG (not a mock): the revert is SQL-shaped (UPDATE ... WHERE
 * unlinked_at IS NULL RETURNING), so the idempotency + the join from the audit
 * marker to the wallet/name rows must be exercised against actual SQL.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { SQL } from "bun"
import { resolve } from "node:path"

import { migrate } from "../../packages/adapters/src/migrate"
import { PostgresSpineAdapter } from "@freeside-auth/adapters"
import { backfillWalletOnlyRows, type WalletOnlyMidiRow } from "../backfill-wallet-only-from-midi"
import { findBackfilledWalletLinkages, revertWalletLinkages } from "../backfill-wallet-only-from-midi-revert"

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL
const MIGRATIONS_DIR = resolve(__dirname, "..", "..", "packages/adapters/src/migrations")

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

const ROW = (i: number, over: Partial<WalletOnlyMidiRow> = {}): WalletOnlyMidiRow => ({
  wallet_address: `0x${String(i).padStart(40, "0")}`,
  dynamic_user_id: null,
  mibera_id: `MIBERA-${String(i).padStart(6, "0")}`,
  display_name: null,
  ...over,
})

describe.skipIf(!TEST_DATABASE_URL)("backfill-wallet-only revert round-trip (A6)", () => {
  const databaseUrl = TEST_DATABASE_URL as string
  let spine: PostgresSpineAdapter

  beforeAll(async () => {
    if (!looksLikeScratchUrl(databaseUrl)) {
      throw new Error(`revert.test: TEST_DATABASE_URL not scratch-shaped.`)
    }
    const sql = new SQL(databaseUrl)
    try {
      await dropEverything(sql)
    } finally {
      await sql.close()
    }
    await migrate({ databaseUrl, migrationsDir: MIGRATIONS_DIR, verb: "up" })
    spine = new PostgresSpineAdapter(databaseUrl)
    const seed = new SQL(databaseUrl)
    try {
      await seed`INSERT INTO worlds (world_slug, display_name) VALUES ('mibera','mibera') ON CONFLICT DO NOTHING`
    } finally {
      await seed.close()
    }
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

  it("backfill → revert restores the baseline (wallet_links + names)", async () => {
    const sql = new SQL(databaseUrl)
    try {
      const priorActive = (await sql`
        SELECT COUNT(*)::int AS n FROM wallet_links WHERE unlinked_at IS NULL
      `) as Array<{ n: number }>
      const baseline = priorActive[0]!.n

      // Backfill 5 wallet-only rows (each absorbs a mibera_id + a display_name).
      const rows = [
        ROW(1, { display_name: "alice" }),
        ROW(2, { display_name: "bob" }),
        ROW(3),
        ROW(4, { dynamic_user_id: "dyn-4" }),
        ROW(5, { display_name: "carol" }),
      ]
      const stats = await backfillWalletOnlyRows(spine, rows, { worldSlug: "mibera", dryRun: false })
      expect(stats.created).toBe(5)

      const afterBackfill = (await sql`
        SELECT COUNT(*)::int AS n FROM wallet_links WHERE unlinked_at IS NULL
      `) as Array<{ n: number }>
      expect(afterBackfill[0]!.n).toBe(baseline + 5)

      // Names were absorbed (generated for all 5, claimed_nym for 3).
      const activeNames = (await sql`
        SELECT COUNT(*)::int AS n FROM world_identity_names WHERE retired_at IS NULL
      `) as Array<{ n: number }>
      expect(activeNames[0]!.n).toBe(5 + 3) // 5 generated + 3 claimed_nym

      // ── REVERT ──
      const linkages = await findBackfilledWalletLinkages(sql)
      expect(linkages.length).toBe(5)
      const revertStats = await revertWalletLinkages(sql, linkages, { dryRun: false })
      expect(revertStats.wallets_unlinked).toBe(5)
      expect(revertStats.names_retired).toBe(8) // all minted names retired

      // Baseline restored: active wallet_links back to baseline; names all retired.
      const afterRevert = (await sql`
        SELECT COUNT(*)::int AS n FROM wallet_links WHERE unlinked_at IS NULL
      `) as Array<{ n: number }>
      expect(afterRevert[0]!.n).toBe(baseline)

      const activeNamesAfter = (await sql`
        SELECT COUNT(*)::int AS n FROM world_identity_names WHERE retired_at IS NULL
      `) as Array<{ n: number }>
      expect(activeNamesAfter[0]!.n).toBe(0)

      // ── IDEMPOTENT re-revert ── (no further changes)
      const linkages2 = await findBackfilledWalletLinkages(sql)
      const revert2 = await revertWalletLinkages(sql, linkages2, { dryRun: false })
      expect(revert2.wallets_unlinked).toBe(0) // already unlinked
      expect(revert2.names_retired).toBe(0)
    } finally {
      await sql.close()
    }
  })

  it("dry-run revert writes nothing", async () => {
    const sql = new SQL(databaseUrl)
    try {
      // Backfill one fresh row.
      await backfillWalletOnlyRows(spine, [ROW(99)], { worldSlug: "mibera", dryRun: false })
      const linkages = await findBackfilledWalletLinkages(sql)
      const before = (await sql`
        SELECT COUNT(*)::int AS n FROM wallet_links WHERE unlinked_at IS NULL
      `) as Array<{ n: number }>
      await revertWalletLinkages(sql, linkages, { dryRun: true })
      const after = (await sql`
        SELECT COUNT(*)::int AS n FROM wallet_links WHERE unlinked_at IS NULL
      `) as Array<{ n: number }>
      expect(after[0]!.n).toBe(before[0]!.n) // dry-run changed nothing
    } finally {
      await sql.close()
    }
  })
})
