/**
 * auth-flow.test.ts — end-to-end /v1/auth/challenge + /v1/auth/verify tests
 * against a real PG scratch DB (T1.6, bead arrakis-tptr).
 *
 * Strategy:
 *   - Skip when TEST_DATABASE_URL is unset (CI sets it; local dev opts in).
 *   - Run migrations against a scratch DB shape, install a real
 *     PostgresSpineAdapter via __setSpineForTest, boot the Hyper app on an
 *     ephemeral port.
 *   - Drive the full flow with `fetch` — caller side mints private keys via
 *     viem and signs the canonical messages /challenge returns.
 *   - Assert wire-shape + DB state (audit rows, user count, wallet_link count).
 *
 * Coverage:
 *   - happy SIWE: challenge → sign → verify → 200 + JWT + cookies + correct user
 *   - happy EIP-191: same with personal_sign envelope
 *   - replay defense: same nonce twice → 401 nonce_replayed
 *   - expiry: mint with ttl=0 (manual DB poke) → 401 nonce_expired
 *   - scheme mismatch: challenge siwe / verify eip191 → 401 scheme_mismatch
 *   - wrong signer: sign with private key A but submit address B → 401 signature_invalid + audit
 *   - wallet mismatch: challenge wallet A / verify wallet B → 401 wallet_mismatch + audit
 *   - LBR-1 CONCURRENT RACE: two simultaneous /verify calls for SAME wallet
 *     after both pass /challenge + sign — both succeed, same user_id, ONE user
 *     row + ONE wallet_link
 *   - integration: returned JWT verifies on GET /v1/me → 200
 *
 * Mirrors the pattern from src/api/__tests__/routes.test.ts (mock spine)
 * but uses a REAL spine because the auth flow is end-to-end + the
 * transactional concurrency proof needs real PG row locking.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import { SQL } from "bun"
import { resolve } from "node:path"
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"
import app from "../index"
import { migrate } from "../../../packages/adapters/src/migrate"
import { PostgresSpineAdapter } from "../../../packages/adapters/src/postgres-spine-adapter"
import { __resetSpineForTest, __setSpineForTest } from "../spine"

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL
const MIGRATIONS_DIR = resolve(
  __dirname,
  "..",
  "..",
  "..",
  "packages",
  "adapters",
  "src",
  "migrations",
)

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

async function clearSpineRows(sql: SQL): Promise<void> {
  await sql.unsafe(`
    TRUNCATE TABLE
      auth_nonces,
      audit_events,
      world_identity,
      linked_accounts,
      wallet_links,
      users
    RESTART IDENTITY CASCADE;
  `)
}

interface ChallengeResp {
  nonce: string
  message: string
  expires_at: string
}

interface VerifyResp {
  user_id: string
  primary_wallet: string
  session: { token: string; expires_at: number }
}

interface UnauthorizedResp {
  error: "unauthorized"
  code: string
  message?: string
}

describe.skipIf(!TEST_DATABASE_URL)("/v1/auth/* end-to-end (T1.6)", () => {
  const databaseUrl = TEST_DATABASE_URL as string
  let baseUrl: string
  let realSpine: PostgresSpineAdapter
  let bookkeepingSql: SQL

  beforeAll(async () => {
    if (!looksLikeScratchUrl(databaseUrl)) {
      throw new Error(
        `auth-flow.test: TEST_DATABASE_URL DB name does not look scratch-shaped (expected substring: ${SCRATCH_DB_HINTS.join(", ")}). Refusing to drop on non-scratch DB.`,
      )
    }
    const sql = new SQL(databaseUrl)
    try {
      await dropAllSpineState(sql)
    } finally {
      await sql.close()
    }
    await migrate({ databaseUrl, migrationsDir: MIGRATIONS_DIR, verb: "up" })
    realSpine = new PostgresSpineAdapter(databaseUrl)
    __setSpineForTest(realSpine)
    bookkeepingSql = new SQL(databaseUrl)
    app.listen({ port: 0, hostname: "127.0.0.1", banner: false })
    const port = app.server?.port
    if (!port) throw new Error("auth-flow.test: app.server.port unavailable after listen")
    baseUrl = `http://127.0.0.1:${port}`
  })

  afterAll(async () => {
    await app.stop()
    await realSpine.close()
    await bookkeepingSql.close()
    __resetSpineForTest()
    const sql = new SQL(databaseUrl)
    try {
      await dropAllSpineState(sql)
    } finally {
      await sql.close()
    }
  })

  beforeEach(async () => {
    await clearSpineRows(bookkeepingSql)
  })

  // ─── happy paths ─────────────────────────────────────────────────────

  it("SIWE happy: challenge → sign → verify → 200 with JWT + Set-Cookie + correct user_id", async () => {
    const pk = generatePrivateKey()
    const acct = privateKeyToAccount(pk)
    const wallet = acct.address.toLowerCase()

    // 1. Challenge
    const chRes = await fetch(`${baseUrl}/v1/auth/challenge`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        walletAddress: wallet,
        scheme: "siwe",
        domain: "identity-api.test",
        uri: "https://identity-api.test",
        chainId: 1,
        statement: "Sign in to identity-api test.",
      }),
    })
    expect(chRes.status).toBe(200)
    const challenge = (await chRes.json()) as ChallengeResp
    expect(challenge.nonce).toMatch(/^[A-Za-z0-9_-]{43}$/) // 32-byte base64url
    expect(challenge.message).toContain("identity-api.test wants you to sign in")
    expect(challenge.message).toContain(challenge.nonce) // SIWE message embeds nonce

    // 2. Sign the canonical message off-line
    const signature = await acct.signMessage({ message: challenge.message })

    // 3. Verify
    const vfRes = await fetch(`${baseUrl}/v1/auth/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        nonce: challenge.nonce,
        signature,
        walletAddress: wallet,
        scheme: "siwe",
      }),
    })
    expect(vfRes.status).toBe(200)
    const verified = (await vfRes.json()) as VerifyResp
    expect(verified.user_id).toMatch(/^[0-9a-f-]{36}$/) // UUID
    expect(verified.primary_wallet).toBe(wallet)
    expect(verified.session.token.split(".")).toHaveLength(3) // JWT has 3 segments
    expect(verified.session.expires_at).toBeGreaterThan(Math.floor(Date.now() / 1000))

    // Set-Cookie: encrypted session + CSRF
    const setCookies = vfRes.headers.getSetCookie()
    expect(setCookies.length).toBeGreaterThan(0)
    expect(setCookies.some((c) => c.startsWith("idapi_sess="))).toBe(true)
    // CSRF cookie may or may not appear on the first response depending on
    // session-establishment ordering; soft-assert via length only.

    // DB invariant: exactly one user, one wallet_link
    const users = (await bookkeepingSql`SELECT user_id FROM users`) as Array<{
      user_id: string
    }>
    expect(users).toHaveLength(1)
    expect(users[0]!.user_id).toBe(verified.user_id)
    const links = (await bookkeepingSql`SELECT * FROM wallet_links WHERE user_id = ${verified.user_id}`) as Array<{
      wallet_address: string
      is_primary: boolean
    }>
    expect(links).toHaveLength(1)
    expect(links[0]!.wallet_address).toBe(wallet)
    expect(links[0]!.is_primary).toBe(true)
  })

  it("EIP-191 happy: challenge → sign personal_sign → verify → 200", async () => {
    const pk = generatePrivateKey()
    const acct = privateKeyToAccount(pk)
    const wallet = acct.address.toLowerCase()

    const chRes = await fetch(`${baseUrl}/v1/auth/challenge`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ walletAddress: wallet, scheme: "eip191" }),
    })
    expect(chRes.status).toBe(200)
    const challenge = (await chRes.json()) as ChallengeResp
    // EIP-191 has the short-form message Sietch precedent shape.
    expect(challenge.message).toBe(`identity-api login challenge: ${challenge.nonce}`)

    const signature = await acct.signMessage({ message: challenge.message })
    const vfRes = await fetch(`${baseUrl}/v1/auth/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        nonce: challenge.nonce,
        signature,
        walletAddress: wallet,
        scheme: "eip191",
      }),
    })
    expect(vfRes.status).toBe(200)
    const verified = (await vfRes.json()) as VerifyResp
    expect(verified.primary_wallet).toBe(wallet)
  })

  it("returning user: second auth with the same wallet returns the SAME user_id (no double-mint)", async () => {
    const pk = generatePrivateKey()
    const acct = privateKeyToAccount(pk)
    const wallet = acct.address.toLowerCase()

    const first = await runAuthFlow(baseUrl, acct, wallet, "siwe")
    expect(first.status).toBe(200)
    const firstUserId = first.body.user_id

    const second = await runAuthFlow(baseUrl, acct, wallet, "siwe")
    expect(second.status).toBe(200)
    expect(second.body.user_id).toBe(firstUserId)

    const users = (await bookkeepingSql`SELECT user_id FROM users`) as Array<{ user_id: string }>
    expect(users).toHaveLength(1)
  })

  // ─── rejection paths ─────────────────────────────────────────────────

  it("nonce replay: consume the SAME nonce twice → second is 401 nonce_replayed", async () => {
    const pk = generatePrivateKey()
    const acct = privateKeyToAccount(pk)
    const wallet = acct.address.toLowerCase()

    const chRes = await fetch(`${baseUrl}/v1/auth/challenge`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ walletAddress: wallet, scheme: "eip191" }),
    })
    const challenge = (await chRes.json()) as ChallengeResp
    const signature = await acct.signMessage({ message: challenge.message })

    const vfBody = JSON.stringify({
      nonce: challenge.nonce,
      signature,
      walletAddress: wallet,
      scheme: "eip191",
    })

    const first = await fetch(`${baseUrl}/v1/auth/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: vfBody,
    })
    expect(first.status).toBe(200)

    const second = await fetch(`${baseUrl}/v1/auth/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: vfBody,
    })
    expect(second.status).toBe(401)
    const body = (await second.json()) as UnauthorizedResp
    expect(body.code).toBe("nonce_replayed")

    // Audit invariant: a nonce_rejected{used} event should have landed
    const rejects = (await bookkeepingSql`
      SELECT payload FROM audit_events WHERE event_type = 'nonce_rejected'
    `) as Array<{ payload: { reason: string } }>
    expect(rejects.length).toBeGreaterThanOrEqual(1)
    expect(rejects.some((r) => r.payload.reason === "used")).toBe(true)
  })

  it("nonce expired: manually expire a nonce → 401 nonce_expired", async () => {
    const pk = generatePrivateKey()
    const acct = privateKeyToAccount(pk)
    const wallet = acct.address.toLowerCase()

    const chRes = await fetch(`${baseUrl}/v1/auth/challenge`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ walletAddress: wallet, scheme: "eip191" }),
    })
    const challenge = (await chRes.json()) as ChallengeResp
    // Force the row past expiry without waiting 5 min.
    await bookkeepingSql`
      UPDATE auth_nonces SET expires_at = NOW() - INTERVAL '1 second' WHERE nonce = ${challenge.nonce}
    `
    const signature = await acct.signMessage({ message: challenge.message })

    const vfRes = await fetch(`${baseUrl}/v1/auth/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        nonce: challenge.nonce,
        signature,
        walletAddress: wallet,
        scheme: "eip191",
      }),
    })
    expect(vfRes.status).toBe(401)
    const body = (await vfRes.json()) as UnauthorizedResp
    expect(body.code).toBe("nonce_expired")
  })

  it("scheme mismatch: challenge siwe / verify eip191 → 401 scheme_mismatch", async () => {
    const pk = generatePrivateKey()
    const acct = privateKeyToAccount(pk)
    const wallet = acct.address.toLowerCase()

    const chRes = await fetch(`${baseUrl}/v1/auth/challenge`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ walletAddress: wallet, scheme: "siwe" }),
    })
    const challenge = (await chRes.json()) as ChallengeResp
    const signature = await acct.signMessage({ message: challenge.message })

    const vfRes = await fetch(`${baseUrl}/v1/auth/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        nonce: challenge.nonce,
        signature,
        walletAddress: wallet,
        scheme: "eip191", // mismatch
      }),
    })
    expect(vfRes.status).toBe(401)
    const body = (await vfRes.json()) as UnauthorizedResp
    expect(body.code).toBe("scheme_mismatch")
  })

  it("wrong signer: sign with key A but submit address B → 401 signature_invalid + audit event", async () => {
    const pkSigner = generatePrivateKey()
    const acctSigner = privateKeyToAccount(pkSigner)
    const pkOther = generatePrivateKey()
    const acctOther = privateKeyToAccount(pkOther)
    const walletSigner = acctSigner.address.toLowerCase()
    const walletOther = acctOther.address.toLowerCase()

    // Challenge for walletOther (the address the attacker claims to be)
    const chRes = await fetch(`${baseUrl}/v1/auth/challenge`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ walletAddress: walletOther, scheme: "eip191" }),
    })
    const challenge = (await chRes.json()) as ChallengeResp
    // …but sign with the signer's key
    const signature = await acctSigner.signMessage({ message: challenge.message })

    const vfRes = await fetch(`${baseUrl}/v1/auth/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        nonce: challenge.nonce,
        signature,
        walletAddress: walletOther,
        scheme: "eip191",
      }),
    })
    expect(vfRes.status).toBe(401)
    const body = (await vfRes.json()) as UnauthorizedResp
    expect(body.code).toBe("signature_invalid")
    // (We don't leak WHICH sub-reason to the client; the audit row carries it.)

    const rejects = (await bookkeepingSql`
      SELECT payload FROM audit_events WHERE event_type = 'auth_signature_rejected'
    `) as Array<{ payload: { reason: string; wallet_address?: string } }>
    expect(rejects.length).toBeGreaterThanOrEqual(1)
    expect(rejects[0]!.payload.wallet_address).toBe(walletOther)
    // The reason will be 'signature_mismatch' (recovered ≠ expected).
    void walletSigner
  })

  it("wallet mismatch: challenge wallet A / verify body wallet B → 401 wallet_mismatch + audit", async () => {
    const pkA = generatePrivateKey()
    const acctA = privateKeyToAccount(pkA)
    const walletA = acctA.address.toLowerCase()
    const pkB = generatePrivateKey()
    const acctB = privateKeyToAccount(pkB)
    const walletB = acctB.address.toLowerCase()

    // Challenge for walletA
    const chRes = await fetch(`${baseUrl}/v1/auth/challenge`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ walletAddress: walletA, scheme: "eip191" }),
    })
    const challenge = (await chRes.json()) as ChallengeResp
    const signature = await acctB.signMessage({ message: challenge.message })

    // Verify with walletB — wallet-mismatch check fires BEFORE signature verify
    const vfRes = await fetch(`${baseUrl}/v1/auth/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        nonce: challenge.nonce,
        signature,
        walletAddress: walletB,
        scheme: "eip191",
      }),
    })
    expect(vfRes.status).toBe(401)
    const body = (await vfRes.json()) as UnauthorizedResp
    expect(body.code).toBe("wallet_mismatch")

    const rejects = (await bookkeepingSql`
      SELECT payload FROM audit_events WHERE event_type = 'auth_signature_rejected'
    `) as Array<{ payload: { reason: string } }>
    expect(rejects.some((r) => r.payload.reason === "wallet_mismatch")).toBe(true)
  })

  it("bad request: missing nonce → 400 (Zod validation)", async () => {
    const res = await fetch(`${baseUrl}/v1/auth/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        signature: "0x" + "a".repeat(130),
        walletAddress: "0x" + "a".repeat(40),
        scheme: "eip191",
      }),
    })
    expect(res.status).toBe(400)
  })

  // ─── LBR-1 LOAD-BEARING CONCURRENT RACE PROOF ────────────────────────

  it("LBR-1: TWO concurrent /verify calls for SAME wallet → both 200 with SAME user_id, ONE user row, ONE wallet_link", async () => {
    const pk = generatePrivateKey()
    const acct = privateKeyToAccount(pk)
    const wallet = acct.address.toLowerCase()

    // Two parallel challenges (each gets a distinct nonce — challenges are
    // independent; the concurrency hazard is in the verify step where both
    // resolve-or-mint hit the wallet_links uniqueness check)
    const [ch1, ch2] = await Promise.all([
      fetch(`${baseUrl}/v1/auth/challenge`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ walletAddress: wallet, scheme: "eip191" }),
      }),
      fetch(`${baseUrl}/v1/auth/challenge`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ walletAddress: wallet, scheme: "eip191" }),
      }),
    ])
    expect(ch1.status).toBe(200)
    expect(ch2.status).toBe(200)
    const c1 = (await ch1.json()) as ChallengeResp
    const c2 = (await ch2.json()) as ChallengeResp
    expect(c1.nonce).not.toBe(c2.nonce) // distinct nonces

    // Sign both messages (in parallel — synchronous viem operation but still)
    const [s1, s2] = await Promise.all([
      acct.signMessage({ message: c1.message }),
      acct.signMessage({ message: c2.message }),
    ])

    // THE RACE: dispatch both verifies simultaneously. Each one's
    // resolveOrMintByWallet runs in a txn; the wallet isn't bound yet, so
    // both will: (a) resolveByWallet → null, (b) mintUser → fresh id,
    // (c) linkWallet → ONE succeeds, ONE raises WalletLinkRaceError. The
    // loser ROLLBACKs, retries in a new txn, and resolveByWallet now hits
    // the winner's row.
    const [v1, v2] = await Promise.all([
      fetch(`${baseUrl}/v1/auth/verify`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          nonce: c1.nonce,
          signature: s1,
          walletAddress: wallet,
          scheme: "eip191",
        }),
      }),
      fetch(`${baseUrl}/v1/auth/verify`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          nonce: c2.nonce,
          signature: s2,
          walletAddress: wallet,
          scheme: "eip191",
        }),
      }),
    ])

    // LOAD-BEARING ASSERTIONS:
    expect(v1.status).toBe(200)
    expect(v2.status).toBe(200)
    const r1 = (await v1.json()) as VerifyResp
    const r2 = (await v2.json()) as VerifyResp
    // SAME user_id — both verifies converge on one canonical user
    expect(r1.user_id).toBe(r2.user_id)

    // DB invariants: exactly ONE user row + exactly ONE active wallet_link
    const users = (await bookkeepingSql`SELECT user_id FROM users`) as Array<{
      user_id: string
    }>
    expect(users).toHaveLength(1)
    expect(users[0]!.user_id).toBe(r1.user_id)

    const links = (await bookkeepingSql`
      SELECT user_id, wallet_address FROM wallet_links WHERE unlinked_at IS NULL
    `) as Array<{ user_id: string; wallet_address: string }>
    expect(links).toHaveLength(1)
    expect(links[0]!.user_id).toBe(r1.user_id)
    expect(links[0]!.wallet_address).toBe(wallet)
  })

  it("LBR-1 (scale): TEN concurrent /verify calls for SAME wallet → ALL 200 with SAME user_id, ONE user row", async () => {
    const pk = generatePrivateKey()
    const acct = privateKeyToAccount(pk)
    const wallet = acct.address.toLowerCase()

    // 10 challenges + 10 signs
    const challenges = await Promise.all(
      Array.from({ length: 10 }, () =>
        fetch(`${baseUrl}/v1/auth/challenge`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ walletAddress: wallet, scheme: "eip191" }),
        }).then((r) => r.json() as Promise<ChallengeResp>),
      ),
    )
    const signed = await Promise.all(
      challenges.map((c) => acct.signMessage({ message: c.message })),
    )

    const verifies = await Promise.all(
      challenges.map((c, i) =>
        fetch(`${baseUrl}/v1/auth/verify`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            nonce: c.nonce,
            signature: signed[i]!,
            walletAddress: wallet,
            scheme: "eip191",
          }),
        }),
      ),
    )

    for (const v of verifies) {
      expect(v.status).toBe(200)
    }
    const bodies = (await Promise.all(verifies.map((v) => v.json()))) as VerifyResp[]
    const userIds = new Set(bodies.map((b) => b.user_id))
    expect(userIds.size).toBe(1) // all converge on one user_id

    const users = (await bookkeepingSql`SELECT user_id FROM users`) as Array<{
      user_id: string
    }>
    expect(users).toHaveLength(1)
    const links = (await bookkeepingSql`
      SELECT user_id FROM wallet_links WHERE unlinked_at IS NULL
    `) as Array<{ user_id: string }>
    expect(links).toHaveLength(1)
  })

  // ─── integration: the minted JWT verifies on /v1/me ──────────────────

  it("integration: JWT returned by /verify is accepted by /v1/me → 200 with the same user_id", async () => {
    const pk = generatePrivateKey()
    const acct = privateKeyToAccount(pk)
    const wallet = acct.address.toLowerCase()

    const flow = await runAuthFlow(baseUrl, acct, wallet, "siwe")
    expect(flow.status).toBe(200)
    const token = flow.body.session.token

    const meRes = await fetch(`${baseUrl}/v1/me`, {
      headers: { authorization: `Bearer ${token}` },
    })
    expect(meRes.status).toBe(200)
    const identity = (await meRes.json()) as { user_id: string; primary_wallet: string }
    expect(identity.user_id).toBe(flow.body.user_id)
    expect(identity.primary_wallet).toBe(wallet)
  })

  // ─── audit chain coverage ────────────────────────────────────────────

  it("audit chain on a happy verify: nonce_minted → nonce_consumed → user_minted → wallet_linked → auth_verified", async () => {
    const pk = generatePrivateKey()
    const acct = privateKeyToAccount(pk)
    const wallet = acct.address.toLowerCase()
    await runAuthFlow(baseUrl, acct, wallet, "siwe")

    const events = (await bookkeepingSql`
      SELECT event_type, actor, user_id FROM audit_events ORDER BY created_at ASC, event_type ASC
    `) as Array<{ event_type: string; actor: string; user_id: string | null }>
    const types = events.map((e) => e.event_type)
    expect(types).toContain("nonce_minted")
    expect(types).toContain("nonce_consumed")
    expect(types).toContain("user_minted")
    expect(types).toContain("wallet_linked")
    expect(types).toContain("auth_verified")
    // The verified row has user_id populated; pre-resolution rows are null.
    const verified = events.find((e) => e.event_type === "auth_verified")!
    expect(verified.user_id).not.toBeNull()
    expect(verified.actor).toBe("self")
  })
})

// ─── helpers ─────────────────────────────────────────────────────────────

interface SignerAcct {
  signMessage: (opts: { message: string }) => Promise<`0x${string}`>
}

async function runAuthFlow(
  baseUrl: string,
  acct: SignerAcct,
  wallet: string,
  scheme: "siwe" | "eip191",
): Promise<{ status: number; body: VerifyResp }> {
  const chRes = await fetch(`${baseUrl}/v1/auth/challenge`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ walletAddress: wallet, scheme }),
  })
  if (chRes.status !== 200) {
    return { status: chRes.status, body: { user_id: "", primary_wallet: "", session: { token: "", expires_at: 0 } } }
  }
  const challenge = (await chRes.json()) as ChallengeResp
  const signature = await acct.signMessage({ message: challenge.message })
  const vfRes = await fetch(`${baseUrl}/v1/auth/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      nonce: challenge.nonce,
      signature,
      walletAddress: wallet,
      scheme,
    }),
  })
  return { status: vfRes.status, body: (await vfRes.json()) as VerifyResp }
}
