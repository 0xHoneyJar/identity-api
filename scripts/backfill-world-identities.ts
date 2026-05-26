#!/usr/bin/env bun
/**
 * One-time follow-up to T4.4 (arrakis-494b): seeds the mibera world +
 * claims nyms in world_identity for every spine user whose primary wallet
 * has a midi_profiles.display_name. Original backfill wrote
 * users/wallets/linked_accounts but NOT world_identities; this closes
 * that gap so honey-road's "show profile name" UI surfaces midi display
 * names through identity-api's compose endpoint.
 *
 * Idempotent (ON CONFLICT DO NOTHING). Logs every action.
 *
 *   IDENTITY_DATABASE_URL=… MIDI_DATABASE_URL=… bun run /tmp/backfill-world-identities.ts [--dry-run]
 */
import { SQL } from "bun"

const dryRun = process.argv.includes("--dry-run")
const WORLD_SLUG = "mibera"
const WORLD_DISPLAY = "Mibera"

const idDb = new SQL(process.env.IDENTITY_DATABASE_URL!)
const midiDb = new SQL(process.env.MIDI_DATABASE_URL!)

console.log(`mode: ${dryRun ? "DRY RUN" : "REAL WRITE"}`)
console.log(`world: ${WORLD_SLUG}`)

// 1. seed mibera world if not present
const existingWorld = await idDb`SELECT world_slug FROM worlds WHERE world_slug = ${WORLD_SLUG}`
if (existingWorld.length === 0) {
  if (dryRun) {
    console.log(`[seed] would INSERT INTO worlds (world_slug, display_name) VALUES ('${WORLD_SLUG}', '${WORLD_DISPLAY}')`)
  } else {
    await idDb`INSERT INTO worlds (world_slug, display_name) VALUES (${WORLD_SLUG}, ${WORLD_DISPLAY})`
    console.log(`[seed] worlds: created '${WORLD_SLUG}' / '${WORLD_DISPLAY}'`)
  }
} else {
  console.log(`[seed] worlds.${WORLD_SLUG} already exists — skip`)
}

// 2. find spine users with wallets matching midi_profiles
const spineWallets = await idDb`
  SELECT u.user_id, wl.wallet_address
  FROM users u
  JOIN wallet_links wl ON wl.user_id = u.user_id
  WHERE wl.unlinked_at IS NULL
`
console.log(`[load] ${spineWallets.length} spine wallets`)

// 3. for each, look up midi display_name + claim nym
let claimed = 0, skipped_existing = 0, skipped_collision = 0, skipped_no_midi = 0, errors = 0

for (const sw of spineWallets) {
  const midi = await midiDb`
    SELECT display_name FROM midi_profiles
    WHERE lower(wallet_address) = lower(${sw.wallet_address})
    LIMIT 1
  `
  if (midi.length === 0) { skipped_no_midi++; continue }
  const nym = (midi[0] as MidiNameRow).display_name

  // already-claimed?
  const existing = await idDb`SELECT nym FROM world_identity WHERE user_id = ${sw.user_id} AND world_slug = ${WORLD_SLUG}`
  if (existing.length > 0) {
    console.log(`[skip] user ${sw.user_id} already has world_identity nym=${(existing[0] as ExistingNymRow).nym}`)
    skipped_existing++
    continue
  }

  if (dryRun) {
    console.log(`[claim] would: user=${sw.user_id} wallet=${sw.wallet_address} → nym='${nym}' in ${WORLD_SLUG}`)
    claimed++
    continue
  }

  try {
    await idDb`
      INSERT INTO world_identity (user_id, world_slug, nym)
      VALUES (${sw.user_id}, ${WORLD_SLUG}, ${nym})
    `
    console.log(`[claim] user=${sw.user_id} wallet=${sw.wallet_address} → nym='${nym}'`)
    claimed++
  } catch (e: any) {
    if (e?.code === "23505") {
      console.log(`[collision] nym='${nym}' already claimed in ${WORLD_SLUG} (user=${sw.user_id} attempted)`)
      skipped_collision++
    } else {
      console.error(`[error] user=${sw.user_id}: ${e?.message ?? e}`)
      errors++
    }
  }
}

console.log(JSON.stringify({
  spine_wallets: spineWallets.length,
  claimed,
  skipped_existing,
  skipped_collision,
  skipped_no_midi,
  errors,
}, null, 2))
