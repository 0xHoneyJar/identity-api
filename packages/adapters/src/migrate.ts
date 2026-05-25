/**
 * migrate.ts — minimal Postgres migration runner for identity-api.
 *
 * Design (T1.2 build notes):
 *   - Source-distribution discipline: zero external packages. Bun built-ins
 *     only (`Bun.SQL`, `fs`, `path`).
 *   - Migration files: `*.up.sql` / `*.down.sql` in `./migrations/`,
 *     lexically sortable filenames (`0001_init_spine.up.sql`).
 *   - State table: `schema_migrations(version text pk, applied_at timestamptz)`
 *     auto-created on first run.
 *   - Each migration's SQL already wraps itself in BEGIN/COMMIT, so we apply
 *     the whole file via `sql.unsafe(...)` (multi-statement raw).
 *   - Idempotent: `up` only applies versions absent from `schema_migrations`;
 *     `down` rolls back the latest applied (one at a time).
 *   - DATABASE_URL is required; we fail-fast with a helpful message.
 *
 * The SDD (§2.2) flags drizzle-kit as a "pin at Phase 1" option for
 * migrations. This runner is the simplest thing that defers that pin until
 * actual ORM needs emerge — the SQL files are pure DDL and remain reusable
 * if drizzle-kit is adopted later (it consumes raw SQL too).
 *
 * Source: PRD v3.0 §4.2, SDD §3.2 (canonical DDL), SDD §2.2 (persistence stack).
 */

import { SQL } from "bun"
import { readdirSync, readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

// ─── verbs ───────────────────────────────────────────────────────────────────

type Verb = "up" | "down" | "status"

const VERBS: ReadonlyArray<Verb> = ["up", "down", "status"]

// ─── migration discovery ────────────────────────────────────────────────────

interface Migration {
  version: string // "0001_init_spine"
  upPath: string
  downPath: string
}

function discoverMigrations(migrationsDir: string): Migration[] {
  let entries: string[]
  try {
    entries = readdirSync(migrationsDir)
  } catch (err) {
    throw new Error(
      `migrate: failed to read migrations directory ${migrationsDir}: ${String(err)}`,
    )
  }

  // Group by version stem; require both .up.sql and .down.sql present.
  const versions = new Map<string, { up?: string; down?: string }>()
  for (const entry of entries) {
    const upMatch = /^(.+)\.up\.sql$/.exec(entry)
    const downMatch = /^(.+)\.down\.sql$/.exec(entry)
    if (upMatch?.[1]) {
      const v = upMatch[1]
      const slot = versions.get(v) ?? {}
      slot.up = join(migrationsDir, entry)
      versions.set(v, slot)
    } else if (downMatch?.[1]) {
      const v = downMatch[1]
      const slot = versions.get(v) ?? {}
      slot.down = join(migrationsDir, entry)
      versions.set(v, slot)
    }
  }

  const migrations: Migration[] = []
  for (const [version, paths] of versions.entries()) {
    if (!paths.up) {
      throw new Error(`migrate: missing .up.sql for version ${version}`)
    }
    if (!paths.down) {
      throw new Error(`migrate: missing .down.sql for version ${version}`)
    }
    migrations.push({ version, upPath: paths.up, downPath: paths.down })
  }

  // Lexical sort guarantees ordered apply (0001 → 0002 → …).
  migrations.sort((a, b) => (a.version < b.version ? -1 : a.version > b.version ? 1 : 0))
  return migrations
}

// ─── state table ────────────────────────────────────────────────────────────

async function ensureStateTable(sql: SQL): Promise<void> {
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `)
}

async function listApplied(sql: SQL): Promise<string[]> {
  const rows = (await sql`
    SELECT version FROM schema_migrations ORDER BY version ASC
  `) as Array<{ version: string }>
  return rows.map((r) => r.version)
}

// ─── apply / rollback ───────────────────────────────────────────────────────

async function applyUp(sql: SQL, migration: Migration): Promise<void> {
  const ddl = readFileSync(migration.upPath, "utf8")
  // The DDL files wrap themselves in BEGIN/COMMIT. We execute the whole
  // file in one round-trip; PG runs them as a single transaction.
  await sql.unsafe(ddl)
  await sql`INSERT INTO schema_migrations (version) VALUES (${migration.version})`
}

async function applyDown(sql: SQL, migration: Migration): Promise<void> {
  const ddl = readFileSync(migration.downPath, "utf8")
  await sql.unsafe(ddl)
  await sql`DELETE FROM schema_migrations WHERE version = ${migration.version}`
}

// ─── verb handlers ──────────────────────────────────────────────────────────

interface RunOpts {
  databaseUrl: string
  migrationsDir: string
  verb: Verb
}

async function runUp(opts: RunOpts): Promise<{ applied: string[] }> {
  const migrations = discoverMigrations(opts.migrationsDir)
  const sql = new SQL(opts.databaseUrl)
  const applied: string[] = []
  try {
    await ensureStateTable(sql)
    const already = new Set(await listApplied(sql))
    const pending = migrations.filter((m) => !already.has(m.version))

    if (pending.length === 0) {
      console.log("migrate up: nothing to apply.")
      return { applied }
    }

    for (const m of pending) {
      console.log(`migrate up: applying ${m.version} …`)
      await applyUp(sql, m)
      applied.push(m.version)
      console.log(`migrate up: applied ${m.version}.`)
    }
  } finally {
    await sql.close()
  }
  return { applied }
}

async function runDown(opts: RunOpts): Promise<{ reverted: string | null }> {
  const migrations = discoverMigrations(opts.migrationsDir)
  const sql = new SQL(opts.databaseUrl)
  let reverted: string | null = null
  try {
    await ensureStateTable(sql)
    const applied = await listApplied(sql)
    const latestVersion = applied.at(-1)
    if (!latestVersion) {
      console.log("migrate down: nothing to revert.")
      return { reverted }
    }
    const m = migrations.find((x) => x.version === latestVersion)
    if (!m) {
      throw new Error(
        `migrate down: applied version ${latestVersion} has no .down.sql file (expected at <migrationsDir>/${latestVersion}.down.sql)`,
      )
    }
    console.log(`migrate down: reverting ${m.version} …`)
    await applyDown(sql, m)
    reverted = m.version
    console.log(`migrate down: reverted ${m.version}.`)
  } finally {
    await sql.close()
  }
  return { reverted }
}

async function runStatus(opts: RunOpts): Promise<{ applied: string[]; pending: string[] }> {
  const migrations = discoverMigrations(opts.migrationsDir)
  const sql = new SQL(opts.databaseUrl)
  try {
    await ensureStateTable(sql)
    const applied = await listApplied(sql)
    const appliedSet = new Set(applied)
    const pending = migrations.filter((m) => !appliedSet.has(m.version)).map((m) => m.version)
    console.log("migrate status")
    console.log(`  applied (${applied.length}):`, applied.length === 0 ? "(none)" : applied.join(", "))
    console.log(`  pending (${pending.length}):`, pending.length === 0 ? "(none)" : pending.join(", "))
    return { applied, pending }
  } finally {
    await sql.close()
  }
}

// ─── exported entrypoint (for tests + CLI) ──────────────────────────────────

export async function migrate(opts: RunOpts): Promise<
  | { verb: "up"; applied: string[] }
  | { verb: "down"; reverted: string | null }
  | { verb: "status"; applied: string[]; pending: string[] }
> {
  switch (opts.verb) {
    case "up": {
      const { applied } = await runUp(opts)
      return { verb: "up", applied }
    }
    case "down": {
      const { reverted } = await runDown(opts)
      return { verb: "down", reverted }
    }
    case "status": {
      const { applied, pending } = await runStatus(opts)
      return { verb: "status", applied, pending }
    }
  }
}

export function defaultMigrationsDir(): string {
  // Resolve relative to THIS file (packages/adapters/src/migrate.ts), so the
  // runner works whether invoked from repo root or from the package.
  const here = dirname(fileURLToPath(import.meta.url))
  return resolve(here, "migrations")
}

// ─── CLI ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const verbArg = process.argv[2] as Verb | undefined
  if (!verbArg || !VERBS.includes(verbArg)) {
    console.error("usage: bun scripts/migrate.ts <up|down|status>")
    process.exit(2)
  }

  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) {
    console.error(
      "migrate: DATABASE_URL is not set.\n" +
        "  Set it to your identity-api Postgres connection string, e.g.:\n" +
        "    export DATABASE_URL=postgres://user:pass@host:5432/identity_api\n" +
        "  In Railway, this is provided automatically; for local dev run a\n" +
        "  container or use a Railway preview DB.",
    )
    process.exit(78) // EX_CONFIG
  }

  try {
    await migrate({
      databaseUrl,
      migrationsDir: defaultMigrationsDir(),
      verb: verbArg,
    })
  } catch (err) {
    console.error(`migrate ${verbArg}: failed:`, err)
    process.exit(1)
  }
}

// Only run main() when invoked directly (not when imported by tests).
if (import.meta.main) {
  await main()
}
