/**
 * identity-resolve-goal-validation.test.ts — the consolidated G-5 acceptance
 * suite for the `POST /v1/identity/resolve` merge facade (Task 1.E2E · bd-2wo.38.4).
 *
 * This file is the closing-report EVIDENCE for PRD goal G-5 (profile serving —
 * read-time compose, no-embed) as delivered by the batch merge facade. It walks
 * the full happy path end-to-end through the booted app: one POST with four
 * wallets exercising all four display tiers + the degradation path + the
 * score-vs-identity boundary.
 *
 * It is NOT a re-implementation of the focused suites:
 *   ↪ Cross-link: packages/engine/src/__tests__/merge-identity.test.ts
 *       (pure priority algorithm — every tier, the score-real-name gate, discord shape)
 *   ↪ Cross-link: src/api/__tests__/identity-resolve-route.test.ts
 *       (HTTP surface — batch bounds, spine miss/throw, keyed-map lookup, dedupe)
 *   ↪ Cross-link: packages/adapters/src/__tests__/http-score-adapter.test.ts
 *       (resolveIdentity classification matrix — 200/401/404/429/5xx/parse/timeout)
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import type { ConsumeNonceResult, SpineIdentityShape, SpinePort } from "@freeside-auth/ports"
import type { ResolvedIdentity } from "@freeside-auth/protocol/api/federation/score"
import app from "../index"
import { JWT_SECRET } from "../../auth"
import { __resetSpineForTest, __setSpineForTest } from "../spine"
import { __resetScoreForTest, __setScoreForTest } from "../score"
import { MockScorePort } from "../../../packages/adapters/src/__tests__/mock-score"

// HS256 JWT minter — the facade is .auth()-gated (OQ-3); G-5 evidence POSTs as
// an authenticated caller. Mirrors routes.test.ts:113 + identity-resolve-route.test.ts.
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

// ─── G-5 fixtures: four wallets, four tiers ─────────────────────────────────

const W_NYM = "0xa100000000000000000000000000000000000001" // (a) spine user + world_nym
const W_DISCORD = "0xb200000000000000000000000000000000000002" // (b) discord linked, no nym
const W_UNLINKED = "0xc300000000000000000000000000000000000003" // (c) unresolved, no score name
const W_SCORE = "0xd400000000000000000000000000000000000004" // (d) score onchain name only
const U_NYM = "11111111-1111-4111-8111-111111111111"
const U_DISCORD = "22222222-2222-4222-8222-222222222222"
const U_SCORE = "44444444-4444-4444-8444-444444444444"

function identity(userId: string, wallet: string, over: Partial<SpineIdentityShape> = {}): SpineIdentityShape {
  return {
    user_id: userId,
    primary_wallet: wallet,
    created_at: "2026-06-01T00:00:00.000Z",
    updated_at: "2026-06-01T00:00:00.000Z",
    wallets: [{ wallet_address: wallet, chain_ids: ["1"], is_primary: true, verified_at: "x", unlinked_at: null }],
    linked_accounts: [],
    world_identities: [],
    world_names: [],
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

interface MockSpine extends SpinePort {
  __link(wallet: string, userId: string, identity: SpineIdentityShape): void
  __reset(): void
}

function buildMockSpine(): MockSpine {
  const walletToUser = new Map<string, string>()
  const userToIdentity = new Map<string, SpineIdentityShape>()
  const m: MockSpine = {
    __link(wallet, userId, id) {
      walletToUser.set(wallet.toLowerCase(), userId)
      userToIdentity.set(userId, id)
    },
    __reset() {
      walletToUser.clear()
      userToIdentity.clear()
    },
    async resolveByWallet(address) {
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
    // A2 (#11 Phase 1): SpinePort gained the world-name primitives; stubs.
    async claimGeneratedName() {
      return "MIBERA-000001";
    },
    async importName() {},
    async setPrimary() {
      return true
    },
    async writeAuditEvent() {},
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

let baseUrl: string
let spine: MockSpine
let score: MockScorePort

beforeAll(async () => {
  spine = buildMockSpine()
  score = new MockScorePort()
  __setSpineForTest(spine)
  __setScoreForTest(score)
  authToken = await mintHs256Jwt(
    { sub: "00000000-0000-4000-8000-0000000000bb", exp: 4102444800 },
    JWT_SECRET,
  )
  app.listen({ port: 0, hostname: "127.0.0.1", banner: false })
  const port = app.server?.port
  if (!port) throw new Error("goal-validation boot: app.server.port unavailable")
  baseUrl = `http://127.0.0.1:${port}`
})

afterAll(async () => {
  await app.stop()
  __resetSpineForTest()
  __resetScoreForTest()
})

beforeEach(() => {
  spine.__reset()
  score.__reset()
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

function seedFourTiers(): void {
  spine.__link(
    W_NYM,
    U_NYM,
    identity(U_NYM, W_NYM, { world_identities: [{ world_slug: "mibera", nym: "honeybadger", joined_at: "x" }] }),
  )
  spine.__link(
    W_DISCORD,
    U_DISCORD,
    identity(U_DISCORD, W_DISCORD, {
      linked_accounts: [{ provider: "discord", external_id: "999000111", verified_at: "x", unlinked_at: null }],
    }),
  )
  spine.__link(W_SCORE, U_SCORE, identity(U_SCORE, W_SCORE))
  // score gives W_NYM a beraname too (nym must still win — boundary), and W_SCORE a real name.
  score.__setResolvedIdentity(W_NYM, scored(W_NYM, { beraname: "hb.bera", display_name: "hb.bera" }))
  score.__setResolvedIdentity(W_SCORE, scored(W_SCORE, { beraname: "dee.bera", display_name: "dee.bera" }))
}

describe("G-5 acceptance — POST /v1/identity/resolve merge facade (Task 1.E2E)", () => {
  it("one pre-merged identity per wallet; priority applied ONCE; all four tiers correct", async () => {
    seedFourTiers()
    const { status, results } = await resolve({
      wallets: [W_NYM, W_DISCORD, W_UNLINKED, W_SCORE],
      world_slug: "mibera",
    })
    expect(status).toBe(200)
    expect(results).toHaveLength(4)

    const byWallet = Object.fromEntries(results.map((r) => [r.wallet, r]))

    // (a) world_nym tier — wins over the score beraname (priority applied once).
    expect(byWallet[W_NYM]!.display_source).toBe("world_nym")
    expect(byWallet[W_NYM]!.display_name).toBe("honeybadger")

    // (b) discord tier — id-only label, { id, linked } shape (NO username).
    expect(byWallet[W_DISCORD]!.display_source).toBe("discord")
    expect(byWallet[W_DISCORD]!.display_name).toBe("999000111")
    expect(byWallet[W_DISCORD]!.discord).toEqual({ id: "999000111", linked: true })

    // (c) address tier — unresolved wallet, no score name → user_id null.
    expect(byWallet[W_UNLINKED]!.display_source).toBe("address")
    expect(byWallet[W_UNLINKED]!.user_id).toBeNull()
    expect(byWallet[W_UNLINKED]!.display_name).toBe(W_UNLINKED)

    // (d) score tier — real onchain name only.
    expect(byWallet[W_SCORE]!.display_source).toBe("score")
    expect(byWallet[W_SCORE]!.display_name).toBe("dee.bera")
  })

  it("score-vs-identity boundary — is_primary_wallet from spine; beraname/ens/twitter raw passthrough", async () => {
    seedFourTiers()
    const { results } = await resolve({ wallets: [W_NYM], world_slug: "mibera" })
    const a = results[0]!
    // Grouping authority is the spine, not score.
    expect(a.is_primary_wallet).toBe(true)
    // Score's beraname is echoed RAW but did NOT drive display (nym won).
    expect(a.beraname).toBe("hb.bera")
    expect(a.display_source).toBe("world_nym")
    // reachable is the v1 tri-state default.
    expect(a.reachable).toBe("unknown")
  })

  it("graceful degradation (FR-P2/NFR-2) — score outage → all degraded, 200 OK, spine tiers still resolve", async () => {
    seedFourTiers()
    score.__setResolveIdentityFailure({ kind: "timeout", message: "score per-source timeout" })
    const { status, results } = await resolve({
      wallets: [W_NYM, W_SCORE, W_UNLINKED],
      world_slug: "mibera",
    })
    expect(status).toBe(200) // never a 5xx on a downstream miss
    expect(results.every((r) => r.degraded)).toBe(true)
    const byWallet = Object.fromEntries(results.map((r) => [r.wallet, r]))
    // Spine-derived tier survives the score outage.
    expect(byWallet[W_NYM]!.display_source).toBe("world_nym")
    // Score-only wallet falls back to address when enrichment is unavailable.
    expect(byWallet[W_SCORE]!.display_source).toBe("address")
    expect(byWallet[W_SCORE]!.beraname).toBeNull()
  })
})
