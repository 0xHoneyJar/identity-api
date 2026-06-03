/**
 * world_identity_upsert_trigger.test.ts — behavior tests for migration 0009 (T1).
 *
 * Bug fix (identity-api #11 Phase 1, sprint-bug-1). The 0008 `recompute_world_nym()`
 * trigger body does a bare `UPDATE world_identity` — a 0-row no-op when no
 * `world_identity` row exists yet. Wallet-only ingress (linkWalletOnly) writes
 * only `world_identity_names` rows and NEVER a `world_identity` row, so 187
 * wallet-only users ended up with name rows but no denorm `world_identity.nym`
 * — the honey-road navbar then renders raw addresses.
 *
 * 0009 changes the trigger body from `UPDATE` to an UPSERT
 * (`INSERT … ON CONFLICT (user_id, world_slug) DO UPDATE … WHERE nym IS DISTINCT`)
 * so the FIRST `world_identity_names` write self-heals the missing
 * `world_identity` row — an all-callers fix at the trigger, not per-caller.
 *
 * Gating + safety mirror world_name_model.test.ts:
 *   - GATED on TEST_DATABASE_URL (skips without it — CI has no PG).
 *   - Refuses non-scratch-shaped DB names (won't drop a real DB).
 *   - SELF-CONTAINED: drops ALL spine state, applies 0001..0009 from clean.
 *
 * Cases:
 *   A1 — insert a world_identity_names row (generated, NO pre-existing
 *        world_identity) → a world_identity row now exists with nym=value.
 *        Pre-0009 this FAILS (0-row UPDATE no-op).
 *   A2 — claimed_nym (priority 10) wins over generated (priority 50) via the
 *        upsert path too.
 *   A3 — IS DISTINCT-skip idempotent: re-firing on an unchanged winner does
 *        not churn world_identity (no needless UPDATE).
 *   Safety — a direct world_identity INSERT (claimNym path) on the same
 *        (user, world) does not raise a spurious PK conflict when a later
 *        name-write recomputes (locks the resolved safety question).
 *   A4 — `migrate down 0009` restores the UPDATE-only (broken) behavior,
 *        proving reversibility (run LAST; re-applies 0009 after).
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
 * 0001..0009 onto a guaranteed-clean DB regardless of what a prior test file
 * left behind. Mirrors world_name_model.test.ts.
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

/** Seed a world + user; return userId. */
async function seedWorldAndUser(sql: SQL, slug: string): Promise<string> {
  await sql`INSERT INTO worlds (world_slug, display_name) VALUES (${slug}, ${slug}) ON CONFLICT DO NOTHING`
  const rows = (await sql`INSERT INTO users DEFAULT VALUES RETURNING user_id`) as Array<{
    user_id: string
  }>
  return rows[0]!.user_id
}

async function selectNym(sql: SQL, userId: string, worldSlug: string): Promise<string | null> {
  const rows = (await sql`
    SELECT nym FROM world_identity WHERE user_id = ${userId} AND world_slug = ${worldSlug}
  `) as Array<{ nym: string }>
  return rows[0]?.nym ?? null
}

describe.skipIf(!TEST_DATABASE_URL)("0009 world_identity upsert trigger (T1)", () => {
  const databaseUrl = TEST_DATABASE_URL as string

  beforeAll(async () => {
    if (!looksLikeScratchUrl(databaseUrl)) {
      throw new Error(
        `world_identity_upsert_trigger.test: TEST_DATABASE_URL DB name does not look scratch-shaped (expected to contain one of: ${SCRATCH_DB_HINTS.join(", ")}). Refusing to drop tables on a non-scratch DB.`,
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

  // ── A1: the core fix — name write SELF-HEALS a missing world_identity row ─────

  it("A1: inserting a world_identity_names row (no pre-existing world_identity) creates the world_identity row with nym=value", async () => {
    const sql = new SQL(databaseUrl)
    try {
      const userId = await seedWorldAndUser(sql, "mibera")

      // Precondition: no world_identity row exists yet (the wallet-only gap).
      expect(await selectNym(sql, userId, "mibera")).toBeNull()

      // Write ONLY a generated name row — exactly what linkWalletOnly does.
      // Pre-0009 the trigger's bare UPDATE is a 0-row no-op → nym stays absent.
      await sql`
        INSERT INTO world_identity_names (user_id, world_slug, name_type, value, priority, is_opt_in)
        VALUES (${userId}, 'mibera', 'generated', 'MIBERA-AABBCC', 50, false)
      `

      // Post-0009: the upsert created the row.
      expect(await selectNym(sql, userId, "mibera")).toBe("MIBERA-AABBCC")

      await sql`DELETE FROM world_identity_names WHERE user_id = ${userId}`
      await sql`DELETE FROM world_identity WHERE user_id = ${userId}`
      await sql`DELETE FROM users WHERE user_id = ${userId}`
    } finally {
      await sql.close()
    }
  })

  // ── A2: priority still resolves correctly through the upsert path ─────────────

  it("A2: claimed_nym (priority 10) wins over generated (priority 50) via the upsert", async () => {
    const sql = new SQL(databaseUrl)
    try {
      const userId = await seedWorldAndUser(sql, "mibera")

      // Generated first → row created with the generated handle.
      await sql`
        INSERT INTO world_identity_names (user_id, world_slug, name_type, value, priority, is_opt_in)
        VALUES (${userId}, 'mibera', 'generated', 'MIBERA-DDEEFF', 50, false)
      `
      expect(await selectNym(sql, userId, "mibera")).toBe("MIBERA-DDEEFF")

      // Then a claimed_nym (priority 10) — the upsert's DO UPDATE re-points nym.
      await sql`
        INSERT INTO world_identity_names (user_id, world_slug, name_type, value, priority, is_opt_in)
        VALUES (${userId}, 'mibera', 'claimed_nym', 'satoshi', 10, false)
      `
      expect(await selectNym(sql, userId, "mibera")).toBe("satoshi")

      await sql`DELETE FROM world_identity_names WHERE user_id = ${userId}`
      await sql`DELETE FROM world_identity WHERE user_id = ${userId}`
      await sql`DELETE FROM users WHERE user_id = ${userId}`
    } finally {
      await sql.close()
    }
  })

  // ── A3: IS DISTINCT-skip idempotency — no churn when the winner is unchanged ──

  it("A3: re-firing the trigger with an unchanged winning value does not churn world_identity (IS DISTINCT skip)", async () => {
    const sql = new SQL(databaseUrl)
    try {
      const userId = await seedWorldAndUser(sql, "mibera")

      await sql`
        INSERT INTO world_identity_names (user_id, world_slug, name_type, value, priority, is_opt_in)
        VALUES (${userId}, 'mibera', 'generated', 'MIBERA-112233', 50, false)
      `
      // Capture the row's ctid (physical tuple id) — an UPDATE rewrites it; the
      // IS DISTINCT guard must NOT update when the winner is unchanged.
      const before = (await sql`
        SELECT ctid::text AS ctid, nym FROM world_identity
         WHERE user_id = ${userId} AND world_slug = 'mibera'
      `) as Array<{ ctid: string; nym: string }>
      expect(before[0]!.nym).toBe("MIBERA-112233")

      // Insert an OPT-IN name (priority 90) — it can NEVER win, so the winning
      // value stays MIBERA-112233. The trigger fires but must skip the UPDATE.
      await sql`
        INSERT INTO world_identity_names (user_id, world_slug, name_type, value, priority, is_opt_in)
        VALUES (${userId}, 'mibera', 'raw_short_addr', '0xAB…cd', 90, true)
      `
      const after = (await sql`
        SELECT ctid::text AS ctid, nym FROM world_identity
         WHERE user_id = ${userId} AND world_slug = 'mibera'
      `) as Array<{ ctid: string; nym: string }>
      expect(after[0]!.nym).toBe("MIBERA-112233") // unchanged
      expect(after[0]!.ctid).toBe(before[0]!.ctid) // no UPDATE → tuple not rewritten

      await sql`DELETE FROM world_identity_names WHERE user_id = ${userId}`
      await sql`DELETE FROM world_identity WHERE user_id = ${userId}`
      await sql`DELETE FROM users WHERE user_id = ${userId}`
    } finally {
      await sql.close()
    }
  })

  // ── Safety: claimNym (direct world_identity INSERT) coexists with the upsert ──

  it("Safety: a direct world_identity INSERT then a name-write recompute does NOT raise a spurious PK conflict", async () => {
    const sql = new SQL(databaseUrl)
    try {
      const userId = await seedWorldAndUser(sql, "mibera")

      // claimNym path: direct world_identity INSERT (no name row written).
      await sql`
        INSERT INTO world_identity (user_id, world_slug, nym)
        VALUES (${userId}, 'mibera', 'direct-claim')
      `

      // A later name-write fires the trigger. The upsert's ON CONFLICT target
      // is the PK (user_id, world_slug); it must DO UPDATE (re-point nym),
      // NOT raise a duplicate-key error.
      let raised: unknown = null
      try {
        await sql`
          INSERT INTO world_identity_names (user_id, world_slug, name_type, value, priority, is_opt_in)
          VALUES (${userId}, 'mibera', 'claimed_nym', 'newname', 10, false)
        `
      } catch (err) {
        raised = err
      }
      expect(raised).toBeNull()
      expect(await selectNym(sql, userId, "mibera")).toBe("newname")

      await sql`DELETE FROM world_identity_names WHERE user_id = ${userId}`
      await sql`DELETE FROM world_identity WHERE user_id = ${userId}`
      await sql`DELETE FROM users WHERE user_id = ${userId}`
    } finally {
      await sql.close()
    }
  })

  // ── Two-user nym uniqueness still holds through the upsert path ───────────────

  it("Safety: two users computing distinct winning values get distinct world_identity rows (UNIQUE(world_slug,nym))", async () => {
    const sql = new SQL(databaseUrl)
    try {
      const u1 = await seedWorldAndUser(sql, "mibera")
      const u2 = await seedWorldAndUser(sql, "mibera")
      await sql`
        INSERT INTO world_identity_names (user_id, world_slug, name_type, value, priority, is_opt_in)
        VALUES (${u1}, 'mibera', 'generated', 'MIBERA-AAAAAA', 50, false)
      `
      await sql`
        INSERT INTO world_identity_names (user_id, world_slug, name_type, value, priority, is_opt_in)
        VALUES (${u2}, 'mibera', 'generated', 'MIBERA-BBBBBB', 50, false)
      `
      expect(await selectNym(sql, u1, "mibera")).toBe("MIBERA-AAAAAA")
      expect(await selectNym(sql, u2, "mibera")).toBe("MIBERA-BBBBBB")

      await sql`DELETE FROM world_identity_names WHERE user_id IN (${u1}, ${u2})`
      await sql`DELETE FROM world_identity WHERE user_id IN (${u1}, ${u2})`
      await sql`DELETE FROM users WHERE user_id IN (${u1}, ${u2})`
    } finally {
      await sql.close()
    }
  })

  // ── A4: reversibility — down 0009 restores the broken UPDATE-only behavior ────
  // Runs LAST: mutates global migration state (down → up). The down restores
  // the 0008 UPDATE-only body, so a name-write on a user with NO world_identity
  // row is again a 0-row no-op (the regression returns), proving 0009 is what
  // fixes it. Re-applies 0009 afterward to leave the DB consistent.

  it("A4: migrate down 0009 restores the UPDATE-only (broken) behavior; up re-applies cleanly", async () => {
    const down = await migrate({ databaseUrl, migrationsDir: MIGRATIONS_DIR, verb: "down" })
    expect(down).toEqual({ verb: "down", reverted: "0009_world_identity_upsert_trigger" })

    const sql = new SQL(databaseUrl)
    try {
      const userId = await seedWorldAndUser(sql, "mibera")
      // Post-down: a name-write on a user with NO world_identity row is a
      // 0-row no-op again (the bug is back) — nym stays absent.
      await sql`
        INSERT INTO world_identity_names (user_id, world_slug, name_type, value, priority, is_opt_in)
        VALUES (${userId}, 'mibera', 'generated', 'MIBERA-EEEEEE', 50, false)
      `
      expect(await selectNym(sql, userId, "mibera")).toBeNull() // regression restored

      await sql`DELETE FROM world_identity_names WHERE user_id = ${userId}`
      await sql`DELETE FROM world_identity WHERE user_id = ${userId}`
      await sql`DELETE FROM users WHERE user_id = ${userId}`
    } finally {
      await sql.close()
    }

    // Re-apply 0009 so the DB is left in the fixed state (round-trip).
    const up = await migrate({ databaseUrl, migrationsDir: MIGRATIONS_DIR, verb: "up" })
    expect(up).toEqual({ verb: "up", applied: ["0009_world_identity_upsert_trigger"] })

    // Sanity: the fix is back — a fresh name-write self-heals again.
    const sql2 = new SQL(databaseUrl)
    try {
      const userId = await seedWorldAndUser(sql2, "mibera")
      await sql2`
        INSERT INTO world_identity_names (user_id, world_slug, name_type, value, priority, is_opt_in)
        VALUES (${userId}, 'mibera', 'generated', 'MIBERA-FFFFFF', 50, false)
      `
      expect(await selectNym(sql2, userId, "mibera")).toBe("MIBERA-FFFFFF")

      await sql2`DELETE FROM world_identity_names WHERE user_id = ${userId}`
      await sql2`DELETE FROM world_identity WHERE user_id = ${userId}`
      await sql2`DELETE FROM users WHERE user_id = ${userId}`
    } finally {
      await sql2.close()
    }
  })
})
