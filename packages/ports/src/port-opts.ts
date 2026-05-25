/**
 * PortCallOpts — shared per-call options for federation client ports (T2.1).
 *
 * Every federation port method (`InventoryPort.getHoldings`, `ScorePort.getScore`,
 * `CodexPort.getMiberaTraits`) accepts an optional `PortCallOpts` parameter as
 * its second argument. The opts surface stays narrow on purpose: T2.2's
 * compose-fan-out orchestrator passes a per-source AbortSignal so a slow
 * upstream cannot tax the overall /v1/profile latency budget (FR-P2).
 *
 * Per SDD §5.4: the per-source timeout strategy at T2.2 wraps each port call
 * in `AbortController` + `setTimeout(ctrl.abort, perSourceTimeoutMs)`. The
 * adapter implementation forwards the `signal` to the underlying `fetch`,
 * which raises `AbortError` on the controller firing; the adapter classifies
 * that as `{ ok: false, reason: { kind: 'timeout', ... } }` per the
 * discriminated-union result contract.
 *
 * Design notes:
 *
 *   - `signal: AbortSignal` is the SAME shape Node, Bun, Deno, and browsers
 *     accept on `fetch(input, { signal })`. No transport-shimming required.
 *   - `fetchImpl` is a test seam (mirror of the SDK's transport `FetchLike`
 *     pattern at packages/sdk/src/transport.ts). Adapters default to global
 *     `fetch`; tests pass a stub to assert request shape / inject responses.
 *   - We intentionally do NOT add `headers` here — per-call header overrides
 *     are a constructor concern (each adapter takes a `defaultHeaders` config
 *     at construction time, which already covers the static-key auth case).
 *     If a future call needs request-scoped headers (e.g., a `X-Trace-Id`
 *     forward), we extend this shape.
 *
 * Why a shared type vs three copies (one per port file):
 *   - The compose orchestrator at T2.2 will accept all three ports as deps
 *     and pass the SAME AbortSignal to each (one per-source budget, three
 *     parallel calls). A shared type lets T2.2 declare its dep parameter
 *     shape uniformly: `Array<(opts: PortCallOpts) => Promise<...>>`.
 *   - Keeps the surface narrow: if it grows, it grows for all three.
 */

/**
 * Subset of WHATWG `fetch` we depend on — also lets tests pass narrowed
 * stubs. Adapter implementations import this type and call `opts.fetchImpl
 * ?? globalThis.fetch` to resolve the actual transport.
 */
export type PortFetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>

/**
 * Per-call options for any federation port method.
 *
 * Pass:
 *   - `signal` to enable cancellation (T2.2 fan-out's per-source timeout)
 *   - `fetchImpl` to inject a test transport
 *
 * Omit both for the production happy path.
 */
export interface PortCallOpts {
  /**
   * AbortSignal forwarded to the underlying `fetch`. When the signal fires
   * (typically because T2.2's per-source `setTimeout` lapsed), the in-flight
   * request is canceled and the adapter resolves to
   * `{ ok: false, reason: { kind: 'timeout', ... } }`.
   *
   * Per the discriminated-union result contract (see each port file), the
   * adapter MUST distinguish AbortError-due-to-signal from AbortError-due-to-
   * connection-failure; the former is `timeout`, the latter is `network_error`.
   */
  readonly signal?: AbortSignal
  /**
   * Override the global `fetch`. Useful for tests that want to assert request
   * shape (URL, headers, body) without standing up a real HTTP server, or for
   * deployments that route through a custom transport layer (e.g., a service-
   * mesh proxy with mTLS).
   */
  readonly fetchImpl?: PortFetchLike
}
