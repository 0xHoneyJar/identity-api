/**
 * client.integration.test.ts — round-trip against booted identity-api.
 *
 * Boots the real Hyper app on an ephemeral port, installs a mock spine,
 * then drives every SDK method through actual fetch -> route -> handler ->
 * response. Asserts typed responses match the wire shape AND the typed
 * surface (the latter implicitly via TypeScript — if the assignment to a
 * type-annotated variable typechecks, the SDK got the shape right).
 *
 * Mirrors the existing src/api/__tests__/routes.test.ts pattern: same mock
 * spine, same JWT-mint helper, same boot/teardown shape. Where routes.test.ts
 * asserts wire shape, this file asserts the SDK's translation surface
 * (404 → null for resolve/identity; typed errors for 401/409/501).
 *
 * Hard wiring: this test must be run from the repo root (so the
 * import { app } from "../../../src/api/index" resolves). The path is
 * intentional — the SDK lives in packages/sdk, the app lives at the top.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import type {
  SpinePort,
  SpineAuditEvent,
  SpineIdentityShape,
} from "@freeside-auth/ports"
import app from "../../../../src/api/index"
import { JWT_SECRET } from "../../../../src/auth"
import { __resetSpineForTest, __setSpineForTest } from "../../../../src/api/spine"
import {
  __setInventoryForTest,
  __resetInventoryForTest,
} from "../../../../src/api/inventory"
import {
  __setScoreForTest,
  __resetScoreForTest,
} from "../../../../src/api/score"
import {
  __setCodexForTest,
  __resetCodexForTest,
} from "../../../../src/api/codex"
import { __resetBreakersForTest } from "../../../../src/api/routes/profile"
import { MockInventoryPort } from "../../../adapters/src/__tests__/mock-inventory"
import { MockScorePort } from "../../../adapters/src/__tests__/mock-score"
import { MockCodexPort } from "../../../adapters/src/__tests__/mock-codex"
import { createIdentityClient } from "../client"
import {
  ConflictError,
  IdentityApiError,
  NetworkError,
  NotImplementedError,
  UnauthorizedError,
  ValidationError,
} from "../errors"
import type { IdentityResp, VerifyResp } from "../types"

// ─── mock SpinePort (mirrors src/api/__tests__/routes.test.ts) ──────────────

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
    // C-2 (bead arrakis-491i): SpinePort gained getManagedWorlds; stub.
    async getManagedWorlds() {
      return []
    },
    async mintUser() {
      return "00000000-0000-0000-0000-000000000001"
    },
    async linkWallet() {},
    async linkAccount() {},
    async claimNym() {},
    // A2 (#11 Phase 1): SpinePort gained the world-name primitives; stubs.
    async claimGeneratedName() {
      return "MIBERA-000001";
    },
    async importName() {},
    async setPrimary() {
      return true
    },
    async writeAuditEvent(event) {
      audits.push(event)
    },
    async mintNonce() {
      return {
        nonce: "test-mock-nonce",
        expires_at: new Date(Date.now() + 300_000).toISOString(),
        message: "test-mock-message",
      }
    },
    async consumeNonce() {
      return { ok: true as const, message: "test-mock-message", wallet_address: null }
    },
    async withTransaction<T>(fn: (spine: SpinePort) => Promise<T>): Promise<T> {
      return fn(m)
    },
  }
  return m
}

// ─── HS256 mint helper (same shape as routes.test.ts) ───────────────────────

async function mintHs256Jwt(payload: Record<string, unknown>, secret: string): Promise<string> {
  const enc = new TextEncoder()
  const header = { alg: "HS256", typ: "JWT" }
  const b64url = (s: string) => btoa(s).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_")
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

// ─── fixtures ──────────────────────────────────────────────────────────────

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
  world_names: [],
}

// ─── boot/teardown ─────────────────────────────────────────────────────────

let baseUrl: string
let mockSpine: MockSpine
let mockInventory: MockInventoryPort
let mockScore: MockScorePort
let mockCodex: MockCodexPort

beforeAll(async () => {
  mockSpine = buildMockSpine()
  mockInventory = new MockInventoryPort()
  mockScore = new MockScorePort()
  mockCodex = new MockCodexPort()
  __setSpineForTest(mockSpine)
  __setInventoryForTest(mockInventory)
  __setScoreForTest(mockScore)
  __setCodexForTest(mockCodex)
  app.listen({ port: 0, hostname: "127.0.0.1", banner: false })
  const port = app.server?.port
  if (!port) throw new Error("SDK integration boot: app.server.port unavailable after listen({port:0})")
  baseUrl = `http://127.0.0.1:${port}`
})

afterAll(async () => {
  await app.stop()
  __resetSpineForTest()
  __resetInventoryForTest()
  __resetScoreForTest()
  __resetCodexForTest()
  __resetBreakersForTest()
})

beforeEach(() => {
  mockSpine.resolveByWalletReturns = undefined
  mockSpine.resolveByAccountReturns = undefined
  mockSpine.resolveByNymReturns = undefined
  mockSpine.getIdentityReturns = undefined
  mockSpine.trace.length = 0
  mockSpine.audits.length = 0
  mockInventory.__reset()
  mockScore.__reset()
  mockCodex.__reset()
  __resetBreakersForTest()
})

// ─── auth.challenge (FR-A1) ────────────────────────────────────────────────

describe("client.auth.challenge", () => {
  it("returns typed ChallengeResp on success", async () => {
    const client = createIdentityClient({ baseUrl })
    const resp = await client.auth.challenge({
      walletAddress: "0xabc0000000000000000000000000000000000001",
      scheme: "siwe",
    })
    // The mock spine returns a fixed nonce; we assert shape, not value.
    expect(resp.nonce).toBe("test-mock-nonce")
    expect(resp.message).toBe("test-mock-message")
    expect(typeof resp.expires_at).toBe("string")
  })

  it("throws ValidationError on malformed input (server-side Zod rejection)", async () => {
    const client = createIdentityClient({ baseUrl })
    let err: unknown
    try {
      // Cast around the typed surface so we can send a deliberately bad
      // input — the typed surface is doing its job catching this at compile
      // time; this test proves the runtime ALSO catches it.
      await client.auth.challenge({
        walletAddress: "not-a-hex-address",
        scheme: "siwe",
      } as unknown as { walletAddress: string; scheme: "siwe" })
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(ValidationError)
    expect((err as ValidationError).status).toBe(400)
  })
})

// ─── me / identity / resolve (FR-A3, FR-R1..R4) ────────────────────────────

describe("client.me (FR-A3)", () => {
  it("returns full IdentityResp with a valid JWT", async () => {
    mockSpine.getIdentityReturns = FIXTURE_IDENTITY
    const token = await mintHs256Jwt(
      { sub: FIXTURE_USER_ID, iat: Math.floor(Date.now() / 1000) },
      JWT_SECRET,
    )
    const client = createIdentityClient({ baseUrl, jwt: token })
    const me = await client.me()
    // TYPED ASSIGNMENT — if the SDK return type is wrong, this typechecks
    // as `unknown` and `.user_id` access errors at compile time. The fact
    // that this compiles is itself a load-bearing claim.
    const userId: string = me.user_id
    const primaryWallet: string | null = me.primary_wallet
    expect(userId).toBe(FIXTURE_USER_ID)
    expect(primaryWallet).toBe("0xabc0000000000000000000000000000000000001")
    expect(me.wallets).toHaveLength(1)
    expect(me.linked_accounts).toHaveLength(1)
    expect(me.world_identities).toHaveLength(1)
  })

  it("throws UnauthorizedError when no JWT is set on the client", async () => {
    const client = createIdentityClient({ baseUrl }) // no jwt
    let err: unknown
    try {
      await client.me()
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(UnauthorizedError)
    expect((err as UnauthorizedError).code).toBe("missing_token")
  })

  it("throws UnauthorizedError when the server rejects an invalid JWT", async () => {
    const client = createIdentityClient({ baseUrl, jwt: "not.a.valid.jwt" })
    let err: unknown
    try {
      await client.me()
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(UnauthorizedError)
  })
})

describe("client.identity.get (FR-R4)", () => {
  it("returns IdentityResp on 200", async () => {
    mockSpine.getIdentityReturns = FIXTURE_IDENTITY
    const client = createIdentityClient({ baseUrl })
    const id = await client.identity.get(FIXTURE_USER_ID)
    // The SDK return type is `IdentityResp | null`; the 200 path narrows to
    // IdentityResp. Assert with a type annotation as a compile-time proof.
    if (id === null) throw new Error("expected non-null")
    const u: string = id.user_id
    expect(u).toBe(FIXTURE_USER_ID)
  })

  it("returns null on 404 (routine-negative-answer convention)", async () => {
    mockSpine.getIdentityReturns = null
    const client = createIdentityClient({ baseUrl })
    const id = await client.identity.get(FIXTURE_USER_ID)
    expect(id).toBeNull()
  })

  it("throws ValidationError on non-UUID userId (server 400)", async () => {
    const client = createIdentityClient({ baseUrl })
    let err: unknown
    try {
      await client.identity.get("not-a-uuid")
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(ValidationError)
  })
})

describe("client.resolve.byWallet (FR-R1)", () => {
  it("200 → typed { user_id } hit", async () => {
    mockSpine.resolveByWalletReturns = FIXTURE_USER_ID
    const client = createIdentityClient({ baseUrl })
    const hit = await client.resolve.byWallet("0xabc0000000000000000000000000000000000001")
    expect(hit).not.toBeNull()
    if (hit === null) return
    // Compile-time proof: `hit.user_id` must be string.
    const u: string = hit.user_id
    expect(u).toBe(FIXTURE_USER_ID)
  })

  it("404 → null", async () => {
    mockSpine.resolveByWalletReturns = null
    const client = createIdentityClient({ baseUrl })
    const hit = await client.resolve.byWallet("0xdead000000000000000000000000000000000000")
    expect(hit).toBeNull()
  })

  it("400 (malformed address) → ValidationError", async () => {
    const client = createIdentityClient({ baseUrl })
    let err: unknown
    try {
      await client.resolve.byWallet("not-an-address")
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(ValidationError)
  })
})

describe("client.resolve.byAccount (FR-R2)", () => {
  it("200 → typed hit", async () => {
    mockSpine.resolveByAccountReturns = FIXTURE_USER_ID
    const client = createIdentityClient({ baseUrl })
    const hit = await client.resolve.byAccount("discord", "disc-7777")
    expect(hit?.user_id).toBe(FIXTURE_USER_ID)
  })

  it("404 → null", async () => {
    mockSpine.resolveByAccountReturns = null
    const client = createIdentityClient({ baseUrl })
    const hit = await client.resolve.byAccount("discord", "nonexistent")
    expect(hit).toBeNull()
  })

  it("400 (unknown provider) → ValidationError", async () => {
    const client = createIdentityClient({ baseUrl })
    let err: unknown
    try {
      // The typed surface forbids "twitter" — cast to bypass for the
      // runtime defense check.
      await client.resolve.byAccount("twitter" as never, "abc")
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(ValidationError)
  })
})

describe("client.resolve.byNym (FR-R3)", () => {
  it("200 → typed hit", async () => {
    mockSpine.resolveByNymReturns = FIXTURE_USER_ID
    const client = createIdentityClient({ baseUrl })
    const hit = await client.resolve.byNym("mibera", "fullshape")
    expect(hit?.user_id).toBe(FIXTURE_USER_ID)
  })

  it("404 → null", async () => {
    mockSpine.resolveByNymReturns = null
    const client = createIdentityClient({ baseUrl })
    const hit = await client.resolve.byNym("mibera", "nope")
    expect(hit).toBeNull()
  })
})

// ─── wired routes (T2.3 + tomorrow) ────────────────────────────────────────

describe("client.profile.get (FR-P1, T2.3 wired)", () => {
  it("returns ProfileResp with identity + degraded[] when federation sources fail", async () => {
    // Spine resolves identity (the SoR — required). Federation ports
    // return failures by default (mocks default to not-configured / 404),
    // so the orchestrator surfaces them in `degraded[]` while still
    // returning 200 with the identity field present (NFR-2 graceful degrade).
    mockSpine.getIdentityReturns = FIXTURE_IDENTITY
    mockInventory.__setFailureForWallet(FIXTURE_IDENTITY.primary_wallet!, {
      kind: "upstream_5xx",
      message: "test: inventory upstream down",
      statusCode: 503,
    })
    mockCodex.__setFailureForNextCall({
      kind: "upstream_5xx",
      message: "test: codex upstream down",
      statusCode: 503,
    })

    const client = createIdentityClient({ baseUrl })
    const profile = await client.profile.get({ world: "mibera", userId: FIXTURE_USER_ID })

    // Typed return: ProfileResp with identity always present.
    expect(profile.identity.user_id).toBe(FIXTURE_USER_ID)
    expect(profile.identity.primary_wallet).toBe(FIXTURE_IDENTITY.primary_wallet)
    // Inventory failed → no holdings field, inventory entry in degraded[].
    expect(profile.holdings).toBeUndefined()
    expect(profile.degraded).toContain("inventory:upstream_5xx")
    // Score mock defaults to not_found → score field omitted, surfaced in
    // degraded[] (per labelFor at compose-profile.ts:393). The breaker
    // treats not_found as healthy (recordOutcome at :374) — the visible-vs-
    // health-signal distinction.
    expect(profile.score).toBeUndefined()
    expect(profile.degraded).toContain("score:not_found")
  })

  it("throws ValidationError(400) when neither userId nor wallet provided", async () => {
    // ProfileQuery.userId + .wallet are both optional at the type level —
    // XOR enforcement happens at runtime in the route handler. This test
    // exercises that runtime guard.
    const client = createIdentityClient({ baseUrl })
    let err: unknown
    try {
      await client.profile.get({ world: "mibera" })
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(ValidationError)
  })
})

describe("client.mibera.dimensions (FR-M1 / G-6, T3.1 wired)", () => {
  it("returns typed MiberaDimensionsResp with tokens=[] when wallet has no Mibera", async () => {
    // Spine resolves cleanly; default inventory mock returns empty holdings
    // → orchestrator surfaces tokens=[] (no Mibera held).
    mockSpine.resolveByWalletReturns = FIXTURE_USER_ID
    mockSpine.getIdentityReturns = FIXTURE_IDENTITY
    const client = createIdentityClient({ baseUrl })
    const resp = await client.mibera.dimensions({ wallet: FIXTURE_IDENTITY.primary_wallet! })
    expect(resp.user_id).toBe(FIXTURE_USER_ID)
    expect(resp.primary_wallet).toBe(FIXTURE_IDENTITY.primary_wallet!)
    expect(resp.tokens).toEqual([])
    expect(resp.degraded).toBeUndefined()
  })
})

describe("client.link.verifiedWallet (FR-C1, T4.1 wired)", () => {
  it("returns 200 + linked user when service token matches (creates new user on both-null)", async () => {
    // LINK_SERVICE_TOKEN must be set BEFORE the app boots for the route's
    // get-at-request-time check to read it. This test sets per-test via
    // env mutation; route reads on each call.
    const previousToken = process.env.LINK_SERVICE_TOKEN
    process.env.LINK_SERVICE_TOKEN = "test-s2s-token"
    try {
      // Spine resolves return null for both → orchestrator creates user.
      mockSpine.resolveByWalletReturns = null
      const client = createIdentityClient({ baseUrl })
      const resp = await client.link.verifiedWallet(
        {
          worldSlug: "mibera",
          discordId: "disc-7777",
          walletAddress: "0xabc0000000000000000000000000000000000001",
        },
        { serviceToken: "test-s2s-token" },
      )
      // Tolerant assertion: orchestrator returned a user_id (mocked mintUser)
      // and the SDK round-tripped the typed envelope.
      expect(resp.ok).toBe(true)
      expect(typeof resp.user_id).toBe("string")
      expect(resp.wallet_address).toBe("0xabc0000000000000000000000000000000000001")
    } finally {
      if (previousToken === undefined) delete process.env.LINK_SERVICE_TOKEN
      else process.env.LINK_SERVICE_TOKEN = previousToken
    }
  })

  it("throws UnauthorizedError(401) when service token is missing/wrong", async () => {
    const previousToken = process.env.LINK_SERVICE_TOKEN
    process.env.LINK_SERVICE_TOKEN = "test-s2s-token"
    try {
      const client = createIdentityClient({ baseUrl })
      let err: unknown
      try {
        await client.link.verifiedWallet(
          {
            worldSlug: "mibera",
            discordId: "disc-7777",
            walletAddress: "0xabc0000000000000000000000000000000000001",
          },
          { serviceToken: "wrong-token" },
        )
      } catch (e) {
        err = e
      }
      expect(err).toBeInstanceOf(UnauthorizedError)
    } finally {
      if (previousToken === undefined) delete process.env.LINK_SERVICE_TOKEN
      else process.env.LINK_SERVICE_TOKEN = previousToken
    }
  })
})

// ─── error class hierarchy proof ───────────────────────────────────────────

describe("error class hierarchy", () => {
  it("UnauthorizedError IS-A IdentityApiError (catch-all branch works)", async () => {
    const client = createIdentityClient({ baseUrl })
    let err: unknown
    try {
      await client.me() // no jwt → 401
    } catch (e) {
      err = e
    }
    // Specific branch
    expect(err).toBeInstanceOf(UnauthorizedError)
    // Generic catch-all branch (consumers can write `if (e instanceof
    // IdentityApiError)` to catch ALL SDK failures uniformly)
    expect(err).toBeInstanceOf(IdentityApiError)
  })
})

// ─── network-failure path ──────────────────────────────────────────────────

describe("NetworkError path", () => {
  it("a bogus baseUrl produces a NetworkError, not an IdentityApiError(4xx)", async () => {
    const client = createIdentityClient({ baseUrl: "http://127.0.0.1:1" })
    let err: unknown
    try {
      await client.resolve.byWallet("0xabc0000000000000000000000000000000000001")
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(NetworkError)
    expect((err as NetworkError).status).toBe(0)
    expect((err as NetworkError).cause).toBeDefined()
  })
})

// Anchor type-only imports so the SDK's surface types stay observed by tsc
// (proves the types compile end-to-end alongside the runtime tests).
type _AnchorVerifyResp = VerifyResp
type _AnchorIdentityResp = IdentityResp
void (null as unknown as _AnchorVerifyResp)
void (null as unknown as _AnchorIdentityResp)
// Also anchor ConflictError for future tests (the spine doesn't surface
// 409 from the mock today; the dedicated transport unit test covers the
// mapping, this anchor keeps the import live in case future tests grow).
type _AnchorConflict = ConflictError
void (null as unknown as _AnchorConflict)
