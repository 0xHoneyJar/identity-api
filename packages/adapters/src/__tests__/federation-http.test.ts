/**
 * federation-http.test.ts — shared HTTP plumbing for federation adapters (T2.1).
 *
 * Verifies the 6 failure-classification kinds + the happy path + AbortSignal
 * handling + the JSON-vs-parse distinction. Adapter-specific behavior (URL
 * shape, header set, building label) is tested in each adapter's own test
 * file; this suite proves the shared helper's contract.
 *
 * Per the SDD §5.4 contract: federationHttpCall NEVER throws; every error
 * resolves to `{ ok: false, reason: {...} }`. We rely on that here by
 * always awaiting + asserting on the result.
 */

import { afterEach, describe, expect, it } from "bun:test"
import { z } from "zod"
import { federationHttpCall } from "../federation-http"

// Minimal happy-path schema for the helper-under-test
const HelloSchema = z.object({ hello: z.string() })

// Test logger that captures every call
function makeLogger(): {
  info: Array<{ obj: unknown; msg?: string }>
  warn: Array<{ obj: unknown; msg?: string }>
  error: Array<{ obj: unknown; msg?: string }>
  surface: {
    info: (obj: Record<string, unknown>, msg?: string) => void
    warn: (obj: Record<string, unknown>, msg?: string) => void
    error: (obj: Record<string, unknown>, msg?: string) => void
  }
} {
  const info: Array<{ obj: unknown; msg?: string }> = []
  const warn: Array<{ obj: unknown; msg?: string }> = []
  const error: Array<{ obj: unknown; msg?: string }> = []
  return {
    info,
    warn,
    error,
    surface: {
      info: (obj, msg) => info.push({ obj, msg }),
      warn: (obj, msg) => warn.push({ obj, msg }),
      error: (obj, msg) => error.push({ obj, msg }),
    },
  }
}

describe("federationHttpCall (T2.1 shared HTTP plumbing)", () => {
  afterEach(() => {
    // Each test owns its own stubs; nothing to global-reset.
  })

  it("happy path: 200 with valid JSON body → ok=true + parsed data", async () => {
    const stub = async () => new Response(JSON.stringify({ hello: "world" }), { status: 200 })
    const res = await federationHttpCall({
      url: "https://example.com/test",
      method: "GET",
      headers: {},
      responseSchema: HelloSchema,
      portOpts: { fetchImpl: stub },
      building: "test",
    })
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.data).toEqual({ hello: "world" })
  })

  it("401 → unauthorized", async () => {
    const stub = async () => new Response("nope", { status: 401 })
    const res = await federationHttpCall({
      url: "https://example.com/test",
      method: "GET",
      headers: {},
      responseSchema: HelloSchema,
      portOpts: { fetchImpl: stub },
      building: "test",
    })
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.reason.kind).toBe("unauthorized")
      expect(res.reason.statusCode).toBe(401)
    }
  })

  it("404 → not_found", async () => {
    const stub = async () => new Response("not found", { status: 404 })
    const res = await federationHttpCall({
      url: "https://example.com/test",
      method: "GET",
      headers: {},
      responseSchema: HelloSchema,
      portOpts: { fetchImpl: stub },
      building: "test",
    })
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.reason.kind).toBe("not_found")
      expect(res.reason.statusCode).toBe(404)
    }
  })

  it("502 → upstream_5xx with statusCode preserved", async () => {
    const stub = async () => new Response("bad gateway", { status: 502 })
    const res = await federationHttpCall({
      url: "https://example.com/test",
      method: "GET",
      headers: {},
      responseSchema: HelloSchema,
      portOpts: { fetchImpl: stub },
      building: "test",
    })
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.reason.kind).toBe("upstream_5xx")
      expect(res.reason.statusCode).toBe(502)
    }
  })

  it("429 → rate_limited (BB F-003) — distinct from parse_error, exempt from breaker", async () => {
    // BB review F-003: 429 used to fall through to the catch-all parse_error
    // branch, which trips the breaker → 30s self-inflicted blackouts on
    // upstream throttle. Now classified as a dedicated kind.
    const stub = async () =>
      new Response('{"code":"rate_limited"}', {
        status: 429,
        headers: { "content-type": "application/json" },
      })
    const res = await federationHttpCall({
      url: "https://example.com/test",
      method: "GET",
      headers: {},
      responseSchema: HelloSchema,
      portOpts: { fetchImpl: stub },
      building: "test",
    })
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.reason.kind).toBe("rate_limited")
      expect(res.reason.statusCode).toBe(429)
      expect(res.reason.message).toContain("429")
    }
  })

  it("200 with non-JSON body → parse_error", async () => {
    const stub = async () => new Response("<html>error page</html>", { status: 200 })
    const res = await federationHttpCall({
      url: "https://example.com/test",
      method: "GET",
      headers: {},
      responseSchema: HelloSchema,
      portOpts: { fetchImpl: stub },
      building: "test",
    })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason.kind).toBe("parse_error")
  })

  it("200 with JSON that fails Zod → parse_error with zodIssues in context", async () => {
    const stub = async () => new Response(JSON.stringify({ goodbye: "world" }), { status: 200 })
    const res = await federationHttpCall({
      url: "https://example.com/test",
      method: "GET",
      headers: {},
      responseSchema: HelloSchema,
      portOpts: { fetchImpl: stub },
      building: "test",
    })
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.reason.kind).toBe("parse_error")
      expect(res.reason.context).toBeDefined()
      expect((res.reason.context as { zodIssues?: unknown }).zodIssues).toBeDefined()
    }
  })

  it("fetch throws (no signal) → network_error", async () => {
    const stub = async () => {
      throw new TypeError("fetch failed: ECONNREFUSED")
    }
    const res = await federationHttpCall({
      url: "https://example.com/test",
      method: "GET",
      headers: {},
      responseSchema: HelloSchema,
      portOpts: { fetchImpl: stub },
      building: "test",
    })
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.reason.kind).toBe("network_error")
      expect(res.reason.message).toContain("fetch failed: ECONNREFUSED")
    }
  })

  it("AbortError + caller signal aborted → timeout", async () => {
    const ctrl = new AbortController()
    const stub = async (_input: unknown, init?: RequestInit) => {
      ctrl.abort()
      const err = new Error("aborted")
      err.name = "AbortError"
      throw err
    }
    const res = await federationHttpCall({
      url: "https://example.com/test",
      method: "GET",
      headers: {},
      responseSchema: HelloSchema,
      portOpts: { signal: ctrl.signal, fetchImpl: stub },
      building: "test",
    })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason.kind).toBe("timeout")
  })

  it("AbortError + caller signal NOT aborted → network_error (not timeout)", async () => {
    // Simulates the server aborting mid-handshake; the caller's signal is
    // clean so this is a network issue, not a timeout.
    const stub = async () => {
      const err = new Error("server aborted")
      err.name = "AbortError"
      throw err
    }
    const res = await federationHttpCall({
      url: "https://example.com/test",
      method: "GET",
      headers: {},
      responseSchema: HelloSchema,
      portOpts: { fetchImpl: stub }, // no signal
      building: "test",
    })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason.kind).toBe("network_error")
  })

  it("POST body is JSON-serialized and content-type is set", async () => {
    let observedInit: RequestInit | undefined
    const stub = async (_input: unknown, init?: RequestInit) => {
      observedInit = init
      return new Response(JSON.stringify({ hello: "world" }), { status: 200 })
    }
    await federationHttpCall({
      url: "https://example.com/test",
      method: "POST",
      headers: {},
      body: { tokenIds: [1, 2, 3] },
      responseSchema: HelloSchema,
      portOpts: { fetchImpl: stub },
      building: "test",
    })
    expect(observedInit?.method).toBe("POST")
    expect(observedInit?.body).toBe('{"tokenIds":[1,2,3]}')
    const headers = observedInit?.headers as Record<string, string>
    expect(headers["content-type"]).toBe("application/json")
  })

  it("adapter-default headers are merged with caller headers (caller wins on duplicates)", async () => {
    let observedInit: RequestInit | undefined
    const stub = async (_input: unknown, init?: RequestInit) => {
      observedInit = init
      return new Response(JSON.stringify({ hello: "world" }), { status: 200 })
    }
    await federationHttpCall({
      url: "https://example.com/test",
      method: "GET",
      headers: { "X-Adapter": "yes", "X-Both": "from-adapter" },
      responseSchema: HelloSchema,
      portOpts: { fetchImpl: stub },
      building: "test",
    })
    const headers = observedInit?.headers as Record<string, string>
    expect(headers["X-Adapter"]).toBe("yes")
    expect(headers["X-Both"]).toBe("from-adapter")
    expect(headers["accept"]).toBe("application/json")
  })

  it("logger captures the right severity per failure class", async () => {
    const log = makeLogger()
    // 5xx → warn
    await federationHttpCall({
      url: "https://example.com/test",
      method: "GET",
      headers: {},
      responseSchema: HelloSchema,
      portOpts: {
        fetchImpl: async () => new Response("err", { status: 503 }),
      },
      logger: log.surface,
      building: "test-bldg",
    })
    expect(log.warn.length).toBe(1)
    // 404 → info
    await federationHttpCall({
      url: "https://example.com/test",
      method: "GET",
      headers: {},
      responseSchema: HelloSchema,
      portOpts: {
        fetchImpl: async () => new Response("err", { status: 404 }),
      },
      logger: log.surface,
      building: "test-bldg",
    })
    expect(log.info.length).toBe(1)
    // parse_error → error
    await federationHttpCall({
      url: "https://example.com/test",
      method: "GET",
      headers: {},
      responseSchema: HelloSchema,
      portOpts: {
        fetchImpl: async () => new Response(JSON.stringify({ wrong: "shape" }), { status: 200 }),
      },
      logger: log.surface,
      building: "test-bldg",
    })
    expect(log.error.length).toBe(1)
  })
})
