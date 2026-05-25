/**
 * auth-nonces.test.ts — engine orchestrator tests (T1.4, bead arrakis-91aj).
 *
 * Pure-logic tests against a hand-rolled SpinePort mock (mirrors the
 * resolve-spine.test.ts T1.5 pattern). No DB needed.
 *
 * Coverage:
 *   - mintAuthNonce delegates + emits 'nonce_minted' audit with the right payload
 *   - mintAuthNonce default ttlSec passes through (we don't inject TTL here,
 *     the adapter owns the default; engine just relays opts).
 *   - consumeAuthNonce ok=true path emits 'nonce_consumed' (NOT 'nonce_rejected')
 *   - consumeAuthNonce ok=false path: for each of the 4 reasons, emits
 *     'nonce_rejected' with reason in payload.
 *   - actor default = 'system'; caller override respected.
 *
 * The DB-side atomic-consume race + wire-level behavior is the adapter
 * test's job (postgres-spine-adapter-nonces.test.ts). Here we just verify
 * the orchestration contract: which method calls happen, what audit rows
 * the engine emits, in what order.
 */

import { beforeEach, describe, expect, it } from "bun:test"
import { mintAuthNonce, consumeAuthNonce } from "../auth-nonces"
import type {
  SpinePort,
  SpineAuditEvent,
  MintNonceInput,
  ConsumeNonceInput,
  ConsumeNonceResult,
  MintNonceResult,
} from "@freeside-auth/ports"

// ─── mock SpinePort (nonce-focused; other methods are no-op stubs) ───────

interface MockSpine extends SpinePort {
  readonly trace: Array<{ method: string; args: unknown }>
  readonly audits: SpineAuditEvent[]
  mintNonceReturns?: MintNonceResult
  consumeNonceReturns?: ConsumeNonceResult
}

function buildMockSpine(): MockSpine {
  const trace: Array<{ method: string; args: unknown }> = []
  const audits: SpineAuditEvent[] = []
  const m: MockSpine = {
    trace,
    audits,
    // ── nonce methods: capture args + return overridable hooks ──
    async mintNonce(input: MintNonceInput): Promise<MintNonceResult> {
      trace.push({ method: "mintNonce", args: input })
      return (
        m.mintNonceReturns ?? {
          nonce: "fixture-nonce-abc",
          expires_at: "2026-05-24T00:05:00.000Z",
        }
      )
    },
    async consumeNonce(input: ConsumeNonceInput): Promise<ConsumeNonceResult> {
      trace.push({ method: "consumeNonce", args: input })
      return (
        m.consumeNonceReturns ?? {
          ok: true,
          message: "fixture-message",
          wallet_address: null,
        }
      )
    },
    async writeAuditEvent(event) {
      trace.push({ method: "writeAuditEvent", args: event })
      audits.push(event)
    },
    // ── other SpinePort methods: minimal stubs (not exercised here) ──
    async resolveByWallet() {
      return null
    },
    async resolveByAccount() {
      return null
    },
    async resolveByNym() {
      return null
    },
    async getIdentity() {
      return null
    },
    async mintUser() {
      return "00000000-0000-0000-0000-000000000001"
    },
    async linkWallet() {},
    async linkAccount() {},
    async claimNym() {},
    async setPrimary() {
      return true
    },
  }
  return m
}

// ─── tests ──────────────────────────────────────────────────────────────

describe("auth-nonces.ts engine orchestrators (T1.4)", () => {
  let spine: MockSpine

  beforeEach(() => {
    spine = buildMockSpine()
  })

  // ── mintAuthNonce ────────────────────────────────────────────────────

  it("mintAuthNonce delegates verbatim + emits 'nonce_minted' audit (actor default 'system')", async () => {
    spine.mintNonceReturns = {
      nonce: "test-nonce-xyz",
      expires_at: "2026-05-24T00:05:00.000Z",
    }
    const result = await mintAuthNonce(spine, {
      scheme: "siwe",
      message: "SIWE message text",
      walletAddress: "0xabc0000000000000000000000000000000000001",
    })
    // Return shape is the adapter's verbatim MintNonceResult.
    expect(result.nonce).toBe("test-nonce-xyz")
    expect(result.expires_at).toBe("2026-05-24T00:05:00.000Z")
    // The mintNonce call goes through with walletAddress (the engine
    // explicitly normalizes undefined → null so the port input is well-typed).
    expect(spine.trace[0]).toEqual({
      method: "mintNonce",
      args: {
        scheme: "siwe",
        message: "SIWE message text",
        walletAddress: "0xabc0000000000000000000000000000000000001",
        ttlSec: undefined,
      },
    })
    // Audit row: nonce_minted, user_id=null, actor='system', payload has
    // scheme + wallet_address + expires_at (NOT the message text).
    expect(spine.audits).toHaveLength(1)
    expect(spine.audits[0]).toEqual({
      event_type: "nonce_minted",
      user_id: null,
      actor: "system",
      payload: {
        scheme: "siwe",
        wallet_address: "0xabc0000000000000000000000000000000000001",
        expires_at: "2026-05-24T00:05:00.000Z",
      },
    })
  })

  it("mintAuthNonce respects caller-supplied actor", async () => {
    await mintAuthNonce(spine, {
      scheme: "eip191",
      message: "msg",
      actor: "self",
    })
    expect(spine.audits[0]!.actor).toBe("self")
  })

  it("mintAuthNonce passes ttlSec override through to the port", async () => {
    await mintAuthNonce(spine, {
      scheme: "siwe",
      message: "msg",
      ttlSec: 60,
    })
    expect((spine.trace[0]!.args as MintNonceInput).ttlSec).toBe(60)
  })

  it("mintAuthNonce normalizes missing walletAddress → null in the port call", async () => {
    await mintAuthNonce(spine, {
      scheme: "siwe",
      message: "no-wallet-hint",
    })
    expect((spine.trace[0]!.args as MintNonceInput).walletAddress).toBeNull()
  })

  // ── consumeAuthNonce ok=true ─────────────────────────────────────────

  it("consumeAuthNonce ok=true: emits 'nonce_consumed' (NOT 'nonce_rejected')", async () => {
    spine.consumeNonceReturns = {
      ok: true,
      message: "the message",
      wallet_address: "0xfeed000000000000000000000000000000000001",
    }
    const result = await consumeAuthNonce(spine, {
      nonce: "abc",
      expectedScheme: "siwe",
      actor: "self",
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.message).toBe("the message")
      expect(result.wallet_address).toBe("0xfeed000000000000000000000000000000000001")
    }
    expect(spine.audits).toHaveLength(1)
    expect(spine.audits[0]).toEqual({
      event_type: "nonce_consumed",
      user_id: null,
      actor: "self",
      payload: {
        scheme: "siwe",
        wallet_address: "0xfeed000000000000000000000000000000000001",
      },
    })
  })

  // ── consumeAuthNonce ok=false (each reason class) ────────────────────

  it("consumeAuthNonce ok=false reason='unknown': emits 'nonce_rejected' with reason in payload", async () => {
    spine.consumeNonceReturns = { ok: false, reason: "unknown" }
    const result = await consumeAuthNonce(spine, {
      nonce: "missing",
      expectedScheme: "siwe",
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe("unknown")
    expect(spine.audits[0]).toEqual({
      event_type: "nonce_rejected",
      user_id: null,
      actor: "system",
      payload: { scheme: "siwe", reason: "unknown" },
    })
  })

  it("consumeAuthNonce ok=false reason='used': emits 'nonce_rejected' with reason='used'", async () => {
    spine.consumeNonceReturns = { ok: false, reason: "used" }
    await consumeAuthNonce(spine, { nonce: "x", expectedScheme: "siwe" })
    expect(spine.audits[0]!.event_type).toBe("nonce_rejected")
    expect(spine.audits[0]!.payload.reason).toBe("used")
  })

  it("consumeAuthNonce ok=false reason='expired': emits 'nonce_rejected' with reason='expired'", async () => {
    spine.consumeNonceReturns = { ok: false, reason: "expired" }
    await consumeAuthNonce(spine, { nonce: "x", expectedScheme: "siwe" })
    expect(spine.audits[0]!.event_type).toBe("nonce_rejected")
    expect(spine.audits[0]!.payload.reason).toBe("expired")
  })

  it("consumeAuthNonce ok=false reason='scheme_mismatch': emits 'nonce_rejected' with reason='scheme_mismatch'", async () => {
    spine.consumeNonceReturns = { ok: false, reason: "scheme_mismatch" }
    await consumeAuthNonce(spine, { nonce: "x", expectedScheme: "eip191" })
    expect(spine.audits[0]!.event_type).toBe("nonce_rejected")
    expect(spine.audits[0]!.payload.reason).toBe("scheme_mismatch")
    // The scheme in the audit row is the EXPECTED scheme the verifier
    // claimed — not the (possibly different) row's actual scheme. This is
    // intentional: an auditor counting 'scheme_mismatch' wants to know
    // which scheme the client thought it was using.
    expect(spine.audits[0]!.payload.scheme).toBe("eip191")
  })

  // ── ordering: emit happens AFTER the port call, not before ───────────

  it("consumeAuthNonce ordering: consumeNonce call precedes writeAuditEvent (audit is always after the work)", async () => {
    spine.consumeNonceReturns = { ok: true, message: "m", wallet_address: null }
    await consumeAuthNonce(spine, { nonce: "x", expectedScheme: "siwe" })
    const methodOrder = spine.trace.map((t) => t.method)
    expect(methodOrder).toEqual(["consumeNonce", "writeAuditEvent"])
  })

  it("mintAuthNonce ordering: mintNonce call precedes writeAuditEvent", async () => {
    await mintAuthNonce(spine, { scheme: "siwe", message: "m" })
    const methodOrder = spine.trace.map((t) => t.method)
    expect(methodOrder).toEqual(["mintNonce", "writeAuditEvent"])
  })
})
