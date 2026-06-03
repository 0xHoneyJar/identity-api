/**
 * managed-worlds-route.test.ts — integration tests for the C-2 route
 * GET /v1/users/:id/managed-worlds (bead arrakis-491i).
 *
 * Strategy (mirrors routes.test.ts):
 *   - Set LINK_SERVICE_TOKEN BEFORE importing the route module (the service
 *     token is read at request time, but we set it at module scope so the
 *     env is stable across the whole file).
 *   - Boot the Hyper app on an ephemeral port (port: 0).
 *   - Install a mock SpinePort via __setSpineForTest().
 *   - Hit the endpoint with fetch; assert status + JSON.
 *
 * No real DB — the mock spine drives every path. JWTs are hand-minted HS256
 * against the SAME JWT_SECRET src/auth.ts loaded (read once at module load).
 *
 * Auth matrix covered:
 *   - no auth                         → 401
 *   - valid service token, any id     → 200 (cross-user read)
 *   - self bearer JWT (sub === id)    → 200
 *   - bearer JWT (sub !== id)         → 403 (authenticated, not authorized)
 *   - garbage bearer token            → 401 (NOT 500)
 *   - malformed (non-UUID) id         → 400
 *   - authorized + user manages none  → 200 + { worlds: [] }
 */

// Set the service token BEFORE any import that reads it. ESM hoists imports,
// but `process.env` assignment in a top-level statement runs after hoisted
// imports — getServiceToken() reads at REQUEST time, so this is in time.
process.env.LINK_SERVICE_TOKEN = "test-c2-service-token-do-not-use-in-prod"

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import type { SpinePort, SpineManagedWorld } from "@freeside-auth/ports"
import app from "../index"
import { JWT_SECRET } from "../../auth"
import { __setSpineForTest, __resetSpineForTest } from "../spine"

const SERVICE_TOKEN = "test-c2-service-token-do-not-use-in-prod"

// ─── mock SpinePort (only getManagedWorlds is exercised) ──────────────────

interface MockSpine extends SpinePort {
  managedWorldsReturns: readonly SpineManagedWorld[]
  readonly calls: Array<{ method: string; userId: string }>
}

function buildMockSpine(): MockSpine {
  const calls: Array<{ method: string; userId: string }> = []
  const notImpl = (name: string) => () => {
    throw new Error(`mock: ${name} not expected in managed-worlds route test`)
  }
  const m: MockSpine = {
    managedWorldsReturns: [],
    calls,
    async getManagedWorlds(userId) {
      calls.push({ method: "getManagedWorlds", userId })
      return m.managedWorldsReturns
    },
    // Unused surface — throw if any of these are touched.
    resolveByWallet: notImpl("resolveByWallet") as never,
    resolveByAccount: notImpl("resolveByAccount") as never,
    resolveByNym: notImpl("resolveByNym") as never,
    getIdentity: notImpl("getIdentity") as never,
    mintUser: notImpl("mintUser") as never,
    linkWallet: notImpl("linkWallet") as never,
    linkAccount: notImpl("linkAccount") as never,
    claimNym: notImpl("claimNym") as never,
    // A2 (#11 Phase 1): SpinePort gained the world-name primitives; unused here.
    claimGeneratedName: notImpl("claimGeneratedName") as never,
    importName: notImpl("importName") as never,
    setPrimary: notImpl("setPrimary") as never,
    writeAuditEvent: notImpl("writeAuditEvent") as never,
    mintNonce: notImpl("mintNonce") as never,
    consumeNonce: notImpl("consumeNonce") as never,
    withTransaction: notImpl("withTransaction") as never,
  }
  return m
}

// ─── HS256 JWT minter (copied from routes.test.ts) ────────────────────────

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

// ─── fixtures ─────────────────────────────────────────────────────────────

const USER_A = "11111111-2222-4333-8444-555555555555"
const USER_B = "99999999-8888-4777-8666-555555555555"
const MANAGED: readonly SpineManagedWorld[] = [
  { world_slug: "thj", granted_at: "2026-01-01T00:00:00.000Z" },
  { world_slug: "mibera", granted_at: "2026-02-01T00:00:00.000Z" },
]

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

beforeEach(() => {
  mockSpine.managedWorldsReturns = MANAGED
})

// ─── tests ──────────────────────────────────────────────────────────────

describe("GET /v1/users/:id/managed-worlds (C-2)", () => {
  it("401 with no auth", async () => {
    const res = await fetch(`${baseUrl}/v1/users/${USER_A}/managed-worlds`)
    expect(res.status).toBe(401)
    const body = (await res.json()) as { code: string }
    expect(body.code).toBe("unauthorized")
  })

  it("200 with a valid service token (cross-user read of any id)", async () => {
    const res = await fetch(`${baseUrl}/v1/users/${USER_A}/managed-worlds`, {
      headers: { "x-service-token": SERVICE_TOKEN },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { user_id: string; worlds: SpineManagedWorld[] }
    expect(body.user_id).toBe(USER_A)
    expect(body.worlds).toHaveLength(2)
    expect(body.worlds[0]!.world_slug).toBe("thj")
  })

  it("401 with a wrong service token (and no bearer)", async () => {
    const res = await fetch(`${baseUrl}/v1/users/${USER_A}/managed-worlds`, {
      headers: { "x-service-token": "wrong-token" },
    })
    expect(res.status).toBe(401)
  })

  it("200 with a self bearer JWT (sub === id)", async () => {
    const jwt = await mintHs256Jwt({ sub: USER_A, iat: Math.floor(Date.now() / 1000) }, JWT_SECRET)
    const res = await fetch(`${baseUrl}/v1/users/${USER_A}/managed-worlds`, {
      headers: { authorization: `Bearer ${jwt}` },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { user_id: string; worlds: SpineManagedWorld[] }
    expect(body.user_id).toBe(USER_A)
    expect(body.worlds).toHaveLength(2)
  })

  it("403 with a bearer JWT whose sub !== id (authenticated, not authorized)", async () => {
    const jwt = await mintHs256Jwt({ sub: USER_B, iat: Math.floor(Date.now() / 1000) }, JWT_SECRET)
    const res = await fetch(`${baseUrl}/v1/users/${USER_A}/managed-worlds`, {
      headers: { authorization: `Bearer ${jwt}` },
    })
    expect(res.status).toBe(403)
    const body = (await res.json()) as { code: string }
    expect(body.code).toBe("forbidden")
  })

  it("401 (NOT 500) on a garbage bearer token", async () => {
    const res = await fetch(`${baseUrl}/v1/users/${USER_A}/managed-worlds`, {
      headers: { authorization: "Bearer aaa.bbb.ccc" },
    })
    expect(res.status).toBe(401)
  })

  it("400 invalid_param on a non-UUID id (before auth)", async () => {
    const res = await fetch(`${baseUrl}/v1/users/not-a-uuid/managed-worlds`, {
      headers: { "x-service-token": SERVICE_TOKEN },
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { code: string; param: string }
    expect(body.code).toBe("invalid_param")
    expect(body.param).toBe("id")
  })

  it("200 + { worlds: [] } when an authorized user manages nothing", async () => {
    mockSpine.managedWorldsReturns = []
    const jwt = await mintHs256Jwt({ sub: USER_A, iat: Math.floor(Date.now() / 1000) }, JWT_SECRET)
    const res = await fetch(`${baseUrl}/v1/users/${USER_A}/managed-worlds`, {
      headers: { authorization: `Bearer ${jwt}` },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { user_id: string; worlds: SpineManagedWorld[] }
    expect(body.worlds).toEqual([])
  })

  it("service token takes precedence — cross-user read of USER_B works", async () => {
    const res = await fetch(`${baseUrl}/v1/users/${USER_B}/managed-worlds`, {
      headers: { "x-service-token": SERVICE_TOKEN },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { user_id: string }
    expect(body.user_id).toBe(USER_B)
    expect(mockSpine.calls.at(-1)?.userId).toBe(USER_B)
  })
})
