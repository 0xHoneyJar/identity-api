/**
 * postgres-spine-adapter-nonces.test.ts — auth_nonces lifecycle tests
 * against a real PG scratch DB (T1.4, bead arrakis-91aj).
 *
 * Gating + safety mirror postgres-spine-adapter.test.ts + migrate.test.ts:
 *   - Suite SKIPs unless TEST_DATABASE_URL is set.
 *   - Refuses non-scratch-shaped DB names (paranoia: never drop on prod).
 *   - Drops + re-applies all migrations in beforeAll so each suite run
 *     starts from a known state.
 *
 * Coverage by FR (the contract this adapter delivers for T1.6's verify):
 *   - mintNonce happy path: returns nonce + expires_at; row persisted with
 *     scheme + message + wallet_address; nonce is base64url-shaped 32-byte.
 *   - mintNonce with default + custom TTL
 *   - mintNonce with NULL wallet_address (SIWE pre-bind path)
 *   - consumeNonce happy: returns ok:true + verbatim message + wallet hint;
 *     row marked used_at IS NOT NULL after; second consume returns 'used'.
 *   - consumeNonce reject classes: unknown, used, expired, scheme_mismatch.
 *   - consumeNonce ATOMIC RACE: two concurrent consume calls of the same
 *     nonce yield EXACTLY ONE ok:true (FR-A1 single-use invariant — the
 *     UPDATE-RETURNING is what makes this race-safe; this test is the proof).
 *   - Crypto discipline: 8 mints yield 8 distinct nonces with the expected
 *     base64url shape (regression-ish proof the CSPRNG is wired right).
 *
 * What this file does NOT test:
 *   - The audit emit pairing (covered by auth-nonces.test.ts at the engine
 *     layer — adapter is pure DB I/O, engine owns the audit policy).
 *   - The 401 envelope mapping (T1.6's job · route layer).
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import { SQL } from "bun"
import { resolve } from "node:path"

import { migrate } from "../migrate"
import { PostgresSpineAdapter } from "../postgres-spine-adapter"

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

describe.skipIf(!TEST_DATABASE_URL)("PostgresSpineAdapter auth_nonces (T1.4)", () => {
  const databaseUrl = TEST_DATABASE_URL as string
  let spine: PostgresSpineAdapter

  beforeAll(async () => {
    if (!looksLikeScratchUrl(databaseUrl)) {
      throw new Error(
        `postgres-spine-adapter-nonces.test: TEST_DATABASE_URL DB name does not look scratch-shaped (expected: ${SCRATCH_DB_HINTS.join(", ")}). Refusing to drop on a non-scratch DB.`,
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
      await sql.unsafe(`TRUNCATE auth_nonces RESTART IDENTITY CASCADE;`)
    } finally {
      await sql.close()
    }
  })

  // ── mintNonce ────────────────────────────────────────────────────────

  it("mintNonce returns a base64url-encoded 32-byte nonce + ISO expiry (FR-A1)", async () => {
    const result = await spine.mintNonce({
      scheme: "siwe",
      message: "honey-road wants you to sign in.\nNonce: …",
      walletAddress: "0xabc0000000000000000000000000000000000001",
    })
    // base64url for 32 bytes is 43 chars, no padding. Charset is A-Z a-z 0-9 - _.
    expect(result.nonce).toMatch(/^[A-Za-z0-9_-]{43}$/)
    // ISO 8601 with Z suffix (UTC).
    expect(result.expires_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
    expect(new Date(result.expires_at).getTime()).toBeGreaterThan(Date.now())
  })

  it("mintNonce persists scheme + message + wallet_address verbatim", async () => {
    const message = "the\nentire\nmessage\nverbatim"
    const wallet = "0xabc0000000000000000000000000000000000002"
    const result = await spine.mintNonce({
      scheme: "eip191",
      message,
      walletAddress: wallet,
    })
    const sql = new SQL(databaseUrl)
    try {
      const rows = (await sql`
        SELECT scheme, message, wallet_address, used_at, expires_at
          FROM auth_nonces WHERE nonce = ${result.nonce}
      `) as Array<{
        scheme: string
        message: string
        wallet_address: string | null
        used_at: string | null
        expires_at: string | Date
      }>
      expect(rows).toHaveLength(1)
      expect(rows[0]!.scheme).toBe("eip191")
      expect(rows[0]!.message).toBe(message)
      expect(rows[0]!.wallet_address).toBe(wallet)
      expect(rows[0]!.used_at).toBeNull()
    } finally {
      await sql.close()
    }
  })

  it("mintNonce accepts NULL walletAddress (SIWE pre-bind path)", async () => {
    const result = await spine.mintNonce({
      scheme: "siwe",
      message: "pre-bind challenge",
      walletAddress: null,
    })
    const sql = new SQL(databaseUrl)
    try {
      const rows = (await sql`
        SELECT wallet_address FROM auth_nonces WHERE nonce = ${result.nonce}
      `) as Array<{ wallet_address: string | null }>
      expect(rows[0]!.wallet_address).toBeNull()
    } finally {
      await sql.close()
    }
  })

  it("mintNonce default TTL = ~300s (SDD §2.2)", async () => {
    const before = Date.now()
    const result = await spine.mintNonce({
      scheme: "siwe",
      message: "default-ttl",
    })
    const expiresMs = new Date(result.expires_at).getTime()
    // Allow some slop for clock skew + insert latency; default is 300s.
    expect(expiresMs - before).toBeGreaterThanOrEqual(295_000)
    expect(expiresMs - before).toBeLessThanOrEqual(310_000)
  })

  it("mintNonce honors ttlSec override", async () => {
    const before = Date.now()
    const result = await spine.mintNonce({
      scheme: "siwe",
      message: "custom-ttl-60",
      ttlSec: 60,
    })
    const expiresMs = new Date(result.expires_at).getTime()
    expect(expiresMs - before).toBeGreaterThanOrEqual(55_000)
    expect(expiresMs - before).toBeLessThanOrEqual(70_000)
  })

  it("mintNonce yields cryptographically-distinct nonces (CSPRNG check)", async () => {
    const seen = new Set<string>()
    for (let i = 0; i < 8; i++) {
      const r = await spine.mintNonce({
        scheme: "siwe",
        message: `msg-${i}`,
      })
      expect(r.nonce).toMatch(/^[A-Za-z0-9_-]{43}$/)
      seen.add(r.nonce)
    }
    expect(seen.size).toBe(8)
  })

  // ── consumeNonce happy path ──────────────────────────────────────────

  it("consumeNonce returns ok=true + verbatim message + wallet_address; marks used_at (FR-A1 single-use)", async () => {
    const wallet = "0xabc0000000000000000000000000000000000003"
    const message = "happy-path challenge text"
    const minted = await spine.mintNonce({
      scheme: "siwe",
      message,
      walletAddress: wallet,
    })
    const result = await spine.consumeNonce({
      nonce: minted.nonce,
      expectedScheme: "siwe",
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.message).toBe(message)
      expect(result.wallet_address).toBe(wallet)
    }

    // Verify used_at is set.
    const sql = new SQL(databaseUrl)
    try {
      const rows = (await sql`
        SELECT used_at FROM auth_nonces WHERE nonce = ${minted.nonce}
      `) as Array<{ used_at: string | Date | null }>
      expect(rows[0]!.used_at).not.toBeNull()
    } finally {
      await sql.close()
    }
  })

  it("consumeNonce on the same nonce twice: second returns ok=false reason='used' (single-use enforcement)", async () => {
    const minted = await spine.mintNonce({
      scheme: "siwe",
      message: "double-consume test",
    })
    const first = await spine.consumeNonce({
      nonce: minted.nonce,
      expectedScheme: "siwe",
    })
    expect(first.ok).toBe(true)
    const second = await spine.consumeNonce({
      nonce: minted.nonce,
      expectedScheme: "siwe",
    })
    expect(second.ok).toBe(false)
    if (!second.ok) expect(second.reason).toBe("used")
  })

  // ── consumeNonce reject classes ──────────────────────────────────────

  it("consumeNonce on an unknown nonce returns reason='unknown'", async () => {
    const result = await spine.consumeNonce({
      nonce: "this-nonce-was-never-minted-1234567890abcdef",
      expectedScheme: "siwe",
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe("unknown")
  })

  it("consumeNonce on an expired row returns reason='expired'", async () => {
    // Mint with ttlSec=0 → row inserted with expires_at=NOW(); UPDATE WHERE
    // expires_at > NOW() fails. A tiny sleep guards against clock granularity.
    const minted = await spine.mintNonce({
      scheme: "siwe",
      message: "expired test",
      ttlSec: 0,
    })
    await new Promise((r) => setTimeout(r, 5))
    const result = await spine.consumeNonce({
      nonce: minted.nonce,
      expectedScheme: "siwe",
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe("expired")
  })

  it("consumeNonce with wrong scheme returns reason='scheme_mismatch'", async () => {
    const minted = await spine.mintNonce({
      scheme: "siwe",
      message: "scheme mismatch test",
    })
    const result = await spine.consumeNonce({
      nonce: minted.nonce,
      expectedScheme: "eip191",
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe("scheme_mismatch")
  })

  // ── ATOMIC RACE: the load-bearing single-use proof ────────────────────

  it("consumeNonce concurrent race: 2 simultaneous calls → exactly ONE ok=true, the other 'used' (FR-A1 atomic single-use)", async () => {
    const minted = await spine.mintNonce({
      scheme: "siwe",
      message: "race-test challenge",
      walletAddress: "0xabc0000000000000000000000000000000000004",
    })
    // Fire both consume calls in parallel. Bun.SQL pools connections, so
    // these dispatch on two distinct PG connections — the only way to
    // actually exercise the row-lock race the UPDATE-RETURNING must win.
    const [a, b] = await Promise.all([
      spine.consumeNonce({ nonce: minted.nonce, expectedScheme: "siwe" }),
      spine.consumeNonce({ nonce: minted.nonce, expectedScheme: "siwe" }),
    ])
    const successes = [a, b].filter((r) => r.ok)
    const failures = [a, b].filter((r) => !r.ok)
    expect(successes).toHaveLength(1)
    expect(failures).toHaveLength(1)
    // The losing call must classify as 'used' (the winner's UPDATE flipped
    // used_at; the loser's UPDATE sees 0 rows; the SELECT finds used_at
    // IS NOT NULL → reason='used').
    const loser = failures[0]!
    if (!loser.ok) expect(loser.reason).toBe("used")
  })

  it("consumeNonce concurrent race at scale: 10 simultaneous calls → exactly 1 ok=true (regression-grade)", async () => {
    const minted = await spine.mintNonce({
      scheme: "siwe",
      message: "scale-race challenge",
    })
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        spine.consumeNonce({ nonce: minted.nonce, expectedScheme: "siwe" }),
      ),
    )
    const successes = results.filter((r) => r.ok)
    expect(successes).toHaveLength(1)
    const losers = results.filter((r) => !r.ok)
    expect(losers).toHaveLength(9)
    for (const l of losers) {
      if (!l.ok) expect(l.reason).toBe("used")
    }
  })
})
