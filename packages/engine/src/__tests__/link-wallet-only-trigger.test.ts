/**
 * link-wallet-only-trigger.test.ts — engine integration tests for the 0009
 * trigger fix (T2), exercising the REAL PostgresSpineAdapter.
 *
 * The unit-level link-wallet-only.test.ts proves the orchestrator's method
 * trace against an in-memory MockSpine. This integration test proves the
 * end-to-end behavior the bug is about: after `linkWalletOnly` runs against a
 * real Postgres spine (with the 0009 upsert trigger installed), the wallet-only
 * user has a populated `world_identity.nym` — the row that the honey-road
 * navbar reads. Pre-0009 the trigger's bare UPDATE was a 0-row no-op and the
 * row never materialized (the 187-user gap).
 *
 * Engine source is UNCHANGED — this verifies the fix is entirely in the
 * migration (all-callers, at the trigger).
 *
 * Gating + safety mirror the adapter DB-gated tests (TEST_DATABASE_URL,
 * scratch-name guard, drop+migrate-all in beforeAll). The adapter is imported
 * via the @freeside-auth/adapters workspace alias (the canonical concrete
 * impl; the engine depends only on the SpinePort interface, but the test may
 * wire the concrete adapter — same pattern as compose-profile.test.ts wiring
 * the adapters mocks).
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import { SQL } from "bun"
import { resolve } from "node:path"

import { PostgresSpineAdapter } from "@freeside-auth/adapters"
// `migrate` is not re-exported from the adapters barrel; import the runner
// directly (same module the adapter DB-gated tests use), via the cross-package
// relative path (mirrors compose-profile.test.ts importing adapters test mocks).
import { migrate } from "../../../adapters/src/migrate"

import { linkWalletOnly } from "../link-wallet-only"

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL
// The migrations live in the adapters package; resolve relative to it.
const MIGRATIONS_DIR = resolve(__dirname, "..", "..", "..", "adapters", "src", "migrations")

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

async function selectNym(sql: SQL, userId: string, worldSlug: string): Promise<string | null> {
  const rows = (await sql`
    SELECT nym FROM world_identity WHERE user_id = ${userId} AND world_slug = ${worldSlug}
  `) as Array<{ nym: string }>
  return rows[0]?.nym ?? null
}

const ADDR_1 = "0x1111111111111111111111111111111111111111"
const ADDR_2 = "0x2222222222222222222222222222222222222222"
const ADDR_3 = "0x3333333333333333333333333333333333333333"

describe.skipIf(!TEST_DATABASE_URL)("linkWalletOnly + 0009 trigger (T2, real spine)", () => {
  const databaseUrl = TEST_DATABASE_URL as string
  let spine: PostgresSpineAdapter

  beforeAll(async () => {
    if (!looksLikeScratchUrl(databaseUrl)) {
      throw new Error(
        `link-wallet-only-trigger.test: TEST_DATABASE_URL not scratch-shaped (expected: ${SCRATCH_DB_HINTS.join(", ")}).`,
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

  // ── B1: importedNames (the backfill path) → world_identity row, nym=claimed ──

  it("B1: linkWalletOnly with importedNames populates world_identity.nym == the claimed_nym", async () => {
    const result = await linkWalletOnly(spine, {
      worldSlug: "mibera",
      walletAddress: ADDR_1,
      importedNames: [
        { nameType: "generated", value: "MIBERA-A1B2C3" },
        { nameType: "claimed_nym", value: "honeybear" },
      ],
    })
    expect(result.userId).toBeTruthy()

    const sql = new SQL(databaseUrl)
    try {
      // claimed_nym (priority 10) beats generated (priority 50): nym==honeybear.
      expect(await selectNym(sql, result.userId, "mibera")).toBe("honeybear")
    } finally {
      await sql.close()
    }
  })

  // ── B2: no importedNames → claimGeneratedName → world_identity row, nym=MIBERA ─

  it("B2: linkWalletOnly without importedNames mints a generated handle and populates world_identity.nym", async () => {
    const result = await linkWalletOnly(spine, {
      worldSlug: "mibera",
      walletAddress: ADDR_2,
    })
    expect(result.userId).toBeTruthy()

    const sql = new SQL(databaseUrl)
    try {
      const nym = await selectNym(sql, result.userId, "mibera")
      expect(nym).toMatch(/^MIBERA-[A-F0-9]{6}$/)
      // The orchestrator echoes the minted generated value; it matches the row.
      expect(result.generatedName).toBe(nym)
    } finally {
      await sql.close()
    }
  })

  // ── B3: idempotent re-run leaves the world_identity row unchanged ─────────────

  it("B3: re-running linkWalletOnly for the same wallet is idempotent (nym unchanged)", async () => {
    const first = await linkWalletOnly(spine, {
      worldSlug: "mibera",
      walletAddress: ADDR_3,
      importedNames: [{ nameType: "generated", value: "MIBERA-998877" }],
    })
    const sql = new SQL(databaseUrl)
    try {
      const nymAfterFirst = await selectNym(sql, first.userId, "mibera")
      expect(nymAfterFirst).toBe("MIBERA-998877")

      const second = await linkWalletOnly(spine, {
        worldSlug: "mibera",
        walletAddress: ADDR_3,
      })
      expect(second.userId).toBe(first.userId)
      expect(second.idempotent).toBe(true)

      // nym unchanged; exactly one world_identity row for the user/world.
      expect(await selectNym(sql, first.userId, "mibera")).toBe("MIBERA-998877")
      const count = (await sql`
        SELECT COUNT(*)::int AS n FROM world_identity
         WHERE user_id = ${first.userId} AND world_slug = 'mibera'
      `) as Array<{ n: number }>
      expect(count[0]!.n).toBe(1)
    } finally {
      await sql.close()
    }
  })

  // ── B4: claims-if-missing (#39) — known wallet, NO world name → claims ────────

  it("B4: known wallet (SIWE pre-minted) with NO world name → claims-if-missing mints a generated handle", async () => {
    // Simulate the post-SIWE reality: /v1/auth/verify already minted the user
    // and linked the wallet, but no world name was ever assigned. The wallet is
    // KNOWN, so linkWalletOnly takes the idempotent_noop branch — which, per
    // #39, now claims the missing handle instead of a pure no-op.
    const userId = await spine.mintUser()
    await spine.linkWallet({ userId, walletAddress: ADDR_1, isPrimary: true })

    const result = await linkWalletOnly(spine, { worldSlug: "mibera", walletAddress: ADDR_1 })
    expect(result.userId).toBe(userId) // same user — no duplicate mint
    expect(result.idempotent).toBe(true) // known wallet
    expect(result.generatedName).toMatch(/^MIBERA-[A-F0-9]{6}$/) // freshly claimed

    const sql = new SQL(databaseUrl)
    try {
      // The claimed handle populated world_identity.nym (via the 0009 upsert).
      expect(await selectNym(sql, userId, "mibera")).toBe(result.generatedName)
      // Exactly one active generated name row — not a duplicate.
      const count = (await sql`
        SELECT COUNT(*)::int AS n FROM world_identity_names
         WHERE user_id = ${userId} AND world_slug = 'mibera'
           AND name_type = 'generated' AND retired_at IS NULL
      `) as Array<{ n: number }>
      expect(count[0]!.n).toBe(1)
    } finally {
      await sql.close()
    }
  })
})
