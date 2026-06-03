/**
 * resolve-spine.test.ts — engine orchestrator tests (T1.5, bead arrakis-232n).
 *
 * Pure-logic tests against a hand-rolled `SpinePort` mock. No DB needed.
 * Coverage: each orchestrator's side-effect sequence (call to spine + audit
 * emit + conflict-rejection audit) and the address normalization rule.
 *
 * The wire-level behavior (PG constraints firing, trigger atomicity) is
 * tested in postgres-spine-adapter.test.ts + primary_wallet_trigger.test.ts.
 * Here we verify the engine's ORCHESTRATION: which calls happen, in what
 * order, with what arguments.
 */

import { describe, expect, it, beforeEach } from "bun:test"
import {
  resolveByWallet,
  resolveByAccount,
  resolveByNym,
  getIdentity,
  mintUser,
  linkWalletWithAudit,
  linkAccountWithAudit,
  claimNymWithAudit,
  setPrimaryWithAudit,
  resolveOrMintByWallet,
} from "../resolve-spine"
import type {
  SpinePort,
  SpineAuditEvent,
  SpineIdentityShape,
} from "@freeside-auth/ports"

// ─── mock SpinePort ──────────────────────────────────────────────────────

interface MockSpine extends SpinePort {
  // Inspectable trace of every write call (chronological)
  readonly trace: Array<{ method: string; args: unknown }>
  // Inspectable audit events written
  readonly audits: SpineAuditEvent[]
  // Overridable result hooks
  resolveByWalletReturns?: string | null
  resolveByAccountReturns?: string | null
  resolveByNymReturns?: string | null
  getIdentityReturns?: SpineIdentityShape | null
  mintUserReturns?: string
  linkWalletThrows?: unknown
  linkAccountThrows?: unknown
  claimNymThrows?: unknown
  setPrimaryReturns?: boolean
  // T1.4 nonce mock hooks (not exercised by resolve-spine tests, but the
  // SpinePort interface requires the methods to exist).
  mintNonceReturns?: { nonce: string; expires_at: string; message: string }
  consumeNonceReturns?:
    | { ok: true; message: string; wallet_address: string | null }
    | { ok: false; reason: "unknown" | "used" | "expired" | "scheme_mismatch" }
}

function buildMockSpine(): MockSpine {
  const trace: Array<{ method: string; args: unknown }> = []
  const audits: SpineAuditEvent[] = []
  const m: MockSpine = {
    trace,
    audits,
    async resolveByWallet(address) {
      trace.push({ method: "resolveByWallet", args: { address } })
      return m.resolveByWalletReturns ?? null
    },
    async resolveByAccount(provider, externalId) {
      trace.push({ method: "resolveByAccount", args: { provider, externalId } })
      return m.resolveByAccountReturns ?? null
    },
    async resolveByNym(worldSlug, nym) {
      trace.push({ method: "resolveByNym", args: { worldSlug, nym } })
      return m.resolveByNymReturns ?? null
    },
    async getIdentity(userId) {
      trace.push({ method: "getIdentity", args: { userId } })
      return m.getIdentityReturns ?? null
    },
    // C-2 (bead arrakis-491i): SpinePort gained getManagedWorlds; stub.
    async getManagedWorlds() {
      return []
    },
    async mintUser() {
      trace.push({ method: "mintUser", args: {} })
      return m.mintUserReturns ?? "00000000-0000-0000-0000-000000000001"
    },
    async linkWallet(opts) {
      trace.push({ method: "linkWallet", args: opts })
      if (m.linkWalletThrows) throw m.linkWalletThrows
    },
    async linkAccount(opts) {
      trace.push({ method: "linkAccount", args: opts })
      if (m.linkAccountThrows) throw m.linkAccountThrows
    },
    async claimNym(opts) {
      trace.push({ method: "claimNym", args: opts })
      if (m.claimNymThrows) throw m.claimNymThrows
    },
    // A2 (#11 Phase 1): SpinePort gained the world-name primitives; stubs.
    async claimGeneratedName(opts) {
      trace.push({ method: "claimGeneratedName", args: opts })
      return "MIBERA-000001"
    },
    async importName(opts) {
      trace.push({ method: "importName", args: opts })
    },
    async setPrimary(opts) {
      trace.push({ method: "setPrimary", args: opts })
      return m.setPrimaryReturns ?? true
    },
    async writeAuditEvent(event) {
      trace.push({ method: "writeAuditEvent", args: event })
      audits.push(event)
    },
    async mintNonce(input) {
      trace.push({ method: "mintNonce", args: input })
      const resolved =
        typeof input.message === "string"
          ? input.message
          : typeof input.messageBuilder === "function"
            ? input.messageBuilder("test-nonce-fixture")
            : "test-message-fixture"
      return (
        m.mintNonceReturns ?? {
          nonce: "test-nonce-fixture",
          expires_at: "2026-05-24T00:05:00.000Z",
          message: resolved,
        }
      )
    },
    async consumeNonce(input) {
      trace.push({ method: "consumeNonce", args: input })
      return (
        m.consumeNonceReturns ?? {
          ok: true,
          message: "test-message-fixture",
          wallet_address: null,
        }
      )
    },
    // T1.6 LBR-1: pass-through transactional stub.
    async withTransaction<T>(fn: (spine: SpinePort) => Promise<T>): Promise<T> {
      return fn(m)
    },
  }
  return m
}

// ─── tests ──────────────────────────────────────────────────────────────

describe("resolve-spine.ts engine orchestrators (T1.5)", () => {
  let spine: MockSpine

  beforeEach(() => {
    spine = buildMockSpine()
  })

  // ── reads pass through verbatim ──────────────────────────────────────

  it("resolveByWallet delegates + lowercases 0x EVM addresses", async () => {
    spine.resolveByWalletReturns = "user-1"
    const got = await resolveByWallet(spine, "0xABC0000000000000000000000000000000000001")
    expect(got).toBe("user-1")
    expect(spine.trace[0]).toEqual({
      method: "resolveByWallet",
      args: { address: "0xabc0000000000000000000000000000000000001" },
    })
  })

  it("resolveByWallet leaves non-0x addresses untouched", async () => {
    spine.resolveByWalletReturns = null
    await resolveByWallet(spine, "SoLAnAnOt0xPrEFiX12345")
    expect(spine.trace[0]).toEqual({
      method: "resolveByWallet",
      args: { address: "SoLAnAnOt0xPrEFiX12345" },
    })
  })

  it("resolveByAccount delegates verbatim", async () => {
    spine.resolveByAccountReturns = "user-x"
    const got = await resolveByAccount(spine, "discord", "DISC-ID-PRESERVED-CASE")
    expect(got).toBe("user-x")
    expect(spine.trace[0]).toEqual({
      method: "resolveByAccount",
      args: { provider: "discord", externalId: "DISC-ID-PRESERVED-CASE" },
    })
  })

  it("resolveByNym delegates verbatim", async () => {
    spine.resolveByNymReturns = null
    await resolveByNym(spine, "mibera", "honeybear")
    expect(spine.trace[0]).toEqual({
      method: "resolveByNym",
      args: { worldSlug: "mibera", nym: "honeybear" },
    })
  })

  it("getIdentity delegates verbatim", async () => {
    spine.getIdentityReturns = {
      user_id: "u1",
      primary_wallet: null,
      created_at: "2026-05-24T00:00:00Z",
      updated_at: "2026-05-24T00:00:00Z",
      wallets: [],
      linked_accounts: [],
      world_identities: [],
      world_names: [],
    }
    const got = await getIdentity(spine, "u1")
    expect(got?.user_id).toBe("u1")
    expect(spine.trace[0]).toEqual({ method: "getIdentity", args: { userId: "u1" } })
  })

  // ── mintUser + audit pairing ─────────────────────────────────────────

  it("mintUser emits a 'user_minted' audit row with the user_id + actor default 'system'", async () => {
    spine.mintUserReturns = "user-minted-uuid"
    const got = await mintUser(spine)
    expect(got).toBe("user-minted-uuid")
    expect(spine.audits).toHaveLength(1)
    expect(spine.audits[0]).toEqual({
      event_type: "user_minted",
      user_id: "user-minted-uuid",
      actor: "system",
      payload: {},
    })
  })

  it("mintUser respects a caller-supplied actor", async () => {
    await mintUser(spine, { actor: "self" })
    expect(spine.audits[0]!.actor).toBe("self")
  })

  // ── linkWalletWithAudit ──────────────────────────────────────────────

  it("linkWalletWithAudit calls spine + emits 'wallet_linked' with the right payload", async () => {
    await linkWalletWithAudit(spine, {
      userId: "user-1",
      walletAddress: "0xABc0000000000000000000000000000000000001",
      chainIds: ["1", "8453"],
      isPrimary: true,
      actor: "sietch-redirect",
    })
    // linkWallet was called with the LOWERCASED address.
    expect(spine.trace[0]!.method).toBe("linkWallet")
    expect(spine.trace[0]!.args).toEqual({
      userId: "user-1",
      walletAddress: "0xabc0000000000000000000000000000000000001",
      chainIds: ["1", "8453"],
      isPrimary: true,
    })
    // Then the audit emit.
    expect(spine.audits).toHaveLength(1)
    expect(spine.audits[0]).toEqual({
      event_type: "wallet_linked",
      user_id: "user-1",
      actor: "sietch-redirect",
      payload: {
        wallet_address: "0xabc0000000000000000000000000000000000001",
        chain_ids: ["1", "8453"],
        is_primary: true,
      },
    })
  })

  // ── linkAccountWithAudit ─────────────────────────────────────────────

  it("linkAccountWithAudit emits 'account_linked' on success", async () => {
    await linkAccountWithAudit(spine, {
      userId: "u-1",
      provider: "discord",
      externalId: "disc-7",
      actor: "self",
    })
    expect(spine.audits).toHaveLength(1)
    expect(spine.audits[0]).toEqual({
      event_type: "account_linked",
      user_id: "u-1",
      actor: "self",
      payload: { provider: "discord", external_id: "disc-7" },
    })
  })

  it("linkAccountWithAudit emits 'conflict_rejected' BEFORE re-raising on conflict", async () => {
    const conflict = new Error("unique violation simulation")
    spine.linkAccountThrows = conflict
    let thrown: unknown = null
    try {
      await linkAccountWithAudit(spine, {
        userId: "u-2",
        provider: "discord",
        externalId: "shared-disc",
        actor: "sietch-redirect",
      })
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBe(conflict)
    // Exactly one audit row: the conflict_rejected (no account_linked).
    expect(spine.audits).toHaveLength(1)
    expect(spine.audits[0]).toEqual({
      event_type: "conflict_rejected",
      user_id: null, // pre-resolution: we don't know who owns the existing row
      actor: "sietch-redirect",
      payload: {
        conflict_kind: "linked_account",
        provider: "discord",
        external_id: "shared-disc",
        attempted_user_id: "u-2",
      },
    })
  })

  // ── claimNymWithAudit ────────────────────────────────────────────────

  it("claimNymWithAudit emits 'nym_claimed' on success", async () => {
    await claimNymWithAudit(spine, {
      userId: "u-1",
      worldSlug: "mibera",
      nym: "honeybear",
    })
    expect(spine.audits).toHaveLength(1)
    expect(spine.audits[0]!.event_type).toBe("nym_claimed")
  })

  it("claimNymWithAudit emits 'conflict_rejected' (kind=world_identity) before re-raising", async () => {
    const conflict = new Error("nym taken")
    spine.claimNymThrows = conflict
    let thrown: unknown = null
    try {
      await claimNymWithAudit(spine, {
        userId: "u-1",
        worldSlug: "mibera",
        nym: "taken",
      })
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBe(conflict)
    expect(spine.audits[0]!.payload.conflict_kind).toBe("world_identity")
  })

  // ── setPrimaryWithAudit ──────────────────────────────────────────────

  it("setPrimaryWithAudit emits 'primary_changed' on success", async () => {
    spine.setPrimaryReturns = true
    const ok = await setPrimaryWithAudit(spine, {
      userId: "u-1",
      walletAddress: "0xBBB0000000000000000000000000000000000002",
    })
    expect(ok).toBe(true)
    expect(spine.audits[0]).toEqual({
      event_type: "primary_changed",
      user_id: "u-1",
      actor: "system",
      payload: { to_wallet: "0xbbb0000000000000000000000000000000000002" },
    })
  })

  it("setPrimaryWithAudit emits NO audit on no-op (not-found)", async () => {
    spine.setPrimaryReturns = false
    const ok = await setPrimaryWithAudit(spine, {
      userId: "u-1",
      walletAddress: "0xnope000000000000000000000000000000000000",
    })
    expect(ok).toBe(false)
    expect(spine.audits).toHaveLength(0)
  })

  // ── resolveOrMintByWallet ────────────────────────────────────────────

  it("resolveOrMintByWallet returns the existing user when resolve hits", async () => {
    spine.resolveByWalletReturns = "existing-user"
    const got = await resolveOrMintByWallet(spine, {
      walletAddress: "0xExisting000000000000000000000000000000000",
    })
    expect(got).toEqual({ userId: "existing-user", minted: false })
    // Only one call: resolve. No mintUser, no linkWallet, no audit.
    expect(spine.trace.map((t) => t.method)).toEqual(["resolveByWallet"])
    expect(spine.audits).toHaveLength(0)
  })

  it("resolveOrMintByWallet mints + links + audits when resolve misses", async () => {
    spine.resolveByWalletReturns = null
    spine.mintUserReturns = "fresh-user-id"
    const got = await resolveOrMintByWallet(spine, {
      walletAddress: "0xfresh000000000000000000000000000000000001",
      chainIds: ["1"],
      actor: "self",
    })
    expect(got).toEqual({ userId: "fresh-user-id", minted: true })
    // Trace: resolve (miss) → mintUser → user_minted audit →
    //         linkWallet (primary=true) → wallet_linked audit.
    const methods = spine.trace.map((t) => t.method)
    expect(methods).toEqual([
      "resolveByWallet",
      "mintUser",
      "writeAuditEvent",
      "linkWallet",
      "writeAuditEvent",
    ])
    expect(spine.audits.map((a) => a.event_type)).toEqual(["user_minted", "wallet_linked"])
    // The wallet_linked audit carries is_primary=true (resolveOrMint promotes
    // the first wallet for a new user to primary).
    expect(spine.audits[1]!.payload.is_primary).toBe(true)
  })
})
