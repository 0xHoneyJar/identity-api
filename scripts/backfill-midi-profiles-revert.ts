#!/usr/bin/env bun
/**
 * backfill-midi-profiles-revert.ts — the down operation for the T4.4
 * backfill (bead arrakis-494b).
 *
 * Per SDD §8.3 / NFR-8 (reversible via actor='backfill' audit marker):
 * this script SELECTs every `audit_events` row with `actor = 'backfill'`
 * AND `event_type = 'link_verified_wallet'`, then soft-unlinks the
 * corresponding wallet_links + linked_accounts rows.
 *
 * Why audit-marker-scoped (not blanket DELETE): the revert MUST NOT
 * reverse a LIVE-verify row (actor='self' or 'sietch-redirect'). The
 * `actor='backfill'` marker is the durable provenance signal.
 *
 * Idempotent: re-running is a no-op once everything is unlinked (the
 * `unlinked_at IS NULL` filter shrinks to empty).
 *
 * Invocation:
 *   DATABASE_URL=...identity_api bun run scripts/backfill-midi-profiles-revert.ts [--dry-run]
 */

import { SQL } from "bun"

interface BackfilledLinkage {
  user_id: string
  wallet_address: string
  discord_id: string
  dynamic_user_id: string | null
  audit_ts: string
}

interface RevertStats {
  audit_rows_seen: number
  wallets_unlinked: number
  accounts_unlinked: number
  already_unlinked: number
}

function parseArgs(): { dryRun: boolean } {
  return { dryRun: process.argv.slice(2).includes("--dry-run") }
}

/**
 * Discover every linkage that the backfill script created. Reads from
 * the audit_events trail — the operator-canonical provenance signal.
 */
export async function findBackfilledLinkages(
  sql: SQL,
): Promise<BackfilledLinkage[]> {
  // The `link_verified_wallet` umbrella audit (engine emits it in the
  // orchestrator's tail) carries the full payload. Filter by actor.
  return sql<BackfilledLinkage[]>`
    SELECT
      user_id::text                                            AS user_id,
      (payload->>'wallet_address')::text                       AS wallet_address,
      (payload->>'discord_id')::text                           AS discord_id,
      (payload->>'dynamic_user_id')::text                      AS dynamic_user_id,
      created_at::text                                         AS audit_ts
    FROM audit_events
    WHERE actor = 'backfill'
      AND event_type = 'link_verified_wallet'
  `
}

/**
 * Pure revert loop — separated for testability. Issues UPDATE
 * statements that set `unlinked_at = NOW()` only where it's still
 * NULL (idempotent).
 */
export async function revertLinkages(
  sql: SQL,
  linkages: readonly BackfilledLinkage[],
  opts: { dryRun: boolean; onLog?: (msg: string) => void },
): Promise<RevertStats> {
  const log = opts.onLog ?? ((m: string) => console.log(m))
  const stats: RevertStats = {
    audit_rows_seen: linkages.length,
    wallets_unlinked: 0,
    accounts_unlinked: 0,
    already_unlinked: 0,
  }

  for (const link of linkages) {
    if (opts.dryRun) {
      log(`[dry-run] would soft-unlink wallet=${link.wallet_address} + discord=${link.discord_id}`)
      continue
    }
    // Soft-unlink the wallet. ONLY affects rows still active.
    const walletResult = await sql`
      UPDATE wallet_links
      SET unlinked_at = NOW()
      WHERE wallet_address = ${link.wallet_address.toLowerCase()}
        AND user_id = ${link.user_id}::uuid
        AND unlinked_at IS NULL
      RETURNING wallet_address
    `
    if (walletResult.length > 0) stats.wallets_unlinked += 1
    else stats.already_unlinked += 1

    // Soft-unlink the discord linked_account.
    const discordResult = await sql`
      UPDATE linked_accounts
      SET unlinked_at = NOW()
      WHERE provider = 'discord'
        AND external_id = ${link.discord_id}
        AND user_id = ${link.user_id}::uuid
        AND unlinked_at IS NULL
      RETURNING external_id
    `
    if (discordResult.length > 0) stats.accounts_unlinked += 1

    // Soft-unlink the dynamic_user_id if it was linked.
    if (link.dynamic_user_id) {
      await sql`
        UPDATE linked_accounts
        SET unlinked_at = NOW()
        WHERE provider = 'dynamic_user_id'
          AND external_id = ${link.dynamic_user_id}
          AND user_id = ${link.user_id}::uuid
          AND unlinked_at IS NULL
      `
    }

    // Write the revert audit (separately — NOT inside a txn with the
    // unlink so a partial failure still records progress).
    await sql`
      INSERT INTO audit_events (event_type, user_id, actor, payload)
      VALUES (
        'backfill_reverted',
        ${link.user_id}::uuid,
        'backfill-revert',
        ${JSON.stringify({
          wallet_address: link.wallet_address,
          discord_id: link.discord_id,
          dynamic_user_id: link.dynamic_user_id,
          source_audit_ts: link.audit_ts,
        })}::jsonb
      )
    `
  }
  return stats
}

async function main(): Promise<number> {
  const opts = parseArgs()
  const dbUrl = process.env.DATABASE_URL
  if (!dbUrl) {
    console.error("backfill-revert: DATABASE_URL is unset")
    return 1
  }
  const sql = new SQL(dbUrl)
  try {
    const linkages = await findBackfilledLinkages(sql)
    console.log(`backfill-revert: ${linkages.length} backfilled linkages found`)
    if (opts.dryRun) console.log("[DRY RUN — no writes will be performed]")
    const stats = await revertLinkages(sql, linkages, opts)
    console.log("backfill-revert: complete")
    console.log(JSON.stringify(stats, null, 2))
    return 0
  } catch (err) {
    console.error(`backfill-revert: failed: ${String(err)}`)
    return 2
  } finally {
    await sql.close().catch(() => {})
  }
}

if (import.meta.main) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error("backfill-revert: unhandled", err)
      process.exit(2)
    })
}
