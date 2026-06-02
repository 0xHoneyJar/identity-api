#!/usr/bin/env bun
/**
 * backfill-wallet-only-from-midi-revert.ts — the down op for the A6 backfill
 * (identity-api #11 Phase 1).
 *
 * SELECTs every `audit_events` row with actor='backfill-wallet' AND
 * event_type='link_wallet_only' (the umbrella the linkWalletOnly orchestrator
 * emits), then:
 *   - soft-unlinks the wallet_links row (unlinked_at = NOW())
 *   - soft-unlinks the dynamic_user_id linked_account (if any)
 *   - RETIRES the user's world_identity_names rows (retired_at = NOW()) — the
 *     names the backfill minted/absorbed
 *
 * Why audit-marker-scoped: the revert MUST NOT touch a LIVE row (actor='self'
 * etc.). actor='backfill-wallet' is the durable provenance marker the A6
 * backfill stamps on every umbrella audit.
 *
 * Idempotent: re-running is a no-op once everything is unlinked/retired (the
 * `unlinked_at IS NULL` / `retired_at IS NULL` filters shrink to empty).
 *
 * Invocation:
 *   DATABASE_URL=...identity_api bun run scripts/backfill-wallet-only-from-midi-revert.ts [--dry-run]
 *
 * Exit codes: 0 = success · 1 = env error · 2 = failure
 */

import { SQL } from "bun"

export interface BackfilledWalletLinkage {
  user_id: string
  wallet_address: string
  dynamic_user_id: string | null
}

export interface WalletRevertStats {
  audit_rows_seen: number
  wallets_unlinked: number
  accounts_unlinked: number
  names_retired: number
  already_unlinked: number
}

function parseArgs(): { dryRun: boolean } {
  return { dryRun: process.argv.slice(2).includes("--dry-run") }
}

/**
 * Discover every linkage the A6 backfill created, from the audit trail. The
 * link_wallet_only umbrella carries the wallet_address + (optional)
 * dynamic_user_id. DISTINCT on user_id so a re-run of the backfill (which would
 * emit a second idempotent umbrella) doesn't double-count.
 */
export async function findBackfilledWalletLinkages(
  sql: SQL,
): Promise<BackfilledWalletLinkage[]> {
  return sql<BackfilledWalletLinkage[]>`
    SELECT DISTINCT ON (user_id)
      user_id::text                          AS user_id,
      (payload->>'wallet_address')::text     AS wallet_address,
      (payload->>'dynamic_user_id')::text    AS dynamic_user_id
    FROM audit_events
    WHERE actor = 'backfill-wallet'
      AND event_type = 'link_wallet_only'
    ORDER BY user_id, created_at DESC
  `
}

/**
 * Pure revert loop — soft-unlinks wallets/accounts + retires names. Idempotent
 * (the WHERE ... IS NULL guards). Separated for testability.
 */
export async function revertWalletLinkages(
  sql: SQL,
  linkages: readonly BackfilledWalletLinkage[],
  opts: { dryRun: boolean; onLog?: (msg: string) => void },
): Promise<WalletRevertStats> {
  const log = opts.onLog ?? ((m: string) => console.log(m))
  const stats: WalletRevertStats = {
    audit_rows_seen: linkages.length,
    wallets_unlinked: 0,
    accounts_unlinked: 0,
    names_retired: 0,
    already_unlinked: 0,
  }

  for (const link of linkages) {
    if (opts.dryRun) {
      log(`[dry-run] would soft-unlink wallet=${link.wallet_address} + retire names for ${link.user_id}`)
      continue
    }

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

    if (link.dynamic_user_id) {
      const accResult = await sql`
        UPDATE linked_accounts
           SET unlinked_at = NOW()
         WHERE provider = 'dynamic_user_id'
           AND external_id = ${link.dynamic_user_id}
           AND user_id = ${link.user_id}::uuid
           AND unlinked_at IS NULL
        RETURNING external_id
      `
      if (accResult.length > 0) stats.accounts_unlinked += 1
    }

    // Retire the names the backfill minted/absorbed for this user. We retire
    // ALL of the user's active names — a wallet-only backfilled user has no
    // other name source, so this is exact. (A future live-name path would need
    // a name-level provenance marker; not in scope for the #11 backfill.)
    const nameResult = await sql`
      UPDATE world_identity_names
         SET retired_at = NOW()
       WHERE user_id = ${link.user_id}::uuid
         AND retired_at IS NULL
      RETURNING value
    `
    stats.names_retired += nameResult.length

    // Audit the revert (separately, NOT in a txn with the unlink, so a partial
    // failure still records progress).
    await sql`
      INSERT INTO audit_events (event_type, user_id, actor, payload)
      VALUES (
        'backfill_wallet_reverted',
        ${link.user_id}::uuid,
        'backfill-wallet-revert',
        ${JSON.stringify({
          wallet_address: link.wallet_address,
          dynamic_user_id: link.dynamic_user_id,
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
    console.error("backfill-wallet-revert: DATABASE_URL is unset")
    return 1
  }
  const sql = new SQL(dbUrl)
  try {
    const linkages = await findBackfilledWalletLinkages(sql)
    console.log(`backfill-wallet-revert: ${linkages.length} backfilled wallet-only linkages found`)
    if (opts.dryRun) console.log("[DRY RUN — no writes will be performed]")
    const stats = await revertWalletLinkages(sql, linkages, opts)
    console.log("backfill-wallet-revert: complete")
    console.log(JSON.stringify(stats, null, 2))
    return 0
  } catch (err) {
    console.error(`backfill-wallet-revert: failed: ${String(err)}`)
    return 2
  } finally {
    await sql.close().catch(() => {})
  }
}

if (import.meta.main) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error("backfill-wallet-revert: unhandled", err)
      process.exit(2)
    })
}
