/**
 * FederationResult — shared discriminated-union for federation port returns (T2.1).
 *
 * Every federation port method (`InventoryPort.getHoldings`, `ScorePort.getScore`,
 * `CodexPort.getMiberaTraits`) returns `Promise<FederationResult<TData>>`:
 *
 *   - `{ ok: true, data: TData }`                 — successful response, validated.
 *   - `{ ok: false, reason: FederationFailure }`  — every failure class.
 *
 * Why a result-type instead of throwing typed errors:
 *
 *   T2.2 will fan out the three federation calls with `Promise.allSettled`.
 *   In a throw-based contract, every `.catch(...)` ends up needing a typed
 *   downcast — `if (e instanceof TimeoutError)`, etc. — and Promise.allSettled
 *   wraps the catch into `{ status: 'rejected', reason: unknown }` which
 *   loses the typed-error knowledge anyway. With the discriminated-union
 *   contract, T2.2 writes:
 *
 *     const [holdings, score, codex] = await Promise.all([
 *       inventory.getHoldings({ walletAddress }, { signal }),
 *       scoreApi.getScore({ walletAddress }, { signal }),
 *       codex.getMiberaTraits({ tokenIds }, { signal }),
 *     ]);
 *     // Every entry is { ok: true, data } | { ok: false, reason }.
 *     // No try/catch. No instanceof. No allSettled boilerplate.
 *
 *   And each adapter resolves its own promise no matter what — the promise
 *   only rejects on a programmer-error path (e.g., a Zod schema bug, a
 *   bug in the adapter itself). Network / HTTP / parse failures all show
 *   up as `ok: false` and the fan-out keeps walking.
 *
 * Failure-class table:
 *
 *   - `timeout`        — the caller's AbortSignal fired (T2.2 per-source budget)
 *   - `unauthorized`   — 401 from upstream (bad API key, expired token)
 *   - `not_found`      — 404 from upstream (e.g., wallet not in score-api)
 *   - `upstream_5xx`   — 500-599 from upstream (treat as transient)
 *   - `parse_error`    — 2xx body failed Zod validation (schema drift)
 *   - `network_error`  — DNS failure, connection refused, TLS error,
 *                        connection reset, body read mid-stream, etc.
 *
 * The `statusCode` field is populated when an HTTP response was received
 * (4xx/5xx); it's absent on timeout / network errors that occurred before
 * the response landed. The `cause` field carries the underlying error
 * object for log forensics — callers should NOT branch on it.
 */

export type FederationFailureKind =
  | "timeout"
  | "unauthorized"
  | "not_found"
  | "upstream_5xx"
  | "parse_error"
  | "network_error"

/**
 * Structured failure with kind + diagnostic context.
 *
 * `statusCode` semantics:
 *   - `401` for `unauthorized`
 *   - `404` for `not_found`
 *   - the actual 5xx for `upstream_5xx` (500, 502, 503, 504, ...)
 *   - present for `parse_error` when the upstream DID respond 2xx but with
 *     a body the schema rejected
 *   - ABSENT for `timeout` (no response received) and usually ABSENT for
 *     `network_error` (depends on phase of failure)
 */
export interface FederationFailure {
  readonly kind: FederationFailureKind
  readonly message: string
  /** HTTP status code when an HTTP response was received; absent otherwise. */
  readonly statusCode?: number
  /**
   * The underlying error object (for forensic logging). Do NOT branch on
   * this — it is the wire-level cause, deliberately untyped (Error,
   * AbortError, TypeError-from-fetch, ZodError, etc.).
   */
  readonly cause?: unknown
  /**
   * Optional diagnostic key/value pairs the adapter can attach (e.g.,
   * `{ wallet: '0x...', upstreamUrl: 'https://...' }`). Surfaced into
   * T2.2's `degraded[]` array as structured signal.
   */
  readonly context?: Readonly<Record<string, unknown>>
}

/**
 * Discriminated union return type. Generic over the success-data payload
 * (each port specializes `TData` to its own response shape).
 */
export type FederationResult<TData> =
  | { readonly ok: true; readonly data: TData }
  | { readonly ok: false; readonly reason: FederationFailure }
