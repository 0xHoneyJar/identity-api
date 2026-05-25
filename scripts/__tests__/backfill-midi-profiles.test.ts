/**
 * backfill-midi-profiles.test.ts — T4.4 · bead arrakis-494b.
 *
 * Tests the data-loop independent of MIDI_DATABASE_URL by injecting a
 * fixture rows array into `backfillRows()`. Mock spine tracks linkage
 * writes + audit emits so we can assert idempotency, conflict handling,
 * and dynamic_user_id linkage.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import type {
  SpineAuditEvent,
  SpineLinkedAccountProvider,
  SpinePort,
} from "@freeside-auth/ports"
import { backfillRows } from "../backfill-midi-profiles"

interface MockSpine extends SpinePort {
  readonly audits: SpineAuditEvent[]
  readonly linkWalletCalls: Array<{ userId: string; walletAddress: string }>
  readonly linkAccountCalls: Array<{
    userId: string
    provider: SpineLinkedAccountProvider
    externalId: string
  }>
  walletToUser: Map<string, string | null>
  discordToUser: Map<string, string | null>
  mintCounter: number
}

function buildMockSpine(): MockSpine {
  const m: MockSpine = {
    audits: [],
    linkWalletCalls: [],
    linkAccountCalls: [],
    walletToUser: new Map(),
    discordToUser: new Map(),
    mintCounter: 0,
    async resolveByWallet(address) {
      return m.walletToUser.get(address.toLowerCase()) ?? null
    },
    async resolveByAccount(provider, externalId) {
      if (provider === "discord") return m.discordToUser.get(externalId) ?? null
      return null
    },
    async resolveByNym() {
      return null
    },
    async getIdentity() {
      return null
    },
    async mintUser() {
      m.mintCounter += 1
      const id = `00000000-0000-4000-8000-${String(m.mintCounter).padStart(12, "0")}`
      return id
    },
    async linkWallet(opts) {
      m.linkWalletCalls.push({ userId: opts.userId, walletAddress: opts.walletAddress })
      m.walletToUser.set(opts.walletAddress.toLowerCase(), opts.userId)
    },
    async linkAccount(opts) {
      m.linkAccountCalls.push(opts)
      if (opts.provider === "discord") m.discordToUser.set(opts.externalId, opts.userId)
    },
    async claimNym() {},
    async setPrimary() {
      return true
    },
    async writeAuditEvent(event) {
      m.audits.push(event)
    },
    async mintNonce() {
      return {
        nonce: "n",
        expires_at: "2026-05-25T00:00:00.000Z",
        message: "m",
      }
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

const ROW = (i: number, opts: { discord?: string; wallet?: string; dynamic?: string } = {}) => ({
  discord_id: opts.discord ?? `disc-${i}`,
  wallet_address: opts.wallet ?? `0x${String(i).padStart(40, "0")}`,
  dynamic_user_id: opts.dynamic ?? null,
})

let mockSpine: MockSpine
beforeEach(() => {
  mockSpine = buildMockSpine()
})

afterEach(() => {
  // Intentionally bare — fresh mock per test.
})

// ─── happy path ────────────────────────────────────────────────────────────

describe("backfillRows — happy path", () => {
  it("creates N users for N non-overlapping rows; emits N umbrella audits", async () => {
    const rows = [ROW(1), ROW(2), ROW(3)]
    const stats = await backfillRows(mockSpine, rows, { worldSlug: "mibera", dryRun: false })
    expect(stats.total).toBe(3)
    expect(stats.created).toBe(3)
    expect(stats.idempotent).toBe(0)
    expect(stats.collisions).toBe(0)
    expect(stats.errors).toBe(0)
    // 3 users minted → 3 linkWallet + 3 linkAccount(discord) + 3 umbrella audits.
    expect(mockSpine.linkWalletCalls).toHaveLength(3)
    expect(mockSpine.linkAccountCalls).toHaveLength(3)
    // Every umbrella audit carries actor='backfill'.
    const umbrellas = mockSpine.audits.filter((a) => a.event_type === "link_verified_wallet")
    expect(umbrellas).toHaveLength(3)
    for (const u of umbrellas) {
      expect(u.actor).toBe("backfill")
    }
  })

  it("links dynamic_user_id when present", async () => {
    const rows = [ROW(1, { dynamic: "dyn-12345" })]
    await backfillRows(mockSpine, rows, { worldSlug: "mibera", dryRun: false })
    const providers = mockSpine.linkAccountCalls.map((c) => c.provider)
    expect(providers).toContain("discord")
    expect(providers).toContain("dynamic_user_id")
  })
})

// ─── idempotency (NFR-7 / NFR-8) ────────────────────────────────────────────

describe("backfillRows — idempotency (NFR-8)", () => {
  it("re-running over the same rows produces zero new linkages", async () => {
    const rows = [ROW(1), ROW(2)]
    const first = await backfillRows(mockSpine, rows, { worldSlug: "mibera", dryRun: false })
    expect(first.created).toBe(2)

    // Reset call trackers but keep the maps (simulating that spine state survives).
    const beforeRetryLinkCount = mockSpine.linkWalletCalls.length
    const second = await backfillRows(mockSpine, rows, { worldSlug: "mibera", dryRun: false })
    expect(second.idempotent).toBe(2)
    expect(second.created).toBe(0)
    // No new linkWallet writes on the second run.
    expect(mockSpine.linkWalletCalls.length).toBe(beforeRetryLinkCount)
  })
})

// ─── conflict handling ─────────────────────────────────────────────────────

describe("backfillRows — collision handling", () => {
  it("logs cross_user_collision without aborting the loop", async () => {
    // Pre-seed: wallet-A already linked to user-X, discord-A linked to user-Y.
    const USER_X = "11111111-1111-4111-8111-111111111111"
    const USER_Y = "22222222-2222-4222-8222-222222222222"
    const WALLET = "0xaaa0000000000000000000000000000000000001"
    const DISCORD = "disc-collide"
    mockSpine.walletToUser.set(WALLET, USER_X)
    mockSpine.discordToUser.set(DISCORD, USER_Y)

    const rows = [
      { discord_id: DISCORD, wallet_address: WALLET, dynamic_user_id: null },
      ROW(2), // a normal row AFTER the collision — must still be processed
      ROW(3),
    ]
    const logs: string[] = []
    const stats = await backfillRows(mockSpine, rows, {
      worldSlug: "mibera",
      dryRun: false,
      onLog: (m) => logs.push(m),
    })
    expect(stats.total).toBe(3)
    expect(stats.collisions).toBe(1)
    expect(stats.created).toBe(2) // the 2 non-conflicting rows still landed
    expect(logs.some((l) => l.includes("collision"))).toBe(true)
    // The conflict_rejected audit was emitted (via outer spine, FAGAN finding).
    expect(mockSpine.audits.map((a) => a.event_type)).toContain("conflict_rejected")
  })
})

// ─── partial-data rows ─────────────────────────────────────────────────────

describe("backfillRows — partial rows are skipped silently", () => {
  it("rows missing discord_id or wallet_address are not counted as errors", async () => {
    const rows = [
      { discord_id: null, wallet_address: "0xaaa", dynamic_user_id: null },
      { discord_id: "disc-x", wallet_address: null, dynamic_user_id: null },
      ROW(1), // valid
    ]
    const stats = await backfillRows(mockSpine, rows, { worldSlug: "mibera", dryRun: false })
    expect(stats.total).toBe(3)
    expect(stats.errors).toBe(0)
    expect(stats.created).toBe(1) // only the valid row landed
  })
})

// ─── dry-run mode ──────────────────────────────────────────────────────────

describe("backfillRows — dry-run", () => {
  it("logs intent + counts as 'created' without writing", async () => {
    const rows = [ROW(1), ROW(2)]
    const logs: string[] = []
    const stats = await backfillRows(mockSpine, rows, {
      worldSlug: "mibera",
      dryRun: true,
      onLog: (m) => logs.push(m),
    })
    expect(stats.created).toBe(2)
    expect(mockSpine.linkWalletCalls).toHaveLength(0)
    expect(logs.every((l) => l.includes("dry-run"))).toBe(true)
  })
})
