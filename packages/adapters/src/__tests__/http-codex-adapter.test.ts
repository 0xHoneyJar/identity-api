/**
 * http-codex-adapter.test.ts — adapter-specific shape tests (T2.1).
 */

import { describe, expect, it } from "bun:test"
import {
  HttpCodexAdapter,
  DEFAULT_CODEX_BASE_URL,
} from "../http-codex-adapter"

function makeMiberaEntry(id: number) {
  return {
    id,
    archetype: "Freetekno" as const,
    ancestor: "satoshi",
    time_period: "1990s",
    birthday: "1992-04-15",
    birth_coordinates: "Belfast, NI",
    sun_sign: "Aries",
    moon_sign: "Libra",
    ascending_sign: "Capricorn",
    element: "Fire" as const,
    swag_rank: "Sss" as const,
    swag_score: 99.5,
    background: "rave-tent",
    body: "tan",
    hair: "blue-mullet",
    eyes: "amber",
    eyebrows: "natural",
    mouth: "smirk",
    shirt: "mesh-tank",
    hat: null,
    glasses: "wraparound-orange",
    mask: null,
    earrings: null,
    face_accessory: null,
    tattoo: "smiley-cheek",
    item: "glowstick",
    drug: "mdma",
  }
}

describe("HttpCodexAdapter (T2.1)", () => {
  it("default baseUrl per registry.yaml", () => {
    const adapter = new HttpCodexAdapter()
    expect(adapter.baseUrl).toBe(DEFAULT_CODEX_BASE_URL)
    expect(DEFAULT_CODEX_BASE_URL).toBe("https://codex.0xhoneyjar.xyz")
  })

  it("POST /v1/mibera/batch with coerced numeric tokenIds", async () => {
    let observedUrl = ""
    let observedBody: unknown = null
    const stub = async (input: string | URL | Request, init?: RequestInit) => {
      observedUrl = typeof input === "string" ? input : input.toString()
      observedBody = JSON.parse(String(init?.body ?? ""))
      return new Response(
        JSON.stringify({ miberas: [makeMiberaEntry(42), makeMiberaEntry(777)] }),
        { status: 200 },
      )
    }
    const adapter = new HttpCodexAdapter({ baseUrl: "https://test.local" })
    const res = await adapter.getMiberaTraits(
      { tokenIds: ["42", "777"] },
      { fetchImpl: stub },
    )
    expect(observedUrl).toBe("https://test.local/v1/mibera/batch")
    expect(observedBody).toEqual({ tokenIds: [42, 777] })
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.data.miberas.length).toBe(2)
  })

  it("empty tokenIds → local parse_error (no round-trip)", async () => {
    let calls = 0
    const stub = async () => {
      calls += 1
      return new Response("never", { status: 200 })
    }
    const adapter = new HttpCodexAdapter()
    const res = await adapter.getMiberaTraits(
      { tokenIds: [] },
      { fetchImpl: stub },
    )
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason.kind).toBe("parse_error")
    expect(calls).toBe(0)
  })

  it("non-integer tokenId → local parse_error", async () => {
    const adapter = new HttpCodexAdapter()
    const res = await adapter.getMiberaTraits(
      { tokenIds: ["42", "not-a-number"] },
      { fetchImpl: async () => new Response("", { status: 200 }) },
    )
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.reason.kind).toBe("parse_error")
      expect(res.reason.message).toContain("not-a-number")
    }
  })

  it("tokenId > 10000 → local parse_error", async () => {
    const adapter = new HttpCodexAdapter()
    const res = await adapter.getMiberaTraits(
      { tokenIds: ["99999"] },
      { fetchImpl: async () => new Response("", { status: 200 }) },
    )
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason.kind).toBe("parse_error")
  })

  it("over-100 tokenIds → local parse_error (caller must split)", async () => {
    const tokenIds: string[] = []
    for (let i = 1; i <= 101; i++) tokenIds.push(String(i))
    const adapter = new HttpCodexAdapter()
    const res = await adapter.getMiberaTraits(
      { tokenIds },
      { fetchImpl: async () => new Response("", { status: 200 }) },
    )
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.reason.kind).toBe("parse_error")
      expect(res.reason.message).toContain("100")
    }
  })

  it("503 from upstream → upstream_5xx", async () => {
    const stub = async () => new Response("service unavailable", { status: 503 })
    const adapter = new HttpCodexAdapter()
    const res = await adapter.getMiberaTraits(
      { tokenIds: ["1"] },
      { fetchImpl: stub },
    )
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.reason.kind).toBe("upstream_5xx")
      expect(res.reason.statusCode).toBe(503)
    }
  })

  it("malformed entry in batch response → parse_error", async () => {
    const stub = async () =>
      new Response(JSON.stringify({ miberas: [{ id: 1, foo: "bar" }] }), { status: 200 })
    const adapter = new HttpCodexAdapter()
    const res = await adapter.getMiberaTraits(
      { tokenIds: ["1"] },
      { fetchImpl: stub },
    )
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason.kind).toBe("parse_error")
  })

  it("happy: round-trips a full MiberaEntry verbatim", async () => {
    const entry = makeMiberaEntry(42)
    const stub = async () => new Response(JSON.stringify({ miberas: [entry] }), { status: 200 })
    const adapter = new HttpCodexAdapter()
    const res = await adapter.getMiberaTraits(
      { tokenIds: ["42"] },
      { fetchImpl: stub },
    )
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.data.miberas[0]).toEqual(entry)
    }
  })
})
