/**
 * identity-resolve-route.test.ts — integration tests for POST /v1/identity/resolve
 * (bd-2wo.38.2 · SDD §7.2 cases 4-6, 11 + happy merge + dedupe).
 *
 * Pattern mirrors profile-route.test.ts: ephemeral port (port: 0), mock spine
 * via __setSpineForTest, mock score via __setScoreForTest + MockScorePort.
 * The pure priority algorithm is unit-tested separately in
 * packages/engine/src/__tests__/merge-identity.test.ts.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import type {
  ConsumeNonceResult,
  SpineAuditEvent,
  SpineIdentityShape,
  SpinePort,
} from "@freeside-auth/ports"
import type { ResolvedIdentity } from "@freeside-auth/protocol/api/federation/score"
import app from "../index"
import { JWT_SECRET } from "../../auth"
import { __resetSpineForTest, __setSpineForTest } from "../spine"
import { __resetScoreForTest, __setScoreForTest } from "../score"
import { MockScorePort } from "../../../packages/adapters/src/__tests__/mock-score"

// ─── HS256 JWT minter — the route is .auth()-gated (OQ-3), so every POST must
// present a valid bearer. Signs against the same JWT_SECRET the plugin verifies
// with (read once at auth module load). Mirrors routes.test.ts:113.
async function mintHs256Jwt(payload: Record<string, unknown>, secret: string): Promise<string> {
  const enc = new TextEncoder()
  const b64url = (s: string) => btoa(s).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_")
  const data = `${b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }))}.${b64url(JSON.stringify(payload))}`
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )
  const sigBuf = await crypto.subtle.sign("HMAC", key, enc.encode(data))
  const sig = btoa(String.fromCharCode(...new Uint8Array(sigBuf)))
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
  return `${data}.${sig}`
}

let authToken = ""
function authHeaders(): Record<string, string> {
  return { "content-type": "application/json", authorization: `Bearer ${authToken}` }
}

// ─── mock spine (per-wallet maps; mirrors profile-route.test stub shape) ─────

interface MockSpine extends SpinePort {
  __link(wallet: string, userId: string, identity: SpineIdentityShape): void
  __throwOnResolve(on: boolean): void
  __reset(): void
}

function buildMockSpine(): MockSpine {
  const walletToUser = new Map<string, string>()
  const userToIdentity = new Map<string, SpineIdentityShape>()
  let throwOnResolve = false
  const m: MockSpine = {
    __link(wallet, userId, identity) {
      walletToUser.set(wallet.toLowerCase(), userId)
      userToIdentity.set(userId, identity)
    },
    __throwOnResolve(on) {
      throwOnResolve = on
    },
    __reset() {
      walletToUser.clear()
      userToIdentity.clear()
      throwOnResolve = false
    },
    async resolveByWallet(address) {
      if (throwOnResolve) throw new Error("pg down: connection refused")
      return walletToUser.get(address.toLowerCase()) ?? null
    },
    async resolveByAccount() {
      return null
    },
    async resolveByNym() {
      return null
    },
    async getIdentity(userId) {
      return userToIdentity.get(userId) ?? null
    },
    // C-2 (bead arrakis-491i): SpinePort gained getManagedWorlds; this mock
    // doesn't exercise it, so a [] stub satisfies the interface.
    async getManagedWorlds() {
      return []
    },
    async mintUser() {
      return "00000000-0000-4000-8000-000000000001"
    },
    async linkWallet() {},
    async linkAccount() {},
    async claimNym() {},
    async setPrimary() {
      return true
    },
    async writeAuditEvent(_event: SpineAuditEvent) {},
    async mintNonce() {
      return { nonce: "n", expires_at: "2026-06-01T00:05:00.000Z", message: "m" }
    },
    async withTransaction<T>(fn: (spine: SpinePort) => Promise<T>): Promise<T> {
      return fn(m)
    },
    async consumeNonce(): Promise<ConsumeNonceResult> {
      return { ok: true, message: "m", wallet_address: null }
    },
  }
  return m
}

// ─── fixtures ──────────────────────────────────────────────────────────────

const WALLET_A = "0xaa00000000000000000000000000000000000001" // nym in mibera
const WALLET_B = "0xbb00000000000000000000000000000000000002" // active discord
const WALLET_C = "0xcc00000000000000000000000000000000000003" // unlinked
const WALLET_D = "0xdd00000000000000000000000000000000000004" // score-name only
const USER_A = "11111111-1111-4111-8111-111111111111"
const USER_B = "22222222-2222-4222-8222-222222222222"
const USER_D = "44444444-4444-4444-8444-444444444444"

function identity(userId: string, wallet: string, over: Partial<SpineIdentityShape> = {}): SpineIdentityShape {
  return {
    user_id: userId,
    primary_wallet: wallet,
    created_at: "2026-06-01T00:00:00.000Z",
    updated_at: "2026-06-01T00:00:00.000Z",
    wallets: [
      { wallet_address: wallet, chain_ids: ["1"], is_primary: true, verified_at: "x", unlinked_at: null },
    ],
    linked_accounts: [],
    world_identities: [],
    ...over,
  }
}

function scored(wallet: string, over: Partial<ResolvedIdentity> = {}): ResolvedIdentity {
  return {
    wallet,
    ens_name: null,
    beraname: null,
    basename: null,
    twitter_handle: null,
    display_name: `${wallet.slice(0, 6)}…${wallet.slice(-4)}`,
    pfp_url: null,
    twitter_source: null,
    ...over,
  }
}

interface Entry {
  wallet: string
  user_id: string | null
  display_name: string
  display_source: string
  discord: { id: string; linked: boolean } | null
  beraname: string | null
  ens_name: string | null
  twitter_handle: string | null
  reachable: string
  is_primary_wallet: boolean
  degraded: boolean
}

// ─── boot/teardown ──────────────────────────────────────────────────────────

let baseUrl: string
let mockSpine: MockSpine
let mockScore: MockScorePort

beforeAll(async () => {
  mockSpine = buildMockSpine()
  mockScore = new MockScorePort()
  __setSpineForTest(mockSpine)
  __setScoreForTest(mockScore)
  authToken = await mintHs256Jwt(
    { sub: "00000000-0000-4000-8000-0000000000aa", exp: 4102444800 },
    JWT_SECRET,
  )
  app.listen({ port: 0, hostname: "127.0.0.1", banner: false })
  const port = app.server?.port
  if (!port) throw new Error("test boot: app.server.port unavailable after listen({port:0})")
  baseUrl = `http://127.0.0.1:${port}`
})

afterAll(async () => {
  await app.stop()
  __resetSpineForTest()
  __resetScoreForTest()
})

beforeEach(() => {
  mockSpine.__reset()
  mockScore.__reset()
})

async function resolve(body: unknown): Promise<{ status: number; results: Entry[] }> {
  const res = await fetch(`${baseUrl}/v1/identity/resolve`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(body),
  })
  const json = (await res.json()) as { results?: Entry[] }
  return { status: res.status, results: json.results ?? [] }
}

// ─── happy merge + priority end-to-end ──────────────────────────────────────

describe("POST /v1/identity/resolve — happy merge", () => {
  it("merges spine + score, applies priority once, one entry per wallet", async () => {
    mockSpine.__link(
      WALLET_A,
      USER_A,
      identity(USER_A, WALLET_A, { world_identities: [{ world_slug: "mibera", nym: "honeybadger", joined_at: "x" }] }),
    )
    mockSpine.__link(
      WALLET_B,
      USER_B,
      identity(USER_B, WALLET_B, {
        linked_accounts: [{ provider: "discord", external_id: "999", verified_at: "x", unlinked_at: null }],
      }),
    )
    // A has an onchain name from score too (nym must still win); C is unlinked.
    mockScore.__setResolvedIdentity(WALLET_A, scored(WALLET_A, { beraname: "hb.bera", display_name: "hb.bera" }))

    const { status, results } = await resolve({ wallets: [WALLET_A, WALLET_B, WALLET_C], world_slug: "mibera" })
    expect(status).toBe(200)
    expect(results).toHaveLength(3)

    const a = results[0]!
    expect(a.user_id).toBe(USER_A)
    expect(a.display_source).toBe("world_nym") // nym wins over score beraname
    expect(a.display_name).toBe("honeybadger")
    expect(a.beraname).toBe("hb.bera") // passthrough, did NOT drive display
    expect(a.is_primary_wallet).toBe(true)
    expect(a.reachable).toBe("unknown")
    expect(a.degraded).toBe(false)

    const b = results[1]!
    expect(b.user_id).toBe(USER_B)
    expect(b.display_source).toBe("discord")
    expect(b.display_name).toBe("999")
    expect(b.discord).toEqual({ id: "999", linked: true })

    const c = results[2]!
    expect(c.user_id).toBeNull()
    expect(c.display_source).toBe("address")
    expect(c.display_name).toBe(WALLET_C)
    expect(c.discord).toBeNull()
  })

  it("dedupes repeated wallets to one entry (first-seen order)", async () => {
    const { status, results } = await resolve({ wallets: [WALLET_C, WALLET_C] })
    expect(status).toBe(200)
    expect(results).toHaveLength(1)
    expect(results[0]!.wallet).toBe(WALLET_C)
  })
})

// ─── §7.2 case 4: per-wallet spine miss ─────────────────────────────────────

describe("POST /v1/identity/resolve — spine miss (case 4)", () => {
  it("an unlinked wallet → user_id null + address tier, batch still 200", async () => {
    mockSpine.__link(WALLET_A, USER_A, identity(USER_A, WALLET_A))
    const { status, results } = await resolve({ wallets: [WALLET_A, WALLET_C] })
    expect(status).toBe(200)
    expect(results[1]!.user_id).toBeNull()
    expect(results[1]!.display_source).toBe("address")
    expect(results[1]!.degraded).toBe(false)
  })
})

// ─── §7.2 case 5: score outage → per-batch degrade, still 200 ────────────────

describe("POST /v1/identity/resolve — score outage (case 5)", () => {
  it("score-api down → ALL entries degraded:true, spine tiers still resolve, 200", async () => {
    mockSpine.__link(
      WALLET_A,
      USER_A,
      identity(USER_A, WALLET_A, { world_identities: [{ world_slug: "mibera", nym: "honeybadger", joined_at: "x" }] }),
    )
    mockScore.__setResolveIdentityFailure({ kind: "upstream_5xx", message: "score 503", statusCode: 503 })

    const { status, results } = await resolve({ wallets: [WALLET_A, WALLET_C], world_slug: "mibera" })
    expect(status).toBe(200)
    expect(results.every((r) => r.degraded)).toBe(true)
    // Spine-derived tier still resolves despite the score outage.
    expect(results[0]!.display_source).toBe("world_nym")
    expect(results[0]!.beraname).toBeNull() // score down → no passthrough
    expect(results[1]!.display_source).toBe("address")
  })
})

// ─── §7.2 case 6: batch bound (Hyper .body validation) ──────────────────────

describe("POST /v1/identity/resolve — batch bound (case 6)", () => {
  const hexWallet = (i: number): string => "0x" + i.toString(16).padStart(40, "0")

  it("101 wallets → 400", async () => {
    const wallets = Array.from({ length: 101 }, (_, i) => hexWallet(i + 1))
    const res = await fetch(`${baseUrl}/v1/identity/resolve`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ wallets }),
    })
    expect(res.status).toBe(400)
  })

  it("0 wallets → 400", async () => {
    const res = await fetch(`${baseUrl}/v1/identity/resolve`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ wallets: [] }),
    })
    expect(res.status).toBe(400)
  })

  it("bad hex → 400", async () => {
    const res = await fetch(`${baseUrl}/v1/identity/resolve`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ wallets: ["not-an-address"] }),
    })
    expect(res.status).toBe(400)
  })

  it("100 wallets → 200 with 100 results", async () => {
    const wallets = Array.from({ length: 100 }, (_, i) => hexWallet(i + 1))
    const { status, results } = await resolve({ wallets })
    expect(status).toBe(200)
    expect(results).toHaveLength(100)
  })
})

// ─── §7.2 case 11: keyed-map lowercased lookup ──────────────────────────────

describe("POST /v1/identity/resolve — keyed-map lowercased lookup (case 11)", () => {
  it("mixed-case input wallet still finds its lowercased score enrichment; echo is normalized", async () => {
    mockSpine.__link(WALLET_D, USER_D, identity(USER_D, WALLET_D))
    mockScore.__setResolvedIdentity(WALLET_D, scored(WALLET_D, { beraname: "dee.bera", display_name: "dee.bera" }))

    const mixed = "0xDD00000000000000000000000000000000000004"
    const { status, results } = await resolve({ wallets: [mixed] })
    expect(status).toBe(200)
    expect(results[0]!.wallet).toBe(WALLET_D) // normalized (lowercased) echo
    expect(results[0]!.display_source).toBe("score") // map lookup found the name
    expect(results[0]!.display_name).toBe("dee.bera")
  })
})

// ─── spine I/O failure → 5xx (not a per-wallet miss) ────────────────────────

describe("POST /v1/identity/resolve — spine I/O failure", () => {
  it("a real spine throw propagates as 5xx (the SoR substrate is down)", async () => {
    mockSpine.__throwOnResolve(true)
    const res = await fetch(`${baseUrl}/v1/identity/resolve`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ wallets: [WALLET_A] }),
    })
    expect(res.status).toBeGreaterThanOrEqual(500)
  })
})

// ─── §OQ-3: auth gate (the route is .auth()-protected before production) ─────

describe("POST /v1/identity/resolve — auth gate (OQ-3)", () => {
  it("401 when no bearer token is presented", async () => {
    const res = await fetch(`${baseUrl}/v1/identity/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json" }, // intentionally no authorization
      body: JSON.stringify({ wallets: [WALLET_A] }),
    })
    expect(res.status).toBe(401)
  })

  it("401 when the bearer token is malformed", async () => {
    const res = await fetch(`${baseUrl}/v1/identity/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer not.a.jwt" },
      body: JSON.stringify({ wallets: [WALLET_A] }),
    })
    expect(res.status).toBe(401)
  })
})
