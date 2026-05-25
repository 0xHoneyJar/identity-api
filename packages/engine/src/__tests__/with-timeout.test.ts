/**
 * with-timeout.test.ts — unit tests for the per-call timeout helper (T2.2).
 *
 * Direct-time-based tests: we don't use bun's fake timers because the helper
 * is a thin pass-through to setTimeout + AbortController + clearTimeout —
 * the test surface is "does the abort signal actually fire by ms, and does
 * clear() actually cancel it." Short sleeps (10-50ms) keep the suite fast.
 *
 * Per T2.2 runbook: helper sits in @freeside-auth/engine.
 */

import { describe, expect, it } from "bun:test"
import { withTimeout } from "../with-timeout"

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

describe("withTimeout (T2.2)", () => {
  it("aborts the signal after the configured ms", async () => {
    const handle = withTimeout(20)
    expect(handle.signal.aborted).toBe(false)
    await sleep(40)
    expect(handle.signal.aborted).toBe(true)
    handle.clear() // safe no-op after firing
  })

  it("does NOT abort before the deadline", async () => {
    const handle = withTimeout(50)
    await sleep(10)
    expect(handle.signal.aborted).toBe(false)
    handle.clear()
  })

  it("clear() cancels a pending timer — signal stays not-aborted", async () => {
    const handle = withTimeout(30)
    handle.clear()
    await sleep(50)
    expect(handle.signal.aborted).toBe(false)
  })

  it("clear() after the timer fired is a no-op (no throw)", async () => {
    const handle = withTimeout(10)
    await sleep(30)
    expect(handle.signal.aborted).toBe(true)
    expect(() => handle.clear()).not.toThrow()
  })

  it("each call returns an independent signal (no aliasing)", async () => {
    const a = withTimeout(15)
    const b = withTimeout(100)
    await sleep(35)
    expect(a.signal.aborted).toBe(true)
    expect(b.signal.aborted).toBe(false)
    b.clear()
  })

  it("returns a stable signal object reference (orchestrator may stash + forward)", () => {
    const handle = withTimeout(1000)
    const first = handle.signal
    const second = handle.signal
    expect(first).toBe(second)
    handle.clear()
  })
})
