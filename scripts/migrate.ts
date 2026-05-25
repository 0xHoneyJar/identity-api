#!/usr/bin/env bun
/**
 * scripts/migrate.ts — user-facing CLI for the identity-api spine migrations.
 *
 * Thin wrapper that delegates to the runner implementation in
 * `packages/adapters/src/migrate.ts` (which colocates with the migration
 * files and the existing PG seam `postgres-split-adapter.ts`).
 *
 * Usage:
 *   bun scripts/migrate.ts up      # apply pending migrations
 *   bun scripts/migrate.ts down    # roll back the latest applied migration
 *   bun scripts/migrate.ts status  # show applied + pending versions
 *
 * Requires DATABASE_URL.
 */

import { defaultMigrationsDir, migrate } from "../packages/adapters/src/migrate"

type Verb = "up" | "down" | "status"
const VERBS: ReadonlyArray<Verb> = ["up", "down", "status"]

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
