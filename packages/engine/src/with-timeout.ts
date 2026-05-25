/**
 * with-timeout.ts — per-call AbortController + setTimeout helper (T2.2).
 *
 * The compose orchestrator (`compose-profile.ts`) creates one of these per
 * federation call so a slow upstream cannot tax the overall /v1/profile
 * latency budget (FR-P2 / NFR-1 < 800ms p95). The pattern:
 *
 *   const ctrl = withTimeout(500)
 *   try {
 *     const result = await port.getHoldings(input, { signal: ctrl.signal })
 *     // result is FederationResult<...> — 'timeout' kind if aborted
 *   } finally {
 *     ctrl.clear()
 *   }
 *
 * The adapter forwards the `signal` to `fetch`; abort raises an AbortError
 * which the shared `federationHttpCall` helper classifies as
 * `{ ok: false, reason: { kind: 'timeout', ... } }`. The disambiguation
 * between abort-due-to-timeout and abort-due-to-connection-failure lives
 * in the adapter (see packages/adapters/src/federation-http.ts).
 *
 * Why call `.clear()` always: if the federation call completed BEFORE the
 * timer fired, leaving the timer scheduled would leak a setTimeout entry
 * in the event-loop queue until it fires (harmlessly aborting an already-
 * complete AbortController, but still a minor inefficiency). Calling
 * `.clear()` is the cleanup contract.
 *
 * Hosting choice: helper sits in `@freeside-auth/engine` (not `ports`)
 * because it's an orchestration primitive — it's the orchestrator's
 * private machinery, not a port-surface concern. Adapters use the
 * AbortSignal opaquely; only the orchestrator constructs them.
 *
 * Source: SDD §6.2 (per-source timeout budget) + §6.3 (degradation
 * contract pseudocode) + T2.1 build notes §6 (T2.2 integration sketch).
 */

/**
 * Construct an AbortController whose signal fires after `ms` milliseconds.
 *
 * Returns:
 *   - `signal` — pass into `PortCallOpts.signal` for the federation call
 *   - `clear` — call after the federation call resolves (success OR failure)
 *     to cancel the pending timer (no-op if it already fired)
 *
 * Edge cases:
 *   - `ms <= 0`: the underlying `setTimeout(... 0)` queues a near-immediate
 *     abort. The orchestrator MUST pass positive values; the helper does
 *     NOT validate (caller's contract — the bead spec defaults are 500/
 *     300/400 so the negative-or-zero case is a programmer-error path).
 *   - `signal.aborted` after `clear()`: false (the abort never fired).
 *   - `signal.aborted` after timer firing: true.
 */
export interface TimeoutHandle {
  /** AbortSignal that fires after the configured timeout. */
  readonly signal: AbortSignal
  /** Cancel the pending timer (no-op if it already fired). */
  clear(): void
}

export function withTimeout(ms: number): TimeoutHandle {
  const ctrl = new AbortController()
  const timer = setTimeout(() => {
    ctrl.abort()
  }, ms)
  return {
    signal: ctrl.signal,
    clear: () => clearTimeout(timer),
  }
}
