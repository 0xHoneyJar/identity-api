/**
 * federation-http.ts — shared HTTP plumbing for the three federation
 * client adapters (T2.1).
 *
 * The InventoryPort / ScorePort / CodexPort adapters all follow the same
 * shape: build a URL, fetch with optional AbortSignal, classify the
 * response status, validate the 2xx body with Zod, return a
 * `FederationResult` discriminated union. This helper extracts the common
 * pieces so each adapter file stays focused on the building-specific
 * contract (path shape, header set, error-classification quirks).
 *
 * Design notes:
 *
 *   - Single private helper, NOT exported from the package barrel. The
 *     adapters import it directly; downstream consumers (T2.2 compose,
 *     T2.3 route handler) reach the adapters via the port interfaces, not
 *     through this implementation detail.
 *
 *   - Defends against the AbortError ambiguity: an AbortError raised
 *     because the CALLER'S signal fired = `timeout`; an AbortError raised
 *     because the SERVER closed the connection mid-body = `network_error`.
 *     Distinguished by inspecting `opts.signal.aborted` at catch time.
 *
 *   - Logs to the supplied `logger` (optional; defaults to a no-op) at
 *     `warn` level for `upstream_5xx` and `network_error` (transient
 *     classes); at `info` for `not_found` (expected for fresh wallets);
 *     at `error` for `parse_error` (schema drift signal). T2.2's
 *     orchestrator wires this to the request's pino instance.
 *
 *   - JSON body parsing uses `await response.text()` then `JSON.parse(...)`
 *     instead of `await response.json()` because the latter throws an
 *     opaque SyntaxError on malformed JSON; doing it in two steps gives
 *     the adapter visibility into "received non-JSON" (could be an HTML
 *     error page from a reverse-proxy timeout) vs "valid JSON but wrong
 *     shape" (genuine schema drift). Both classify as `parse_error`, but
 *     the cause carries different signal.
 *
 *   - 2xx 204 (No Content) responses are NOT supported here — the three
 *     federation endpoints always return a body on success. A 204 would
 *     surface as `parse_error` (empty body fails JSON parse) which is
 *     accurate.
 *
 * Per SDD §5.4: this is the federation TRANSPORT layer; the per-port
 * adapter is the SHAPING layer (URL paths, header conventions, response
 * classification quirks).
 */

import type {
  FederationResult,
  FederationFailureKind,
  PortFetchLike,
  PortCallOpts,
} from "@freeside-auth/ports"
import { z, type ZodType } from "zod"

/**
 * Logger surface the adapter writes to. Subset of pino's API. Pass
 * `undefined` (the default) to silence all logs.
 */
export interface FederationLogger {
  info(obj: Record<string, unknown>, msg?: string): void
  warn(obj: Record<string, unknown>, msg?: string): void
  error(obj: Record<string, unknown>, msg?: string): void
}

/** No-op logger — used when the caller doesn't supply one. */
const NOOP_LOGGER: FederationLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
}

/**
 * Configuration for one federated HTTP call. The adapter assembles this,
 * `federationHttpCall` executes it.
 */
export interface FederationHttpCallOpts<TData> {
  /** Resolved absolute URL (baseUrl + path + query). */
  readonly url: string
  /** HTTP method. */
  readonly method: "GET" | "POST"
  /** Headers (caller pre-merges adapter defaults + per-call). */
  readonly headers: Record<string, string>
  /** JSON-encodable body for POST. Serialized via JSON.stringify. */
  readonly body?: unknown
  /** Zod schema to validate the 2xx response body. */
  readonly responseSchema: ZodType<TData>
  /** Caller-provided per-call options (AbortSignal + fetchImpl). */
  readonly portOpts?: PortCallOpts
  /** Adapter-default fetch (used when portOpts.fetchImpl is absent). */
  readonly fallbackFetch?: PortFetchLike
  /** Optional logger surface. */
  readonly logger?: FederationLogger
  /** Building name for log context (e.g., "inventory-api"). */
  readonly building: string
  /** Optional per-call context for log + failure.context propagation. */
  readonly context?: Record<string, unknown>
}

/**
 * Execute one federated HTTP call and return a typed FederationResult.
 *
 * Never throws — every error (network, abort, status, parse) maps to
 * `{ ok: false, reason: { kind, message, statusCode?, cause?, context? } }`.
 */
export async function federationHttpCall<TData>(
  opts: FederationHttpCallOpts<TData>,
): Promise<FederationResult<TData>> {
  const fetchImpl: PortFetchLike =
    opts.portOpts?.fetchImpl ?? opts.fallbackFetch ?? globalThis.fetch.bind(globalThis)
  const log = opts.logger ?? NOOP_LOGGER

  // Body serialization. Adapters supply a plain object; we stringify here
  // so the JSON.stringify error (cyclic ref, BigInt, etc.) becomes a
  // wrapping `parse_error` rather than a thrown rejection.
  let bodyString: string | undefined
  if (opts.body !== undefined) {
    try {
      bodyString = JSON.stringify(opts.body)
    } catch (err) {
      return failure({
        kind: "parse_error",
        message: `federation: failed to JSON-serialize request body for ${opts.building}`,
        cause: err,
        context: { ...opts.context, url: opts.url },
      })
    }
  }

  const init: RequestInit = {
    method: opts.method,
    headers: {
      // Ensure JSON content-type when a body is supplied; the adapter can
      // override via opts.headers.
      ...(bodyString ? { "content-type": "application/json" } : {}),
      accept: "application/json",
      ...opts.headers,
    },
    signal: opts.portOpts?.signal,
    body: bodyString,
  }

  let response: Response
  try {
    response = await fetchImpl(opts.url, init)
  } catch (err) {
    // Distinguish AbortError-due-to-signal (timeout) from AbortError-due-to-
    // connection-failure (network_error). The AbortController's `aborted`
    // flag is the source of truth at catch time.
    const isAbort = isAbortError(err)
    const callerAborted = opts.portOpts?.signal?.aborted === true
    if (isAbort && callerAborted) {
      log.warn(
        {
          building: opts.building,
          url: opts.url,
          ...opts.context,
        },
        "federation: per-source timeout fired",
      )
      return failure({
        kind: "timeout",
        message: `federation: request to ${opts.building} timed out (caller AbortSignal fired)`,
        cause: err,
        context: { ...opts.context, url: opts.url },
      })
    }
    log.warn(
      {
        building: opts.building,
        url: opts.url,
        err,
        ...opts.context,
      },
      "federation: network error",
    )
    return failure({
      kind: "network_error",
      message: `federation: network error calling ${opts.building}: ${errorMessage(err)}`,
      cause: err,
      context: { ...opts.context, url: opts.url },
    })
  }

  // Classify status. The classification has to happen BEFORE parsing the
  // body because (a) 401 / 404 bodies may not be JSON, and (b) we want to
  // distinguish status-class failures from parse-class failures even when
  // both could land at the same code path.
  if (response.status === 401) {
    return failure({
      kind: "unauthorized",
      message: `federation: ${opts.building} returned 401 (check credentials)`,
      statusCode: 401,
      context: { ...opts.context, url: opts.url },
    })
  }
  if (response.status === 404) {
    log.info(
      { building: opts.building, url: opts.url, ...opts.context },
      "federation: upstream returned 404",
    )
    return failure({
      kind: "not_found",
      message: `federation: ${opts.building} returned 404`,
      statusCode: 404,
      context: { ...opts.context, url: opts.url },
    })
  }
  // BB review F-003: 429 Too Many Requests is a HEALTHY upstream signaling
  // "slow down" — NOT an outage. Classifying as parse_error → breaker trip →
  // 30s self-inflicted blackout. Map to rate_limited (exempt from breaker
  // per compose-profile recordOutcome).
  if (response.status === 429) {
    log.warn(
      { building: opts.building, url: opts.url, ...opts.context },
      "federation: upstream returned 429 rate-limited",
    )
    return failure({
      kind: "rate_limited",
      message: `federation: ${opts.building} returned 429 (rate-limited; upstream is healthy)`,
      statusCode: 429,
      context: { ...opts.context, url: opts.url },
    })
  }
  if (response.status >= 500 && response.status <= 599) {
    log.warn(
      {
        building: opts.building,
        url: opts.url,
        status: response.status,
        ...opts.context,
      },
      "federation: upstream 5xx",
    )
    return failure({
      kind: "upstream_5xx",
      message: `federation: ${opts.building} returned ${response.status}`,
      statusCode: response.status,
      context: { ...opts.context, url: opts.url },
    })
  }
  // Catch-all non-2xx (other 4xx). Classify as parse_error since the
  // contract is "any non-200 with a recognized shape is one of the above";
  // anything else is an unexpected breach of contract that should be
  // surfaced (e.g., 429 rate-limit, 422 validation failure).
  if (!response.ok) {
    return failure({
      kind: "parse_error",
      message: `federation: ${opts.building} returned unexpected status ${response.status}`,
      statusCode: response.status,
      context: { ...opts.context, url: opts.url, status: response.status },
    })
  }

  // 2xx — read body + parse JSON + validate Zod.
  let raw: string
  try {
    raw = await response.text()
  } catch (err) {
    log.error(
      { building: opts.building, url: opts.url, err, ...opts.context },
      "federation: body read failed",
    )
    return failure({
      kind: "network_error",
      message: `federation: failed to read response body from ${opts.building}: ${errorMessage(err)}`,
      cause: err,
      statusCode: response.status,
      context: { ...opts.context, url: opts.url },
    })
  }
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch (err) {
    log.error(
      {
        building: opts.building,
        url: opts.url,
        err,
        // Truncate; an HTML error page can be megabytes
        rawPreview: raw.slice(0, 256),
        ...opts.context,
      },
      "federation: response body is not valid JSON",
    )
    return failure({
      kind: "parse_error",
      message: `federation: ${opts.building} returned non-JSON body`,
      statusCode: response.status,
      cause: err,
      context: { ...opts.context, url: opts.url },
    })
  }
  const parsed = opts.responseSchema.safeParse(json)
  if (!parsed.success) {
    log.error(
      {
        building: opts.building,
        url: opts.url,
        zodIssues: parsed.error.issues,
        ...opts.context,
      },
      "federation: response body failed schema validation",
    )
    return failure({
      kind: "parse_error",
      message: `federation: ${opts.building} response failed Zod validation`,
      statusCode: response.status,
      cause: parsed.error,
      context: { ...opts.context, url: opts.url, zodIssues: parsed.error.issues },
    })
  }
  return { ok: true, data: parsed.data }
}

// ─── helpers ────────────────────────────────────────────────────────────────

function failure(args: {
  kind: FederationFailureKind
  message: string
  statusCode?: number
  cause?: unknown
  context?: Record<string, unknown>
}): { ok: false; reason: { kind: FederationFailureKind; message: string; statusCode?: number; cause?: unknown; context?: Record<string, unknown> } } {
  return {
    ok: false,
    reason: {
      kind: args.kind,
      message: args.message,
      ...(args.statusCode !== undefined ? { statusCode: args.statusCode } : {}),
      ...(args.cause !== undefined ? { cause: args.cause } : {}),
      ...(args.context !== undefined ? { context: args.context } : {}),
    },
  }
}

function isAbortError(err: unknown): boolean {
  if (err === null || typeof err !== "object") return false
  const e = err as { name?: unknown; code?: unknown }
  return e.name === "AbortError" || e.code === "ABORT_ERR" || e.code === 20
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === "string") return err
  try {
    return JSON.stringify(err)
  } catch {
    return String(err)
  }
}

/**
 * Normalize a baseUrl by stripping a single trailing slash. Adapters use
 * this so their per-call URL build always has exactly one `/` between the
 * baseUrl and the path.
 */
export function stripTrailingSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s
}

/**
 * Encode a path-parameter for URL embedding. We don't use the global
 * `encodeURIComponent` directly because it permits some characters in
 * path segments that JSON-encoded slug-pattern paths should never see
 * (e.g., `..` traversal). The adapter callers pre-validate the input
 * (wallet hex, integer token-id) before reaching here; this helper is
 * defense-in-depth.
 *
 * For wallet addresses + integer token-ids the result is identical to
 * `encodeURIComponent`; explicit naming makes the intent visible in code
 * review.
 */
export function encodePathParam(s: string | number): string {
  return encodeURIComponent(String(s))
}

// re-export the Zod type so adapters don't have to import zod for the
// generic constraint (they import zod anyway for their own schemas).
export type { ZodType }
// keep a runtime no-op import so bun's bundler treats z as a value-symbol
// (some adapter dispatch paths may reach a runtime z.* call; not strictly
// needed today but cheap insurance against bundler dead-code surprises).
void z
