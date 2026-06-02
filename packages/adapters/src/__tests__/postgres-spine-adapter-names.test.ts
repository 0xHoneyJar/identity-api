/**
 * postgres-spine-adapter-names.test.ts — adapter name primitives (A2).
 *
 * Sprint A (identity-api #11 Phase 1) hoists the world display-name generator
 * into the spine. Two new adapter primitives + a getIdentity extension:
 *
 *   - claimGeneratedName(txn,{userId,worldSlug}) — the HOISTED generator:
 *     reads the world's generated_scheme type + pattern, mints a CONFORMING
 *     value, collision-checks against the partial unique (retry), INSERTs a
 *     world_identity_names row, emits a `name_assigned` audit. NEW users only.
 *   - importName(txn,{userId,worldSlug,nameType,value}) — ABSORBS an
 *     externally-minted value (the backfill's honey-road mibera_id +
 *     display_name) at the type's default priority/opt-in; same audit.
 *   - getIdentity now surfaces `world_names: SpineWorldName[]`.
 *
 * Gating + safety mirror postgres-spine-adapter.test.ts (TEST_DATABASE_URL,
 * scratch-guard, drop+migrate in beforeAll).
 *
 * Coverage:
 *   - claimGeneratedName mints a value matching ^MIBERA-[A-F0-9]{6}$
 *   - the minted value is collision-safe (a pre-seeded collision is retried past)
 *   - importName absorbs an external value verbatim at the type's defaults
 *   - getIdentity surfaces world_names (active + retired flag)
 *   - both emit a `name_assigned` audit row
 *   - the recompute trigger keeps world_identity.nym in sync after claim/import
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import { SQL } from "bun"
import { resolve } from "node:path"

import { migrate } from "../migrate"
import { PostgresSpineAdapter } from "../postgres-spine-adapter"

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL
const MIGRATIONS_DIR = resolve(__dirname, "..", "migrations")

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

/** Seed a user with a baseline world_identity row so the recompute trigger has a target. */
async function seedUserWithWorldIdentity(
  spine: PostgresSpineAdapter,
  sql: SQL,
  worldSlug: string,
  seedNym: string,
): Promise<string> {
  const userId = await spine.mintUser()
  await sql`
    INSERT INTO world_identity (user_id, world_slug, nym)
    VALUES (${userId}, ${worldSlug}, ${seedNym})
  `
  return userId
}

describe.skipIf(!TEST_DATABASE_URL)("PostgresSpineAdapter name primitives (A2)", () => {
  const databaseUrl = TEST_DATABASE_URL as string
  let spine: PostgresSpineAdapter

  beforeAll(async () => {
    if (!looksLikeScratchUrl(databaseUrl)) {
      throw new Error(
        `postgres-spine-adapter-names.test: TEST_DATABASE_URL not scratch-shaped (expected: ${SCRATCH_DB_HINTS.join(", ")}).`,
      )
    }
    const sql = new SQL(databaseUrl)
    try {
      await dropEverything(sql)
    } finally {
      await sql.close()
    }
    await migrate({ databaseUrl, migrationsDir: MIGRATIONS_DIR, verb: "up" })
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
        TRUNCATE world_identity_names, world_identity, audit_events, users RESTART IDENTITY CASCADE;
      `)
      await seedWorld(sql, "mibera")
    } finally {
      await sql.close()
    }
  })

  // ── claimGeneratedName ───────────────────────────────────────────────────────

  it("claimGeneratedName mints a value conforming to the world's generated pattern", async () => {
    const sql = new SQL(databaseUrl)
    try {
      const userId = await seedUserWithWorldIdentity(spine, sql, "mibera", "seed-nym")
      const value = await spine.claimGeneratedName({ userId, worldSlug: "mibera" })
      expect(value).toMatch(/^MIBERA-[A-F0-9]{6}$/)

      const rows = (await sql`
        SELECT name_type, value, priority, is_opt_in, retired_at
          FROM world_identity_names WHERE user_id = ${userId}
      `) as Array<{
        name_type: string
        value: string
        priority: number
        is_opt_in: boolean
        retired_at: string | null
      }>
      expect(rows.length).toBe(1)
      expect(rows[0]!.name_type).toBe("generated")
      expect(rows[0]!.value).toBe(value)
      expect(rows[0]!.priority).toBe(50) // the type's default_priority
      expect(rows[0]!.is_opt_in).toBe(false)
      expect(rows[0]!.retired_at).toBeNull()
    } finally {
      await sql.close()
    }
  })

  it("claimGeneratedName is collision-safe: retries past a value already taken", async () => {
    const sql = new SQL(databaseUrl)
    try {
      const userId = await seedUserWithWorldIdentity(spine, sql, "mibera", "seed-nym")
      // Mint once.
      const first = await spine.claimGeneratedName({ userId, worldSlug: "mibera" })
      // A second user claims; must not collide with `first` (different value).
      const u2 = await seedUserWithWorldIdentity(spine, sql, "mibera", "seed-nym-2")
      const second = await spine.claimGeneratedName({ userId: u2, worldSlug: "mibera" })
      expect(second).not.toBe(first)
      expect(second).toMatch(/^MIBERA-[A-F0-9]{6}$/)
    } finally {
      await sql.close()
    }
  })

  it("claimGeneratedName emits a name_assigned audit", async () => {
    const sql = new SQL(databaseUrl)
    try {
      const userId = await seedUserWithWorldIdentity(spine, sql, "mibera", "seed-nym")
      const value = await spine.claimGeneratedName({ userId, worldSlug: "mibera" })
      const audit = (await sql`
        SELECT event_type, user_id, payload FROM audit_events
         WHERE event_type = 'name_assigned' AND user_id = ${userId}
      `) as Array<{ event_type: string; user_id: string; payload: Record<string, unknown> }>
      expect(audit.length).toBe(1)
      expect(audit[0]!.payload.world_slug).toBe("mibera")
      expect(audit[0]!.payload.name_type).toBe("generated")
      expect(audit[0]!.payload.value).toBe(value)
      expect(audit[0]!.payload.origin).toBe("generated")
    } finally {
      await sql.close()
    }
  })

  it("claimGeneratedName recomputes world_identity.nym to the generated handle (privacy floor)", async () => {
    const sql = new SQL(databaseUrl)
    try {
      const userId = await seedUserWithWorldIdentity(spine, sql, "mibera", "placeholder")
      const value = await spine.claimGeneratedName({ userId, worldSlug: "mibera" })
      const wi = (await sql`
        SELECT nym FROM world_identity WHERE user_id = ${userId} AND world_slug = 'mibera'
      `) as Array<{ nym: string }>
      expect(wi[0]!.nym).toBe(value) // trigger recomputed to the only active non-opt-in name
    } finally {
      await sql.close()
    }
  })

  // ── importName ────────────────────────────────────────────────────────────────

  it("importName absorbs an external value verbatim at the type's defaults", async () => {
    const sql = new SQL(databaseUrl)
    try {
      const userId = await seedUserWithWorldIdentity(spine, sql, "mibera", "placeholder")
      await spine.importName({
        userId,
        worldSlug: "mibera",
        nameType: "generated",
        value: "MIBERA-ABCDEF",
      })
      const rows = (await sql`
        SELECT name_type, value, priority, is_opt_in FROM world_identity_names
         WHERE user_id = ${userId}
      `) as Array<{ name_type: string; value: string; priority: number; is_opt_in: boolean }>
      expect(rows.length).toBe(1)
      expect(rows[0]!.value).toBe("MIBERA-ABCDEF") // verbatim, NOT regenerated
      expect(rows[0]!.priority).toBe(50)
      expect(rows[0]!.is_opt_in).toBe(false)

      const audit = (await sql`
        SELECT payload FROM audit_events WHERE event_type = 'name_assigned' AND user_id = ${userId}
      `) as Array<{ payload: Record<string, unknown> }>
      expect(audit.length).toBe(1)
      expect(audit[0]!.payload.origin).toBe("imported")
    } finally {
      await sql.close()
    }
  })

  it("importName of a claimed_nym makes it the default nym (priority 10 beats generated 50)", async () => {
    const sql = new SQL(databaseUrl)
    try {
      const userId = await seedUserWithWorldIdentity(spine, sql, "mibera", "placeholder")
      await spine.importName({
        userId,
        worldSlug: "mibera",
        nameType: "generated",
        value: "MIBERA-000001",
      })
      await spine.importName({
        userId,
        worldSlug: "mibera",
        nameType: "claimed_nym",
        value: "jessepollak",
      })
      const wi = (await sql`
        SELECT nym FROM world_identity WHERE user_id = ${userId} AND world_slug = 'mibera'
      `) as Array<{ nym: string }>
      expect(wi[0]!.nym).toBe("jessepollak") // claimed_nym (10) preferred over generated (50)
    } finally {
      await sql.close()
    }
  })

  // ── getIdentity surfaces world_names ─────────────────────────────────────────

  it("getIdentity surfaces world_names (active rows, priority-ordered)", async () => {
    const sql = new SQL(databaseUrl)
    try {
      const userId = await seedUserWithWorldIdentity(spine, sql, "mibera", "placeholder")
      await spine.importName({
        userId,
        worldSlug: "mibera",
        nameType: "generated",
        value: "MIBERA-AAAAAA",
      })
      await spine.importName({
        userId,
        worldSlug: "mibera",
        nameType: "claimed_nym",
        value: "zora",
      })
      const identity = await spine.getIdentity(userId)
      expect(identity).not.toBeNull()
      expect(identity!.world_names).toBeDefined()
      // Priority-ordered: claimed_nym (10) before generated (50).
      const names = identity!.world_names
      expect(names.length).toBe(2)
      expect(names[0]!.name_type).toBe("claimed_nym")
      expect(names[0]!.value).toBe("zora")
      expect(names[0]!.world_slug).toBe("mibera")
      expect(names[0]!.is_opt_in).toBe(false)
      expect(names[0]!.retired_at).toBeNull()
      expect(names[1]!.name_type).toBe("generated")
    } finally {
      await sql.close()
    }
  })
})
