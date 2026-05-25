/**
 * circuit-breaker.ts — lightweight in-memory per-source circuit-breaker (T2.2).
 *
 * Per SDD §6.4: "Per-source consecutive-failure counter → if a source trips
 * N consecutive timeouts, short-circuit it to `degraded` for a cooldown
 * window (avoids paying the full timeout on a known-down source). Keeps
 * the p95 honest during a sustained outage. Implementation is a simple
 * in-memory counter on the single Railway instance (NFR-3 single-service
 * makes shared state trivial — no Redis needed in v1)."
 *
 * Three states:
 *   - `closed`     — calls flow through normally; failures increment counter
 *   - `open`       — calls short-circuit (skip HTTP, return circuit_open)
 *   - `half_open`  — cooldown elapsed; ONE call permitted as a probe.
 *                    Success → closed; failure → open (cooldown restart).
 *
 * State transitions:
 *
 *      ┌──────── recordSuccess (resets counter)
 *      ▼
 *   ┌─────────┐  N consecutive failures within rolling window
 *   │ closed  │ ───────────────────────────────────────────────► ┌──────┐
 *   └─────────┘                                                  │ open │
 *      ▲                                                         └──────┘
 *      │ recordSuccess                                              │
 *      │                                                            │ cooldownMs elapsed
 *      │                                                            ▼
 *   ┌───────────┐         recordFailure         ┌─────────────────┐
 *   │ half_open │ ─────────────────────────────► │ open (restart) │
 *   └───────────┘                                └─────────────────┘
 *
 * Why the rolling window matters: SDD §6.4 says "consecutive" but a strict
 * consecutive counter rejects the "5 failures spread over hours, then 1
 * success in between" case as healthy — which it is. We implement the
 * counter inside a rolling time window so a transient sustained outage
 * trips the breaker but a slow trickle of failures doesn't.
 *
 * Defaults (per SDD §6.4 spec — "lightweight v1"; the doc doesn't pin
 * exact numbers, so the orchestrator picks per the runbook):
 *   - failureThreshold: 5
 *   - rollingWindowMs: 60_000 (1 minute)
 *   - cooldownMs:     30_000 (30 seconds)
 *
 * Why one breaker per source (vs one shared): independence — one source's
 * outage shouldn't open the breaker for the other two. The orchestrator
 * instantiates ONE per source and threads them via deps.
 *
 * Source: SDD §6.4 (circuit-breaker spec), T2.1 build notes §6, PRD v3.0
 * NFR-1 (latency budget) + NFR-2 (downstream isolation).
 */

// ─── public types ──────────────────────────────────────────────────────────

export type CircuitBreakerState = "closed" | "open" | "half_open"

export interface CircuitBreakerOpts {
  /**
   * Number of failures within the rolling window required to open the breaker.
   * Default: 5.
   */
  readonly failureThreshold?: number
  /**
   * Window over which failures are counted. Failures older than this drop off.
   * Default: 60_000 ms.
   */
  readonly rollingWindowMs?: number
  /**
   * After opening, how long to stay open before transitioning to half_open
   * (where the next call is permitted as a probe). Default: 30_000 ms.
   */
  readonly cooldownMs?: number
  /**
   * Time source — injectable for tests. Default: Date.now.
   */
  readonly now?: () => number
}

// ─── implementation ────────────────────────────────────────────────────────

export class CircuitBreaker {
  private state: CircuitBreakerState = "closed"
  /** Timestamps of recent failures (within the rolling window). */
  private readonly failureTimestamps: number[] = []
  /** When the breaker opened; consulted to decide half-open transition. */
  private openedAt: number | null = null

  private readonly failureThreshold: number
  private readonly rollingWindowMs: number
  private readonly cooldownMs: number
  private readonly now: () => number

  constructor(opts: CircuitBreakerOpts = {}) {
    this.failureThreshold = opts.failureThreshold ?? 5
    this.rollingWindowMs = opts.rollingWindowMs ?? 60_000
    this.cooldownMs = opts.cooldownMs ?? 30_000
    this.now = opts.now ?? Date.now
  }

  /**
   * Is the breaker currently open?
   *
   * SIDE EFFECT: if the breaker is `open` AND the cooldown has elapsed,
   * this transition's the state to `half_open` and returns `false` — the
   * caller proceeds with the probe call. This is the canonical "check
   * before call" pattern; isOpen() returning false means "call permitted."
   *
   * Why a side-effecting check (vs a separate `tryHalfOpen()`): the
   * orchestrator's call sites are uniform — `if (breaker.isOpen()) skip;
   * else call port`. Making the half-open transition implicit in the
   * check keeps the call site clean.
   */
  isOpen(): boolean {
    this.evictExpiredFailures()
    if (this.state === "open" && this.openedAt !== null) {
      if (this.now() - this.openedAt >= this.cooldownMs) {
        this.state = "half_open"
      }
    }
    return this.state === "open"
  }

  /**
   * Record a successful call. Resets the breaker:
   *   - `closed`     → counter cleared (idempotent in steady state).
   *   - `half_open`  → `closed` (probe succeeded).
   *   - `open`       → no-op (shouldn't happen — caller checked isOpen()
   *                    first; defensive).
   */
  recordSuccess(): void {
    if (this.state === "open") {
      // Defensive: success while open means the caller bypassed isOpen()
      // or made a parallel call. Don't trust the success to close — wait
      // for the half-open probe path.
      return
    }
    this.state = "closed"
    this.failureTimestamps.length = 0
    this.openedAt = null
  }

  /**
   * Record a failed call. Effect depends on state:
   *   - `closed`    → push timestamp; if count >= threshold within window,
   *                   transition to `open`.
   *   - `half_open` → re-open (probe failed); cooldown restarts.
   *   - `open`      → no-op (shouldn't happen; defensive).
   */
  recordFailure(): void {
    if (this.state === "open") {
      // Defensive: see recordSuccess() comment.
      return
    }
    if (this.state === "half_open") {
      // Probe failed — re-open, restart cooldown.
      this.state = "open"
      this.openedAt = this.now()
      // Half-open never accumulates timestamps; reset to be safe.
      this.failureTimestamps.length = 0
      return
    }
    // closed: increment counter, check threshold.
    this.failureTimestamps.push(this.now())
    this.evictExpiredFailures()
    if (this.failureTimestamps.length >= this.failureThreshold) {
      this.state = "open"
      this.openedAt = this.now()
    }
  }

  /**
   * Drop timestamps older than the rolling window. Called before any
   * threshold check; keeps the array bounded in steady state.
   */
  private evictExpiredFailures(): void {
    const cutoff = this.now() - this.rollingWindowMs
    while (this.failureTimestamps.length > 0 && this.failureTimestamps[0]! < cutoff) {
      this.failureTimestamps.shift()
    }
  }

  // ─── test seams ──────────────────────────────────────────────────────────

  /** Current state (inspectable for tests). */
  __getState(): CircuitBreakerState {
    return this.state
  }

  /** Current failure count (within window — inspectable for tests). */
  __getFailureCount(): number {
    this.evictExpiredFailures()
    return this.failureTimestamps.length
  }
}
