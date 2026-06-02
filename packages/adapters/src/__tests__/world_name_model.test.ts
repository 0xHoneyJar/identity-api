/**
 * world_name_model.test.ts — behavior tests for migration 0008 (A1).
 *
 * Sprint A (identity-api #11 Phase 1) introduces the world NAME REGISTRY:
 * the spine becomes the sole generator/owner of world display-names. The
 * flat `world_identity.nym TEXT` (0001) is extended (NOT replaced) by a
 * typed, prioritized, soft-retireable name registry:
 *
 *   - world_name_types  — per-world scheme registry (generated/derived/authored)
 *   - world_identity_names — per-user typed name rows (multiple per user/world)
 *
 * The old single-column `UNIQUE (world_slug, nym)` on world_identity is
 * REPLACED by a partial unique index on
 * `(world_slug, name_type, value) WHERE retired_at IS NULL` — incompatible
 * with the multi-name model. `world_identity.nym` is KEPT as a denormalized
 * default-display pointer; a BEFORE trigger recomputes it from the lowest-
 * priority active non-opt-in name row (mirrors 0002_primary_wallet_trigger).
 *
 * Strategy mirrors primary_wallet_trigger.test.ts / migrate.test.ts:
 *   - GATED on TEST_DATABASE_URL (skips without it — CI has no PG).
 *   - Refuses non-scratch-shaped DB names (won't drop a real DB).
 *   - SELF-CONTAINED: drops ALL spine state, applies 0001..0008 from clean,
 *     so the suite does not depend on prior migrations' run order. (The
 *     existing primary_wallet_trigger.test.ts down/up assertions are stale
 *     re: 0003-0007 and are NOT touched here.)
 *
 * Cases:
 *   1. structure        — both tables present with the spec'd columns + FKs
 *   2. uniqueness moved  — old UNIQUE(world_slug,nym) gone; partial unique present
 *   3. seed              — mibera seeded with claimed_nym/generated/raw_short_addr
 *   4. nym preserved     — world_identity.nym column still present; PK intact
 *   5. trigger present   — recompute trigger installed on world_identity_names
 *   6. trigger recompute — inserting name rows recomputes world_identity.nym to
 *                          the lowest-priority active non-opt-in value
 *   7. soft-retire       — partial unique allows re-use of a retired value;
 *                          active duplicate is rejected
 *   8. claimNym path     — direct world_identity INSERT (claimNymWithAudit path)
 *                          still works after the migration (R-3)
 *   9. down              — drops trigger + both tables; nym untouched; partial
 *                          unique gone, old UNIQUE(world_slug,nym) restored
 *  10. up-after-down     — re-applies cleanly, round-trips
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { SQL } from "bun"
import { resolve } from "node:path"

import { migrate } from "../migrate"

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

/**
 * Drop EVERY public table + the trigger functions, so the suite applies
 * 0001..0008 onto a guaranteed-clean DB regardless of what a prior test file
 * left behind. Discovers tables dynamically so new migrations don't strand
 * tables (the gap that breaks primary_wallet_trigger.test's static drop list).
 */
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

async function applyAllUp(databaseUrl: string): Promise<void> {
  const result = await migrate({ databaseUrl, migrationsDir: MIGRATIONS_DIR, verb: "up" })
  if (result.verb !== "up") throw new Error(`expected verb up, got ${result.verb}`)
}

async function columnNames(sql: SQL, table: string): Promise<string[]> {
  const rows = (await sql`
    SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = ${table}
     ORDER BY column_name
  `) as Array<{ column_name: string }>
  return rows.map((r) => r.column_name)
}

async function indexNames(sql: SQL, table: string): Promise<string[]> {
  const rows = (await sql`
    SELECT indexname FROM pg_indexes
     WHERE schemaname = 'public' AND tablename = ${table}
     ORDER BY indexname
  `) as Array<{ indexname: string }>
  return rows.map((r) => r.indexname)
}

/** Seed a world + user; return userId. */
async function seedWorldAndUser(sql: SQL, slug: string): Promise<string> {
  await sql`INSERT INTO worlds (world_slug, display_name) VALUES (${slug}, ${slug}) ON CONFLICT DO NOTHING`
  const rows = (await sql`INSERT INTO users DEFAULT VALUES RETURNING user_id`) as Array<{
    user_id: string
  }>
  return rows[0]!.user_id
}

describe.skipIf(!TEST_DATABASE_URL)("0008 world name model (A1)", () => {
  const databaseUrl = TEST_DATABASE_URL as string

  beforeAll(async () => {
    if (!looksLikeScratchUrl(databaseUrl)) {
      throw new Error(
        `world_name_model.test: TEST_DATABASE_URL DB name does not look scratch-shaped (expected to contain one of: ${SCRATCH_DB_HINTS.join(", ")}). Refusing to drop tables on a non-scratch DB.`,
      )
    }
    const sql = new SQL(databaseUrl)
    try {
      await dropEverything(sql)
    } finally {
      await sql.close()
    }
    await applyAllUp(databaseUrl)
  })

  afterAll(async () => {
    const sql = new SQL(databaseUrl)
    try {
      await dropEverything(sql)
    } finally {
      await sql.close()
    }
  })

  // ── 1. structure ───────────────────────────────────────────────────────────

  it("creates world_name_types + world_identity_names with the spec'd columns", async () => {
    const sql = new SQL(databaseUrl)
    try {
      const types = await columnNames(sql, "world_name_types")
      expect(types).toEqual(
        [
          "created_at",
          "default_priority",
          "generator_kind",
          "is_opt_in",
          "name_type",
          "pattern",
          "world_slug",
        ].sort(),
      )

      const names = await columnNames(sql, "world_identity_names")
      expect(names).toEqual(
        [
          "assigned_at",
          "is_opt_in",
          "name_type",
          "priority",
          "retired_at",
          "user_id",
          "value",
          "world_slug",
        ].sort(),
      )
    } finally {
      await sql.close()
    }
  })

  // ── 2. uniqueness moved ──────────────────────────────────────────────────────

  it("ADDS the per-type partial unique on world_identity_names while KEEPING world_identity's UNIQUE(world_slug,nym)", async () => {
    const sql = new SQL(databaseUrl)
    try {
      // Divergence-with-rationale (see 0008.up): the old per-nym unique on
      // world_identity is KEPT — the live route GET /v1/resolve/nym depends on
      // world-nym uniqueness for its LIMIT-1 lookup. The registry adds a
      // SEPARATE per-(type,value) partial unique; it does not replace the
      // denorm-pointer guarantee.
      const wiConstraints = (await sql`
        SELECT conname FROM pg_constraint c
          JOIN pg_class t ON t.oid = c.conrelid
         WHERE t.relname = 'world_identity' AND c.contype = 'u'
      `) as Array<{ conname: string }>
      expect(wiConstraints.length).toBe(1) // UNIQUE(world_slug, nym) KEPT

      // The per-type partial unique index lives on world_identity_names.
      const idx = await indexNames(sql, "world_identity_names")
      expect(idx).toContain("uq_world_identity_names_active_value")
    } finally {
      await sql.close()
    }
  })

  // ── 3. seed ──────────────────────────────────────────────────────────────────

  it("seeds mibera with claimed_nym / generated / raw_short_addr name types", async () => {
    const sql = new SQL(databaseUrl)
    try {
      const rows = (await sql`
        SELECT name_type, generator_kind, pattern, default_priority, is_opt_in
          FROM world_name_types WHERE world_slug = 'mibera'
         ORDER BY default_priority ASC
      `) as Array<{
        name_type: string
        generator_kind: string
        pattern: string | null
        default_priority: number
        is_opt_in: boolean
      }>
      expect(rows).toEqual([
        {
          name_type: "claimed_nym",
          generator_kind: "authored",
          pattern: null,
          default_priority: 10,
          is_opt_in: false,
        },
        {
          name_type: "generated",
          generator_kind: "generated_scheme",
          pattern: "^MIBERA-[A-F0-9]{6}$",
          default_priority: 50,
          is_opt_in: false,
        },
        {
          name_type: "raw_short_addr",
          generator_kind: "derived",
          pattern: null,
          default_priority: 90,
          is_opt_in: true,
        },
      ])
    } finally {
      await sql.close()
    }
  })

  // ── 4. nym preserved ─────────────────────────────────────────────────────────

  it("keeps world_identity.nym + its PK (claimNymWithAudit path survives)", async () => {
    const sql = new SQL(databaseUrl)
    try {
      const cols = await columnNames(sql, "world_identity")
      expect(cols).toContain("nym")

      const pk = (await sql`
        SELECT conname FROM pg_constraint c
          JOIN pg_class t ON t.oid = c.conrelid
         WHERE t.relname = 'world_identity' AND c.contype = 'p'
      `) as Array<{ conname: string }>
      expect(pk.length).toBe(1) // PK (user_id, world_slug) intact
    } finally {
      await sql.close()
    }
  })

  // ── 5. trigger present ───────────────────────────────────────────────────────

  it("installs the nym-recompute trigger on world_identity_names", async () => {
    const sql = new SQL(databaseUrl)
    try {
      const triggers = (await sql`
        SELECT trigger_name, action_timing
          FROM information_schema.triggers
         WHERE event_object_table = 'world_identity_names'
           AND trigger_name = 'trg_recompute_world_nym'
      `) as Array<{ trigger_name: string; action_timing: string }>
      expect(triggers.length).toBeGreaterThan(0)
      for (const t of triggers) expect(t.action_timing).toBe("AFTER")

      const fn = (await sql`
        SELECT proname FROM pg_proc WHERE proname = 'recompute_world_nym'
      `) as Array<{ proname: string }>
      expect(fn.map((r) => r.proname)).toContain("recompute_world_nym")
    } finally {
      await sql.close()
    }
  })

  // ── 6. trigger recompute ─────────────────────────────────────────────────────

  it("recomputes world_identity.nym to the lowest-priority active non-opt-in name", async () => {
    const sql = new SQL(databaseUrl)
    try {
      const userId = await seedWorldAndUser(sql, "mibera")
      // Seed a baseline world_identity row (nym is the denorm pointer; start
      // it as the generated handle so the PK row exists).
      await sql`
        INSERT INTO world_identity (user_id, world_slug, nym)
        VALUES (${userId}, 'mibera', 'MIBERA-ABCDEF')
      `

      // Insert the generated name row (priority 50).
      await sql`
        INSERT INTO world_identity_names (user_id, world_slug, name_type, value, priority, is_opt_in)
        VALUES (${userId}, 'mibera', 'generated', 'MIBERA-ABCDEF', 50, false)
      `
      let wi = (await sql`
        SELECT nym FROM world_identity WHERE user_id = ${userId} AND world_slug = 'mibera'
      `) as Array<{ nym: string }>
      expect(wi[0]!.nym).toBe("MIBERA-ABCDEF")

      // Now insert a claimed_nym (priority 10 — preferred). nym recomputes.
      await sql`
        INSERT INTO world_identity_names (user_id, world_slug, name_type, value, priority, is_opt_in)
        VALUES (${userId}, 'mibera', 'claimed_nym', 'satoshi', 10, false)
      `
      wi = (await sql`
        SELECT nym FROM world_identity WHERE user_id = ${userId} AND world_slug = 'mibera'
      `) as Array<{ nym: string }>
      expect(wi[0]!.nym).toBe("satoshi")

      // An opt-in name (raw_short_addr, priority 90) must NEVER win the default.
      await sql`
        INSERT INTO world_identity_names (user_id, world_slug, name_type, value, priority, is_opt_in)
        VALUES (${userId}, 'mibera', 'raw_short_addr', '0xAB…cd', 90, true)
      `
      wi = (await sql`
        SELECT nym FROM world_identity WHERE user_id = ${userId} AND world_slug = 'mibera'
      `) as Array<{ nym: string }>
      expect(wi[0]!.nym).toBe("satoshi") // unchanged — opt-in excluded

      // Retire the claimed_nym → nym falls back to the generated handle, NOT
      // the opt-in raw address.
      await sql`
        UPDATE world_identity_names SET retired_at = NOW()
         WHERE user_id = ${userId} AND world_slug = 'mibera' AND name_type = 'claimed_nym'
      `
      wi = (await sql`
        SELECT nym FROM world_identity WHERE user_id = ${userId} AND world_slug = 'mibera'
      `) as Array<{ nym: string }>
      expect(wi[0]!.nym).toBe("MIBERA-ABCDEF") // generated floor, never the raw addr

      await sql`DELETE FROM world_identity_names WHERE user_id = ${userId}`
      await sql`DELETE FROM world_identity WHERE user_id = ${userId}`
      await sql`DELETE FROM users WHERE user_id = ${userId}`
    } finally {
      await sql.close()
    }
  })

  // ── 7. soft-retire + partial unique ──────────────────────────────────────────

  it("partial unique rejects an active duplicate value but allows re-use after retire", async () => {
    const sql = new SQL(databaseUrl)
    try {
      const u1 = await seedWorldAndUser(sql, "mibera")
      const u2 = await seedWorldAndUser(sql, "mibera")

      await sql`
        INSERT INTO world_identity_names (user_id, world_slug, name_type, value, priority, is_opt_in)
        VALUES (${u1}, 'mibera', 'claimed_nym', 'duke', 10, false)
      `

      // Active duplicate of the same (world, type, value) → rejected.
      let raised = false
      try {
        await sql`
          INSERT INTO world_identity_names (user_id, world_slug, name_type, value, priority, is_opt_in)
          VALUES (${u2}, 'mibera', 'claimed_nym', 'duke', 10, false)
        `
      } catch {
        raised = true
      }
      expect(raised).toBe(true)

      // Retire u1's 'duke' → u2 may now claim it.
      await sql`
        UPDATE world_identity_names SET retired_at = NOW()
         WHERE user_id = ${u1} AND name_type = 'claimed_nym' AND value = 'duke'
      `
      await sql`
        INSERT INTO world_identity_names (user_id, world_slug, name_type, value, priority, is_opt_in)
        VALUES (${u2}, 'mibera', 'claimed_nym', 'duke', 10, false)
      `
      const active = (await sql`
        SELECT COUNT(*)::int AS n FROM world_identity_names
         WHERE world_slug = 'mibera' AND name_type = 'claimed_nym' AND value = 'duke'
           AND retired_at IS NULL
      `) as Array<{ n: number }>
      expect(active[0]!.n).toBe(1)

      await sql`DELETE FROM world_identity_names WHERE user_id IN (${u1}, ${u2})`
      await sql`DELETE FROM users WHERE user_id IN (${u1}, ${u2})`
    } finally {
      await sql.close()
    }
  })

  // ── 8. claimNym path survives ────────────────────────────────────────────────

  it("a direct world_identity INSERT (claimNymWithAudit path) still works post-migration", async () => {
    const sql = new SQL(databaseUrl)
    try {
      const userId = await seedWorldAndUser(sql, "mibera")
      // claimNymWithAudit writes world_identity directly with a nym. The old
      // UNIQUE(world_slug,nym) is gone but the PK (user_id, world_slug) still
      // guards "one nym row per user/world".
      await sql`
        INSERT INTO world_identity (user_id, world_slug, nym)
        VALUES (${userId}, 'mibera', 'direct-claim')
      `
      const wi = (await sql`
        SELECT nym FROM world_identity WHERE user_id = ${userId} AND world_slug = 'mibera'
      `) as Array<{ nym: string }>
      expect(wi[0]!.nym).toBe("direct-claim")

      await sql`DELETE FROM world_identity WHERE user_id = ${userId}`
      await sql`DELETE FROM users WHERE user_id = ${userId}`
    } finally {
      await sql.close()
    }
  })

  // ── 9. down ──────────────────────────────────────────────────────────────────

  it("down: drops trigger + both tables; nym + its UNIQUE(world_slug,nym) untouched", async () => {
    const result = await migrate({ databaseUrl, migrationsDir: MIGRATIONS_DIR, verb: "down" })
    expect(result).toEqual({ verb: "down", reverted: "0008_world_name_model" })

    const sql = new SQL(databaseUrl)
    try {
      const tablesGone = (await sql`
        SELECT tablename FROM pg_tables
         WHERE schemaname = 'public'
           AND tablename IN ('world_name_types', 'world_identity_names')
      `) as Array<{ tablename: string }>
      expect(tablesGone).toEqual([])

      const fn = (await sql`
        SELECT proname FROM pg_proc WHERE proname = 'recompute_world_nym'
      `) as Array<{ proname: string }>
      expect(fn).toEqual([])

      // nym column + its UNIQUE(world_slug, nym) survive (never dropped by up).
      const cols = await columnNames(sql, "world_identity")
      expect(cols).toContain("nym")
      const wiUnique = (await sql`
        SELECT conname FROM pg_constraint c
          JOIN pg_class t ON t.oid = c.conrelid
         WHERE t.relname = 'world_identity' AND c.contype = 'u'
      `) as Array<{ conname: string }>
      expect(wiUnique.length).toBe(1) // UNIQUE(world_slug, nym) intact
    } finally {
      await sql.close()
    }
  })

  // ── 10. up-after-down ────────────────────────────────────────────────────────

  it("up after down: re-applies 0008 cleanly (round-trip)", async () => {
    const result = await migrate({ databaseUrl, migrationsDir: MIGRATIONS_DIR, verb: "up" })
    expect(result).toEqual({ verb: "up", applied: ["0008_world_name_model"] })

    const sql = new SQL(databaseUrl)
    try {
      const idx = await indexNames(sql, "world_identity_names")
      expect(idx).toContain("uq_world_identity_names_active_value")
      const seeded = (await sql`
        SELECT COUNT(*)::int AS n FROM world_name_types WHERE world_slug = 'mibera'
      `) as Array<{ n: number }>
      expect(seeded[0]!.n).toBe(3)
    } finally {
      await sql.close()
    }
  })
})
