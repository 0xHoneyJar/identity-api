/**
 * wallet-only-route.test.ts — integration tests for POST /v1/link/wallet-only
 * (bead bd-4hu · Sprint B part 1).
 *
 * Exercises the wallet-only ingress route — the sibling of
 * /v1/link/verified-wallet MINUS the discord axis and MINUS the 409/collision
 * path. The engine resolver (`firstClaimResolver`,
 * `link-wallet-only.ts:82-97`) only produces `create_user | idempotent_noop`,
 * so there is no cross-user collision class on this path; the route therefore
 * has no 409 branch.
 *
 *   - Auth gate: missing/wrong X-Service-Token → 401; service unconfigured → 503.
 *   - New wallet (resolveByWallet null, no importedNames) → 200, mintUser +
 *     linkWallet + claimGeneratedName; generated_name = "MIBERA-000001",
 *     idempotent = false.
 *   - Known wallet (resolveByWallet hit) → 200 idempotent no-op; generated_name
 *     = null, idempotent = true, NO writes.
 *   - Audit: umbrella `link_wallet_only` event emitted with NO `discord_id`
 *     key in its payload (`link-wallet-only.ts:197-208`).
 *
 * Pattern: ephemeral port, mock spine (records calls + audits), env
 * LINK_SERVICE_TOKEN set per beforeEach — mirrors link-route.test.ts.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import type {
  SpineAuditEvent,
  SpineIdentityShape,
  SpineLinkedAccountProvider,
  SpinePort,
} from "@freeside-auth/ports"
import { LinkWalletOnlyReqSchema } from "@freeside-auth/protocol/api"
import { zodConverter } from "../../hyper/openapi-zod"
import app from "../index"
import { __resetSpineForTest, __setSpineForTest } from "../spine"

// ─── mock spine — tracks linkage + name writes for the wallet-only path ─────

interface LinkCall {
  method: "linkWallet" | "linkAccount" | "mintUser" | "claimGeneratedName" | "importName"
  args: unknown
}

interface MockSpine extends SpinePort {
  readonly audits: SpineAuditEvent[]
  readonly linkCalls: LinkCall[]
  resolveByWalletReturns?: string | null
  resolveByAccountByProvider?: Partial<Record<SpineLinkedAccountProvider, string | null>>
  mintUserReturns?: string
}

function buildMockSpine(): MockSpine {
  const audits: SpineAuditEvent[] = []
  const linkCalls: LinkCall[] = []
  let _mintCounter = 0
  const m: MockSpine = {
    audits,
    linkCalls,
    async resolveByWallet() {
      return m.resolveByWalletReturns ?? null
    },
    async resolveByAccount(provider) {
      return m.resolveByAccountByProvider?.[provider] ?? null
    },
    async resolveByNym() {
      return null
    },
    async getIdentity(): Promise<SpineIdentityShape | null> {
      return null
    },
    // C-2 (bead arrakis-491i): SpinePort gained getManagedWorlds; stub.
    async getManagedWorlds() {
      return []
    },
    async mintUser() {
      _mintCounter += 1
      linkCalls.push({ method: "mintUser", args: { counter: _mintCounter } })
      return m.mintUserReturns ?? `00000000-0000-4000-8000-${String(_mintCounter).padStart(12, "0")}`
    },
    async linkWallet(opts) {
      linkCalls.push({ method: "linkWallet", args: opts })
    },
    async linkAccount(opts) {
      linkCalls.push({ method: "linkAccount", args: opts })
    },
    async claimNym() {},
    // A2 (#11 Phase 1): SpinePort gained the world-name primitives. The
    // wallet-only path drives claimGeneratedName on a fresh claim.
    async claimGeneratedName(opts) {
      linkCalls.push({ method: "claimGeneratedName", args: opts })
      return "MIBERA-000001"
    },
    async importName(opts) {
      linkCalls.push({ method: "importName", args: opts })
    },
    async setPrimary() {
      return true
    },
    async writeAuditEvent(event) {
      audits.push(event)
    },
    async mintNonce() {
      return {
        nonce: "test-mock-nonce",
        expires_at: "2026-05-25T00:05:00.000Z",
        message: "test-mock-message",
      }
    },
    async consumeNonce() {
      return { ok: true as const, message: "test-mock-message", wallet_address: null }
    },
    async withTransaction<T>(fn: (spine: SpinePort) => Promise<T>): Promise<T> {
      // Pass-through txn — the mock doesn't need real transactional semantics
      // for unit-level integration tests.
      return fn(m)
    },
  }
  return m
}

// ─── fixtures ──────────────────────────────────────────────────────────────

const USER_A = "11111111-1111-4111-8111-111111111111"
const WALLET_A = "0xaaa0000000000000000000000000000000000001"
const SERVICE_TOKEN = "test-s2s-token"

// ─── boot/teardown ──────────────────────────────────────────────────────────

let baseUrl: string
let mockSpine: MockSpine

beforeAll(async () => {
  mockSpine = buildMockSpine()
  __setSpineForTest(mockSpine)
  app.listen({ port: 0, hostname: "127.0.0.1", banner: false })
  const port = app.server?.port
  if (!port) throw new Error("test boot: app.server.port unavailable")
  baseUrl = `http://127.0.0.1:${port}`
})

afterAll(async () => {
  await app.stop()
  __resetSpineForTest()
  delete process.env.LINK_SERVICE_TOKEN
})

beforeEach(() => {
  mockSpine.audits.length = 0
  mockSpine.linkCalls.length = 0
  mockSpine.resolveByWalletReturns = undefined
  mockSpine.resolveByAccountByProvider = undefined
  mockSpine.mintUserReturns = undefined
  process.env.LINK_SERVICE_TOKEN = SERVICE_TOKEN
})

// ─── helpers ────────────────────────────────────────────────────────────────

interface WalletOnlySuccessBody {
  ok: true
  user_id: string
  wallet_address: string
  idempotent: boolean
  generated_name: string | null
}

async function postWalletOnly(
  body: {
    worldSlug?: string
    walletAddress?: string
    dynamicUserId?: string
    importedNames?: { nameType: string; value: string }[]
  },
  opts: { serviceToken?: string | null } = {},
): Promise<{ status: number; body: WalletOnlySuccessBody | { code: string } }> {
  const headers: Record<string, string> = { "content-type": "application/json" }
  if (opts.serviceToken !== null) {
    headers["x-service-token"] = opts.serviceToken ?? SERVICE_TOKEN
  }
  const res = await fetch(`${baseUrl}/v1/link/wallet-only`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      worldSlug: "mibera",
      walletAddress: WALLET_A,
      ...body,
    }),
  })
  return {
    status: res.status,
    body: (await res.json()) as WalletOnlySuccessBody | { code: string },
  }
}

// ─── auth gate ──────────────────────────────────────────────────────────────

describe("POST /v1/link/wallet-only — auth", () => {
  it("503 when LINK_SERVICE_TOKEN is unset (service unconfigured)", async () => {
    delete process.env.LINK_SERVICE_TOKEN
    const { status, body } = await postWalletOnly({})
    expect(status).toBe(503)
    expect((body as { code: string }).code).toBe("service_unconfigured")
  })

  it("401 when X-Service-Token is missing", async () => {
    const { status, body } = await postWalletOnly({}, { serviceToken: null })
    expect(status).toBe(401)
    expect((body as { code: string }).code).toBe("unauthorized")
  })

  it("401 when X-Service-Token is wrong", async () => {
    const { status, body } = await postWalletOnly({}, { serviceToken: "wrong" })
    expect(status).toBe(401)
    expect((body as { code: string }).code).toBe("unauthorized")
  })
})

// ─── happy path: new wallet → fresh claim ────────────────────────────────────

describe("POST /v1/link/wallet-only — new wallet → create + claimGeneratedName", () => {
  it("mints user, links wallet, claims a generated name → 200 generated_name set, idempotent false", async () => {
    mockSpine.resolveByWalletReturns = null // unknown wallet → create_user
    mockSpine.mintUserReturns = USER_A
    const { status, body } = await postWalletOnly({})
    expect(status).toBe(200)
    const ok = body as WalletOnlySuccessBody
    expect(ok.ok).toBe(true)
    expect(ok.user_id).toBe(USER_A)
    expect(ok.idempotent).toBe(false)
    expect(ok.generated_name).toBe("MIBERA-000001")
    // mintUser → linkWallet → claimGeneratedName (no importedNames given).
    const methods = mockSpine.linkCalls.map((c) => c.method)
    expect(methods).toEqual(["mintUser", "linkWallet", "claimGeneratedName"])
    // wallet linked as primary, never a discord linkAccount.
    expect(mockSpine.linkCalls.some((c) => c.method === "linkAccount")).toBe(false)
  })
})

// ─── idempotent path: known wallet → no-op ───────────────────────────────────

describe("POST /v1/link/wallet-only — known wallet → idempotent no-op", () => {
  it("returns 200 idempotent true, generated_name null, NO writes", async () => {
    mockSpine.resolveByWalletReturns = USER_A // known wallet → idempotent_noop
    const { status, body } = await postWalletOnly({})
    expect(status).toBe(200)
    const ok = body as WalletOnlySuccessBody
    expect(ok.ok).toBe(true)
    expect(ok.user_id).toBe(USER_A)
    expect(ok.idempotent).toBe(true)
    expect(ok.generated_name).toBeNull()
    // NO mintUser / linkWallet / claimGeneratedName fired.
    expect(mockSpine.linkCalls).toEqual([])
  })
})

// ─── audit: no discord axis ──────────────────────────────────────────────────

describe("POST /v1/link/wallet-only — audit", () => {
  it("emits link_wallet_only umbrella audit with NO discord_id key in payload", async () => {
    mockSpine.resolveByWalletReturns = null
    mockSpine.mintUserReturns = USER_A
    const { status } = await postWalletOnly({})
    expect(status).toBe(200)
    const umbrella = mockSpine.audits.find((a) => a.event_type === "link_wallet_only")
    expect(umbrella).toBeDefined()
    // The wallet-only path NEVER touches discord — assert the payload has no
    // discord_id key (link-wallet-only.ts:197-208).
    expect("discord_id" in (umbrella as SpineAuditEvent).payload).toBe(false)
    // Sanity: no audit on this path carries a discord_id key.
    for (const a of mockSpine.audits) {
      expect("discord_id" in a.payload).toBe(false)
    }
  })
})

// ─── input validation ──────────────────────────────────────────────────────

describe("POST /v1/link/wallet-only — input validation", () => {
  it("400 on malformed walletAddress", async () => {
    const res = await fetch(`${baseUrl}/v1/link/wallet-only`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-service-token": SERVICE_TOKEN },
      body: JSON.stringify({ worldSlug: "mibera", walletAddress: "not-an-address" }),
    })
    expect(res.status).toBe(400)
  })
})

// ─── OpenAPI converter: array body regression ───────────────────────────────
//
// LinkWalletOnlyReqSchema is the first request body to carry a `z.array(...)`.
// Under Zod v4 the array `_def` exposes BOTH `type` (the discriminator string
// "array") and `element` (the actual element schema); the converter must read
// `element` first or it walks the string and crashes on `def.typeName` at app
// boot (the openapi plugin generates the spec on the OpenAPI route). This pins
// the fix so a regression fails here, not only at app-boot for every route.
describe("openapi-zod converter — array request body (regression)", () => {
  it("converts importedNames array → {type:'array', items:{type:'object'}} without throwing", () => {
    const json = zodConverter.toJsonSchema(LinkWalletOnlyReqSchema) as {
      type: string
      properties: Record<string, { type?: string | string[]; items?: { type?: string } }>
    }
    expect(json.type).toBe("object")
    const imported = json.properties.importedNames
    expect(imported?.type).toBe("array")
    expect(imported?.items?.type).toBe("object")
  })
})
