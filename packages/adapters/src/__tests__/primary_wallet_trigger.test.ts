/**
 * primary_wallet_trigger.test.ts — behavior tests for migration 0002 (T1.3).
 *
 * What the SDD-spec'd trigger ACTUALLY delivers (empirically verified — see
 * T1.3 build notes "SDD discrepancy" section): with `AFTER INSERT OR UPDATE
 * OF is_primary`, the partial-unique `uq_wallet_links_one_primary_per_user`
 * fires BEFORE the AFTER trigger gets a chance to demote prior primaries.
 * So:
 *   - Single-statement atomic swap (naive `UPDATE … SET is_primary=TRUE`
 *     while another row is primary) RAISES a uniqueness violation. The
 *     trigger's defense-in-depth demote pass never runs.
 *   - The legitimate workflow is two-statement (caller demotes any prior
 *     primary, then promotes the new one). The trigger then handles the
 *     `users.primary_wallet` mirror.
 *   - Single-INSERT first-ever primary works (no prior to conflict with).
 *   - Self-reset (UPDATE a primary row to TRUE again) works (no conflict).
 *
 * This matches the SDD §3.2 spec verbatim (function name, trigger name,
 * AFTER timing, body). The SDD's prose claims "atomic" single-statement
 * swap, which the literal SQL does not deliver. The mismatch is documented
 * in build notes and flagged back to the operator — these tests assert
 * what the spec-as-written ACTUALLY does, not what its prose claims.
 *
 * Strategy: against a real Postgres connection (TEST_DATABASE_URL), apply
 * 0001 + 0002 onto a clean scratch DB and exercise the trigger's behavior
 * across 10 cases:
 *
 *   1. installation          — trigger + function present after up
 *   2. legitimate swap       — two-statement workflow (caller demotes,
 *                              trigger mirrors); also asserts updated_at
 *                              advances on each mirror
 *   3. soft-unlink isolation — inactive rows do not compete; new primary
 *                              on a different wallet succeeds without
 *                              touching the soft-unlinked prior
 *   4. multi-user isolation  — primary changes for U1 do not touch U2
 *   5. self-reset            — re-applying primary to the already-primary
 *                              row is a no-op (no orphans, users.* stable)
 *   6. INSERT path           — first ever primary mirrors to users.*
 *   7. hard guarantee (INS)  — naive single-statement INSERT of a second
 *                              primary raises uniqueness violation
 *   8. hard guarantee (UPD)  — naive single-statement UPDATE flipping a
 *                              second wallet to primary ALSO raises
 *                              (the AFTER trigger does not rescue this)
 *   9. down                  — trigger + function gone; partial-unique
 *                              survives (hard guarantee outlives
 *                              convenience trigger rollback)
 *  10. re-install            — up after down restores behavior cleanly
 *
 * Mirrors the gating + safety posture from migrate.test.ts:
 *   - Skipped without TEST_DATABASE_URL.
 *   - Refuses non-scratch-shaped DB names.
 *   - Drops all spine + trigger state before/after the suite.
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

async function dropAllSpineState(sql: SQL): Promise<void> {
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

async function applyUpToAll(databaseUrl: string): Promise<void> {
  const result = await migrate({
    databaseUrl,
    migrationsDir: MIGRATIONS_DIR,
    verb: "up",
  })
  // Result type: { verb: "up"; applied: string[] }. We expect 0001 + 0002
  // applied in lexical order from a clean DB.
  if (result.verb !== "up") {
    throw new Error(`expected verb up, got ${result.verb}`)
  }
}

interface TriggerRow {
  trigger_name: string
  event_manipulation: string
  action_timing: string
  event_object_table: string
}

async function findTrigger(sql: SQL): Promise<TriggerRow[]> {
  return (await sql`
    SELECT trigger_name, event_manipulation, action_timing, event_object_table
      FROM information_schema.triggers
     WHERE event_object_table = 'wallet_links'
       AND trigger_name = 'trg_sync_primary_wallet'
     ORDER BY event_manipulation
  `) as TriggerRow[]
}

async function findFunction(sql: SQL): Promise<string[]> {
  const rows = (await sql`
    SELECT proname FROM pg_proc WHERE proname = 'sync_primary_wallet'
  `) as Array<{ proname: string }>
  return rows.map((r) => r.proname)
}

describe.skipIf(!TEST_DATABASE_URL)("0002 primary-wallet trigger (T1.3)", () => {
  const databaseUrl = TEST_DATABASE_URL as string

  beforeAll(async () => {
    if (!looksLikeScratchUrl(databaseUrl)) {
      throw new Error(
        `primary_wallet_trigger.test: TEST_DATABASE_URL DB name does not look scratch-shaped (expected to contain one of: ${SCRATCH_DB_HINTS.join(", ")}). Refusing to drop tables on a non-scratch DB.`,
      )
    }
    const sql = new SQL(databaseUrl)
    try {
      await dropAllSpineState(sql)
    } finally {
      await sql.close()
    }
    // Apply 0001 + 0002 onto the clean DB; every individual test then
    // works on this prepared state and cleans its own rows.
    await applyUpToAll(databaseUrl)
  })

  afterAll(async () => {
    const sql = new SQL(databaseUrl)
    try {
      await dropAllSpineState(sql)
    } finally {
      await sql.close()
    }
  })

  // ── 1. Installation surface ────────────────────────────────────────────────

  it("installs trg_sync_primary_wallet on wallet_links (INSERT + UPDATE timings)", async () => {
    const sql = new SQL(databaseUrl)
    try {
      const triggers = await findTrigger(sql)
      // information_schema.triggers reports one row per event_manipulation, so
      // a single CREATE TRIGGER with INSERT OR UPDATE shows up as TWO rows.
      const manipulations = triggers.map((t) => t.event_manipulation).sort()
      expect(manipulations).toEqual(["INSERT", "UPDATE"])
      for (const t of triggers) {
        // BEFORE — operator curation 2026-05-24 (T1.3 review gate). SDD §3.2
        // amended from AFTER to make single-statement atomic swap actually
        // work; AFTER let the partial-unique fire before the trigger could
        // demote. See trigger SQL header for the full reconciliation.
        expect(t.action_timing).toBe("BEFORE")
        expect(t.event_object_table).toBe("wallet_links")
      }

      const fn = await findFunction(sql)
      expect(fn).toContain("sync_primary_wallet")
    } finally {
      await sql.close()
    }
  })

  // ── 3 + 4. Legitimate two-statement swap: caller demotes, trigger mirrors ──

  it("legitimate two-statement swap (caller demotes prior, then promotes new) mirrors to users.primary_wallet and advances updated_at", async () => {
    const sql = new SQL(databaseUrl)
    try {
      // Fresh user U; insert wallet A as primary; insert wallet B as
      // non-primary. The SDD-spec'd trigger does NOT support single-statement
      // atomic swap (test 9 documents the constraint); the legitimate caller
      // workflow is two statements (typically inside one transaction):
      //   (1) UPDATE wallet_links SET is_primary=FALSE WHERE … is_primary=TRUE
      //   (2) UPDATE wallet_links SET is_primary=TRUE  WHERE … target row
      // The trigger fires on (2) and mirrors users.primary_wallet. T1.5
      // resolve logic will adopt this pattern.
      const userRow = (await sql`
        INSERT INTO users DEFAULT VALUES RETURNING user_id
      `) as Array<{ user_id: string }>
      const userId = userRow[0]!.user_id

      await sql`
        INSERT INTO wallet_links (wallet_address, user_id, is_primary)
        VALUES ('0xaaa', ${userId}, TRUE)
      `
      await sql`
        INSERT INTO wallet_links (wallet_address, user_id, is_primary)
        VALUES ('0xbbb', ${userId}, FALSE)
      `

      // Capture users.updated_at after the first primary so we can prove the
      // SECOND mirror advances it.
      const afterFirst = (await sql`
        SELECT primary_wallet, updated_at FROM users WHERE user_id = ${userId}
      `) as Array<{ primary_wallet: string; updated_at: string }>
      expect(afterFirst[0]!.primary_wallet).toBe("0xaaa")

      // Wait a beat so NOW() returns a strictly-greater statement-time
      // value on the second mirror.
      await new Promise((r) => setTimeout(r, 50))

      // Step 1: caller demotes prior primary.
      await sql`
        UPDATE wallet_links SET is_primary = FALSE
         WHERE user_id = ${userId}
           AND is_primary = TRUE
           AND unlinked_at IS NULL
      `
      // Step 2: caller promotes new primary. The trigger fires here.
      await sql`
        UPDATE wallet_links SET is_primary = TRUE
         WHERE wallet_address = '0xbbb' AND user_id = ${userId}
      `

      // (a) Prior primary A is demoted (active, but is_primary=false).
      const a = (await sql`
        SELECT is_primary, unlinked_at FROM wallet_links
         WHERE wallet_address = '0xaaa' AND user_id = ${userId}
      `) as Array<{ is_primary: boolean; unlinked_at: string | null }>
      expect(a[0]!.is_primary).toBe(false)
      expect(a[0]!.unlinked_at).toBeNull()

      // (b) New primary B is set.
      const b = (await sql`
        SELECT is_primary FROM wallet_links
         WHERE wallet_address = '0xbbb' AND user_id = ${userId}
      `) as Array<{ is_primary: boolean }>
      expect(b[0]!.is_primary).toBe(true)

      // (c) users.primary_wallet mirrored to B.
      // (d) users.updated_at advanced past the prior mirror.
      const afterSwap = (await sql`
        SELECT primary_wallet, updated_at FROM users WHERE user_id = ${userId}
      `) as Array<{ primary_wallet: string; updated_at: string }>
      expect(afterSwap[0]!.primary_wallet).toBe("0xbbb")
      expect(new Date(afterSwap[0]!.updated_at).getTime()).toBeGreaterThan(
        new Date(afterFirst[0]!.updated_at).getTime(),
      )

      // (e) Exactly one active primary (FR-R5 invariant).
      const count = (await sql`
        SELECT COUNT(*)::int AS n FROM wallet_links
         WHERE user_id = ${userId} AND is_primary = TRUE AND unlinked_at IS NULL
      `) as Array<{ n: number }>
      expect(count[0]!.n).toBe(1)

      // Cleanup: leave the table empty for the next test.
      await sql`DELETE FROM wallet_links WHERE user_id = ${userId}`
      await sql`DELETE FROM users WHERE user_id = ${userId}`
    } finally {
      await sql.close()
    }
  })

  // ── 5. Soft-unlink isolation ───────────────────────────────────────────────

  it("a soft-unlinked prior primary does not compete; a new primary on a different wallet succeeds", async () => {
    const sql = new SQL(databaseUrl)
    try {
      const userRow = (await sql`
        INSERT INTO users DEFAULT VALUES RETURNING user_id
      `) as Array<{ user_id: string }>
      const userId = userRow[0]!.user_id

      // Insert A as primary then SOFT UNLINK A (set unlinked_at + leave
      // is_primary historically TRUE; the partial-unique excludes inactive
      // rows so this is allowed).
      await sql`
        INSERT INTO wallet_links (wallet_address, user_id, is_primary)
        VALUES ('0xa1', ${userId}, TRUE)
      `
      await sql`
        UPDATE wallet_links SET unlinked_at = NOW()
         WHERE wallet_address = '0xa1' AND user_id = ${userId}
      `

      // Now insert C with is_primary=TRUE. The trigger fires; A is inactive
      // so the WHERE excludes it; no row of A is touched. C becomes primary.
      await sql`
        INSERT INTO wallet_links (wallet_address, user_id, is_primary)
        VALUES ('0xc1', ${userId}, TRUE)
      `

      const a = (await sql`
        SELECT is_primary, unlinked_at FROM wallet_links
         WHERE wallet_address = '0xa1' AND user_id = ${userId}
      `) as Array<{ is_primary: boolean; unlinked_at: string | null }>
      // A's is_primary is unchanged (historically TRUE — preserved across
      // soft-unlink; the trigger refuses to touch inactive rows).
      expect(a[0]!.is_primary).toBe(true)
      expect(a[0]!.unlinked_at).not.toBeNull()

      const c = (await sql`
        SELECT is_primary FROM wallet_links
         WHERE wallet_address = '0xc1' AND user_id = ${userId}
      `) as Array<{ is_primary: boolean }>
      expect(c[0]!.is_primary).toBe(true)

      const user = (await sql`
        SELECT primary_wallet FROM users WHERE user_id = ${userId}
      `) as Array<{ primary_wallet: string }>
      expect(user[0]!.primary_wallet).toBe("0xc1")

      await sql`DELETE FROM wallet_links WHERE user_id = ${userId}`
      await sql`DELETE FROM users WHERE user_id = ${userId}`
    } finally {
      await sql.close()
    }
  })

  // ── 6. Multi-user isolation ────────────────────────────────────────────────

  it("changing primary for user U1 does not touch user U2's primary", async () => {
    const sql = new SQL(databaseUrl)
    try {
      const u1Row = (await sql`
        INSERT INTO users DEFAULT VALUES RETURNING user_id
      `) as Array<{ user_id: string }>
      const u2Row = (await sql`
        INSERT INTO users DEFAULT VALUES RETURNING user_id
      `) as Array<{ user_id: string }>
      const u1 = u1Row[0]!.user_id
      const u2 = u2Row[0]!.user_id

      await sql`
        INSERT INTO wallet_links (wallet_address, user_id, is_primary)
        VALUES ('0xu1a', ${u1}, TRUE)
      `
      await sql`
        INSERT INTO wallet_links (wallet_address, user_id, is_primary)
        VALUES ('0xu2x', ${u2}, TRUE)
      `

      // Now flip U1 to a second wallet B (using the legitimate two-statement
      // workflow — see test 3 for full rationale). U2's X must remain
      // primary and users.primary_wallet for U2 must remain '0xu2x'.
      await sql`
        INSERT INTO wallet_links (wallet_address, user_id, is_primary)
        VALUES ('0xu1b', ${u1}, FALSE)
      `
      await sql`
        UPDATE wallet_links SET is_primary = FALSE
         WHERE user_id = ${u1} AND is_primary = TRUE AND unlinked_at IS NULL
      `
      await sql`
        UPDATE wallet_links SET is_primary = TRUE
         WHERE wallet_address = '0xu1b' AND user_id = ${u1}
      `

      const u1a = (await sql`
        SELECT is_primary FROM wallet_links
         WHERE wallet_address = '0xu1a' AND user_id = ${u1}
      `) as Array<{ is_primary: boolean }>
      expect(u1a[0]!.is_primary).toBe(false)

      const u2x = (await sql`
        SELECT is_primary FROM wallet_links
         WHERE wallet_address = '0xu2x' AND user_id = ${u2}
      `) as Array<{ is_primary: boolean }>
      expect(u2x[0]!.is_primary).toBe(true)

      const u1User = (await sql`
        SELECT primary_wallet FROM users WHERE user_id = ${u1}
      `) as Array<{ primary_wallet: string }>
      expect(u1User[0]!.primary_wallet).toBe("0xu1b")

      const u2User = (await sql`
        SELECT primary_wallet FROM users WHERE user_id = ${u2}
      `) as Array<{ primary_wallet: string }>
      expect(u2User[0]!.primary_wallet).toBe("0xu2x")

      await sql`DELETE FROM wallet_links WHERE user_id IN (${u1}, ${u2})`
      await sql`DELETE FROM users WHERE user_id IN (${u1}, ${u2})`
    } finally {
      await sql.close()
    }
  })

  // ── 7. Self-reset is a no-op ───────────────────────────────────────────────

  it("re-setting an already-primary row to primary is a no-op (no orphans, users.primary_wallet stable)", async () => {
    const sql = new SQL(databaseUrl)
    try {
      const userRow = (await sql`
        INSERT INTO users DEFAULT VALUES RETURNING user_id
      `) as Array<{ user_id: string }>
      const userId = userRow[0]!.user_id

      await sql`
        INSERT INTO wallet_links (wallet_address, user_id, is_primary)
        VALUES ('0xself', ${userId}, TRUE)
      `

      // Now re-set the same row to primary. The trigger fires; the SELF
      // exclusion (`wallet_address <> NEW.wallet_address`) prevents the
      // trigger's UPDATE from touching the row, but the mirror to users.*
      // still runs (idempotent).
      await sql`
        UPDATE wallet_links SET is_primary = TRUE
         WHERE wallet_address = '0xself' AND user_id = ${userId}
      `

      const self = (await sql`
        SELECT is_primary FROM wallet_links
         WHERE wallet_address = '0xself' AND user_id = ${userId}
      `) as Array<{ is_primary: boolean }>
      expect(self[0]!.is_primary).toBe(true)

      const user = (await sql`
        SELECT primary_wallet FROM users WHERE user_id = ${userId}
      `) as Array<{ primary_wallet: string }>
      expect(user[0]!.primary_wallet).toBe("0xself")

      // No second primary appeared (FR-R5: exactly one primary per user
      // among active rows). The partial-unique would have caught it; assert
      // anyway as defense-in-depth.
      const primaries = (await sql`
        SELECT COUNT(*)::int AS n FROM wallet_links
         WHERE user_id = ${userId}
           AND is_primary = TRUE
           AND unlinked_at IS NULL
      `) as Array<{ n: number }>
      expect(primaries[0]!.n).toBe(1)

      await sql`DELETE FROM wallet_links WHERE user_id = ${userId}`
      await sql`DELETE FROM users WHERE user_id = ${userId}`
    } finally {
      await sql.close()
    }
  })

  // ── 8. Single-INSERT path mirrors with no prior ────────────────────────────

  it("inserting the FIRST ever primary wallet for a user mirrors to users.primary_wallet (no prior to demote)", async () => {
    const sql = new SQL(databaseUrl)
    try {
      const userRow = (await sql`
        INSERT INTO users DEFAULT VALUES RETURNING user_id
      `) as Array<{ user_id: string }>
      const userId = userRow[0]!.user_id

      // Single INSERT with is_primary=TRUE. There is no prior row to demote;
      // the trigger's first UPDATE is a 0-row no-op, the second mirrors.
      await sql`
        INSERT INTO wallet_links (wallet_address, user_id, is_primary)
        VALUES ('0xfirst', ${userId}, TRUE)
      `

      const user = (await sql`
        SELECT primary_wallet FROM users WHERE user_id = ${userId}
      `) as Array<{ primary_wallet: string }>
      expect(user[0]!.primary_wallet).toBe("0xfirst")

      await sql`DELETE FROM wallet_links WHERE user_id = ${userId}`
      await sql`DELETE FROM users WHERE user_id = ${userId}`
    } finally {
      await sql.close()
    }
  })

  // ── 8 + 9. Hard guarantee: naive single-statement second primary raises ────
  //
  // Both INSERT and UPDATE flavors of "create a second primary in one
  // statement" hit the partial-unique before the AFTER trigger can demote.
  // This is the SDD's "hard guarantee" surfacing. The two tests document
  // both raise paths so T1.5 resolve logic has executable contract docs.

  it("single-statement INSERT of a SECOND primary succeeds atomically — BEFORE trigger demotes the prior first, then partial-unique sees a consistent state", async () => {
    // Operator curation 2026-05-24 flipped the trigger to BEFORE (SDD §3.2
    // amended). With BEFORE, a single-statement INSERT of a second primary
    // for the same user no longer raises — the trigger runs first and
    // demotes the prior primary, so the partial-unique sees only the new
    // tuple as primary and is satisfied. This test ASSERTS the atomic
    // behavior the SDD prose has always claimed.
    //
    // The partial-unique still hard-guarantees CONCURRENT races (two
    // simultaneous transactions setting conflicting primaries serialize on
    // the unique index slot). That class is hard to exercise deterministically
    // in a unit test; documented but not asserted here.
    const sql = new SQL(databaseUrl)
    try {
      const userRow = (await sql`
        INSERT INTO users DEFAULT VALUES RETURNING user_id
      `) as Array<{ user_id: string }>
      const userId = userRow[0]!.user_id

      await sql`
        INSERT INTO wallet_links (wallet_address, user_id, is_primary)
        VALUES ('0xhard1', ${userId}, TRUE)
      `

      // Single-statement INSERT of a second primary. Trigger demotes hard1
      // BEFORE the partial-unique check on hard2 — INSERT succeeds.
      await sql`
        INSERT INTO wallet_links (wallet_address, user_id, is_primary)
        VALUES ('0xhard2', ${userId}, TRUE)
      `

      // hard1 demoted (still active, just not primary anymore).
      const first = (await sql`
        SELECT is_primary, unlinked_at FROM wallet_links
         WHERE wallet_address = '0xhard1' AND user_id = ${userId}
      `) as Array<{ is_primary: boolean; unlinked_at: string | null }>
      expect(first[0]!.is_primary).toBe(false)
      expect(first[0]!.unlinked_at).toBeNull()

      // hard2 is the new primary.
      const second = (await sql`
        SELECT is_primary FROM wallet_links
         WHERE wallet_address = '0xhard2' AND user_id = ${userId}
      `) as Array<{ is_primary: boolean }>
      expect(second[0]!.is_primary).toBe(true)

      // users.primary_wallet mirrored to hard2.
      const user = (await sql`
        SELECT primary_wallet FROM users WHERE user_id = ${userId}
      `) as Array<{ primary_wallet: string }>
      expect(user[0]!.primary_wallet).toBe("0xhard2")

      // FR-R5 invariant: exactly one active primary per user.
      const count = (await sql`
        SELECT COUNT(*)::int AS n FROM wallet_links
         WHERE user_id = ${userId} AND is_primary = TRUE AND unlinked_at IS NULL
      `) as Array<{ n: number }>
      expect(count[0]!.n).toBe(1)

      await sql`DELETE FROM wallet_links WHERE user_id = ${userId}`
      await sql`DELETE FROM users WHERE user_id = ${userId}`
    } finally {
      await sql.close()
    }
  })

  it("single-statement UPDATE flipping a non-primary wallet to is_primary=TRUE succeeds atomically — BEFORE trigger demotes prior; SDD-prose 'atomic swap' delivered", async () => {
    // The SDD-prose's "atomic swap" claim now HOLDS with BEFORE timing.
    // Operator curation 2026-05-24 flipped the trigger; SDD §3.2 amended.
    // A single UPDATE to set is_primary=TRUE on a non-primary row, while
    // another row is primary for the same user, demotes the prior first
    // (trigger runs BEFORE the partial-unique check) and the UPDATE
    // succeeds. T1.5 resolve logic can use the single-statement promote
    // pattern; the two-statement workflow is no longer required.
    const sql = new SQL(databaseUrl)
    try {
      const userRow = (await sql`
        INSERT INTO users DEFAULT VALUES RETURNING user_id
      `) as Array<{ user_id: string }>
      const userId = userRow[0]!.user_id

      await sql`
        INSERT INTO wallet_links (wallet_address, user_id, is_primary)
        VALUES ('0xupd1', ${userId}, TRUE)
      `
      await sql`
        INSERT INTO wallet_links (wallet_address, user_id, is_primary)
        VALUES ('0xupd2', ${userId}, FALSE)
      `

      // Single-statement promote. With BEFORE, the trigger demotes upd1
      // first, then the partial-unique check on upd2 sees a consistent
      // state and succeeds.
      await sql`
        UPDATE wallet_links SET is_primary = TRUE
         WHERE wallet_address = '0xupd2' AND user_id = ${userId}
      `

      // upd1 demoted, still active.
      const upd1 = (await sql`
        SELECT is_primary, unlinked_at FROM wallet_links
         WHERE wallet_address = '0xupd1' AND user_id = ${userId}
      `) as Array<{ is_primary: boolean; unlinked_at: string | null }>
      expect(upd1[0]!.is_primary).toBe(false)
      expect(upd1[0]!.unlinked_at).toBeNull()

      // upd2 is the new primary.
      const upd2 = (await sql`
        SELECT is_primary FROM wallet_links
         WHERE wallet_address = '0xupd2' AND user_id = ${userId}
      `) as Array<{ is_primary: boolean }>
      expect(upd2[0]!.is_primary).toBe(true)

      // Mirror updated.
      const user = (await sql`
        SELECT primary_wallet FROM users WHERE user_id = ${userId}
      `) as Array<{ primary_wallet: string }>
      expect(user[0]!.primary_wallet).toBe("0xupd2")

      // FR-R5 invariant: exactly one active primary per user.
      const count = (await sql`
        SELECT COUNT(*)::int AS n FROM wallet_links
         WHERE user_id = ${userId} AND is_primary = TRUE AND unlinked_at IS NULL
      `) as Array<{ n: number }>
      expect(count[0]!.n).toBe(1)

      await sql`DELETE FROM wallet_links WHERE user_id = ${userId}`
      await sql`DELETE FROM users WHERE user_id = ${userId}`
    } finally {
      await sql.close()
    }
  })

  // ── 10. Down removes trigger + function ────────────────────────────────────

  it("down: rolls back 0002 and removes both trigger and function", async () => {
    const result = await migrate({
      databaseUrl,
      migrationsDir: MIGRATIONS_DIR,
      verb: "down",
    })
    expect(result).toEqual({ verb: "down", reverted: "0002_primary_wallet_trigger" })

    const sql = new SQL(databaseUrl)
    try {
      const triggers = await findTrigger(sql)
      expect(triggers).toEqual([])
      const fn = await findFunction(sql)
      expect(fn).toEqual([])

      // 0001 spine + partial-unique remain — the hard guarantee survives
      // rollback of the convenience trigger.
      const indexes = (await sql`
        SELECT indexname FROM pg_indexes
         WHERE schemaname = 'public' AND indexname = 'uq_wallet_links_one_primary_per_user'
      `) as Array<{ indexname: string }>
      expect(indexes.length).toBe(1)
    } finally {
      await sql.close()
    }
  })

  // ── 11. Re-applying up restores behavior ──────────────────────────────────

  it("up after down: re-applies 0002 cleanly (trigger back, behavior round-trips)", async () => {
    const result = await migrate({
      databaseUrl,
      migrationsDir: MIGRATIONS_DIR,
      verb: "up",
    })
    expect(result).toEqual({ verb: "up", applied: ["0002_primary_wallet_trigger"] })

    const sql = new SQL(databaseUrl)
    try {
      const triggers = await findTrigger(sql)
      expect(triggers.length).toBe(2) // INSERT + UPDATE rows
      const fn = await findFunction(sql)
      expect(fn).toContain("sync_primary_wallet")

      // Quick behavior smoke: trigger fires after re-apply.
      const userRow = (await sql`
        INSERT INTO users DEFAULT VALUES RETURNING user_id
      `) as Array<{ user_id: string }>
      const userId = userRow[0]!.user_id
      await sql`
        INSERT INTO wallet_links (wallet_address, user_id, is_primary)
        VALUES ('0xroundtrip', ${userId}, TRUE)
      `
      const user = (await sql`
        SELECT primary_wallet FROM users WHERE user_id = ${userId}
      `) as Array<{ primary_wallet: string }>
      expect(user[0]!.primary_wallet).toBe("0xroundtrip")

      await sql`DELETE FROM wallet_links WHERE user_id = ${userId}`
      await sql`DELETE FROM users WHERE user_id = ${userId}`
    } finally {
      await sql.close()
    }
  })
})
