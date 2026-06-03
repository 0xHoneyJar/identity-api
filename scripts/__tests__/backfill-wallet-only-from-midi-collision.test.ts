/**
 * backfill-wallet-only-from-midi-collision.test.ts — T3 (sprint-bug-1).
 *
 * The wallet-only backfill ABSORBS honey-road's display_name as a `claimed_nym`.
 * Two midi users shared display_name "rug" → the second `importName` of
 * (mibera, claimed_nym, "rug") hit the partial-unique
 * `uq_world_identity_names_active_value` and raised
 * SpineConflictError(kind="world_identity"), which the bare catch site counted
 * as a hard error (exit 3) — dropping the whole user.
 *
 * The fix: on SpineConflictError with `kind==="world_identity" &&
 * context.name_type==="claimed_nym"`, RETRY `linkWalletOnly` with importedNames
 * stripped to the generated mibera_id only (drop the colliding claimed_nym).
 * The user is then created generated-only and the 0009 trigger populates
 * world_identity.nym = MIBERA-XXXX. A non-claimed_nym conflict still errors
 * (no silent swallow).
 *
 * This test uses a REAL PostgresSpineAdapter against a scratch DB so the actual
 * partial-unique collision + SpineConflictError + 0009 upsert all fire for real.
 *
 * Gating + safety mirror the adapter DB-gated tests (TEST_DATABASE_URL,
 * scratch-name guard, drop+migrate-all in beforeAll).
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import { SQL } from "bun"
import { resolve } from "node:path"

import { PostgresSpineAdapter } from "@freeside-auth/adapters"
import { migrate } from "../../packages/adapters/src/migrate"

import {
  backfillWalletOnlyRows,
  type WalletOnlyMidiRow,
} from "../backfill-wallet-only-from-midi"

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL
const MIGRATIONS_DIR = resolve(__dirname, "..", "..", "packages", "adapters", "src", "migrations")

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
  const tables = (await sql`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public'
  `) as Array<{ tablename: string }>
  for (const t of tables) {
    await sql.unsafe(`DROP TABLE IF EXISTS "${t.tablename}" CASCADE`)
  }
  await sql.unsafe(`DROP FUNCTION IF EXISTS sync_primary_wallet() CASCADE`)
  await sql.unsafe(`DROP FUNCTION IF EXISTS recompute_world_nym() CASCADE`)
}

async function seedWorld(sql: SQL, slug: string): Promise<void> {
  await sql`INSERT INTO worlds (world_slug, display_name) VALUES (${slug}, ${slug}) ON CONFLICT DO NOTHING`
}

const HOLDER_ADDR = "0xaaaa000000000000000000000000000000000001"
const RUG_ADDR = "0xbbbb000000000000000000000000000000000002"
const OTHER_ADDR = "0xcccc000000000000000000000000000000000003"

describe.skipIf(!TEST_DATABASE_URL)("backfill claimed_nym collision retry (T3, real spine)", () => {
  const databaseUrl = TEST_DATABASE_URL as string
  let spine: PostgresSpineAdapter

  beforeAll(async () => {
    if (!looksLikeScratchUrl(databaseUrl)) {
      throw new Error(
        `backfill-collision.test: TEST_DATABASE_URL not scratch-shaped (expected: ${SCRATCH_DB_HINTS.join(", ")}).`,
      )
    }
    const sql = new SQL(databaseUrl)
    try {
      await dropEverything(sql)
    } finally {
      await sql.close()
    }
    const result = await migrate({ databaseUrl, migrationsDir: MIGRATIONS_DIR, verb: "up" })
    if (result.verb !== "up") throw new Error(`expected verb up, got ${result.verb}`)

    spine = new PostgresSpineAdapter(databaseUrl)
    const seedSql = new SQL(databaseUrl)
    try {
      await seedWorld(seedSql, "mibera")
    } finally {
      await seedSql.close()
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

  afterEach(async () => {
    const sql = new SQL(databaseUrl)
    try {
      await sql.unsafe(`
        TRUNCATE world_identity_names, world_identity, wallet_links, linked_accounts, audit_events, users RESTART IDENTITY CASCADE;
      `)
      await seedWorld(sql, "mibera")
    } finally {
      await sql.close()
    }
  })

  async function selectNym(sql: SQL, userId: string): Promise<string | null> {
    const rows = (await sql`
      SELECT nym FROM world_identity WHERE user_id = ${userId} AND world_slug = 'mibera'
    `) as Array<{ nym: string }>
    return rows[0]?.nym ?? null
  }

  // ── retry creates the colliding user generated-only ──────────────────────────

  it("retries claimed_nym collision generated-only: user created with MIBERA-XXXX, claimedNymDropped==1, exit 0", async () => {
    // Prior holder already claimed (mibera, claimed_nym, "rug").
    const holderRows: WalletOnlyMidiRow[] = [
      { wallet_address: HOLDER_ADDR, dynamic_user_id: null, mibera_id: "MIBERA-111111", display_name: "rug" },
    ]
    const holderStats = await backfillWalletOnlyRows(spine, holderRows, {
      worldSlug: "mibera",
      dryRun: false,
      onLog: () => {},
    })
    expect(holderStats.created).toBe(1)
    expect(holderStats.errors).toBe(0)

    // The colliding row: a DIFFERENT user with the same display_name "rug".
    const collidingRows: WalletOnlyMidiRow[] = [
      { wallet_address: RUG_ADDR, dynamic_user_id: null, mibera_id: "MIBERA-222222", display_name: "rug" },
    ]
    const stats = await backfillWalletOnlyRows(spine, collidingRows, {
      worldSlug: "mibera",
      dryRun: false,
      onLog: () => {},
    })

    expect(stats.created).toBe(1)
    expect(stats.errors).toBe(0)
    expect(stats.claimedNymDropped).toBe(1)

    // The colliding user exists, generated-only, nym == its own MIBERA-XXXX
    // (NOT "rug" — that was dropped).
    const sql = new SQL(databaseUrl)
    try {
      const users = (await sql`
        SELECT wi.user_id, wi.nym
          FROM world_identity wi
          JOIN wallet_links wl ON wl.user_id = wi.user_id
         WHERE wl.wallet_address = ${RUG_ADDR.toLowerCase()}
      `) as Array<{ user_id: string; nym: string }>
      expect(users.length).toBe(1)
      expect(users[0]!.nym).toBe("MIBERA-222222")

      // The dropped claimed_nym must NOT exist as an active name row for them.
      const claimed = (await sql`
        SELECT value FROM world_identity_names
         WHERE user_id = ${users[0]!.user_id} AND name_type = 'claimed_nym' AND retired_at IS NULL
      `) as Array<{ value: string }>
      expect(claimed.length).toBe(0)
    } finally {
      await sql.close()
    }
  })

  // ── a non-claimed_nym conflict still errors (no silent swallow) ───────────────

  it("a non-claimed_nym world_identity conflict still increments stats.errors", async () => {
    // Holder takes the GENERATED value MIBERA-333333.
    const holderRows: WalletOnlyMidiRow[] = [
      { wallet_address: OTHER_ADDR, dynamic_user_id: null, mibera_id: "MIBERA-333333", display_name: null },
    ]
    const holderStats = await backfillWalletOnlyRows(spine, holderRows, {
      worldSlug: "mibera",
      dryRun: false,
      onLog: () => {},
    })
    expect(holderStats.created).toBe(1)

    // A different wallet whose mibera_id collides on the GENERATED value
    // (not a claimed_nym). The retry must NOT fire — this is a real error.
    const collidingRows: WalletOnlyMidiRow[] = [
      { wallet_address: HOLDER_ADDR, dynamic_user_id: null, mibera_id: "MIBERA-333333", display_name: null },
    ]
    const stats = await backfillWalletOnlyRows(spine, collidingRows, {
      worldSlug: "mibera",
      dryRun: false,
      onLog: () => {},
    })

    expect(stats.errors).toBe(1)
    expect(stats.created).toBe(0)
    expect(stats.claimedNymDropped).toBe(0)
  })
})
