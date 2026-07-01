/**
 * auth-discord-route.test.ts — integration tests for Discord OAuth login (#44).
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
import {
  __resetDiscordLoginOAuthClientForTest,
  __setDiscordLoginOAuthClientForTest,
} from "../routes/auth-discord"
import {
  __resetConsumedStateNoncesForTest,
  DiscordOAuthExchangeError,
  mintLoginOAuthState,
} from "../../discord-oauth"

const REDIRECT = "https://dashboard.example/auth/discord/callback"
const CSRF = "csrf-token-abc"

interface MockSpine extends SpinePort {
  readonly audits: SpineAuditEvent[]
  readonly linkAccountCalls: Array<{
    userId: string
    provider: SpineLinkedAccountProvider
    externalId: string
  }>
  mintUserCalls: number
  resolveByAccountByProvider?: Partial<Record<SpineLinkedAccountProvider, string | null>>
  mintUserId?: string
}

function buildMockSpine(): MockSpine {
  const audits: SpineAuditEvent[] = []
  const linkAccountCalls: MockSpine["linkAccountCalls"] = []
  let mintUserCalls = 0
  const m: MockSpine = {
    audits,
    linkAccountCalls,
    mintUserCalls: 0,
    async resolveByWallet() {
      return null
    },
    async resolveByAccount(provider) {
      return m.resolveByAccountByProvider?.[provider] ?? null
    },
    async resolveByNym() {
      return null
    },
    async getIdentity(userId: string): Promise<SpineIdentityShape | null> {
      return {
        user_id: userId,
        primary_wallet: null,
        wallets: [],
        linked_accounts: [],
        world_identities: [],
        world_names: [],
        created_at: "2026-06-01T00:00:00.000Z",
        updated_at: "2026-06-01T00:00:00.000Z",
      }
    },
    async getManagedWorlds() {
      return []
    },
    async mintUser() {
      mintUserCalls += 1
      m.mintUserCalls = mintUserCalls
      return m.mintUserId ?? "00000000-0000-4000-8000-000000000001"
    },
    async linkWallet() {},
    async linkAccount(opts) {
      linkAccountCalls.push({
        userId: opts.userId,
        provider: opts.provider,
        externalId: opts.externalId,
      })
    },
    async claimNym() {},
    async claimGeneratedName() {
      return "MIBERA-000001"
    },
    async importName() {},
    async setPrimary() {
      return true
    },
    async writeAuditEvent(event) {
      audits.push(event)
    },
    async mintNonce() {
      return { nonce: "n", expires_at: "2026-06-01T00:05:00.000Z", message: "m" }
    },
    async consumeNonce() {
      return { ok: true as const, message: "m", wallet_address: null }
    },
    async withTransaction<T>(fn: (spine: SpinePort) => Promise<T>): Promise<T> {
      return fn(m)
    },
  }
  return m
}

let baseUrl = ""
let mockSpine: MockSpine
const DISCORD_ID = "987654321098765432"

describe("Discord login routes", () => {
  beforeAll(async () => {
    app.listen({ port: 0, hostname: "127.0.0.1", banner: false })
    const port = app.server?.port
    if (!port) throw new Error("test boot: app.server.port unavailable")
    baseUrl = `http://127.0.0.1:${port}`
  })

  beforeEach(() => {
    mockSpine = buildMockSpine()
    __setSpineForTest(mockSpine)
    __resetConsumedStateNoncesForTest()
    __resetDiscordLoginOAuthClientForTest()
    process.env.DISCORD_CLIENT_ID = "client-id"
    process.env.DISCORD_CLIENT_SECRET = "client-secret"
    process.env.DISCORD_LOGIN_REDIRECT_ALLOWLIST = REDIRECT
    __setDiscordLoginOAuthClientForTest({
      authorizeUrl({ redirectUri, state }) {
        return `https://discord.test/authorize?redirect=${encodeURIComponent(redirectUri ?? "")}&state=${state}`
      },
      async exchangeCode() {
        return DISCORD_ID
      },
    })
  })

  afterAll(async () => {
    __resetSpineForTest()
    delete process.env.DISCORD_CLIENT_ID
    delete process.env.DISCORD_CLIENT_SECRET
    delete process.env.DISCORD_LOGIN_REDIRECT_ALLOWLIST
    await app.stop()
  })

  it("GET authorize with allowed redirect_uri → 302 to Discord", async () => {
    const u = new URL(`${baseUrl}/v1/auth/discord/authorize`)
    u.searchParams.set("redirect_uri", REDIRECT)
    u.searchParams.set("state", CSRF)
    const res = await fetch(u.toString(), { redirect: "manual" })
    expect(res.status).toBe(302)
    const loc = res.headers.get("location") ?? ""
    expect(loc).toContain("discord.test")
    expect(loc).toContain(encodeURIComponent(REDIRECT))
  })

  it("GET authorize with disallowed redirect_uri → 400", async () => {
    const u = new URL(`${baseUrl}/v1/auth/discord/authorize`)
    u.searchParams.set("redirect_uri", "https://evil.example/cb")
    u.searchParams.set("state", CSRF)
    const res = await fetch(u.toString(), { redirect: "manual" })
    expect(res.status).toBe(400)
  })

  it("GET authorize without Discord env → 503", async () => {
    delete process.env.DISCORD_CLIENT_ID
    const u = new URL(`${baseUrl}/v1/auth/discord/authorize`)
    u.searchParams.set("redirect_uri", REDIRECT)
    u.searchParams.set("state", CSRF)
    const res = await fetch(u.toString(), { redirect: "manual" })
    expect(res.status).toBe(503)
  })

  it("POST exchange happy path → session JWT + linked discord", async () => {
    mockSpine.resolveByAccountByProvider = { discord: null }
    const res = await fetch(`${baseUrl}/v1/auth/discord/exchange`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "auth-code", redirect_uri: REDIRECT }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.user_id).toBe("00000000-0000-4000-8000-000000000001")
    expect(typeof (body.session as { token?: string })?.token).toBe("string")
    expect(typeof (body.session as { expires_at?: number })?.expires_at).toBe("number")
    expect((body.discord as { id?: string })?.id).toBe(DISCORD_ID)
    expect(mockSpine.linkAccountCalls).toHaveLength(1)
    expect(mockSpine.audits.some((a) => a.event_type === "auth_verified")).toBe(true)
  })

  it("POST exchange existing discord user → no mint", async () => {
    const existing = "11111111-1111-4111-8111-111111111111"
    mockSpine.resolveByAccountByProvider = { discord: existing }
    const res = await fetch(`${baseUrl}/v1/auth/discord/exchange`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "auth-code", redirect_uri: REDIRECT }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.user_id).toBe(existing)
    expect(mockSpine.mintUserCalls).toBe(0)
    expect(mockSpine.linkAccountCalls).toHaveLength(0)
  })

  it("POST exchange oauth failure → 502", async () => {
    __setDiscordLoginOAuthClientForTest({
      authorizeUrl() {
        return "https://discord.test"
      },
      async exchangeCode() {
        throw new DiscordOAuthExchangeError()
      },
    })
    const res = await fetch(`${baseUrl}/v1/auth/discord/exchange`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "bad", redirect_uri: REDIRECT }),
    })
    expect(res.status).toBe(502)
  })

  it("POST exchange with state replay → second request 401", async () => {
    mockSpine.resolveByAccountByProvider = { discord: null }
    const { state } = mintLoginOAuthState(REDIRECT, CSRF)
    const payload = { code: "auth-code", redirect_uri: REDIRECT, state }
    const first = await fetch(`${baseUrl}/v1/auth/discord/exchange`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    })
    expect(first.status).toBe(200)
    const second = await fetch(`${baseUrl}/v1/auth/discord/exchange`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    })
    expect(second.status).toBe(401)
  })
})
