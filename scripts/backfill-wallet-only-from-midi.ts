#!/usr/bin/env bun
/**
 * backfill-wallet-only-from-midi.ts — A6 · identity-api #11 Phase 1.
 *
 * One-time data backfill for the 189 WALLET-ONLY midi users — the rows the
 * existing backfill-midi-profiles.ts SKIPS (it needs BOTH discord + wallet;
 * skip-filter at backfill-midi-profiles.ts:134-138). These 189 are invisible
 * to the spine because the only spine-creating engine API, linkVerifiedWallet,
 * hard-requires discordId. This backfill replays each as a `linkWalletOnly`
 * call — the no-discord orchestrator (A3) — and ABSORBS honey-road's existing
 * names so nothing on-screen changes.
 *
 * Source filter (mibera-honeyroad midi_profiles):
 *   wallet_address IS NOT NULL AND discord_id IS NULL    (the wallet-only 189)
 * Columns read: wallet_address, dynamic_user_id, mibera_id (NOT NULL — 100%
 *   coverage, format ^MIBERA-[A-F0-9]{6}$), display_name.
 *
 * Mapping → linkWalletOnly:
 *   worldSlug      → 'mibera'
 *   walletAddress  → wallet_address
 *   dynamicUserId  → dynamic_user_id (optional)
 *   importedNames  → [{generated: mibera_id}, {claimed_nym: display_name?}]
 *   actor          → 'backfill-wallet'   (the revert's provenance marker)
 *
 * ABSORB, don't regenerate: the spine claimGeneratedName is for NEW users only;
 * here we IMPORT honey-road's mibera_id verbatim so the 189 see the same handle
 * they already see.
 *
 * HARD count assertion (NEW precedent — no existing backfill asserts this):
 * post-run, active wallet_links MUST be >= prior + 189, else exit 3.
 *
 * Revert path: scripts/backfill-wallet-only-from-midi-revert.ts soft-unlinks
 * actor='backfill-wallet' linkages + retires the minted names.
 *
 * Invocation:
 *   DATABASE_URL=...identity_api MIDI_DATABASE_URL=...honeyroad \
 *     bun run scripts/backfill-wallet-only-from-midi.ts \
 *       [--world-slug=mibera] [--dry-run] [--expected-net-new=189]
 *
 * Exit codes:
 *   0 = success (all rows processed; HARD count met)
 *   1 = env error (DATABASE_URL or MIDI_DATABASE_URL unset)
 *   2 = source-read error
 *   3 = unrecoverable spine error OR HARD count assertion failed (short count)
 */

import { SQL } from "bun"
import { PostgresSpineAdapter, SpineConflictError } from "@freeside-auth/adapters"
import { linkWalletOnly } from "@freeside-auth/engine"
import type { ImportedName } from "@freeside-auth/engine"

export interface WalletOnlyMidiRow {
  wallet_address: string | null
  dynamic_user_id: string | null
  mibera_id: string | null
  display_name: string | null
}

export interface WalletOnlyBackfillStats {
  total: number
  created: number
  idempotent: number
  skipped: number
  errors: number
  /**
   * Users created generated-only after their absorbed `claimed_nym` collided
   * with an already-active value in the world (duplicate honey-road
   * display_name, e.g. two users named "rug"). The losing user keeps their
   * unique generated MIBERA-XXXX and DROPS the colliding claimed_nym — a
   * permanent, surfaced degradation (the operator can re-assign a unique nym
   * later if desired).
   */
  claimedNymDropped: number
}

interface RunOpts {
  worldSlug: string
  dryRun: boolean
  expectedNetNew: number
}

const DEFAULT_EXPECTED_NET_NEW = 189

function parseArgs(): RunOpts {
  const args = process.argv.slice(2)
  let worldSlug = "mibera"
  let dryRun = false
  let expectedNetNew = DEFAULT_EXPECTED_NET_NEW
  for (const a of args) {
    if (a.startsWith("--world-slug=")) worldSlug = a.slice("--world-slug=".length)
    else if (a === "--dry-run") dryRun = true
    else if (a.startsWith("--expected-net-new=")) {
      expectedNetNew = Number(a.slice("--expected-net-new=".length))
    } else if (a === "--help" || a === "-h") {
      console.log(
        "Usage: backfill-wallet-only-from-midi.ts [--world-slug=mibera] [--dry-run] [--expected-net-new=189]",
      )
      process.exit(0)
    }
  }
  return { worldSlug, dryRun, expectedNetNew }
}

/**
 * Connect to the midi source (READ-ONLY) and read the WALLET-ONLY rows — the
 * 189 the existing backfill skips. Filters to wallet present + discord NULL.
 */
export async function readWalletOnlyMidiProfiles(midiUrl: string): Promise<WalletOnlyMidiRow[]> {
  const sql = new SQL(midiUrl)
  try {
    const rows = await sql<WalletOnlyMidiRow[]>`
      SELECT
        wallet_address::text   AS wallet_address,
        dynamic_user_id::text  AS dynamic_user_id,
        mibera_id::text        AS mibera_id,
        display_name::text     AS display_name
      FROM midi_profiles
      WHERE wallet_address IS NOT NULL
        AND discord_id IS NULL
    `
    return rows
  } finally {
    await sql.close().catch(() => {})
  }
}

/**
 * The testable backfill loop. Pass a mock spine + an in-memory rows array.
 *
 * For each row: build importedNames from the honey-road values (ABSORB) and
 * call linkWalletOnly. A row missing wallet_address OR mibera_id is SKIPPED
 * (the generated name is required to absorb; mibera_id is NOT NULL in the
 * source so a null here means a data anomaly worth skipping, not aborting).
 */
export async function backfillWalletOnlyRows(
  spine: import("@freeside-auth/ports").SpinePort,
  rows: readonly WalletOnlyMidiRow[],
  opts: { worldSlug: string; dryRun: boolean; onLog?: (msg: string) => void },
): Promise<WalletOnlyBackfillStats> {
  const log = opts.onLog ?? ((m: string) => console.log(m))
  const stats: WalletOnlyBackfillStats = {
    total: rows.length,
    created: 0,
    idempotent: 0,
    skipped: 0,
    errors: 0,
    claimedNymDropped: 0,
  }

  let i = 0
  for (const row of rows) {
    i++
    if (!row.wallet_address || !row.mibera_id) {
      // Wallet-only backfill REQUIRES a wallet + a mibera_id to absorb. A row
      // missing either is partial data — skip without counting as an error.
      stats.skipped += 1
      continue
    }

    if (opts.dryRun) {
      log(
        `[dry-run ${i}/${rows.length}] would link wallet=${row.wallet_address} ` +
          `absorbing generated=${row.mibera_id}` +
          (row.display_name ? ` claimed_nym=${row.display_name}` : ""),
      )
      stats.created += 1
      continue
    }

    // ABSORB honey-road's existing names (do NOT regenerate).
    const importedNames: ImportedName[] = [{ nameType: "generated", value: row.mibera_id }]
    if (row.display_name) {
      importedNames.push({ nameType: "claimed_nym", value: row.display_name })
    }

    try {
      const result = await linkWalletOnly(
        spine,
        {
          worldSlug: opts.worldSlug,
          walletAddress: row.wallet_address,
          ...(row.dynamic_user_id ? { dynamicUserId: row.dynamic_user_id } : {}),
          importedNames,
        },
        { actor: "backfill-wallet" },
      )
      if (result.idempotent) stats.idempotent += 1
      else stats.created += 1
    } catch (err) {
      // A duplicate honey-road display_name absorbed as a `claimed_nym` collides
      // with an already-active value in the world (e.g. two users named "rug").
      // The spine raises SpineConflictError(kind='world_identity') with
      // context.name_type='claimed_nym'. Rather than drop the whole user, RETRY
      // generated-only: the user keeps their unique mibera_id (priority 50 wins,
      // no claimed_nym row) and the 0009 trigger populates world_identity.nym =
      // MIBERA-XXXX. Any OTHER conflict (e.g. a generated-value collision) is a
      // real error — no silent swallow.
      if (
        err instanceof SpineConflictError &&
        err.kind === "world_identity" &&
        err.context?.name_type === "claimed_nym"
      ) {
        try {
          const retry = await linkWalletOnly(
            spine,
            {
              worldSlug: opts.worldSlug,
              walletAddress: row.wallet_address,
              ...(row.dynamic_user_id ? { dynamicUserId: row.dynamic_user_id } : {}),
              importedNames: [{ nameType: "generated", value: row.mibera_id }],
            },
            { actor: "backfill-wallet" },
          )
          if (retry.idempotent) stats.idempotent += 1
          else stats.created += 1
          stats.claimedNymDropped += 1
          log(
            `[claimed_nym-dropped ${i}/${rows.length}] wallet=${row.wallet_address}: ` +
              `display_name "${row.display_name}" already claimed in '${opts.worldSlug}'; ` +
              `created generated-only as ${row.mibera_id}`,
          )
        } catch (retryErr) {
          stats.errors += 1
          log(
            `[error ${i}/${rows.length}] wallet=${row.wallet_address} (retry after claimed_nym drop): ${String(retryErr)}`,
          )
        }
      } else {
        stats.errors += 1
        log(`[error ${i}/${rows.length}] wallet=${row.wallet_address}: ${String(err)}`)
      }
    }

    if (i % 50 === 0) log(`[progress] ${i}/${rows.length} rows processed`)
  }
  return stats
}

/**
 * HARD count assertion (NEW precedent). Returns the exit code: 0 when the
 * net-new active wallet_links count meets or exceeds the expected floor, 3
 * otherwise (short count OR backwards count — both are failure signals the
 * operator must investigate before trusting the backfill).
 */
export function assertNetNewLinkages(args: {
  prior: number
  after: number
  expected: number
}): number {
  const netNew = args.after - args.prior
  if (netNew >= args.expected) return 0
  return 3
}

/** Count ACTIVE wallet_links (unlinked_at IS NULL) — the HARD-count metric. */
export async function countActiveWalletLinks(sql: SQL): Promise<number> {
  const rows = (await sql`
    SELECT COUNT(*)::int AS n FROM wallet_links WHERE unlinked_at IS NULL
  `) as Array<{ n: number }>
  return rows[0]?.n ?? 0
}

async function main(): Promise<number> {
  const opts = parseArgs()

  const dbUrl = process.env.DATABASE_URL
  if (!dbUrl) {
    console.error("backfill-wallet-only: DATABASE_URL is unset (identity-api spine)")
    return 1
  }
  const midiUrl = process.env.MIDI_DATABASE_URL
  if (!midiUrl) {
    console.error("backfill-wallet-only: MIDI_DATABASE_URL is unset (mibera-honeyroad source)")
    return 1
  }

  console.log(`backfill-wallet-only: reading wallet-only midi_profiles from ${redactUrl(midiUrl)}`)
  let rows: WalletOnlyMidiRow[]
  try {
    rows = await readWalletOnlyMidiProfiles(midiUrl)
  } catch (err) {
    console.error(`backfill-wallet-only: midi source read failed: ${String(err)}`)
    return 2
  }
  console.log(`backfill-wallet-only: ${rows.length} wallet-only rows loaded`)

  if (opts.dryRun) console.log("[DRY RUN — no writes will be performed]")

  // Two DB connections: the spine adapter (writes) + a raw SQL for the
  // pre/post HARD-count. Both closed in finally.
  const spine = new PostgresSpineAdapter(dbUrl)
  const countSql = new SQL(dbUrl)
  try {
    const prior = opts.dryRun ? 0 : await countActiveWalletLinks(countSql)
    const stats = await backfillWalletOnlyRows(spine, rows, opts)
    console.log("backfill-wallet-only: loop complete")
    console.log(JSON.stringify(stats, null, 2))

    if (stats.errors > 0) {
      console.error(`backfill-wallet-only: ${stats.errors} unrecoverable spine errors`)
      return 3
    }

    if (opts.dryRun) return 0

    const after = await countActiveWalletLinks(countSql)
    const code = assertNetNewLinkages({ prior, after, expected: opts.expectedNetNew })
    if (code !== 0) {
      console.error(
        `backfill-wallet-only: HARD COUNT FAILED — active wallet_links went ${prior} → ${after} ` +
          `(net-new ${after - prior} < expected ${opts.expectedNetNew}). Exit 3.`,
      )
      return code
    }
    console.log(
      `backfill-wallet-only: HARD COUNT OK — active wallet_links ${prior} → ${after} ` +
        `(net-new ${after - prior} >= ${opts.expectedNetNew}).`,
    )
    return 0
  } finally {
    await spine.close().catch(() => {})
    await countSql.close().catch(() => {})
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

if (import.meta.main) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error("backfill-wallet-only: unhandled error", err)
      process.exit(3)
    })
}
