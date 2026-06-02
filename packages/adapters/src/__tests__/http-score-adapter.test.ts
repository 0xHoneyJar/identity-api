/**
 * http-score-adapter.test.ts — adapter-specific shape tests (T2.1).
 */

import { describe, expect, it } from "bun:test"
import {
  HttpScoreAdapter,
  DEFAULT_SCORE_BASE_URL,
  SCORE_API_KEY_HEADER,
} from "../http-score-adapter"

// Realistic-shaped WalletProfile body. score-api returns a full row; the
// fixture below covers every required field per ScoreGetWalletRespSchema.
function makeWalletProfile(wallet: string) {
  return {
    wallet,
    og_score: 70,
    nft_score: 55,
    onchain_score: 80,
    og_score_raw: 65,
    nft_score_raw: 50,
    onchain_score_raw: 78,
    first_activity: "2024-01-01T00:00:00Z",
    last_activity: "2026-05-20T00:00:00Z",
    og_factor_count: 4,
    nft_factor_count: 2,
    onchain_factor_count: 8,
    trust_filter: 0.95,
    trust_coefficient: 1,
    trust_classification: "normal" as const,
    flagged_for_review: false,
    og_breadth: 0.6,
    nft_breadth: 0.5,
    onchain_breadth: 0.7,
    og_breadth_multiplier: 0.88,
    nft_breadth_multiplier: 0.85,
    onchain_breadth_multiplier: 0.91,
    og_rank: 100,
    nft_rank: 200,
    onchain_rank: 50,
    overall_rank: 75,
    total_ranked_wallets: 5000,
    og_percentile: 98,
    nft_percentile: 96,
    onchain_percentile: 99,
    overall_percentile: 98.5,
    combined_score: 220,
    crowd_tier: "eternal" as const,
    crowd_tier_display: "Eternal",
    elite_tier: null,
    elite_tier_display: null,
    points_to_next_crowd_tier: 0,
    next_crowd_tier_display: null,
    badge_count: 12,
    pioneer_badge_count: 3,
  }
}

describe("HttpScoreAdapter (T2.1)", () => {
  it("default baseUrl per registry.yaml", () => {
    const adapter = new HttpScoreAdapter()
    expect(adapter.baseUrl).toBe(DEFAULT_SCORE_BASE_URL)
    expect(DEFAULT_SCORE_BASE_URL).toBe("https://score.0xhoneyjar.xyz")
  })

  it("apiKey is injected as X-API-Key header", async () => {
    let observed: RequestInit | undefined
    const stub = async (_in: unknown, init?: RequestInit) => {
      observed = init
      return new Response(
        JSON.stringify(makeWalletProfile("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")),
        { status: 200 },
      )
    }
    const adapter = new HttpScoreAdapter({ apiKey: "test-key-123" })
    await adapter.getScore(
      { walletAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
      { fetchImpl: stub },
    )
    const headers = observed?.headers as Record<string, string>
    expect(headers[SCORE_API_KEY_HEADER]).toBe("test-key-123")
  })

  it("absent apiKey → no X-API-Key header (upstream will return 401 → unauthorized)", async () => {
    let observed: RequestInit | undefined
    const stub = async (_in: unknown, init?: RequestInit) => {
      observed = init
      return new Response("Unauthorized", { status: 401 })
    }
    const adapter = new HttpScoreAdapter()
    const res = await adapter.getScore(
      { walletAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
      { fetchImpl: stub },
    )
    const headers = observed?.headers as Record<string, string>
    expect(headers[SCORE_API_KEY_HEADER]).toBeUndefined()
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason.kind).toBe("unauthorized")
  })

  it("getScore calls GET /v1/wallets/:address with the wallet param URL-encoded", async () => {
    let observedUrl = ""
    const stub = async (input: string | URL | Request) => {
      observedUrl = typeof input === "string" ? input : input.toString()
      return new Response(
        JSON.stringify(makeWalletProfile("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")),
        { status: 200 },
      )
    }
    const adapter = new HttpScoreAdapter({ baseUrl: "https://test.local/" })
    await adapter.getScore(
      { walletAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
      { fetchImpl: stub },
    )
    expect(observedUrl).toBe(
      "https://test.local/v1/wallets/0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    )
  })

  it("happy path: returns parsed WalletProfile", async () => {
    const fixture = makeWalletProfile("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
    const stub = async () => new Response(JSON.stringify(fixture), { status: 200 })
    const adapter = new HttpScoreAdapter({ apiKey: "k" })
    const res = await adapter.getScore(
      { walletAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
      { fetchImpl: stub },
    )
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.data.wallet).toBe(fixture.wallet)
      expect(res.data.crowd_tier).toBe("eternal")
    }
  })

  it("schema is loose() — forward-compatible unknown fields pass", async () => {
    const fixture = {
      ...makeWalletProfile("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
      brand_new_field: "added-by-score-api-tomorrow",
    }
    const stub = async () => new Response(JSON.stringify(fixture), { status: 200 })
    const adapter = new HttpScoreAdapter({ apiKey: "k" })
    const res = await adapter.getScore(
      { walletAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
      { fetchImpl: stub },
    )
    expect(res.ok).toBe(true)
  })

  it("missing required field → parse_error (backwards-incompat detection)", async () => {
    const fixture = makeWalletProfile("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa") as Record<
      string,
      unknown
    >
    delete fixture.crowd_tier
    const stub = async () => new Response(JSON.stringify(fixture), { status: 200 })
    const adapter = new HttpScoreAdapter({ apiKey: "k" })
    const res = await adapter.getScore(
      { walletAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
      { fetchImpl: stub },
    )
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason.kind).toBe("parse_error")
  })

  it("404 → not_found (fresh wallet, no score yet)", async () => {
    const stub = async () => new Response("Not Found", { status: 404 })
    const adapter = new HttpScoreAdapter({ apiKey: "k" })
    const res = await adapter.getScore(
      { walletAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
      { fetchImpl: stub },
    )
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason.kind).toBe("not_found")
  })
})

// ─── resolveIdentity (bd-2wo.38.1) ──────────────────────────────────────────

const WA = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
const WB = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"

function makeResolved(wallet: string, over: Record<string, unknown> = {}) {
  return {
    wallet,
    ens_name: null,
    beraname: "honeybadger.bera",
    basename: null,
    twitter_handle: null,
    display_name: "honeybadger.bera",
    pfp_url: null,
    twitter_source: null,
    ...over,
  }
}

function makeResolveResp(...wallets: string[]) {
  const identities: Record<string, unknown> = {}
  for (const w of wallets) identities[w.toLowerCase()] = makeResolved(w.toLowerCase())
  return { identities }
}

describe("HttpScoreAdapter.resolveIdentity (bd-2wo.38.1)", () => {
  it("POSTs /v1/identity/resolve with { wallets } body + X-API-Key (NO world_slug)", async () => {
    let observedUrl = ""
    let observed: RequestInit | undefined
    const stub = async (input: string | URL | Request, init?: RequestInit) => {
      observedUrl = typeof input === "string" ? input : input.toString()
      observed = init
      return new Response(JSON.stringify(makeResolveResp(WA, WB)), { status: 200 })
    }
    const adapter = new HttpScoreAdapter({ baseUrl: "https://test.local/", apiKey: "k-1" })
    await adapter.resolveIdentity({ wallets: [WA, WB] }, { fetchImpl: stub })
    expect(observedUrl).toBe("https://test.local/v1/identity/resolve")
    expect(observed?.method).toBe("POST")
    const headers = observed?.headers as Record<string, string>
    expect(headers[SCORE_API_KEY_HEADER]).toBe("k-1")
    expect(headers["content-type"]).toBe("application/json")
    const body = JSON.parse(observed?.body as string)
    expect(body).toEqual({ wallets: [WA, WB] })
    expect(body.world_slug).toBeUndefined()
  })

  it("happy path: returns the keyed-map { identities }", async () => {
    const stub = async () => new Response(JSON.stringify(makeResolveResp(WA, WB)), { status: 200 })
    const adapter = new HttpScoreAdapter({ apiKey: "k" })
    const res = await adapter.resolveIdentity({ wallets: [WA, WB] }, { fetchImpl: stub })
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.data.identities[WA.toLowerCase()]?.beraname).toBe("honeybadger.bera")
      expect(res.data.identities[WB.toLowerCase()]?.display_name).toBe("honeybadger.bera")
    }
  })

  it("schema is loose() — unknown top-level + per-identity fields pass", async () => {
    const resp = {
      identities: { [WA.toLowerCase()]: makeResolved(WA.toLowerCase(), { new_field: "x" }) },
      cursor: "next-page",
    }
    const stub = async () => new Response(JSON.stringify(resp), { status: 200 })
    const adapter = new HttpScoreAdapter({ apiKey: "k" })
    const res = await adapter.resolveIdentity({ wallets: [WA] }, { fetchImpl: stub })
    expect(res.ok).toBe(true)
  })

  it("missing required field (display_name) → parse_error", async () => {
    const bad = makeResolved(WA.toLowerCase()) as Record<string, unknown>
    delete bad.display_name
    const resp = { identities: { [WA.toLowerCase()]: bad } }
    const stub = async () => new Response(JSON.stringify(resp), { status: 200 })
    const adapter = new HttpScoreAdapter({ apiKey: "k" })
    const res = await adapter.resolveIdentity({ wallets: [WA] }, { fetchImpl: stub })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason.kind).toBe("parse_error")
  })

  it("401 → unauthorized", async () => {
    const stub = async () => new Response("Unauthorized", { status: 401 })
    const adapter = new HttpScoreAdapter()
    const res = await adapter.resolveIdentity({ wallets: [WA] }, { fetchImpl: stub })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason.kind).toBe("unauthorized")
  })

  it("404 → not_found", async () => {
    const stub = async () => new Response("Not Found", { status: 404 })
    const adapter = new HttpScoreAdapter({ apiKey: "k" })
    const res = await adapter.resolveIdentity({ wallets: [WA] }, { fetchImpl: stub })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason.kind).toBe("not_found")
  })

  it("429 → rate_limited (breaker-exempt; upstream healthy)", async () => {
    const stub = async () => new Response("Too Many Requests", { status: 429 })
    const adapter = new HttpScoreAdapter({ apiKey: "k" })
    const res = await adapter.resolveIdentity({ wallets: [WA] }, { fetchImpl: stub })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason.kind).toBe("rate_limited")
  })

  it("503 → upstream_5xx", async () => {
    const stub = async () => new Response("Service Unavailable", { status: 503 })
    const adapter = new HttpScoreAdapter({ apiKey: "k" })
    const res = await adapter.resolveIdentity({ wallets: [WA] }, { fetchImpl: stub })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason.kind).toBe("upstream_5xx")
  })

  it("caller AbortSignal fired → timeout", async () => {
    const ac = new AbortController()
    ac.abort()
    const stub = async () => {
      throw Object.assign(new Error("aborted"), { name: "AbortError" })
    }
    const adapter = new HttpScoreAdapter({ apiKey: "k" })
    const res = await adapter.resolveIdentity(
      { wallets: [WA] },
      { fetchImpl: stub, signal: ac.signal },
    )
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason.kind).toBe("timeout")
  })
})
