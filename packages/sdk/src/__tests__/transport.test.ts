/**
 * transport.test.ts — unit tests for the SDK's HTTP transport layer.
 *
 * No app boot; we pass a fetch shim and assert the request shape +
 * response handling. Three concerns:
 *   - URL construction (baseUrl, path params, query string)
 *   - Header composition (defaults, content-type, bearer JWT)
 *   - Error mapping (2xx → typed body, non-2xx → typed error class)
 *
 * This file is the gatekeeper for everything in transport.ts. The
 * integration tests in `client.integration.test.ts` exercise the same
 * transport against a real app + mock spine.
 */

import { describe, expect, it, mock } from "bun:test"
import {
  createTransport,
  type FetchLike,
  type TransportRequestOpts,
} from "../transport"
import {
  ConflictError,
  IdentityApiError,
  NetworkError,
  NotImplementedError,
  UnauthorizedError,
  ValidationError,
} from "../errors"

// ─── small fetch-shim helpers ───────────────────────────────────────────────

interface CapturedCall {
  url: string
  init: RequestInit | undefined
}

function makeFetch(responses: Array<Response | (() => Response | Promise<Response>) | Error>): {
  fetch: FetchLike
  calls: CapturedCall[]
} {
  const calls: CapturedCall[] = []
  let i = 0
  const fetchImpl: FetchLike = async (input, init) => {
    const url = typeof input === "string" ? input : (input as URL).toString()
    calls.push({ url, init })
    const cell = responses[i++]
    if (cell === undefined) throw new Error(`makeFetch: no response queued for call ${i}`)
    if (cell instanceof Error) throw cell
    if (typeof cell === "function") return cell()
    return cell
  }
  return { fetch: fetchImpl, calls }
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  })
}

// ─── URL construction ──────────────────────────────────────────────────────

describe("createTransport — URL construction", () => {
  it("strips trailing slash from baseUrl and prepends path", async () => {
    const { fetch, calls } = makeFetch([jsonResponse(200, {})])
    const t = createTransport({ baseUrl: "https://identity-api.test/", fetch })
    await t.request({ method: "GET", path: "/health" })
    expect(calls[0]!.url).toBe("https://identity-api.test/health")
  })

  it("substitutes :pathParam segments via URI-encoded values", async () => {
    const { fetch, calls } = makeFetch([jsonResponse(200, {})])
    const t = createTransport({ baseUrl: "https://i.t", fetch })
    await t.request({
      method: "GET",
      path: "/v1/resolve/account/:provider/:externalId",
      pathParams: { provider: "discord", externalId: "user with spaces" },
    } satisfies TransportRequestOpts)
    expect(calls[0]!.url).toBe(
      "https://i.t/v1/resolve/account/discord/user%20with%20spaces",
    )
  })

  it("appends query string skipping undefined values", async () => {
    const { fetch, calls } = makeFetch([jsonResponse(200, {})])
    const t = createTransport({ baseUrl: "https://i.t", fetch })
    await t.request({
      method: "GET",
      path: "/v1/profile",
      query: { world: "mibera", userId: undefined, wallet: "0xabc" },
    })
    expect(calls[0]!.url).toBe("https://i.t/v1/profile?world=mibera&wallet=0xabc")
  })

  it("normalizes a path without leading slash", async () => {
    const { fetch, calls } = makeFetch([jsonResponse(200, {})])
    const t = createTransport({ baseUrl: "https://i.t", fetch })
    await t.request({ method: "GET", path: "health" })
    expect(calls[0]!.url).toBe("https://i.t/health")
  })
})

// ─── headers ────────────────────────────────────────────────────────────────

describe("createTransport — headers", () => {
  it("merges defaultHeaders into every request", async () => {
    const { fetch, calls } = makeFetch([jsonResponse(200, {})])
    const t = createTransport({
      baseUrl: "https://i.t",
      fetch,
      defaultHeaders: { "x-trace-id": "abc-123" },
    })
    await t.request({ method: "GET", path: "/health" })
    const h = calls[0]!.init!.headers as Record<string, string>
    expect(h["x-trace-id"]).toBe("abc-123")
    expect(h.accept).toBe("application/json")
  })

  it("sets content-type for JSON bodies on POST", async () => {
    const { fetch, calls } = makeFetch([jsonResponse(200, {})])
    const t = createTransport({ baseUrl: "https://i.t", fetch })
    await t.request({
      method: "POST",
      path: "/v1/auth/challenge",
      body: { walletAddress: "0x" + "a".repeat(40), scheme: "siwe" },
    })
    const h = calls[0]!.init!.headers as Record<string, string>
    expect(h["content-type"]).toBe("application/json")
    expect(calls[0]!.init!.body).toBe(
      JSON.stringify({ walletAddress: "0x" + "a".repeat(40), scheme: "siwe" }),
    )
  })

  it("does NOT serialize a body on GET", async () => {
    const { fetch, calls } = makeFetch([jsonResponse(200, {})])
    const t = createTransport({ baseUrl: "https://i.t", fetch })
    await t.request({ method: "GET", path: "/health", body: { ignored: true } })
    expect(calls[0]!.init!.body).toBeUndefined()
  })
})

// ─── bearer JWT injection ──────────────────────────────────────────────────

describe("createTransport — bearer JWT", () => {
  it("injects Authorization header when requireAuth + static jwt", async () => {
    const { fetch, calls } = makeFetch([jsonResponse(200, {})])
    const t = createTransport({ baseUrl: "https://i.t", fetch, jwt: "tok.en.sig" })
    await t.request({ method: "GET", path: "/v1/me", requireAuth: true })
    const h = calls[0]!.init!.headers as Record<string, string>
    expect(h["authorization"]).toBe("Bearer tok.en.sig")
  })

  it("calls the getter on every request — supports rotating tokens", async () => {
    const { fetch } = makeFetch([jsonResponse(200, {}), jsonResponse(200, {})])
    const getter = mock(() => "rotating-token")
    const t = createTransport({ baseUrl: "https://i.t", fetch, jwt: getter })
    await t.request({ method: "GET", path: "/v1/me", requireAuth: true })
    await t.request({ method: "GET", path: "/v1/me", requireAuth: true })
    expect(getter).toHaveBeenCalledTimes(2)
  })

  it("supports an async JWT getter", async () => {
    const { fetch, calls } = makeFetch([jsonResponse(200, {})])
    const t = createTransport({
      baseUrl: "https://i.t",
      fetch,
      jwt: async () => "async-token",
    })
    await t.request({ method: "GET", path: "/v1/me", requireAuth: true })
    const h = calls[0]!.init!.headers as Record<string, string>
    expect(h["authorization"]).toBe("Bearer async-token")
  })

  it("throws UnauthorizedError immediately if jwt is unset + requireAuth", async () => {
    const { fetch } = makeFetch([])
    const t = createTransport({ baseUrl: "https://i.t", fetch })
    let err: unknown
    try {
      await t.request({ method: "GET", path: "/v1/me", requireAuth: true })
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(UnauthorizedError)
    expect(err).toBeInstanceOf(IdentityApiError) // hierarchy preserved
    expect((err as UnauthorizedError).status).toBe(401)
    expect((err as UnauthorizedError).code).toBe("missing_token")
  })

  it("respects authHeader override", async () => {
    const { fetch, calls } = makeFetch([jsonResponse(200, {})])
    const t = createTransport({
      baseUrl: "https://i.t",
      fetch,
      jwt: "tok",
      authHeader: "X-Custom-Auth",
    })
    await t.request({ method: "GET", path: "/v1/me", requireAuth: true })
    const h = calls[0]!.init!.headers as Record<string, string>
    expect(h["x-custom-auth"]).toBe("Bearer tok")
    expect(h["authorization"]).toBeUndefined()
  })
})

// ─── 2xx response parsing ──────────────────────────────────────────────────

describe("createTransport — 2xx response parsing", () => {
  it("parses JSON body and returns typed shape", async () => {
    const fixture = { user_id: "uuid-1", primary_wallet: "0xabc" }
    const { fetch } = makeFetch([jsonResponse(200, fixture)])
    const t = createTransport({ baseUrl: "https://i.t", fetch })
    const got = await t.request<typeof fixture>({ method: "GET", path: "/v1/me" })
    expect(got).toEqual(fixture)
  })

  it("returns undefined for 204 No Content", async () => {
    const { fetch } = makeFetch([new Response(null, { status: 204 })])
    const t = createTransport({ baseUrl: "https://i.t", fetch })
    const got = await t.request<undefined>({ method: "GET", path: "/health" })
    expect(got).toBeUndefined()
  })

  it("throws NetworkError when a 200 body is not valid JSON", async () => {
    const { fetch } = makeFetch([new Response("<html>oops</html>", { status: 200 })])
    const t = createTransport({ baseUrl: "https://i.t", fetch })
    let err: unknown
    try {
      await t.request({ method: "GET", path: "/wat" })
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(NetworkError)
  })
})

// ─── non-2xx → typed error class ───────────────────────────────────────────

describe("createTransport — error class mapping", () => {
  it("401 → UnauthorizedError with code + envelope", async () => {
    const { fetch } = makeFetch([
      jsonResponse(401, { error: "unauthorized", code: "invalid_nonce", message: "Challenge nonce is unknown or expired" }, {
        "x-request-id": "req-001",
      }),
    ])
    const t = createTransport({ baseUrl: "https://i.t", fetch })
    let err: unknown
    try {
      await t.request({ method: "POST", path: "/v1/auth/verify" })
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(UnauthorizedError)
    expect(err).toBeInstanceOf(IdentityApiError) // hierarchy
    const e = err as UnauthorizedError
    expect(e.status).toBe(401)
    expect(e.code).toBe("invalid_nonce")
    expect(e.message).toBe("Challenge nonce is unknown or expired")
    expect(e.requestId).toBe("req-001")
    expect(e.envelope?.error).toBe("unauthorized")
  })

  it("409 → ConflictError", async () => {
    const { fetch } = makeFetch([
      jsonResponse(409, { error: "conflict", code: "cross_user_collision" }),
    ])
    const t = createTransport({ baseUrl: "https://i.t", fetch })
    let err: unknown
    try {
      await t.request({ method: "POST", path: "/v1/link/verified-wallet" })
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(ConflictError)
    expect((err as ConflictError).code).toBe("cross_user_collision")
  })

  it("400 → ValidationError with details.issues passthrough", async () => {
    const { fetch } = makeFetch([
      jsonResponse(400, {
        error: "validation_failed",
        code: "invalid_body",
        details: { issues: [{ path: ["walletAddress"], message: "must be hex" }] },
      }),
    ])
    const t = createTransport({ baseUrl: "https://i.t", fetch })
    let err: unknown
    try {
      await t.request({ method: "POST", path: "/v1/auth/challenge" })
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(ValidationError)
    const e = err as ValidationError
    expect(e.envelope?.details?.issues?.[0]?.message).toBe("must be hex")
  })

  it("501 → NotImplementedError carries the task id", async () => {
    const { fetch } = makeFetch([
      jsonResponse(501, { error: "not_implemented", task: "T2.3", bead: "arrakis-eqxj" }),
    ])
    const t = createTransport({ baseUrl: "https://i.t", fetch })
    let err: unknown
    try {
      await t.request({ method: "GET", path: "/v1/profile" })
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(NotImplementedError)
    expect((err as NotImplementedError).envelope).toMatchObject({
      error: "not_implemented",
    })
  })

  it("503 → bare IdentityApiError (no specific subclass)", async () => {
    const { fetch } = makeFetch([
      jsonResponse(503, { error: "service_unavailable", code: "downstream_down" }),
    ])
    const t = createTransport({ baseUrl: "https://i.t", fetch })
    let err: unknown
    try {
      await t.request({ method: "GET", path: "/v1/me" })
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(IdentityApiError)
    expect(err).not.toBeInstanceOf(UnauthorizedError)
    expect((err as IdentityApiError).status).toBe(503)
  })

  it("fetch rejection → NetworkError preserving the cause", async () => {
    const cause = new TypeError("getaddrinfo ENOTFOUND nope.invalid")
    const { fetch } = makeFetch([cause])
    const t = createTransport({ baseUrl: "https://i.t", fetch })
    let err: unknown
    try {
      await t.request({ method: "GET", path: "/v1/me" })
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(NetworkError)
    expect((err as NetworkError).cause).toBe(cause)
    expect((err as NetworkError).status).toBe(0)
    // NetworkError is also-an IdentityApiError so the catch-all branch works.
    expect(err).toBeInstanceOf(IdentityApiError)
  })

  it("non-JSON error body still surfaces with raw text + status", async () => {
    const { fetch } = makeFetch([new Response("<h1>502 Bad Gateway</h1>", { status: 502 })])
    const t = createTransport({ baseUrl: "https://i.t", fetch })
    let err: unknown
    try {
      await t.request({ method: "GET", path: "/v1/me" })
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(IdentityApiError)
    const e = err as IdentityApiError
    expect(e.status).toBe(502)
    expect(e.rawBody).toContain("Bad Gateway")
    expect(e.envelope).toBeUndefined()
  })
})
