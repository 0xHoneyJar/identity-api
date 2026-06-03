/**
 * backfill-wallet-only-from-midi.test.ts — A6 (identity-api #11 Phase 1).
 *
 * Tests the wallet-only backfill data-loop independent of MIDI_DATABASE_URL by
 * injecting a fixture rows array into `backfillWalletOnlyRows()`. The disposable
 * PG has no midi_profiles source, so we mock the MIDI rows (mirroring
 * backfill-midi-profiles.test.ts) and use an in-memory MockSpine.
 *
 * The 189 this backfill targets are EXACTLY the rows the existing
 * backfill-midi-profiles SKIPS (discord_id IS NULL) — wallet-only midi users
 * invisible to the spine because linkVerifiedWallet hard-requires discordId.
 *
 * Coverage:
 *   - filter: wallet_address present, discord_id NULL → processed
 *   - ABSORB: importedNames built from mibera_id (generated) + display_name
 *     (claimed_nym); the spine importName receives them VERBATIM (no regenerate)
 *   - idempotency: re-run produces zero new linkages
 *   - dry-run: no writes
 *   - HARD count assertion: assertNetNewLinkages exit 3 on short count
 *   - actor='backfill-wallet' on every umbrella audit (for the revert)
 */

import { beforeEach, describe, expect, it } from "bun:test"
import type {
  SpineAuditEvent,
  SpineLinkedAccountProvider,
  SpinePort,
} from "@freeside-auth/ports"
import {
  assertNetNewLinkages,
  backfillWalletOnlyRows,
  type WalletOnlyMidiRow,
} from "../backfill-wallet-only-from-midi"

interface MockSpine extends SpinePort {
  readonly audits: SpineAuditEvent[]
  readonly importNameCalls: Array<{ userId: string; nameType: string; value: string }>
  readonly linkAccountCalls: Array<{ provider: SpineLinkedAccountProvider; externalId: string }>
  walletToUser: Map<string, string | null>
  mintCounter: number
}

function buildMockSpine(): MockSpine {
  const m: MockSpine = {
    audits: [],
    importNameCalls: [],
    linkAccountCalls: [],
    walletToUser: new Map(),
    mintCounter: 0,
    async resolveByWallet(address) {
      return m.walletToUser.get(address.toLowerCase()) ?? null
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
    async getManagedWorlds() {
      return []
    },
    async mintUser() {
      m.mintCounter += 1
      return `00000000-0000-4000-8000-${String(m.mintCounter).padStart(12, "0")}`
    },
    async linkWallet(opts) {
      m.walletToUser.set(opts.walletAddress.toLowerCase(), opts.userId)
    },
    async linkAccount(opts) {
      m.linkAccountCalls.push({ provider: opts.provider, externalId: opts.externalId })
    },
    async claimNym() {},
    async claimGeneratedName() {
      return "MIBERA-SHOULD-NOT-HAPPEN"
    },
    async importName(opts) {
      m.importNameCalls.push({ userId: opts.userId, nameType: opts.nameType, value: opts.value })
    },
    async setPrimary() {
      return true
    },
    async writeAuditEvent(event) {
      m.audits.push(event)
    },
    async mintNonce() {
      return { nonce: "n", expires_at: "2026-06-02T00:00:00.000Z", message: "m" }
    },
    async consumeNonce() {
      return { ok: true as const, message: "m", wallet_address: null }
    },
    async withTransaction<T>(fn: (spine: SpinePort) => Promise<T>): Promise<T> {
      return fn(m)
    },
  }
  return m
}

const ROW = (i: number, over: Partial<WalletOnlyMidiRow> = {}): WalletOnlyMidiRow => ({
  wallet_address: `0x${String(i).padStart(40, "0")}`,
  dynamic_user_id: null,
  mibera_id: `MIBERA-${String(i).padStart(6, "0")}`,
  display_name: null,
  ...over,
})

let mockSpine: MockSpine
beforeEach(() => {
  mockSpine = buildMockSpine()
})

// ─── filter + absorb ─────────────────────────────────────────────────────────

describe("backfillWalletOnlyRows — absorb (NOT regenerate)", () => {
  it("imports the mibera_id as a 'generated' name VERBATIM (never claimGeneratedName)", async () => {
    const rows = [ROW(1, { mibera_id: "MIBERA-ABCDEF" })]
    const stats = await backfillWalletOnlyRows(mockSpine, rows, {
      worldSlug: "mibera",
      dryRun: false,
    })
    expect(stats.created).toBe(1)
    // The generated name was ABSORBED, not minted.
    const generated = mockSpine.importNameCalls.find((c) => c.nameType === "generated")
    expect(generated).toBeDefined()
    expect(generated!.value).toBe("MIBERA-ABCDEF") // verbatim
  })

  it("imports display_name as a 'claimed_nym' when present", async () => {
    const rows = [ROW(1, { mibera_id: "MIBERA-000001", display_name: "satoshi" })]
    await backfillWalletOnlyRows(mockSpine, rows, { worldSlug: "mibera", dryRun: false })
    const types = mockSpine.importNameCalls.map((c) => `${c.nameType}:${c.value}`)
    expect(types).toContain("generated:MIBERA-000001")
    expect(types).toContain("claimed_nym:satoshi")
  })

  it("omits the claimed_nym import when display_name is null", async () => {
    const rows = [ROW(1, { display_name: null })]
    await backfillWalletOnlyRows(mockSpine, rows, { worldSlug: "mibera", dryRun: false })
    const claimed = mockSpine.importNameCalls.filter((c) => c.nameType === "claimed_nym")
    expect(claimed).toHaveLength(0)
  })

  it("links dynamic_user_id when present (NEVER discord)", async () => {
    const rows = [ROW(1, { dynamic_user_id: "dyn-9" })]
    await backfillWalletOnlyRows(mockSpine, rows, { worldSlug: "mibera", dryRun: false })
    const providers = mockSpine.linkAccountCalls.map((c) => c.provider)
    expect(providers).toEqual(["dynamic_user_id"])
    expect(providers).not.toContain("discord")
  })

  it("stamps every umbrella audit with actor='backfill-wallet' (for the revert)", async () => {
    const rows = [ROW(1), ROW(2)]
    await backfillWalletOnlyRows(mockSpine, rows, { worldSlug: "mibera", dryRun: false })
    const umbrellas = mockSpine.audits.filter((a) => a.event_type === "link_wallet_only")
    expect(umbrellas).toHaveLength(2)
    for (const u of umbrellas) expect(u.actor).toBe("backfill-wallet")
  })
})

// ─── skip rows without a wallet ──────────────────────────────────────────────

describe("backfillWalletOnlyRows — partial rows skipped", () => {
  it("a row with no wallet_address is skipped, not an error", async () => {
    const rows = [
      { wallet_address: null, dynamic_user_id: null, mibera_id: "MIBERA-X", display_name: null },
      ROW(1),
    ]
    const stats = await backfillWalletOnlyRows(mockSpine, rows, {
      worldSlug: "mibera",
      dryRun: false,
    })
    expect(stats.total).toBe(2)
    expect(stats.errors).toBe(0)
    expect(stats.created).toBe(1)
    expect(stats.skipped).toBe(1)
  })

  it("a row with no mibera_id is skipped (the generated name is required to absorb)", async () => {
    const rows = [
      { wallet_address: "0xabc", dynamic_user_id: null, mibera_id: null, display_name: null },
      ROW(1),
    ]
    const stats = await backfillWalletOnlyRows(mockSpine, rows, {
      worldSlug: "mibera",
      dryRun: false,
    })
    expect(stats.created).toBe(1)
    expect(stats.skipped).toBe(1)
  })
})

// ─── idempotency ─────────────────────────────────────────────────────────────

describe("backfillWalletOnlyRows — idempotency", () => {
  it("re-running over the same rows produces zero new users", async () => {
    const rows = [ROW(1), ROW(2)]
    const first = await backfillWalletOnlyRows(mockSpine, rows, {
      worldSlug: "mibera",
      dryRun: false,
    })
    expect(first.created).toBe(2)
    const second = await backfillWalletOnlyRows(mockSpine, rows, {
      worldSlug: "mibera",
      dryRun: false,
    })
    expect(second.idempotent).toBe(2)
    expect(second.created).toBe(0)
  })
})

// ─── dry-run ──────────────────────────────────────────────────────────────────

describe("backfillWalletOnlyRows — dry-run", () => {
  it("counts intent without writing", async () => {
    const rows = [ROW(1), ROW(2)]
    const logs: string[] = []
    const stats = await backfillWalletOnlyRows(mockSpine, rows, {
      worldSlug: "mibera",
      dryRun: true,
      onLog: (m) => logs.push(m),
    })
    expect(stats.created).toBe(2)
    expect(mockSpine.importNameCalls).toHaveLength(0)
    expect(mockSpine.audits).toHaveLength(0)
    expect(logs.every((l) => l.includes("dry-run"))).toBe(true)
  })
})

// ─── HARD count assertion ─────────────────────────────────────────────────────

describe("assertNetNewLinkages — HARD count (exit 3 on short)", () => {
  it("returns 0 when the net-new count meets the expected floor", () => {
    expect(assertNetNewLinkages({ prior: 10, after: 10 + 189, expected: 189 })).toBe(0)
  })

  it("returns 0 when MORE than expected landed (>= floor)", () => {
    expect(assertNetNewLinkages({ prior: 10, after: 10 + 200, expected: 189 })).toBe(0)
  })

  it("returns 3 when fewer than expected landed (short count)", () => {
    expect(assertNetNewLinkages({ prior: 10, after: 10 + 188, expected: 189 })).toBe(3)
  })

  it("returns 3 when the count went backwards (corruption signal)", () => {
    expect(assertNetNewLinkages({ prior: 10, after: 5, expected: 189 })).toBe(3)
  })
})
