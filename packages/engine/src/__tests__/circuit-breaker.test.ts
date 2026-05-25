/**
 * circuit-breaker.test.ts — unit tests for the per-source breaker (T2.2).
 *
 * Tests use an injected `now()` so they're deterministic and fast (no real
 * sleeps for cooldown math). State-transition table coverage:
 *
 *   closed → closed       (success while closed)
 *   closed → open         (N failures within window)
 *   open → open           (call while open / before cooldown)
 *   open → half_open      (isOpen() after cooldown)
 *   half_open → closed    (success in probe path)
 *   half_open → open      (failure in probe path; cooldown restarts)
 *
 * Also: rolling-window failure-eviction edge cases.
 */

import { describe, expect, it } from "bun:test"
import { CircuitBreaker } from "../circuit-breaker"

/** Mutable time-source for deterministic tests. */
function mkClock(start = 1_000_000) {
  const t = { v: start }
  return {
    tick: (ms: number) => {
      t.v += ms
    },
    now: () => t.v,
  }
}

describe("CircuitBreaker (T2.2 · SDD §6.4)", () => {
  it("starts closed; isOpen() is false", () => {
    const cb = new CircuitBreaker()
    expect(cb.__getState()).toBe("closed")
    expect(cb.isOpen()).toBe(false)
  })

  it("recordSuccess on a closed breaker is a no-op (state stays closed)", () => {
    const cb = new CircuitBreaker()
    cb.recordSuccess()
    expect(cb.__getState()).toBe("closed")
    expect(cb.__getFailureCount()).toBe(0)
  })

  it("opens after N consecutive failures within the rolling window", () => {
    const clock = mkClock()
    const cb = new CircuitBreaker({
      failureThreshold: 5,
      rollingWindowMs: 60_000,
      cooldownMs: 30_000,
      now: clock.now,
    })
    for (let i = 0; i < 4; i++) cb.recordFailure()
    expect(cb.__getState()).toBe("closed")
    expect(cb.__getFailureCount()).toBe(4)
    cb.recordFailure() // 5th — trip
    expect(cb.__getState()).toBe("open")
    expect(cb.isOpen()).toBe(true)
  })

  it("does NOT open if failures spread beyond rolling window (eviction works)", () => {
    const clock = mkClock()
    const cb = new CircuitBreaker({
      failureThreshold: 3,
      rollingWindowMs: 1_000,
      cooldownMs: 5_000,
      now: clock.now,
    })
    cb.recordFailure()
    cb.recordFailure()
    clock.tick(1_500) // both fall out of the 1s window
    cb.recordFailure()
    expect(cb.__getState()).toBe("closed")
    expect(cb.__getFailureCount()).toBe(1)
  })

  it("recordSuccess on closed breaker clears the failure counter", () => {
    const clock = mkClock()
    const cb = new CircuitBreaker({
      failureThreshold: 3,
      rollingWindowMs: 60_000,
      cooldownMs: 5_000,
      now: clock.now,
    })
    cb.recordFailure()
    cb.recordFailure()
    expect(cb.__getFailureCount()).toBe(2)
    cb.recordSuccess()
    expect(cb.__getFailureCount()).toBe(0)
    expect(cb.__getState()).toBe("closed")
  })

  it("stays open during the cooldown window", () => {
    const clock = mkClock()
    const cb = new CircuitBreaker({
      failureThreshold: 2,
      rollingWindowMs: 60_000,
      cooldownMs: 10_000,
      now: clock.now,
    })
    cb.recordFailure()
    cb.recordFailure()
    expect(cb.isOpen()).toBe(true)
    clock.tick(5_000)
    expect(cb.isOpen()).toBe(true)
    clock.tick(4_999)
    expect(cb.isOpen()).toBe(true)
  })

  it("transitions open → half_open after cooldown elapses (probed via isOpen())", () => {
    const clock = mkClock()
    const cb = new CircuitBreaker({
      failureThreshold: 2,
      rollingWindowMs: 60_000,
      cooldownMs: 10_000,
      now: clock.now,
    })
    cb.recordFailure()
    cb.recordFailure()
    expect(cb.__getState()).toBe("open")
    clock.tick(10_001)
    expect(cb.isOpen()).toBe(false) // half-open: call permitted
    expect(cb.__getState()).toBe("half_open")
  })

  it("half_open + recordSuccess → closed (probe succeeded)", () => {
    const clock = mkClock()
    const cb = new CircuitBreaker({
      failureThreshold: 2,
      rollingWindowMs: 60_000,
      cooldownMs: 10_000,
      now: clock.now,
    })
    cb.recordFailure()
    cb.recordFailure()
    clock.tick(10_001)
    cb.isOpen() // transitions to half_open
    cb.recordSuccess()
    expect(cb.__getState()).toBe("closed")
    expect(cb.__getFailureCount()).toBe(0)
  })

  it("half_open + recordFailure → open (probe failed, cooldown restarts)", () => {
    const clock = mkClock()
    const cb = new CircuitBreaker({
      failureThreshold: 2,
      rollingWindowMs: 60_000,
      cooldownMs: 10_000,
      now: clock.now,
    })
    cb.recordFailure()
    cb.recordFailure()
    clock.tick(10_001)
    cb.isOpen() // → half_open
    cb.recordFailure()
    expect(cb.__getState()).toBe("open")
    // cooldown restarted
    clock.tick(5_000)
    expect(cb.isOpen()).toBe(true)
    clock.tick(5_001)
    expect(cb.isOpen()).toBe(false) // now half_open again
    expect(cb.__getState()).toBe("half_open")
  })

  it("uses the documented defaults (threshold 5, window 60s, cooldown 30s)", () => {
    const clock = mkClock()
    const cb = new CircuitBreaker({ now: clock.now })
    for (let i = 0; i < 4; i++) cb.recordFailure()
    expect(cb.__getState()).toBe("closed")
    cb.recordFailure() // 5th
    expect(cb.__getState()).toBe("open")
    clock.tick(29_999)
    expect(cb.isOpen()).toBe(true)
    clock.tick(2)
    expect(cb.isOpen()).toBe(false) // half-open at >= 30s
  })

  it("recordSuccess while open is a defensive no-op (state stays open)", () => {
    const clock = mkClock()
    const cb = new CircuitBreaker({
      failureThreshold: 2,
      rollingWindowMs: 60_000,
      cooldownMs: 10_000,
      now: clock.now,
    })
    cb.recordFailure()
    cb.recordFailure()
    expect(cb.__getState()).toBe("open")
    cb.recordSuccess() // shouldn't have been called (caller bypassed isOpen)
    expect(cb.__getState()).toBe("open")
  })

  it("recordFailure while open is a defensive no-op", () => {
    const clock = mkClock()
    const cb = new CircuitBreaker({
      failureThreshold: 2,
      rollingWindowMs: 60_000,
      cooldownMs: 10_000,
      now: clock.now,
    })
    cb.recordFailure()
    cb.recordFailure()
    const openedAt = clock.now()
    expect(cb.__getState()).toBe("open")
    clock.tick(5_000)
    cb.recordFailure() // illegal-but-defended call
    // openedAt should NOT have been refreshed; cooldown still tracks original
    expect(cb.__getState()).toBe("open")
    clock.tick(5_001) // 10_001ms after the ORIGINAL open
    expect(cb.isOpen()).toBe(false)
    void openedAt
  })

  it("survives a mixed-traffic interleave (failures + success drop counter)", () => {
    const clock = mkClock()
    const cb = new CircuitBreaker({
      failureThreshold: 3,
      rollingWindowMs: 60_000,
      cooldownMs: 10_000,
      now: clock.now,
    })
    cb.recordFailure() // 1
    cb.recordFailure() // 2
    cb.recordSuccess() // counter cleared
    cb.recordFailure() // 1 (post-clear)
    cb.recordFailure() // 2
    expect(cb.__getState()).toBe("closed") // hasn't tripped
    cb.recordFailure() // 3 — trip
    expect(cb.__getState()).toBe("open")
  })
})
