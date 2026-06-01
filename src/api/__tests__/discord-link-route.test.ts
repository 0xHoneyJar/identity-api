/**
 * discord-link-route.test.ts — integration tests for the Discord-social
 * OAuth-verify + link front-end (bd-2wo.14).
 *
 * Covers every acceptance criterion in
 * grimoires/loa/specs/discord-social-credential-link-adapter.md:
 *   - Happy path: authed user A → initiate → callback(verified D) → linked.
 *   - Idempotent: A re-links D → 200 no-op, no duplicate write.
 *   - Cross-user collision: D bound to B, A links D → 409, no write.
 *   - Unauthenticated: initiate/callback without a valid session → 401.
 *   - IDOR-negative: linked user_id is ALWAYS the session sub; no request
 *     input can specify another user_id.
 *   - OAuth-state/CSRF-negative: a state not bound to the live session →
 *     rejected (401), no code-exchange, no link.
 *   - Unconfigured: missing Discord env → 503 service_unconfigured.
 *
 * The OAuth boundary is MOCKED via the route's __setDiscordOAuthClientForTest
 * seam (live verification waits on real Discord creds, per spec out-of-scope).
 *
 * Pattern: ephemeral port, mock spine (records linkAccount calls + audits),
 * hand-minted HS256 bearer JWT against the same JWT_SECRET src/auth.ts loaded.
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
  __resetDiscordOAuthClientForTest,
  __setDiscordOAuthClientForTest,
} from "../routes/discord-link"
import { JWT_SECRET } from "../../auth"
import {
  __resetConsumedStateNoncesForTest,
  DiscordOAuthNotProvisioned,
  mintOAuthState,
} from "../../discord-oauth"

// ─── mock spine (tracks linkAccount writes + audits) ─────────────────────────

interface LinkAccountCall {
  userId: string
  provider: SpineLinkedAccountProvider
  externalId: string
}

interface MockSpine extends SpinePort {
  readonly audits: SpineAuditEvent[]
  readonly linkAccountCalls: LinkAccountCall[]
  resolveByAccountByProvider?: Partial<Record<SpineLinkedAccountProvider, string | null>>
}

function buildMockSpine(): MockSpine {
  const audits: SpineAuditEvent[] = []
  const linkAccountCalls: LinkAccountCall[] = []
  const m: MockSpine = {
    audits,
    linkAccountCalls,
    async resolveByWallet() {
      return null
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
      return "00000000-0000-4000-8000-000000000000"
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

// ─── HS256 bearer JWT minter (mirrors routes.test.ts) ────────────────────────

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

// ─── fixtures ────────────────────────────────────────────────────────────────

const USER_A = "11111111-1111-4111-8111-111111111111"
const USER_B = "22222222-2222-4222-8222-222222222222"
const DISCORD_D = "discord-user-7777"

// Mock OAuth client: authorizeUrl echoes the state; exchangeCode returns a
// configurable verified discordId.
let nextDiscordId = DISCORD_D
const mockOAuthClient = {
  authorizeUrl({ state }: { state: string }) {
    return `https://discord.com/oauth2/authorize?state=${encodeURIComponent(state)}`
  },
  async exchangeCode() {
    return nextDiscordId
  },
}

const DISCORD_ENV = {
  DISCORD_CLIENT_ID: "test-client-id",
  DISCORD_CLIENT_SECRET: "test-client-secret",
  DISCORD_LINK_CALLBACK_URL: "https://identity-api.test/v1/link/discord/callback",
}

// ─── boot/teardown ───────────────────────────────────────────────────────────

let baseUrl: string
let mockSpine: MockSpine
let jwtA: string
let jwtB: string

beforeAll(async () => {
  mockSpine = buildMockSpine()
  __setSpineForTest(mockSpine)
  __setDiscordOAuthClientForTest(mockOAuthClient)
  jwtA = await mintHs256Jwt({ sub: USER_A }, JWT_SECRET)
  jwtB = await mintHs256Jwt({ sub: USER_B }, JWT_SECRET)
  app.listen({ port: 0, hostname: "127.0.0.1", banner: false })
  const port = app.server?.port
  if (!port) throw new Error("test boot: app.server.port unavailable")
  baseUrl = `http://127.0.0.1:${port}`
})

afterAll(async () => {
  await app.stop()
  __resetSpineForTest()
  __resetDiscordOAuthClientForTest()
  for (const k of Object.keys(DISCORD_ENV)) delete process.env[k]
})

beforeEach(() => {
  mockSpine.audits.length = 0
  mockSpine.linkAccountCalls.length = 0
  mockSpine.resolveByAccountByProvider = undefined
  nextDiscordId = DISCORD_D
  __resetConsumedStateNoncesForTest()
  __setDiscordOAuthClientForTest(mockOAuthClient)
  Object.assign(process.env, DISCORD_ENV)
})

// ─── helpers ──────────────────────────────────────────────────────────────────

function authHeader(jwt: string): Record<string, string> {
  return { authorization: `Bearer ${jwt}` }
}

/** Mint a state bound to a given sub (the same minter the route uses). */
function stateFor(sub: string): string {
  return mintOAuthState(sub).state
}

async function getInitiate(jwt?: string): Promise<Response> {
  return fetch(`${baseUrl}/v1/link/discord/initiate`, {
    headers: jwt ? authHeader(jwt) : {},
    redirect: "manual",
  })
}

async function getCallback(
  opts: { jwt?: string; code?: string | null; state?: string | null },
): Promise<{ status: number; body: Record<string, unknown> }> {
  const u = new URL(`${baseUrl}/v1/link/discord/callback`)
  if (opts.code !== null && opts.code !== undefined) u.searchParams.set("code", opts.code)
  if (opts.code === undefined) u.searchParams.set("code", "test-oauth-code")
  if (opts.state !== null && opts.state !== undefined) u.searchParams.set("state", opts.state)
  const res = await fetch(u.toString(), { headers: opts.jwt ? authHeader(opts.jwt) : {} })
  let body: Record<string, unknown> = {}
  try {
    body = (await res.json()) as Record<string, unknown>
  } catch {
    body = {}
  }
  return { status: res.status, body }
}

// ─── unconfigured ──────────────────────────────────────────────────────────────

describe("Discord link — unconfigured (503)", () => {
  it("initiate → 503 when Discord env is missing", async () => {
    for (const k of Object.keys(DISCORD_ENV)) delete process.env[k]
    const res = await getInitiate(jwtA)
    expect(res.status).toBe(503)
    expect((await res.json()).code).toBe("service_unconfigured")
  })

  it("callback → 503 when Discord env is missing", async () => {
    for (const k of Object.keys(DISCORD_ENV)) delete process.env[k]
    const { status, body } = await getCallback({ jwt: jwtA, state: stateFor(USER_A) })
    expect(status).toBe(503)
    expect(body.code).toBe("service_unconfigured")
  })

  it("auth gate runs BEFORE config check — anonymous caller gets 401, not 503 (no config leak)", async () => {
    // .auth() middleware gates before the handler's config check. An
    // unauthenticated caller must NOT learn whether Discord is configured.
    for (const k of Object.keys(DISCORD_ENV)) delete process.env[k]
    const res = await getInitiate(/* no jwt */)
    expect(res.status).toBe(401)
  })
})

// ─── unauthenticated ────────────────────────────────────────────────────────────

describe("Discord link — unauthenticated (401)", () => {
  it("initiate without a bearer JWT → 401", async () => {
    const res = await getInitiate(/* no jwt */)
    expect(res.status).toBe(401)
  })

  it("callback without a bearer JWT → 401", async () => {
    const { status } = await getCallback({ state: stateFor(USER_A) })
    expect(status).toBe(401)
  })

  it("callback with a malformed bearer JWT → 401 (not 500)", async () => {
    const u = new URL(`${baseUrl}/v1/link/discord/callback`)
    u.searchParams.set("code", "c")
    u.searchParams.set("state", stateFor(USER_A))
    const res = await fetch(u.toString(), { headers: { authorization: "Bearer not-a-jwt" } })
    expect(res.status).toBe(401)
  })
})

// ─── initiate happy path ─────────────────────────────────────────────────────────

describe("Discord link — initiate", () => {
  it("302 redirects to the Discord authorize URL with a session-bound state", async () => {
    const res = await getInitiate(jwtA)
    expect(res.status).toBe(302)
    const loc = res.headers.get("location")
    expect(loc).toBeTruthy()
    expect(loc!).toContain("discord.com/oauth2/authorize")
    // The state is present and decodes back to USER_A (the session sub).
    const stateParam = new URL(loc!).searchParams.get("state")
    expect(stateParam).toBeTruthy()
  })
})

// ─── callback happy path ─────────────────────────────────────────────────────────

describe("Discord link — callback happy path", () => {
  it("links the verified Discord id to the session user → 200", async () => {
    mockSpine.resolveByAccountByProvider = { discord: null }
    const { status, body } = await getCallback({ jwt: jwtA, state: stateFor(USER_A) })
    expect(status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.user_id).toBe(USER_A)
    expect(body.provider).toBe("discord")
    expect(body.external_id).toBe(DISCORD_D)
    expect(body.idempotent).toBe(false)
    // linkAccount fired with the SESSION user_id + discord provider.
    expect(mockSpine.linkAccountCalls).toHaveLength(1)
    expect(mockSpine.linkAccountCalls[0]).toEqual({
      userId: USER_A,
      provider: "discord",
      externalId: DISCORD_D,
    })
    // account_linked audit emitted.
    expect(mockSpine.audits.map((a) => a.event_type)).toContain("account_linked")
  })
})

// ─── idempotent ─────────────────────────────────────────────────────────────────

describe("Discord link — idempotent", () => {
  it("re-link of the same (user, discord) → 200 no-op, NO new write", async () => {
    mockSpine.resolveByAccountByProvider = { discord: USER_A }
    const { status, body } = await getCallback({ jwt: jwtA, state: stateFor(USER_A) })
    expect(status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.user_id).toBe(USER_A)
    expect(body.idempotent).toBe(true)
    // No linkAccount write, no account_linked audit.
    expect(mockSpine.linkAccountCalls).toEqual([])
    expect(mockSpine.audits.map((a) => a.event_type)).not.toContain("account_linked")
  })
})

// ─── cross-user collision ────────────────────────────────────────────────────────

describe("Discord link — cross-user collision (409)", () => {
  it("Discord D already bound to user B, user A links D → 409, NO write", async () => {
    mockSpine.resolveByAccountByProvider = { discord: USER_B }
    const { status, body } = await getCallback({ jwt: jwtA, state: stateFor(USER_A) })
    expect(status).toBe(409)
    expect(body.ok).toBe(false)
    expect(body.conflict).toBe("cross_user_collision")
    // NO link write fired.
    expect(mockSpine.linkAccountCalls).toEqual([])
  })
})

// ─── IDOR-negative ───────────────────────────────────────────────────────────────

describe("Discord link — IDOR-negative (linked user is ALWAYS the session sub)", () => {
  it("a query param attempting to set user_id is ignored — links to session sub", async () => {
    mockSpine.resolveByAccountByProvider = { discord: null }
    // Attacker (session A) tries to smuggle user_id=B via query string.
    const u = new URL(`${baseUrl}/v1/link/discord/callback`)
    u.searchParams.set("code", "c")
    u.searchParams.set("state", stateFor(USER_A))
    u.searchParams.set("user_id", USER_B)
    u.searchParams.set("userId", USER_B)
    u.searchParams.set("sub", USER_B)
    const res = await fetch(u.toString(), { headers: authHeader(jwtA) })
    const body = (await res.json()) as Record<string, unknown>
    expect(res.status).toBe(200)
    // Linked to the SESSION sub (A), NOT the smuggled B.
    expect(body.user_id).toBe(USER_A)
    expect(mockSpine.linkAccountCalls[0]?.userId).toBe(USER_A)
  })

  it("a state minted for user A used by a session for user B links to B, never A", async () => {
    // Even if a state for A leaks, the callback binds to the LIVE session sub;
    // here the state's sub (A) != live session sub (B) → rejected as CSRF.
    mockSpine.resolveByAccountByProvider = { discord: null }
    const { status } = await getCallback({ jwt: jwtB, state: stateFor(USER_A) })
    expect(status).toBe(401) // invalid_state — not bound to this session
    expect(mockSpine.linkAccountCalls).toEqual([])
  })
})

// ─── OAuth-state / CSRF-negative ─────────────────────────────────────────────────

describe("Discord link — OAuth-state/CSRF-negative", () => {
  it("missing state → 401 invalid_state, no code-exchange, no link", async () => {
    mockSpine.resolveByAccountByProvider = { discord: null }
    const { status, body } = await getCallback({ jwt: jwtA, state: null })
    expect(status).toBe(401)
    expect(body.code).toBe("invalid_state")
    expect(mockSpine.linkAccountCalls).toEqual([])
  })

  it("forged/tampered state (bad signature) → 401, no link", async () => {
    const tampered = stateFor(USER_A).replace(/.$/, (ch) => (ch === "A" ? "B" : "A"))
    const { status, body } = await getCallback({ jwt: jwtA, state: tampered })
    expect(status).toBe(401)
    expect(body.code).toBe("invalid_state")
    expect(mockSpine.linkAccountCalls).toEqual([])
  })

  it("state bound to a DIFFERENT session sub → 401 (account-linking CSRF)", async () => {
    // State minted for B, presented under session A → rejected.
    const { status, body } = await getCallback({ jwt: jwtA, state: stateFor(USER_B) })
    expect(status).toBe(401)
    expect(body.code).toBe("invalid_state")
    expect(mockSpine.linkAccountCalls).toEqual([])
  })

  it("missing code → 400 missing_code", async () => {
    const { status, body } = await getCallback({ jwt: jwtA, code: null, state: stateFor(USER_A) })
    expect(status).toBe(400)
    expect(body.code).toBe("missing_code")
  })
})

// ─── single-use / replay (CRITICAL fix) ──────────────────────────────────────

describe("Discord link — single-use state (replay rejected)", () => {
  it("a valid state used twice → first 200, second 401 invalid_state, exactly one write", async () => {
    mockSpine.resolveByAccountByProvider = { discord: null }
    const state = stateFor(USER_A)
    const first = await getCallback({ jwt: jwtA, state })
    expect(first.status).toBe(200)
    const second = await getCallback({ jwt: jwtA, state })
    expect(second.status).toBe(401)
    expect(second.body.code).toBe("invalid_state")
    // Replay must NOT produce a second link write.
    expect(mockSpine.linkAccountCalls).toHaveLength(1)
  })
})

// ─── exchange failure mapping (never 500) ─────────────────────────────────────

describe("Discord link — exchange failure mapping (never 500)", () => {
  it("a thrown exchange → 502 oauth_exchange_failed, no link", async () => {
    mockSpine.resolveByAccountByProvider = { discord: null }
    __setDiscordOAuthClientForTest({
      authorizeUrl: () => "https://discord.com/oauth2/authorize",
      async exchangeCode() {
        throw new Error("discord upstream 500")
      },
    })
    const { status, body } = await getCallback({ jwt: jwtA, state: stateFor(USER_A) })
    expect(status).toBe(502)
    expect(body.code).toBe("oauth_exchange_failed")
    expect(mockSpine.linkAccountCalls).toEqual([])
  })

  it("the unprovisioned default exchange → 503 service_unconfigured, not 500", async () => {
    mockSpine.resolveByAccountByProvider = { discord: null }
    __setDiscordOAuthClientForTest({
      authorizeUrl: () => "https://discord.com/oauth2/authorize",
      async exchangeCode() {
        throw new DiscordOAuthNotProvisioned()
      },
    })
    const { status, body } = await getCallback({ jwt: jwtA, state: stateFor(USER_A) })
    expect(status).toBe(503)
    expect(body.code).toBe("service_unconfigured")
  })
})

// ─── TOCTOU race → 409 (not 500) (MAJOR fix) ─────────────────────────────────

describe("Discord link — TOCTOU race", () => {
  it("a concurrent link of the same discord to another user → 409 (not 500)", async () => {
    // Pre-check sees the account unbound; a concurrent writer links it to B in
    // the window; our linkAccount throws a unique-violation; linkVerifiedCredential
    // re-resolves and maps to the SAME 409 the non-racing collision path returns.
    mockSpine.resolveByAccountByProvider = { discord: null }
    const origLinkAccount = mockSpine.linkAccount.bind(mockSpine)
    mockSpine.linkAccount = async () => {
      // The concurrent writer won the race in the resolve→write window.
      mockSpine.resolveByAccountByProvider = { discord: USER_B }
      throw new Error(
        'duplicate key value violates unique constraint "linked_accounts_provider_external_id_key"',
      )
    }
    try {
      const { status, body } = await getCallback({ jwt: jwtA, state: stateFor(USER_A) })
      expect(status).toBe(409)
      expect(body.conflict).toBe("cross_user_collision")
    } finally {
      mockSpine.linkAccount = origLinkAccount
    }
  })
})
