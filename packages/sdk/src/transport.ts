/**
 * HTTP transport for @freeside-auth/identity-client.
 *
 * Wraps `fetch` with:
 *   - JSON request body encoding
 *   - Bearer-JWT injection (when configured)
 *   - Default header merge
 *   - 2xx → typed body
 *   - non-2xx → typed IdentityApiError (via errors.ts/classifyHttpError)
 *   - fetch rejection → NetworkError
 *
 * Pluggable: pass `fetch: customFetch` at client construction time and the
 * transport uses your shim instead of the global. Tests pass a sinon-like
 * stub; production passes nothing (uses global fetch).
 *
 * Per FR-B4 + PRD §11 post-verify lock-ins: this is the consume organ that
 * external worlds (honey-road, Sietch) vendor as source. The transport
 * MUST NOT depend on Node-only APIs — `fetch`, `URL`, `JSON`, `Headers` are
 * Web Standards available in browsers, Bun, modern Node, edge runtimes.
 * No `node:` imports.
 */

import {
  classifyHttpError,
  IdentityApiError,
  NetworkError,
  UnauthorizedError,
  type ServerErrorEnvelope,
} from "./errors"

/** Subset of `fetch` we depend on — also lets us pass narrowed test stubs. */
export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

/**
 * Resolver for a bearer JWT. May be a static string OR an async getter
 * (the latter useful for callers whose token rotates — e.g., a refresh
 * loop in their app). Called once per outgoing request that requires auth;
 * the result is injected as `Authorization: Bearer <token>`.
 */
export type JwtResolver = string | (() => string | Promise<string>)

export interface TransportOpts {
  readonly baseUrl: string
  readonly fetch?: FetchLike
  readonly defaultHeaders?: Record<string, string>
  readonly jwt?: JwtResolver
  /**
   * Override the bearer-token header name. Defaults to "authorization".
   * (You'd only override this for service-to-service contexts that use a
   * sidechannel header — link.verifiedWallet() exposes its own per-call
   * `serviceTokenHeader` parameter; per-client overrides aren't needed
   * for the user-session surface.)
   */
  readonly authHeader?: string
}

/**
 * The transport object exposes a single typed method: `request(path, init)`.
 * Used by `client.ts` for every call. Tests can construct transports
 * directly to exercise lower-level behavior.
 */
export interface Transport {
  request<TResp>(opts: TransportRequestOpts): Promise<TResp>
}

export interface TransportRequestOpts {
  readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"
  /** Path relative to baseUrl (must START with /). */
  readonly path: string
  /** Path-replacement map (for `:address` style segments). */
  readonly pathParams?: Record<string, string>
  /** Optional query parameters. Values are coerced via String(). */
  readonly query?: Record<string, string | number | boolean | undefined>
  /** JSON-encoded into the body for POST/PUT/PATCH. */
  readonly body?: unknown
  /** Forward additional headers (overrides defaults). */
  readonly headers?: Record<string, string>
  /** Include the auth header (Bearer JWT). Default: false. */
  readonly requireAuth?: boolean
  /** Skip the auto JSON parse — return raw Response (rare; reserved). */
  readonly raw?: boolean
}

/**
 * Construct a Transport. Pure function — no module-level state.
 */
export function createTransport(opts: TransportOpts): Transport {
  const fetchImpl: FetchLike = opts.fetch ?? globalThis.fetch.bind(globalThis)
  const authHeaderName = (opts.authHeader ?? "authorization").toLowerCase()
  const baseUrl = stripTrailingSlash(opts.baseUrl)
  const baseHeaders: Record<string, string> = {
    accept: "application/json",
    ...(opts.defaultHeaders ?? {}),
  }

  async function resolveJwt(): Promise<string | undefined> {
    const j = opts.jwt
    if (typeof j === "string") return j
    if (typeof j === "function") {
      const r = j()
      return r instanceof Promise ? await r : r
    }
    return undefined
  }

  async function request<TResp>(rOpts: TransportRequestOpts): Promise<TResp> {
    const url = buildUrl(baseUrl, rOpts.path, rOpts.pathParams, rOpts.query)
    const init: RequestInit = {
      method: rOpts.method,
      headers: { ...baseHeaders, ...(rOpts.headers ?? {}) },
    }

    // Bearer-JWT injection.
    if (rOpts.requireAuth) {
      const token = await resolveJwt()
      if (!token) {
        // We could let the server return 401, but failing fast here avoids
        // a round-trip + makes the missing-token bug less mysterious for
        // SDK users debugging auth flows. UnauthorizedError keeps the
        // catch-block contract uniform (the server-side 401 also throws
        // the same class).
        throw new UnauthorizedError({
          status: 401,
          message: "no JWT configured on client (set `jwt:` at createIdentityClient)",
          code: "missing_token",
        })
      }
      ;(init.headers as Record<string, string>)[authHeaderName] = `Bearer ${token}`
    }

    // JSON body for mutating methods.
    if (rOpts.body !== undefined && rOpts.method !== "GET" && rOpts.method !== "DELETE") {
      ;(init.headers as Record<string, string>)["content-type"] = "application/json"
      init.body = JSON.stringify(rOpts.body)
    }

    // Issue the request.
    let res: Response
    try {
      res = await fetchImpl(url, init)
    } catch (cause) {
      throw new NetworkError({
        message: `fetch failed for ${rOpts.method} ${url}`,
        cause,
      })
    }

    // 2xx → parse + return.
    if (res.ok) {
      if (rOpts.raw) return res as unknown as TResp
      // 204 No Content / empty body — return undefined cast to TResp.
      // (Most identity-api routes return JSON; this is forward-compat.)
      if (res.status === 204) return undefined as unknown as TResp
      const text = await res.text()
      if (!text) return undefined as unknown as TResp
      try {
        return JSON.parse(text) as TResp
      } catch (cause) {
        // 200 with a non-JSON body is exceptional; surface as NetworkError
        // so callers route it through the same retry path as fetch failures.
        throw new NetworkError({
          message: `response body was not valid JSON for ${rOpts.method} ${url}`,
          cause,
        })
      }
    }

    // Non-2xx → typed error.
    const text = await safeReadText(res)
    const envelope = safeParseEnvelope(text)
    const requestId = res.headers.get("x-request-id") ?? undefined
    throw classifyHttpError({
      status: res.status,
      envelope,
      rawBody: envelope ? undefined : text,
      requestId,
    })
  }

  return { request }
}

// ─── helpers ────────────────────────────────────────────────────────────────

function buildUrl(
  baseUrl: string,
  path: string,
  pathParams: Record<string, string> | undefined,
  query: Record<string, string | number | boolean | undefined> | undefined,
): string {
  let resolved = path
  if (pathParams) {
    for (const [name, raw] of Object.entries(pathParams)) {
      resolved = resolved.replaceAll(`:${name}`, encodeURIComponent(raw))
    }
  }
  if (!resolved.startsWith("/")) resolved = `/${resolved}`
  const u = `${baseUrl}${resolved}`
  if (!query) return u

  // Build query string preserving insertion order; skip undefined values.
  const qs: string[] = []
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined) continue
    qs.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
  }
  return qs.length === 0 ? u : `${u}?${qs.join("&")}`
}

function stripTrailingSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s
}

async function safeReadText(res: Response): Promise<string> {
  try {
    return await res.text()
  } catch {
    return ""
  }
}

function safeParseEnvelope(text: string): ServerErrorEnvelope | undefined {
  if (!text) return undefined
  try {
    const v = JSON.parse(text) as unknown
    if (v && typeof v === "object") return v as ServerErrorEnvelope
    return undefined
  } catch {
    return undefined
  }
}
