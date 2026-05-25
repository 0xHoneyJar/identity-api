/**
 * link-route.test.ts — T4.TEST integration tests for POST /v1/link/verified-wallet
 * (bead arrakis-ljjq · pair with T4.1 arrakis-hyde).
 *
 * Exercises:
 *   - Auth gate: missing/wrong X-Service-Token → 401; service unconfigured → 503.
 *   - 5-case conflict matrix per SDD §8.2 / D8 / cycle-c FR-L3:
 *       a. both null              → 200, create user + link both
 *       b. same user              → 200 idempotent no-op
 *       c. discord set, wallet null → 200, wallet rebound to discord-user
 *       d. wallet set, discord null → 200, discord rebound to wallet-user
 *       e. both set, different    → 409 cross_user_collision (HARD FAIL)
 *   - Audit emit per outcome (link_verified_wallet umbrella row + sub-rows;
 *     conflict_rejected on case e).
 *   - dynamic_user_id ALSO linked when supplied (non-noop outcomes only).
 *
 * Pattern: ephemeral port, mock spine (records calls + audits), env LINK_SERVICE_TOKEN
 * set per beforeEach.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import type {
  SpineAuditEvent,
  SpineIdentityShape,
  SpineLinkedAccountProvider,
  SpinePort,
} from "@freeside-auth/ports"
import app from "../index"
import { __resetSpineForTest, __setSpineForTest } from "../spine"

// ─── mock spine — richer than routes.test.ts to track linkage writes ───────

interface LinkCall {
  method: "linkWallet" | "linkAccount" | "mintUser"
  args: unknown
}

interface MockSpine extends SpinePort {
  readonly audits: SpineAuditEvent[]
  readonly linkCalls: LinkCall[]
  resolveByWalletReturns?: string | null
  resolveByAccountByProvider?: Partial<Record<SpineLinkedAccountProvider, string | null>>
  mintUserReturns?: string
  // Per-call state: tracks the next mint() return so a single test can mint
  // multiple users.
}

// Alias used by the audit-durability test to construct a sentinel-mock
// extending the base interface. The cast in the test body keeps the
// override readable.
type SpineSnapshot = MockSpine

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
      // for unit-level integration tests. T4.4's backfill test will exercise
      // real-DB txn behavior.
      return fn(m)
    },
  }
  return m
}

// ─── fixtures ──────────────────────────────────────────────────────────────

const USER_A = "11111111-1111-4111-8111-111111111111"
const USER_B = "22222222-2222-4222-8222-222222222222"
const WALLET_A = "0xaaa0000000000000000000000000000000000001"
const DISCORD_A = "discA-7777"
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

interface LinkSuccessBody {
  ok: true
  user_id: string
  wallet_address: string
  idempotent: boolean
  conflict_resolved: "wallet_rebound" | "discord_rebound" | null
}

interface LinkConflictBody {
  ok: false
  conflict: "cross_user_collision"
  message: string
}

async function postLink(
  body: { worldSlug?: string; discordId?: string; walletAddress?: string; dynamicUserId?: string },
  opts: { serviceToken?: string | null } = {},
): Promise<{ status: number; body: LinkSuccessBody | LinkConflictBody | { code: string } }> {
  const headers: Record<string, string> = { "content-type": "application/json" }
  if (opts.serviceToken !== null) {
    headers["x-service-token"] = opts.serviceToken ?? SERVICE_TOKEN
  }
  const res = await fetch(`${baseUrl}/v1/link/verified-wallet`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      worldSlug: "mibera",
      discordId: DISCORD_A,
      walletAddress: WALLET_A,
      ...body,
    }),
  })
  return {
    status: res.status,
    body: (await res.json()) as LinkSuccessBody | LinkConflictBody | { code: string },
  }
}

// ─── auth gate ──────────────────────────────────────────────────────────────

describe("POST /v1/link/verified-wallet — auth", () => {
  it("401 when X-Service-Token is missing", async () => {
    const { status, body } = await postLink({}, { serviceToken: null })
    expect(status).toBe(401)
    expect((body as { code: string }).code).toBe("unauthorized")
  })

  it("401 when X-Service-Token is wrong", async () => {
    const { status, body } = await postLink({}, { serviceToken: "wrong" })
    expect(status).toBe(401)
    expect((body as { code: string }).code).toBe("unauthorized")
  })

  it("503 when LINK_SERVICE_TOKEN is unset (service unconfigured)", async () => {
    delete process.env.LINK_SERVICE_TOKEN
    const { status, body } = await postLink({})
    expect(status).toBe(503)
    expect((body as { code: string }).code).toBe("service_unconfigured")
  })
})

// ─── 5-case conflict matrix (SDD §8.2) ──────────────────────────────────────

describe("POST /v1/link/verified-wallet — case (a) both null → create", () => {
  it("creates user, links wallet + discord (both linked_accounts) → 200", async () => {
    mockSpine.mintUserReturns = USER_A
    const { status, body } = await postLink({})
    expect(status).toBe(200)
    const ok = body as LinkSuccessBody
    expect(ok.ok).toBe(true)
    expect(ok.user_id).toBe(USER_A)
    expect(ok.idempotent).toBe(false)
    expect(ok.conflict_resolved).toBeNull()
    // mintUser → linkWallet → linkAccount(discord)
    const methods = mockSpine.linkCalls.map((c) => c.method)
    expect(methods).toEqual(["mintUser", "linkWallet", "linkAccount"])
    // Audit trail: wallet_linked + account_linked + link_verified_wallet umbrella.
    const eventTypes = mockSpine.audits.map((a) => a.event_type)
    expect(eventTypes).toContain("wallet_linked")
    expect(eventTypes).toContain("account_linked")
    expect(eventTypes).toContain("link_verified_wallet")
  })

  it("ALSO links dynamic_user_id when supplied", async () => {
    mockSpine.mintUserReturns = USER_A
    const { status, body } = await postLink({ dynamicUserId: "dyn-12345" })
    expect(status).toBe(200)
    expect((body as LinkSuccessBody).user_id).toBe(USER_A)
    // 2 linkAccount calls: discord + dynamic_user_id
    const linkAccountCalls = mockSpine.linkCalls.filter((c) => c.method === "linkAccount")
    expect(linkAccountCalls).toHaveLength(2)
    const providers = linkAccountCalls.map(
      (c) => (c.args as { provider: string }).provider,
    )
    expect(providers).toContain("discord")
    expect(providers).toContain("dynamic_user_id")
  })
})

describe("POST /v1/link/verified-wallet — case (b) same user → idempotent", () => {
  it("both resolve to same user → 200 idempotent, NO new writes", async () => {
    mockSpine.resolveByWalletReturns = USER_A
    mockSpine.resolveByAccountByProvider = { discord: USER_A }
    const { status, body } = await postLink({})
    expect(status).toBe(200)
    const ok = body as LinkSuccessBody
    expect(ok.ok).toBe(true)
    expect(ok.user_id).toBe(USER_A)
    expect(ok.idempotent).toBe(true)
    expect(ok.conflict_resolved).toBeNull()
    // NO mintUser / linkWallet / linkAccount fired.
    expect(mockSpine.linkCalls).toEqual([])
    // Only the umbrella audit fired.
    const eventTypes = mockSpine.audits.map((a) => a.event_type)
    expect(eventTypes).toEqual(["link_verified_wallet"])
  })

  it("idempotent re-link DOES NOT re-link dynamic_user_id (skip on idempotent)", async () => {
    mockSpine.resolveByWalletReturns = USER_A
    mockSpine.resolveByAccountByProvider = { discord: USER_A }
    const { status } = await postLink({ dynamicUserId: "dyn-12345" })
    expect(status).toBe(200)
    // No linkAccount fired (idempotent skip rule).
    expect(mockSpine.linkCalls.filter((c) => c.method === "linkAccount")).toEqual([])
  })
})

describe("POST /v1/link/verified-wallet — case (c) discord set, wallet null → rebind wallet", () => {
  it("links wallet to discord-user → 200 conflict_resolved=wallet_rebound", async () => {
    mockSpine.resolveByWalletReturns = null
    mockSpine.resolveByAccountByProvider = { discord: USER_A }
    const { status, body } = await postLink({})
    expect(status).toBe(200)
    const ok = body as LinkSuccessBody
    expect(ok.user_id).toBe(USER_A)
    expect(ok.idempotent).toBe(false)
    expect(ok.conflict_resolved).toBe("wallet_rebound")
    // ONLY linkWallet fired (discord already linked).
    const methods = mockSpine.linkCalls.map((c) => c.method)
    expect(methods).toEqual(["linkWallet"])
  })
})

describe("POST /v1/link/verified-wallet — case (d) wallet set, discord null → rebind discord", () => {
  it("links discord to wallet-user → 200 conflict_resolved=discord_rebound", async () => {
    mockSpine.resolveByWalletReturns = USER_A
    mockSpine.resolveByAccountByProvider = { discord: null }
    const { status, body } = await postLink({})
    expect(status).toBe(200)
    const ok = body as LinkSuccessBody
    expect(ok.user_id).toBe(USER_A)
    expect(ok.conflict_resolved).toBe("discord_rebound")
    // ONLY linkAccount(discord) fired.
    const calls = mockSpine.linkCalls
    expect(calls).toHaveLength(1)
    expect(calls[0]?.method).toBe("linkAccount")
    expect((calls[0]?.args as { provider: string }).provider).toBe("discord")
  })
})

describe("POST /v1/link/verified-wallet — case (e) BOTH SET, DIFFERENT users → 409 HARD FAIL", () => {
  it("returns 409 cross_user_collision + audits conflict_rejected", async () => {
    mockSpine.resolveByWalletReturns = USER_A
    mockSpine.resolveByAccountByProvider = { discord: USER_B }
    const { status, body } = await postLink({})
    expect(status).toBe(409)
    const conflict = body as LinkConflictBody
    expect(conflict.ok).toBe(false)
    expect(conflict.conflict).toBe("cross_user_collision")
    expect(conflict.message).toContain(USER_A)
    expect(conflict.message).toContain(USER_B)
    // NO link writes fired.
    expect(mockSpine.linkCalls.filter((c) => c.method !== "mintUser")).toEqual([])
    // Audit conflict_rejected emitted (NFR-5: log rejected attempts).
    const eventTypes = mockSpine.audits.map((a) => a.event_type)
    expect(eventTypes).toContain("conflict_rejected")
    // NO link_verified_wallet umbrella audit (the throw aborts before it fires).
    expect(eventTypes).not.toContain("link_verified_wallet")
  })

  it("conflict_rejected audit DURABILITY — written through outer spine so txn rollback can't lose it (FAGAN iter-1 regression)", async () => {
    // The mock pass-through txn is too lenient to catch the original bug
    // (audit through txnSpine + throw → would roll back the audit in real
    // PG). Simulate the rollback semantics: the orchestrator must call
    // writeAuditEvent through the OUTER spine before throwing, so that
    // even when withTransaction's closure throws (rolling back any
    // txn-scoped writes), the audit row persists.
    //
    // Construct a sentinel mock that tracks "outer-only" vs "txn-scoped"
    // audits by intercepting writeAuditEvent on the OUTER spine but
    // NOT on the closure-passed spine.
    const outerAudits: SpineAuditEvent[] = []
    const txnAudits: SpineAuditEvent[] = []
    const sentinel: SpineSnapshot = {
      ...mockSpine,
      async writeAuditEvent(event: SpineAuditEvent) {
        outerAudits.push(event)
      },
      async withTransaction<T>(fn: (spine: SpinePort) => Promise<T>): Promise<T> {
        // The closure spine routes audits to txnAudits — simulating the
        // "would be rolled back" pool.
        const txnSpine: SpinePort = {
          ...mockSpine,
          async writeAuditEvent(event) {
            txnAudits.push(event)
          },
        }
        try {
          return await fn(txnSpine)
        } catch (err) {
          // Real PG would roll back txnAudits here. Simulate:
          txnAudits.length = 0
          throw err
        }
      },
    } as unknown as SpineSnapshot
    __setSpineForTest(sentinel as unknown as SpinePort)
    mockSpine.resolveByWalletReturns = USER_A
    mockSpine.resolveByAccountByProvider = { discord: USER_B }
    try {
      const { status } = await postLink({})
      expect(status).toBe(409)
      // The conflict_rejected audit MUST be in outerAudits (survived the
      // simulated rollback), NOT in txnAudits (which gets cleared on throw).
      const outerEventTypes = outerAudits.map((a) => a.event_type)
      expect(outerEventTypes).toContain("conflict_rejected")
      expect(txnAudits.map((a) => a.event_type)).not.toContain("conflict_rejected")
    } finally {
      __setSpineForTest(mockSpine)
    }
  })

  it("conflict_rejected audit FAILURE does not suppress the typed 409 (BB F-005 regression)", async () => {
    // BB review F-005: a transient audit-write failure used to propagate
    // unchanged through the orchestrator → the route's catch only matched
    // LinkCrossUserCollisionError → the audit-DB-error leaked as 500.
    // Now the audit is in its own try/catch; failures log but the typed
    // collision error ALWAYS reaches the route handler → 409.
    const auditErrors: Error[] = []
    const sentinel: SpineSnapshot = {
      ...mockSpine,
      async writeAuditEvent(_event: SpineAuditEvent) {
        const err = new Error("simulated audit DB unavailable")
        auditErrors.push(err)
        throw err
      },
      async withTransaction<T>(fn: (spine: SpinePort) => Promise<T>): Promise<T> {
        return fn(this as unknown as SpinePort)
      },
    } as unknown as SpineSnapshot
    __setSpineForTest(sentinel as unknown as SpinePort)
    mockSpine.resolveByWalletReturns = USER_A
    mockSpine.resolveByAccountByProvider = { discord: USER_B }
    try {
      const { status, body } = await postLink({})
      // CRITICAL: still 409, NOT 500. Collision IS the business outcome;
      // audit-write failure is observability infra and must not change it.
      expect(status).toBe(409)
      expect((body as LinkConflictBody).conflict).toBe("cross_user_collision")
      // The audit write was attempted at least once (and failed).
      expect(auditErrors.length).toBeGreaterThanOrEqual(1)
    } finally {
      __setSpineForTest(mockSpine)
    }
  })

  it("does NOT link dynamic_user_id on collision (no writes after collision detection)", async () => {
    mockSpine.resolveByWalletReturns = USER_A
    mockSpine.resolveByAccountByProvider = { discord: USER_B }
    const { status } = await postLink({ dynamicUserId: "dyn-doomed" })
    expect(status).toBe(409)
    expect(mockSpine.linkCalls.filter((c) => c.method === "linkAccount")).toEqual([])
  })
})

// ─── input validation ──────────────────────────────────────────────────────

describe("POST /v1/link/verified-wallet — input validation", () => {
  it("400 on malformed walletAddress", async () => {
    const res = await fetch(`${baseUrl}/v1/link/verified-wallet`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-service-token": SERVICE_TOKEN },
      body: JSON.stringify({
        worldSlug: "mibera",
        discordId: DISCORD_A,
        walletAddress: "not-an-address",
      }),
    })
    expect(res.status).toBe(400)
  })

  it("400 on missing discordId", async () => {
    const res = await fetch(`${baseUrl}/v1/link/verified-wallet`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-service-token": SERVICE_TOKEN },
      body: JSON.stringify({
        worldSlug: "mibera",
        walletAddress: WALLET_A,
      }),
    })
    expect(res.status).toBe(400)
  })
})
