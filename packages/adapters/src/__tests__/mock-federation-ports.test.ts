/**
 * mock-federation-ports.test.ts — contract tests for the three mock ports (T2.1).
 *
 * The mock ports are test seams used by downstream T2.2 (compose) + T2.3
 * (/v1/profile route handler) tests. Verifying their contract here keeps
 * those downstream tests from re-deriving the same shape every time.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { MockInventoryPort } from "./mock-inventory"
import { MockScorePort } from "./mock-score"
import { MockCodexPort } from "./mock-codex"

describe("MockInventoryPort (T2.1 test seam)", () => {
  let port: MockInventoryPort
  beforeEach(() => {
    port = new MockInventoryPort()
  })
  afterEach(() => {
    port.__reset()
  })

  it("returns empty-holdings default when no fixture is set", async () => {
    const res = await port.getHoldings({ walletAddress: "0xabc" })
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.data.holdings).toEqual([])
      expect(res.data.completeness.complete).toBe(true)
    }
  })

  it("returns the installed fixture for the installed wallet", async () => {
    port.__setHoldingsForWallet("0xABC", {
      holdings: [
        { contractAddress: "0x6666397dfe9a8c469bf65dc744cb1c733416c420", chainId: 80094, tokenCount: 1, tokenIds: ["42"] },
      ],
      completeness: { as_of_block: 1, holder_count: 100, source: "sonar", complete: true },
    })
    const res = await port.getHoldings({ walletAddress: "0xabc" })
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.data.holdings[0]?.tokenIds).toEqual(["42"])
  })

  it("failure injection wins over fixture", async () => {
    port.__setHoldingsForWallet("0xabc", {
      holdings: [],
      completeness: { as_of_block: 1, holder_count: 0, source: "sonar", complete: true },
    })
    port.__setFailureForWallet("0xabc", {
      kind: "timeout",
      message: "test timeout",
    })
    const res = await port.getHoldings({ walletAddress: "0xabc" })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason.kind).toBe("timeout")
  })

  it("history captures every call (for fan-out assertions in T2.2 tests)", async () => {
    await port.getHoldings({ walletAddress: "0xaaa" })
    await port.getHoldings({ walletAddress: "0xbbb" })
    expect(port.history.length).toBe(2)
    expect(port.history[0]?.wallet).toBe("0xaaa")
    expect(port.history[1]?.wallet).toBe("0xbbb")
  })

  it("__reset clears fixtures, failures, and history", async () => {
    port.__setHoldingsForWallet("0xabc", {
      holdings: [{ contractAddress: "0x6666397dfe9a8c469bf65dc744cb1c733416c420", chainId: 80094, tokenCount: 1, tokenIds: ["x"] }],
      completeness: { as_of_block: 1, holder_count: 1, source: "sonar", complete: true },
    })
    await port.getHoldings({ walletAddress: "0xabc" })
    port.__reset()
    expect(port.history.length).toBe(0)
    const res = await port.getHoldings({ walletAddress: "0xabc" })
    if (res.ok) expect(res.data.holdings.length).toBe(0)
  })
})

describe("MockScorePort (T2.1 test seam)", () => {
  let port: MockScorePort
  beforeEach(() => {
    port = new MockScorePort()
  })

  it("returns not_found by default (matches score-api real behavior)", async () => {
    const res = await port.getScore({ walletAddress: "0xaaa" })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason.kind).toBe("not_found")
  })

  it("returns the installed fixture", async () => {
    port.__setScoreForWallet("0xaaa", {
      wallet: "0xaaa",
      og_score: 50, nft_score: 60, onchain_score: 70,
      og_score_raw: 48, nft_score_raw: 58, onchain_score_raw: 68,
      first_activity: null, last_activity: null,
      og_factor_count: 2, nft_factor_count: 3, onchain_factor_count: 4,
      trust_filter: 1.0, trust_coefficient: 1, trust_classification: "normal", flagged_for_review: false,
      og_breadth: 0.5, nft_breadth: 0.6, onchain_breadth: 0.7,
      og_breadth_multiplier: 0.85, nft_breadth_multiplier: 0.88, onchain_breadth_multiplier: 0.91,
      og_rank: null, nft_rank: null, onchain_rank: null, overall_rank: null, total_ranked_wallets: null,
      og_percentile: null, nft_percentile: null, onchain_percentile: null, overall_percentile: null,
      combined_score: 180, crowd_tier: "devoted", crowd_tier_display: "Devoted",
      elite_tier: null, elite_tier_display: null,
      points_to_next_crowd_tier: 20, next_crowd_tier_display: "Front Row",
      badge_count: 5, pioneer_badge_count: 1,
    })
    const res = await port.getScore({ walletAddress: "0xaaa" })
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.data.crowd_tier).toBe("devoted")
  })
})

describe("MockCodexPort (T2.1 test seam)", () => {
  let port: MockCodexPort
  beforeEach(() => {
    port = new MockCodexPort()
  })

  it("returns empty miberas list when no entries are set", async () => {
    const res = await port.getMiberaTraits({ tokenIds: ["1", "2"] })
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.data.miberas).toEqual([])
  })

  it("silently omits unknown tokenIds; returns known ones (matches real wire contract)", async () => {
    port.__setMiberaEntry({
      id: 42,
      archetype: "Freetekno", ancestor: "satoshi", time_period: "x", birthday: "y",
      birth_coordinates: "z", sun_sign: "Aries", moon_sign: "Libra", ascending_sign: "Capricorn",
      element: "Fire", swag_rank: "Sss", swag_score: 99,
      background: "x", body: "x", hair: null, eyes: "x", eyebrows: "x", mouth: "x",
      shirt: null, hat: null, glasses: null, mask: null, earrings: null,
      face_accessory: null, tattoo: null, item: null, drug: "mdma",
    })
    const res = await port.getMiberaTraits({ tokenIds: ["42", "9999"] })
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.data.miberas.length).toBe(1)
      expect(res.data.miberas[0]?.id).toBe(42)
    }
  })

  it("__setFailureForNextCall fires once then clears", async () => {
    port.__setFailureForNextCall({
      kind: "network_error",
      message: "test net error",
    })
    const first = await port.getMiberaTraits({ tokenIds: ["1"] })
    expect(first.ok).toBe(false)
    if (!first.ok) expect(first.reason.kind).toBe("network_error")
    const second = await port.getMiberaTraits({ tokenIds: ["1"] })
    expect(second.ok).toBe(true)
  })
})
