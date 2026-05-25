/**
 * routes.test.ts — integration tests for the wired T1.5 spine routes.
 *
 * Strategy:
 *   - Boot the Hyper app on an ephemeral port (port: 0).
 *   - Install a mock SpinePort via __setSpineForTest() BEFORE first call.
 *   - Hit each endpoint with `fetch` against the bound URL.
 *   - Assert status + JSON body.
 *
 * No real DB needed — the mock spine drives every code path.
 *
 * For /v1/me we mint a hand-crafted HS256 JWT against the dev secret the
 * src/auth.ts loader uses (`loadSecret("JWT_SECRET")`). Tests set
 * JWT_SECRET to a stable value before the auth module is imported so the
 * JWT we sign here verifies against the same secret the plugin verifies
 * with — JWT_SECRET is read ONCE at module load.
 *
 * Coverage:
 *   GET /v1/resolve/wallet/:address     → 200, 404, 400 (malformed)
 *   GET /v1/resolve/account/:p/:eid     → 200, 404
 *   GET /v1/resolve/nym/:slug/:nym      → 200, 404
 *   GET /v1/identity/:userId            → 200, 404, 400 (non-UUID)
 *   GET /v1/me                          → 200 (with JWT), 401 (no JWT)
 */

// Import order matters: ESM hoists all imports above any top-level code.
// That means we CAN'T set `process.env.JWT_SECRET` here and expect it to
// flow into src/auth.ts at import time (auth.ts reads it during its own
// module eval). Instead we import JWT_SECRET out of the auth module and
// mint test JWTs against whatever secret auth.ts is actually using — the
// ephemeral dev fallback is fine because we sign with the same byte string
// the verifier uses.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import type {
  SpinePort,
  SpineAuditEvent,
  SpineIdentityShape,
} from "@freeside-auth/ports"
import app from "../index"
import { JWT_SECRET } from "../../auth"
import { __setSpineForTest, __resetSpineForTest } from "../spine"

// ─── mock SpinePort (mirrors the engine test mock) ───────────────────────

interface MockSpine extends SpinePort {
  readonly trace: Array<{ method: string; args: unknown }>
  readonly audits: SpineAuditEvent[]
  resolveByWalletReturns?: string | null
  resolveByAccountReturns?: string | null
  resolveByNymReturns?: string | null
  getIdentityReturns?: SpineIdentityShape | null
}

function buildMockSpine(): MockSpine {
  const trace: Array<{ method: string; args: unknown }> = []
  const audits: SpineAuditEvent[] = []
  const m: MockSpine = {
    trace,
    audits,
    async resolveByWallet(address) {
      trace.push({ method: "resolveByWallet", args: { address } })
      return m.resolveByWalletReturns ?? null
    },
    async resolveByAccount(provider, externalId) {
      trace.push({ method: "resolveByAccount", args: { provider, externalId } })
      return m.resolveByAccountReturns ?? null
    },
    async resolveByNym(worldSlug, nym) {
      trace.push({ method: "resolveByNym", args: { worldSlug, nym } })
      return m.resolveByNymReturns ?? null
    },
    async getIdentity(userId) {
      trace.push({ method: "getIdentity", args: { userId } })
      return m.getIdentityReturns ?? null
    },
    async mintUser() {
      return "00000000-0000-0000-0000-000000000001"
    },
    async linkWallet() {},
    async linkAccount() {},
    async claimNym() {},
    async setPrimary() {
      return true
    },
    async writeAuditEvent(event) {
      audits.push(event)
    },
    async mintNonce() {
      // T1.4 — route tests don't exercise nonce path yet (T1.6's job).
      return {
        nonce: "test-mock-nonce",
        expires_at: "2026-05-24T00:05:00.000Z",
        message: "test-mock-message",
      }
    },
    async consumeNonce() {
      return {
        ok: true as const,
        message: "test-mock-message",
        wallet_address: null,
      }
    },
    // T1.6 LBR-1: pass-through transactional stub.
    async withTransaction<T>(fn: (spine: SpinePort) => Promise<T>): Promise<T> {
      return fn(m)
    },
  }
  return m
}

// ─── HS256 JWT minter (for /v1/me test) ──────────────────────────────────

async function mintHs256Jwt(payload: Record<string, unknown>, secret: string): Promise<string> {
  const enc = new TextEncoder()
  const header = { alg: "HS256", typ: "JWT" }
  const b64url = (s: string) =>
    btoa(s).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_")
  const headerEnc = b64url(JSON.stringify(header))
  const payloadEnc = b64url(JSON.stringify(payload))
  const data = `${headerEnc}.${payloadEnc}`

  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )
  const sigBuf = await crypto.subtle.sign("HMAC", key, enc.encode(data))
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sigBuf)))
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
  return `${data}.${sigB64}`
}

// ─── fixtures ───────────────────────────────────────────────────────────

// Valid UUID v4 format (per Zod's uuid() regex: version digit '4' at
// position 14, variant digit '8|9|a|b' at position 19).
const FIXTURE_USER_ID = "11111111-2222-4333-8444-555555555555"
const FIXTURE_IDENTITY: SpineIdentityShape = {
  user_id: FIXTURE_USER_ID,
  primary_wallet: "0xabc0000000000000000000000000000000000001",
  created_at: "2026-05-24T00:00:00.000Z",
  updated_at: "2026-05-24T00:00:00.000Z",
  wallets: [
    {
      wallet_address: "0xabc0000000000000000000000000000000000001",
      chain_ids: ["1"],
      is_primary: true,
      verified_at: "2026-05-24T00:00:00.000Z",
      unlinked_at: null,
    },
  ],
  linked_accounts: [
    {
      provider: "discord",
      external_id: "disc-7777",
      verified_at: "2026-05-24T00:00:00.000Z",
      unlinked_at: null,
    },
  ],
  world_identities: [
    {
      world_slug: "mibera",
      nym: "fullshape",
      joined_at: "2026-05-24T00:00:00.000Z",
    },
  ],
}

// ─── boot/teardown ──────────────────────────────────────────────────────

let baseUrl: string
let mockSpine: MockSpine

beforeAll(async () => {
  mockSpine = buildMockSpine()
  __setSpineForTest(mockSpine)
  app.listen({ port: 0, hostname: "127.0.0.1", banner: false })
  const port = app.server?.port
  if (!port) throw new Error("test boot: app.server.port unavailable after listen({port: 0})")
  baseUrl = `http://127.0.0.1:${port}`
})

afterAll(async () => {
  await app.stop()
  __resetSpineForTest()
})

// ─── tests ──────────────────────────────────────────────────────────────

describe("GET /v1/resolve/wallet/:address (FR-R1)", () => {
  it("200 + {user_id} on hit", async () => {
    mockSpine.resolveByWalletReturns = FIXTURE_USER_ID
    const res = await fetch(`${baseUrl}/v1/resolve/wallet/0xabc0000000000000000000000000000000000001`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { user_id: string }
    expect(body.user_id).toBe(FIXTURE_USER_ID)
  })

  it("404 not_found on miss", async () => {
    mockSpine.resolveByWalletReturns = null
    const res = await fetch(`${baseUrl}/v1/resolve/wallet/0xdeadbeef00000000000000000000000000000000`)
    expect(res.status).toBe(404)
    const body = (await res.json()) as { code: string }
    expect(body.code).toBe("not_found")
  })

  it("400 invalid_param on malformed address", async () => {
    const res = await fetch(`${baseUrl}/v1/resolve/wallet/not-an-address`)
    expect(res.status).toBe(400)
    const body = (await res.json()) as { code: string; param: string }
    expect(body.code).toBe("invalid_param")
    expect(body.param).toBe("address")
  })
})

describe("GET /v1/resolve/account/:provider/:externalId (FR-R2)", () => {
  it("200 + {user_id} on hit", async () => {
    mockSpine.resolveByAccountReturns = FIXTURE_USER_ID
    const res = await fetch(`${baseUrl}/v1/resolve/account/discord/disc-7777`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { user_id: string }
    expect(body.user_id).toBe(FIXTURE_USER_ID)
  })

  it("404 not_found on miss", async () => {
    mockSpine.resolveByAccountReturns = null
    const res = await fetch(`${baseUrl}/v1/resolve/account/discord/nope`)
    expect(res.status).toBe(404)
  })

  it("400 invalid_param on unknown provider", async () => {
    const res = await fetch(`${baseUrl}/v1/resolve/account/twitter/abc`)
    expect(res.status).toBe(400)
    const body = (await res.json()) as { code: string; param: string }
    expect(body.code).toBe("invalid_param")
    expect(body.param).toBe("provider")
  })
})

describe("GET /v1/resolve/nym/:worldSlug/:nym (FR-R3)", () => {
  it("200 + {user_id} on hit", async () => {
    mockSpine.resolveByNymReturns = FIXTURE_USER_ID
    const res = await fetch(`${baseUrl}/v1/resolve/nym/mibera/fullshape`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { user_id: string }
    expect(body.user_id).toBe(FIXTURE_USER_ID)
  })

  it("404 not_found on miss", async () => {
    mockSpine.resolveByNymReturns = null
    const res = await fetch(`${baseUrl}/v1/resolve/nym/mibera/nope`)
    expect(res.status).toBe(404)
  })
})

describe("GET /v1/identity/:userId (FR-R4)", () => {
  it("200 + full Identity on hit", async () => {
    mockSpine.getIdentityReturns = FIXTURE_IDENTITY
    const res = await fetch(`${baseUrl}/v1/identity/${FIXTURE_USER_ID}`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as SpineIdentityShape
    expect(body.user_id).toBe(FIXTURE_USER_ID)
    expect(body.wallets).toHaveLength(1)
    expect(body.linked_accounts).toHaveLength(1)
    expect(body.world_identities).toHaveLength(1)
  })

  it("404 not_found when user is absent", async () => {
    mockSpine.getIdentityReturns = null
    const res = await fetch(`${baseUrl}/v1/identity/${FIXTURE_USER_ID}`)
    expect(res.status).toBe(404)
  })

  it("400 invalid_param on non-UUID userId", async () => {
    const res = await fetch(`${baseUrl}/v1/identity/not-a-uuid`)
    expect(res.status).toBe(400)
    const body = (await res.json()) as { code: string; param: string }
    expect(body.code).toBe("invalid_param")
    expect(body.param).toBe("userId")
  })
})

describe("GET /v1/me (FR-A3)", () => {
  it("401 missing_token without a JWT", async () => {
    const res = await fetch(`${baseUrl}/v1/me`)
    expect(res.status).toBe(401)
  })

  it("200 + full Identity with a valid bearer JWT", async () => {
    mockSpine.getIdentityReturns = FIXTURE_IDENTITY
    const jwt = await mintHs256Jwt(
      { sub: FIXTURE_USER_ID, iat: Math.floor(Date.now() / 1000) },
      JWT_SECRET,
    )
    const res = await fetch(`${baseUrl}/v1/me`, {
      headers: { authorization: `Bearer ${jwt}` },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as SpineIdentityShape
    expect(body.user_id).toBe(FIXTURE_USER_ID)
  })

  it("401 with a JWT whose sub is not a UUID", async () => {
    const jwt = await mintHs256Jwt(
      { sub: "not-a-uuid", iat: Math.floor(Date.now() / 1000) },
      JWT_SECRET,
    )
    const res = await fetch(`${baseUrl}/v1/me`, {
      headers: { authorization: `Bearer ${jwt}` },
    })
    expect(res.status).toBe(401)
    const body = (await res.json()) as { code: string }
    expect(body.code).toBe("invalid_sub")
  })

  it("404 when JWT sub resolves to a missing user", async () => {
    mockSpine.getIdentityReturns = null
    const jwt = await mintHs256Jwt(
      { sub: "99999999-9999-4999-8999-999999999999", iat: Math.floor(Date.now() / 1000) },
      JWT_SECRET,
    )
    const res = await fetch(`${baseUrl}/v1/me`, {
      headers: { authorization: `Bearer ${jwt}` },
    })
    expect(res.status).toBe(404)
  })

  // T1.6 LBR-3 — L7 regression. Verdict reproduction: a malformed bearer
  // token with 3 segments but garbage payloads used to 500 because
  // SyntaxError from JSON.parse leaked past the vendored auth-jwt middleware's
  // narrow `catch (e) { if (e instanceof JwtError) }`. The src/auth.ts wrap
  // converts SyntaxError/TypeError to 401 (without touching vendored Hyper).
  it("401 on single-string bearer token (NOT 500) — hits the 3-segment guard, JwtError-class", async () => {
    // A single-string token (no dots) hits verifyJwt's first guard
    // `if (parts.length !== 3) throw new JwtError("invalid_token", ...)`,
    // which the inner middleware classifies as 401 'invalid_token'. This
    // exercises the inner JwtError path; the SyntaxError-leak path is the
    // 3-segment-with-garbage test below.
    const res = await fetch(`${baseUrl}/v1/me`, {
      headers: { authorization: "Bearer total-garbage-not-a-jwt" },
    })
    expect(res.status).toBe(401)
    const body = (await res.json()) as { error: string; code: string }
    expect(body.error).toBe("unauthorized")
    expect(body.code).toBe("invalid_token")
  })

  it("401 (NOT 500) on 3-segment bearer with garbage payloads (L7 / LBR-3 — the actual SyntaxError leak)", async () => {
    // `aaa.bbb.ccc` has 3 segments → passes verifyJwt's parts-count guard
    // → b64urlToUtf8(a) is decodable but yields non-JSON text → JSON.parse
    // throws SyntaxError → leaks past `catch (e) { if (e instanceof JwtError) }`
    // → 500 BASELINE. The src/auth.ts hardenAuthMiddleware wrap catches the
    // SyntaxError and returns 401 'malformed_token' INSTEAD.
    const res = await fetch(`${baseUrl}/v1/me`, {
      headers: { authorization: "Bearer aaa.bbb.ccc" },
    })
    expect(res.status).toBe(401) // ← THE LOAD-BEARING ASSERTION
    const body = (await res.json()) as { error: string; code: string }
    expect(body.error).toBe("unauthorized")
    expect(body.code).toBe("malformed_token")
  })

  it("401 (NOT 500) on 3-segment bearer that base64-decodes to non-JSON (L7 sibling)", async () => {
    // Three base64-decodable segments → JSON.parse throws SyntaxError on
    // "hello" / "world" as non-JSON text. Same leak class as the previous test.
    const res = await fetch(`${baseUrl}/v1/me`, {
      headers: { authorization: "Bearer aGVsbG8.d29ybGQ.YWFh" },
    })
    expect(res.status).toBe(401)
    const body = (await res.json()) as { error: string; code: string }
    expect(body.error).toBe("unauthorized")
    expect(body.code).toBe("malformed_token")
  })
})
