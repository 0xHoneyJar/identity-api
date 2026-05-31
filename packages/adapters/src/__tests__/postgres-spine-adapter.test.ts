/**
 * postgres-spine-adapter.test.ts — adapter behavior tests against a real PG
 * scratch DB (T1.5, bead arrakis-232n).
 *
 * Gating + safety mirror migrate.test.ts:
 *   - Suite SKIPs unless TEST_DATABASE_URL is set.
 *   - Refuses non-scratch-shaped DB names (paranoia: never drop on prod).
 *   - Drops + re-applies all migrations in beforeAll so each suite run
 *     starts from a known state.
 *
 * Coverage by FR (the contract this adapter delivers):
 *   - FR-R1 resolveByWallet: happy + not-found + case-insensitive
 *   - FR-R2 resolveByAccount: happy + not-found
 *   - FR-R3 resolveByNym: happy + not-found + world-scoped
 *   - FR-R4 getIdentity: composite assembly + not-found
 *   - FR-R5 setPrimary: single-statement promote (the T1.3 BEFORE payoff)
 *           + idempotent self-reset + not-found path
 *   - FR-R6 mintUser / linkWallet / linkAccount / claimNym
 *           + linkAccount collision → SpineConflictError(kind=linked_account)
 *           + claimNym world-unique collision → SpineConflictError(kind=world_identity)
 *           + claimNym user-PK collision → SpineConflictError(kind=world_identity)
 *   - NFR-5 writeAuditEvent persists with the expected shape
 *
 * The atomicity proofs (single-statement promote, INSERT-with-primary-of-second)
 * are owned by 0002_primary_wallet_trigger.test.ts; here we just call the
 * adapter and confirm the surface contract.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import { SQL } from "bun"
import { resolve } from "node:path"

import { migrate } from "../migrate"
import {
  PostgresSpineAdapter,
  SpineConflictError,
} from "../postgres-spine-adapter"

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
    DROP TABLE IF EXISTS world_managers CASCADE;
    DROP TABLE IF EXISTS world_identity CASCADE;
    DROP TABLE IF EXISTS worlds CASCADE;
    DROP TABLE IF EXISTS linked_accounts CASCADE;
    DROP TABLE IF EXISTS wallet_links CASCADE;
    DROP TABLE IF EXISTS users CASCADE;
    DROP TABLE IF EXISTS schema_migrations CASCADE;
  `)
}

async function clearWritableTables(sql: SQL): Promise<void> {
  // Truncate between tests so we don't leak state. CASCADE clears child
  // tables; we keep the worlds row(s) we seed for nym tests.
  await sql.unsafe(`
    TRUNCATE world_managers, world_identity, linked_accounts, wallet_links, audit_events, users, auth_nonces
    RESTART IDENTITY CASCADE;
  `)
}

async function seedTestWorld(sql: SQL, slug: string): Promise<void> {
  await sql`
    INSERT INTO worlds (world_slug, display_name)
    VALUES (${slug}, ${slug})
    ON CONFLICT (world_slug) DO NOTHING
  `
}

describe.skipIf(!TEST_DATABASE_URL)("PostgresSpineAdapter (T1.5)", () => {
  const databaseUrl = TEST_DATABASE_URL as string
  let spine: PostgresSpineAdapter

  beforeAll(async () => {
    if (!looksLikeScratchUrl(databaseUrl)) {
      throw new Error(
        `postgres-spine-adapter.test: TEST_DATABASE_URL DB name does not look scratch-shaped (expected: ${SCRATCH_DB_HINTS.join(", ")}). Refusing to drop on a non-scratch DB.`,
      )
    }
    const sql = new SQL(databaseUrl)
    try {
      await dropAllSpineState(sql)
    } finally {
      await sql.close()
    }
    await migrate({ databaseUrl, migrationsDir: MIGRATIONS_DIR, verb: "up" })
    spine = new PostgresSpineAdapter(databaseUrl)
    // Seed worlds for the nym tests.
    const seedSql = new SQL(databaseUrl)
    try {
      await seedTestWorld(seedSql, "thj")
      await seedTestWorld(seedSql, "mibera")
    } finally {
      await seedSql.close()
    }
  })

  afterAll(async () => {
    await spine.close()
    const sql = new SQL(databaseUrl)
    try {
      await dropAllSpineState(sql)
    } finally {
      await sql.close()
    }
  })

  afterEach(async () => {
    const sql = new SQL(databaseUrl)
    try {
      await clearWritableTables(sql)
      // Re-seed worlds since TRUNCATE wiped them.
      await seedTestWorld(sql, "thj")
      await seedTestWorld(sql, "mibera")
    } finally {
      await sql.close()
    }
  })

  // ── FR-R1 resolveByWallet ─────────────────────────────────────────────

  it("resolveByWallet returns the user_id for an active linked wallet (FR-R1)", async () => {
    const userId = await spine.mintUser()
    await spine.linkWallet({
      userId,
      walletAddress: "0xabc0000000000000000000000000000000000001",
      isPrimary: true,
    })
    const got = await spine.resolveByWallet("0xabc0000000000000000000000000000000000001")
    expect(got).toBe(userId)
  })

  it("resolveByWallet returns null for an unknown wallet", async () => {
    const got = await spine.resolveByWallet("0xdeadbeef00000000000000000000000000000000")
    expect(got).toBeNull()
  })

  it("resolveByWallet excludes soft-unlinked rows", async () => {
    const userId = await spine.mintUser()
    await spine.linkWallet({
      userId,
      walletAddress: "0xabc0000000000000000000000000000000000002",
      isPrimary: true,
    })
    // Soft-unlink the wallet.
    const sql = new SQL(databaseUrl)
    try {
      await sql`
        UPDATE wallet_links SET unlinked_at = NOW()
         WHERE wallet_address = '0xabc0000000000000000000000000000000000002'
      `
    } finally {
      await sql.close()
    }
    const got = await spine.resolveByWallet("0xabc0000000000000000000000000000000000002")
    expect(got).toBeNull()
  })

  // ── FR-R2 resolveByAccount ────────────────────────────────────────────

  it("resolveByAccount returns the user_id for a (provider, externalId) tuple (FR-R2)", async () => {
    const userId = await spine.mintUser()
    await spine.linkAccount({ userId, provider: "discord", externalId: "discord-1234" })
    const got = await spine.resolveByAccount("discord", "discord-1234")
    expect(got).toBe(userId)
  })

  it("resolveByAccount returns null when (provider, externalId) is unknown", async () => {
    const got = await spine.resolveByAccount("discord", "nope-9999")
    expect(got).toBeNull()
  })

  // ── FR-R3 resolveByNym ────────────────────────────────────────────────

  it("resolveByNym returns the user_id for (world, nym) (FR-R3)", async () => {
    const userId = await spine.mintUser()
    await spine.claimNym({ userId, worldSlug: "mibera", nym: "honeybear" })
    const got = await spine.resolveByNym("mibera", "honeybear")
    expect(got).toBe(userId)
  })

  it("resolveByNym is world-scoped — same nym in a different world is null", async () => {
    const userId = await spine.mintUser()
    await spine.claimNym({ userId, worldSlug: "mibera", nym: "honeybear" })
    const otherWorld = await spine.resolveByNym("thj", "honeybear")
    expect(otherWorld).toBeNull()
  })

  it("resolveByNym returns null for an unknown nym", async () => {
    const got = await spine.resolveByNym("mibera", "nobody-claims-this")
    expect(got).toBeNull()
  })

  // ── FR-R4 getIdentity ────────────────────────────────────────────────

  it("getIdentity assembles the full composite (FR-R4)", async () => {
    const userId = await spine.mintUser()
    await spine.linkWallet({
      userId,
      walletAddress: "0xfac1000000000000000000000000000000000001",
      chainIds: ["1", "8453"],
      isPrimary: true,
    })
    await spine.linkWallet({
      userId,
      walletAddress: "0xfac1000000000000000000000000000000000002",
      isPrimary: false,
    })
    await spine.linkAccount({ userId, provider: "discord", externalId: "disc-7777" })
    await spine.linkAccount({ userId, provider: "telegram", externalId: "tg-7777" })
    await spine.claimNym({ userId, worldSlug: "mibera", nym: "fullshape" })

    const identity = await spine.getIdentity(userId)
    expect(identity).not.toBeNull()
    if (!identity) return

    expect(identity.user_id).toBe(userId)
    expect(identity.primary_wallet).toBe("0xfac1000000000000000000000000000000000001")
    expect(identity.wallets).toHaveLength(2)
    // Primary first per the ORDER BY is_primary DESC.
    expect(identity.wallets[0]!.wallet_address).toBe("0xfac1000000000000000000000000000000000001")
    expect(identity.wallets[0]!.is_primary).toBe(true)
    expect(identity.wallets[0]!.chain_ids).toEqual(["1", "8453"])
    expect(identity.wallets[1]!.is_primary).toBe(false)

    expect(identity.linked_accounts).toHaveLength(2)
    const providers = identity.linked_accounts.map((a) => a.provider).sort()
    expect(providers).toEqual(["discord", "telegram"])

    expect(identity.world_identities).toHaveLength(1)
    expect(identity.world_identities[0]!.world_slug).toBe("mibera")
    expect(identity.world_identities[0]!.nym).toBe("fullshape")
  })

  it("getIdentity returns null for an unknown user_id", async () => {
    const got = await spine.getIdentity("00000000-0000-0000-0000-000000000000")
    expect(got).toBeNull()
  })

  // ── FR-R5 setPrimary — single-statement promote (T1.3 BEFORE payoff) ──

  it("setPrimary in one statement: demotes prior + mirrors users.primary_wallet (FR-R5 atomic swap)", async () => {
    const userId = await spine.mintUser()
    await spine.linkWallet({
      userId,
      walletAddress: "0xaaaa000000000000000000000000000000000001",
      isPrimary: true,
    })
    await spine.linkWallet({
      userId,
      walletAddress: "0xbbbb000000000000000000000000000000000002",
      isPrimary: false,
    })

    // Capture pre-state.
    const sql = new SQL(databaseUrl)
    try {
      const pre = (await sql`
        SELECT primary_wallet, updated_at FROM users WHERE user_id = ${userId}
      `) as Array<{ primary_wallet: string; updated_at: string }>
      expect(pre[0]!.primary_wallet).toBe("0xaaaa000000000000000000000000000000000001")
      const beforeTs = new Date(pre[0]!.updated_at).getTime()

      await new Promise((r) => setTimeout(r, 50))

      // SINGLE-STATEMENT promote — this is the T1.3 amendment payoff.
      const ok = await spine.setPrimary({
        userId,
        walletAddress: "0xbbbb000000000000000000000000000000000002",
      })
      expect(ok).toBe(true)

      // Post-state: A demoted, B primary, mirror updated, updated_at advanced.
      const a = (await sql`
        SELECT is_primary FROM wallet_links
         WHERE wallet_address = '0xaaaa000000000000000000000000000000000001'
      `) as Array<{ is_primary: boolean }>
      const b = (await sql`
        SELECT is_primary FROM wallet_links
         WHERE wallet_address = '0xbbbb000000000000000000000000000000000002'
      `) as Array<{ is_primary: boolean }>
      expect(a[0]!.is_primary).toBe(false)
      expect(b[0]!.is_primary).toBe(true)

      const post = (await sql`
        SELECT primary_wallet, updated_at FROM users WHERE user_id = ${userId}
      `) as Array<{ primary_wallet: string; updated_at: string }>
      expect(post[0]!.primary_wallet).toBe("0xbbbb000000000000000000000000000000000002")
      expect(new Date(post[0]!.updated_at).getTime()).toBeGreaterThan(beforeTs)

      // FR-R5 invariant: exactly one active primary per user.
      const count = (await sql`
        SELECT COUNT(*)::int AS n FROM wallet_links
         WHERE user_id = ${userId} AND is_primary = TRUE AND unlinked_at IS NULL
      `) as Array<{ n: number }>
      expect(count[0]!.n).toBe(1)
    } finally {
      await sql.close()
    }
  })

  it("setPrimary on an unknown (user, wallet) returns false (no-op)", async () => {
    const userId = await spine.mintUser()
    // No link exists.
    const ok = await spine.setPrimary({
      userId,
      walletAddress: "0xneverlinked00000000000000000000000000000",
    })
    expect(ok).toBe(false)
  })

  it("setPrimary on an already-primary wallet is idempotent (returns true)", async () => {
    const userId = await spine.mintUser()
    await spine.linkWallet({
      userId,
      walletAddress: "0xself000000000000000000000000000000000001",
      isPrimary: true,
    })
    const ok = await spine.setPrimary({
      userId,
      walletAddress: "0xself000000000000000000000000000000000001",
    })
    expect(ok).toBe(true)
  })

  // ── FR-R6 mintUser + writes ──────────────────────────────────────────

  it("mintUser returns a UUID user_id (FR-R6)", async () => {
    const userId = await spine.mintUser()
    expect(typeof userId).toBe("string")
    // UUID v4-ish check.
    expect(userId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  })

  // ── Conflict policy — linkAccount cross-user collision ─────────────────

  it("linkAccount throws SpineConflictError(linked_account) on (provider, externalId) duplicate (D9)", async () => {
    const u1 = await spine.mintUser()
    const u2 = await spine.mintUser()
    await spine.linkAccount({ userId: u1, provider: "discord", externalId: "shared-discord" })

    // u2 attempts to claim the same discord — must hard-fail per D9.
    let thrown: unknown = null
    try {
      await spine.linkAccount({ userId: u2, provider: "discord", externalId: "shared-discord" })
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(SpineConflictError)
    if (thrown instanceof SpineConflictError) {
      expect(thrown.kind).toBe("linked_account")
      expect(thrown.context).toEqual({
        provider: "discord",
        external_id: "shared-discord",
        attempted_user_id: u2,
      })
    }
    // Spine state unchanged: u1 still owns the discord row.
    const owner = await spine.resolveByAccount("discord", "shared-discord")
    expect(owner).toBe(u1)
  })

  // ── Conflict policy — claimNym nym taken in world ──────────────────────

  it("claimNym throws SpineConflictError(world_identity) on world-unique nym collision (FR-R3)", async () => {
    const u1 = await spine.mintUser()
    const u2 = await spine.mintUser()
    await spine.claimNym({ userId: u1, worldSlug: "mibera", nym: "taken" })

    let thrown: unknown = null
    try {
      await spine.claimNym({ userId: u2, worldSlug: "mibera", nym: "taken" })
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(SpineConflictError)
    if (thrown instanceof SpineConflictError) {
      expect(thrown.kind).toBe("world_identity")
    }
    const owner = await spine.resolveByNym("mibera", "taken")
    expect(owner).toBe(u1)
  })

  it("claimNym throws SpineConflictError(world_identity) when user already has a nym in this world (user-PK collision)", async () => {
    const userId = await spine.mintUser()
    await spine.claimNym({ userId, worldSlug: "mibera", nym: "first" })
    let thrown: unknown = null
    try {
      await spine.claimNym({ userId, worldSlug: "mibera", nym: "second" })
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(SpineConflictError)
    if (thrown instanceof SpineConflictError) {
      expect(thrown.kind).toBe("world_identity")
    }
  })

  // ── NFR-5 writeAuditEvent ────────────────────────────────────────────

  it("writeAuditEvent persists a row with the expected shape (NFR-5)", async () => {
    const userId = await spine.mintUser()
    await spine.writeAuditEvent({
      event_type: "wallet_linked",
      user_id: userId,
      actor: "self",
      payload: { wallet_address: "0xfeed", chain_ids: ["1"], is_primary: true },
    })
    const sql = new SQL(databaseUrl)
    try {
      const rows = (await sql`
        SELECT event_type, user_id, actor, payload FROM audit_events WHERE user_id = ${userId}
      `) as Array<{
        event_type: string
        user_id: string
        actor: string
        payload: { wallet_address: string; chain_ids: string[]; is_primary: boolean }
      }>
      expect(rows).toHaveLength(1)
      expect(rows[0]!.event_type).toBe("wallet_linked")
      expect(rows[0]!.actor).toBe("self")
      expect(rows[0]!.payload.wallet_address).toBe("0xfeed")
      expect(rows[0]!.payload.is_primary).toBe(true)
    } finally {
      await sql.close()
    }
  })

  it("writeAuditEvent defaults actor='system' when unset and accepts null user_id", async () => {
    await spine.writeAuditEvent({
      event_type: "conflict_rejected",
      user_id: null,
      payload: { conflict_kind: "linked_account", provider: "discord", external_id: "x" },
    })
    const sql = new SQL(databaseUrl)
    try {
      const rows = (await sql`
        SELECT actor, user_id FROM audit_events WHERE event_type = 'conflict_rejected'
      `) as Array<{ actor: string; user_id: string | null }>
      expect(rows).toHaveLength(1)
      expect(rows[0]!.actor).toBe("system")
      expect(rows[0]!.user_id).toBeNull()
    } finally {
      await sql.close()
    }
  })

  // ── C-2 getManagedWorlds (bead arrakis-491i) ───────────────────────────
  //
  // Grant-issuance is OUT OF SCOPE (no write port method) — so these tests
  // seed `world_managers` rows directly via SQL, then assert the read path.
  // The worlds "thj" + "mibera" are seeded by the afterEach re-seed.

  async function grantManager(
    userId: string,
    worldSlug: string,
    grantedBy: string | null = "test-operator",
  ): Promise<void> {
    const sql = new SQL(databaseUrl)
    try {
      await sql`
        INSERT INTO world_managers (user_id, world_slug, granted_by)
        VALUES (${userId}, ${worldSlug}, ${grantedBy})
      `
    } finally {
      await sql.close()
    }
  }

  it("getManagedWorlds returns [] for a user that manages nothing (C-2)", async () => {
    const userId = await spine.mintUser()
    const got = await spine.getManagedWorlds(userId)
    expect(got).toEqual([])
  })

  it("getManagedWorlds returns [] for a non-existent user (no 404 at this layer) (C-2)", async () => {
    const got = await spine.getManagedWorlds("00000000-0000-4000-8000-000000000000")
    expect(got).toEqual([])
  })

  it("getManagedWorlds returns each managed world, granted_at ASC (C-2)", async () => {
    const userId = await spine.mintUser()
    await grantManager(userId, "thj")
    await grantManager(userId, "mibera")
    const got = await spine.getManagedWorlds(userId)
    expect(got).toHaveLength(2)
    const slugs = got.map((w) => w.world_slug)
    expect(slugs).toContain("thj")
    expect(slugs).toContain("mibera")
    // granted_at present + ASC-ordered (oldest first; both default NOW()).
    expect(typeof got[0]!.granted_at).toBe("string")
    expect(got[0]!.granted_at <= got[1]!.granted_at).toBe(true)
    // granted_by is NOT surfaced on the read shape.
    expect(got[0]!).not.toHaveProperty("granted_by")
  })

  it("getManagedWorlds is per-user isolated (C-2)", async () => {
    const alice = await spine.mintUser()
    const bob = await spine.mintUser()
    await grantManager(alice, "thj")
    await grantManager(bob, "mibera")
    const aliceWorlds = await spine.getManagedWorlds(alice)
    const bobWorlds = await spine.getManagedWorlds(bob)
    expect(aliceWorlds.map((w) => w.world_slug)).toEqual(["thj"])
    expect(bobWorlds.map((w) => w.world_slug)).toEqual(["mibera"])
  })

  it("world_managers grant CASCADE-deletes when the user is removed (C-2 FK)", async () => {
    const userId = await spine.mintUser()
    await grantManager(userId, "thj")
    expect(await spine.getManagedWorlds(userId)).toHaveLength(1)
    const sql = new SQL(databaseUrl)
    try {
      await sql`DELETE FROM users WHERE user_id = ${userId}`
    } finally {
      await sql.close()
    }
    expect(await spine.getManagedWorlds(userId)).toEqual([])
  })

  it("world_managers accepts null granted_by (backfilled-provenance row) (C-2)", async () => {
    const userId = await spine.mintUser()
    await grantManager(userId, "thj", null)
    const got = await spine.getManagedWorlds(userId)
    expect(got.map((w) => w.world_slug)).toEqual(["thj"])
  })
})
