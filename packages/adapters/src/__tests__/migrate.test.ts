/**
 * migrate.test.ts — round-trip integration test for the spine migration runner.
 *
 * Strategy: against a real Postgres connection (TEST_DATABASE_URL), prove the
 * full lifecycle on a CLEAN database:
 *   - up (applies 0001) → 7 spine tables + key indexes present
 *   - down (rolls back 0001) → tables absent
 *   - up again → identical state
 *   - up while applied → no-op (idempotency)
 *
 * The test is GATED on TEST_DATABASE_URL — without it, the suite skips with
 * a single info-line. This is intentional: CI without a PG instance must
 * still pass; only ops with a real DB exercise it.
 *
 * Safety: the test DROPs `schema_migrations` + all spine tables at start.
 * Point TEST_DATABASE_URL ONLY at a scratch DB (the test will refuse to
 * touch a DB whose name does not look scratch-shaped).
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { SQL } from "bun"
import { resolve } from "node:path"

import { migrate } from "../migrate"

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL
const MIGRATIONS_DIR = resolve(__dirname, "..", "migrations")

// Spine tables in FK-safe creation order (mirrors 0001).
const SPINE_TABLES = [
  "users",
  "wallet_links",
  "linked_accounts",
  "worlds",
  "world_identity",
  "audit_events",
  "auth_nonces",
] as const

// Key indexes that must exist after a successful `up`. (Partial-unique
// indexes are the FR-R5 hard guarantee; we assert them by name.)
const SPINE_INDEXES = [
  "uq_wallet_links_active_address",
  "uq_wallet_links_one_primary_per_user",
  "idx_wallet_links_user",
  "idx_linked_accounts_user",
  "idx_world_identity_user",
  "idx_audit_events_user",
  "idx_audit_events_type_time",
  "idx_auth_nonces_expires",
] as const

const SCRATCH_DB_HINTS = ["test", "scratch", "ephemeral", "ci", "tmp", "preview"]

function looksLikeScratchUrl(url: string): boolean {
  // Heuristic: extract the path segment after the host:port and check for
  // scratch-shaped names. This refuses to drop tables against e.g.
  // postgres://…/production or postgres://…/identity_api.
  try {
    const u = new URL(url)
    const dbName = u.pathname.replace(/^\//, "").toLowerCase()
    if (!dbName) return false
    return SCRATCH_DB_HINTS.some((hint) => dbName.includes(hint))
  } catch {
    return false
  }
}

async function dropAllSpineState(sql: SQL): Promise<void> {
  // Drop in reverse FK order, plus schema_migrations + (defensively) the
  // sync_primary_wallet trigger function from 0002 if a prior test session
  // installed it.
  await sql.unsafe(`
    DROP TRIGGER IF EXISTS trg_sync_primary_wallet ON wallet_links;
    DROP FUNCTION IF EXISTS sync_primary_wallet();
    DROP TABLE IF EXISTS auth_nonces CASCADE;
    DROP TABLE IF EXISTS audit_events CASCADE;
    DROP TABLE IF EXISTS world_identity CASCADE;
    DROP TABLE IF EXISTS worlds CASCADE;
    DROP TABLE IF EXISTS linked_accounts CASCADE;
    DROP TABLE IF EXISTS wallet_links CASCADE;
    DROP TABLE IF EXISTS users CASCADE;
    DROP TABLE IF EXISTS schema_migrations CASCADE;
  `)
}

async function listPublicTables(sql: SQL): Promise<string[]> {
  const rows = (await sql`
    SELECT table_name
      FROM information_schema.tables
     WHERE table_schema = 'public'
     ORDER BY table_name ASC
  `) as Array<{ table_name: string }>
  return rows.map((r) => r.table_name)
}

async function listPublicIndexes(sql: SQL): Promise<string[]> {
  const rows = (await sql`
    SELECT indexname
      FROM pg_indexes
     WHERE schemaname = 'public'
     ORDER BY indexname ASC
  `) as Array<{ indexname: string }>
  return rows.map((r) => r.indexname)
}

describe.skipIf(!TEST_DATABASE_URL)("migrate 0001 round-trip (T1.2)", () => {
  // Type narrowing: inside this block TEST_DATABASE_URL is defined.
  const databaseUrl = TEST_DATABASE_URL as string

  beforeAll(async () => {
    if (!looksLikeScratchUrl(databaseUrl)) {
      throw new Error(
        `migrate.test: TEST_DATABASE_URL DB name does not look scratch-shaped (expected to contain one of: ${SCRATCH_DB_HINTS.join(", ")}). Refusing to drop tables on a non-scratch DB.`,
      )
    }
    const sql = new SQL(databaseUrl)
    try {
      await dropAllSpineState(sql)
    } finally {
      await sql.close()
    }
  })

  afterAll(async () => {
    // Final cleanup — same posture as beforeAll, leave the scratch DB clean.
    const sql = new SQL(databaseUrl)
    try {
      await dropAllSpineState(sql)
    } finally {
      await sql.close()
    }
  })

  it("starts on a clean DB (no spine tables present)", async () => {
    const sql = new SQL(databaseUrl)
    try {
      const tables = await listPublicTables(sql)
      for (const t of SPINE_TABLES) {
        expect(tables).not.toContain(t)
      }
      expect(tables).not.toContain("schema_migrations")
    } finally {
      await sql.close()
    }
  })

  it("up: applies all pending migrations starting with 0001 and creates all 7 spine tables + key indexes", async () => {
    const result = await migrate({
      databaseUrl,
      migrationsDir: MIGRATIONS_DIR,
      verb: "up",
    })
    // T1.3 added 0002_primary_wallet_trigger after this test was authored.
    // Assert 0001 is the first applied (the round-trip target); any later
    // migrations also applied are listed in lexical order. This keeps the
    // T1.2 round-trip intent intact while staying robust to future
    // migrations being added in the same sequence.
    expect(result.verb).toBe("up")
    if (result.verb === "up") {
      expect(result.applied[0]).toBe("0001_init_spine")
      // After T1.3 both should land in one up; after later sprints, more
      // may follow. The round-trip target is 0001; the rest are bystanders
      // here (their own test files own their behavior assertions).
      expect(result.applied).toContain("0001_init_spine")
    }

    const sql = new SQL(databaseUrl)
    try {
      const tables = await listPublicTables(sql)
      for (const t of SPINE_TABLES) {
        expect(tables).toContain(t)
      }
      expect(tables).toContain("schema_migrations")

      const indexes = await listPublicIndexes(sql)
      for (const idx of SPINE_INDEXES) {
        expect(indexes).toContain(idx)
      }

      // schema_migrations row present for 0001 (the round-trip target).
      const applied = (await sql`
        SELECT version FROM schema_migrations ORDER BY version
      `) as Array<{ version: string }>
      expect(applied.map((r) => r.version)).toContain("0001_init_spine")
    } finally {
      await sql.close()
    }
  })

  it("up (idempotent): second invocation is a no-op", async () => {
    const result = await migrate({
      databaseUrl,
      migrationsDir: MIGRATIONS_DIR,
      verb: "up",
    })
    expect(result).toEqual({ verb: "up", applied: [] })

    // Spine still present after the no-op.
    const sql = new SQL(databaseUrl)
    try {
      const tables = await listPublicTables(sql)
      for (const t of SPINE_TABLES) {
        expect(tables).toContain(t)
      }
    } finally {
      await sql.close()
    }
  })

  it("status: reports all migrations applied, no pending", async () => {
    const result = await migrate({
      databaseUrl,
      migrationsDir: MIGRATIONS_DIR,
      verb: "status",
    })
    // T1.3 added 0002_primary_wallet_trigger. Assert 0001 is applied and
    // pending is empty (no migrations left to run); later migrations are
    // listed in `applied` in lexical order.
    expect(result.verb).toBe("status")
    if (result.verb === "status") {
      expect(result.applied).toContain("0001_init_spine")
      expect(result.pending).toEqual([])
    }
  })

  it("down: full rollback removes all spine tables (but leaves pgcrypto + schema_migrations)", async () => {
    // T1.3 added 0002 atop 0001 — `down` rolls back ONE migration at a
    // time (the most recent). To prove the 0001 round-trip closes (the
    // T1.2 intent), invoke down until the migration ledger is empty.
    let safetyBudget = 16
    while (safetyBudget-- > 0) {
      const result = await migrate({
        databaseUrl,
        migrationsDir: MIGRATIONS_DIR,
        verb: "down",
      })
      if (result.verb !== "down") {
        throw new Error(`unexpected verb: ${result.verb}`)
      }
      if (result.reverted === null) break
    }
    expect(safetyBudget).toBeGreaterThan(0) // guard against infinite loops

    const sql = new SQL(databaseUrl)
    try {
      const tables = await listPublicTables(sql)
      for (const t of SPINE_TABLES) {
        expect(tables).not.toContain(t)
      }
      // schema_migrations is the runner's state and intentionally persists
      // across rollbacks — it's the tracking ledger, not part of the spine.
      expect(tables).toContain("schema_migrations")

      // schema_migrations row is gone.
      const applied = (await sql`
        SELECT version FROM schema_migrations
      `) as Array<{ version: string }>
      expect(applied).toEqual([])
    } finally {
      await sql.close()
    }
  })

  it("up after down: re-applies cleanly (round-trip closes)", async () => {
    const result = await migrate({
      databaseUrl,
      migrationsDir: MIGRATIONS_DIR,
      verb: "up",
    })
    // T1.3-aware: assert 0001 lands first; later migrations also apply in
    // lexical order. The round-trip target is 0001 (spine present).
    expect(result.verb).toBe("up")
    if (result.verb === "up") {
      expect(result.applied[0]).toBe("0001_init_spine")
    }

    const sql = new SQL(databaseUrl)
    try {
      const tables = await listPublicTables(sql)
      for (const t of SPINE_TABLES) {
        expect(tables).toContain(t)
      }
    } finally {
      await sql.close()
    }
  })
})
