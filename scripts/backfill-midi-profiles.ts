#!/usr/bin/env bun
/**
 * backfill-midi-profiles.ts — T4.4 · bead arrakis-494b.
 *
 * One-time data backfill: read `midi_profiles` snapshot rows from
 * mibera-honeyroad's Postgres and replay each as a `linkVerifiedWallet`
 * call into the identity-api spine. Idempotent (NFR-8) — safe to re-run
 * if interrupted.
 *
 * Source schema (mibera-honeyroad `lib/db/schema/index.ts:441-481`,
 * per SDD §8.3 + PRD §10):
 *   midi_profiles (
 *     discord_id        TEXT,
 *     discord_username  TEXT,
 *     dynamic_user_id   TEXT,
 *     wallet_address    TEXT
 *     ... plus columns we don't read
 *   )
 *
 * Mapping into linkVerifiedWallet input:
 *   - worldSlug      → 'mibera' (the only world midi_profiles backs today;
 *                       extensible via --world-slug flag)
 *   - discordId      → midi_profiles.discord_id
 *   - walletAddress  → midi_profiles.wallet_address
 *   - dynamicUserId  → midi_profiles.dynamic_user_id (optional)
 *
 * Conflict handling:
 *   - Rows that resolve to the same spine user are idempotent no-ops.
 *   - Rows that produce a cross_user_collision are LOGGED but DO NOT abort
 *     the whole backfill; the operator gets a summary at the end.
 *
 * Revert path: `scripts/backfill-midi-profiles-revert.ts` queries
 * `audit_events WHERE actor = 'backfill'` and soft-unlinks each linkage.
 *
 * Invocation:
 *   DATABASE_URL=...identity_api MIDI_DATABASE_URL=...honeyroad \
 *     bun run scripts/backfill-midi-profiles.ts [--world-slug=mibera] [--dry-run]
 *
 * Exit codes:
 *   0 = success (all rows processed; some may be collisions, logged)
 *   1 = env error (DATABASE_URL or MIDI_DATABASE_URL unset)
 *   2 = source-read error
 *   3 = unrecoverable spine error
 */

import { SQL } from "bun"
import { PostgresSpineAdapter } from "@freeside-auth/adapters"
import {
  linkVerifiedWallet,
  LinkCrossUserCollisionError,
} from "@freeside-auth/engine"

interface BackfillStats {
  total: number
  idempotent: number
  created: number
  wallet_rebound: number
  discord_rebound: number
  collisions: number
  errors: number
}

interface MidiProfileRow {
  discord_id: string | null
  wallet_address: string | null
  dynamic_user_id: string | null
}

interface RunOpts {
  worldSlug: string
  dryRun: boolean
}

function parseArgs(): RunOpts {
  const args = process.argv.slice(2)
  let worldSlug = "mibera"
  let dryRun = false
  for (const a of args) {
    if (a.startsWith("--world-slug=")) worldSlug = a.slice("--world-slug=".length)
    else if (a === "--dry-run") dryRun = true
    else if (a === "--help" || a === "-h") {
      console.log("Usage: backfill-midi-profiles.ts [--world-slug=mibera] [--dry-run]")
      process.exit(0)
    }
  }
  return { worldSlug, dryRun }
}

/**
 * Connect to the midi source (READ-ONLY) and stream rows. The query
 * filters to rows with at least one of {discord_id, wallet_address}
 * non-null — empty rows are useless for linkage.
 */
export async function readMidiProfiles(midiUrl: string): Promise<MidiProfileRow[]> {
  const sql = new SQL(midiUrl)
  try {
    const rows = await sql<MidiProfileRow[]>`
      SELECT
        discord_id::text       AS discord_id,
        wallet_address::text   AS wallet_address,
        dynamic_user_id::text  AS dynamic_user_id
      FROM midi_profiles
      WHERE discord_id IS NOT NULL OR wallet_address IS NOT NULL
    `
    return rows
  } finally {
    await sql.close().catch(() => {})
  }
}

/**
 * Run the backfill loop. Exposed for testing — pass a mock spine + an
 * in-memory rows array.
 */
export async function backfillRows(
  spine: import("@freeside-auth/ports").SpinePort,
  rows: readonly MidiProfileRow[],
  opts: { worldSlug: string; dryRun: boolean; onLog?: (msg: string) => void },
): Promise<BackfillStats> {
  const log = opts.onLog ?? ((m: string) => console.log(m))
  const stats: BackfillStats = {
    total: rows.length,
    idempotent: 0,
    created: 0,
    wallet_rebound: 0,
    discord_rebound: 0,
    collisions: 0,
    errors: 0,
  }

  let i = 0
  for (const row of rows) {
    i++
    if (!row.discord_id || !row.wallet_address) {
      // Need BOTH for a verified-link write; rows missing one are
      // partial data — skip without counting as error.
      continue
    }
    if (opts.dryRun) {
      log(`[dry-run ${i}/${rows.length}] would link discord=${row.discord_id} wallet=${row.wallet_address}`)
      stats.created += 1
      continue
    }
    try {
      const result = await linkVerifiedWallet(
        spine,
        {
          worldSlug: opts.worldSlug,
          discordId: row.discord_id,
          walletAddress: row.wallet_address,
          ...(row.dynamic_user_id ? { dynamicUserId: row.dynamic_user_id } : {}),
        },
        { actor: "backfill" },
      )
      if (result.idempotent) stats.idempotent += 1
      else if (result.conflictResolved === "wallet_rebound") stats.wallet_rebound += 1
      else if (result.conflictResolved === "discord_rebound") stats.discord_rebound += 1
      else stats.created += 1
    } catch (err) {
      if (err instanceof LinkCrossUserCollisionError) {
        stats.collisions += 1
        log(
          `[collision ${i}/${rows.length}] wallet=${row.wallet_address} → ${err.walletUser}; ` +
            `discord=${row.discord_id} → ${err.discordUser}`,
        )
      } else {
        stats.errors += 1
        log(`[error ${i}/${rows.length}] ${String(err)}`)
      }
    }
    if (i % 50 === 0) {
      log(`[progress] ${i}/${rows.length} rows processed`)
    }
  }
  return stats
}

async function main(): Promise<number> {
  const opts = parseArgs()

  const dbUrl = process.env.DATABASE_URL
  if (!dbUrl) {
    console.error("backfill-midi-profiles: DATABASE_URL is unset (identity-api spine)")
    return 1
  }
  const midiUrl = process.env.MIDI_DATABASE_URL
  if (!midiUrl) {
    console.error("backfill-midi-profiles: MIDI_DATABASE_URL is unset (mibera-honeyroad source)")
    return 1
  }

  console.log(`backfill: reading midi_profiles from ${redactUrl(midiUrl)}`)
  let rows: MidiProfileRow[]
  try {
    rows = await readMidiProfiles(midiUrl)
  } catch (err) {
    console.error(`backfill: midi source read failed: ${String(err)}`)
    return 2
  }
  console.log(`backfill: ${rows.length} rows loaded from midi_profiles`)

  if (opts.dryRun) {
    console.log("[DRY RUN — no writes will be performed]")
  }

  const spine = new PostgresSpineAdapter(dbUrl)
  try {
    const stats = await backfillRows(spine, rows, opts)
    console.log("backfill: complete")
    console.log(JSON.stringify(stats, null, 2))
    return stats.errors > 0 ? 3 : 0
  } finally {
    // PostgresSpineAdapter doesn't expose close() in v1; bun's SQL pool
    // closes on process exit. If close() is added later, call here.
  }
}

function redactUrl(url: string): string {
  try {
    const u = new URL(url)
    return `${u.protocol}//${u.host}${u.pathname}`
  } catch {
    return "<unparseable-url>"
  }
}

// Allow `bun run` execution without firing on test import.
if (import.meta.main) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error("backfill: unhandled error", err)
      process.exit(3)
    })
}
