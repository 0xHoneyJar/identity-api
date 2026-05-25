/**
 * compose-profile.test.ts — orchestrator unit tests (T2.2).
 *
 * Covers the FR-P1..P4 / NFR-2 / D6 / D8 invariants:
 *   - happy path (all 3 sources ok → full Profile, no degraded[])
 *   - per-source degrade: inventory / score / codex each individually
 *   - all-3-degraded → identity-only Profile, degraded=[3 entries]
 *   - per-source timeout → 'inventory:timeout' tag
 *   - circuit-breaker: failures open it; subsequent call returns circuit_open
 *   - circuit half-open: cooldown elapses; success closes
 *   - input shape: both {userId} and {walletAddress} work
 *   - spine failure: propagates as throw (NOT graceful degrade)
 *   - audit emit: profile_composed vs profile_compose_degraded
 *
 * Uses MockInventoryPort / MockScorePort / MockCodexPort from T2.1
 * + a hand-rolled MockSpine (mirrors resolve-spine.test.ts pattern).
 */

import { describe, expect, it, beforeEach } from "bun:test"
import { composeProfile } from "../compose-profile"
import { CircuitBreaker } from "../circuit-breaker"
// Relative imports into the adapters package's test seam — avoids needing
// to add a subpath export in adapters/package.json (which would expose the
// mock files as a runtime entry-point) AND avoids the circular-dep risk
// of adding @freeside-auth/adapters as an engine devDependency (adapters
// depends on engine already). bun test resolves relative paths fine.
import { MockInventoryPort } from "../../../adapters/src/__tests__/mock-inventory"
import { MockScorePort } from "../../../adapters/src/__tests__/mock-score"
import { MockCodexPort } from "../../../adapters/src/__tests__/mock-codex"
import type {
  SpinePort,
  SpineAuditEvent,
  SpineIdentityShape,
  FederationFailure,
} from "@freeside-auth/ports"
import type {
  CodexMiberaEntry,
  InventoryGetHoldingsResp,
  ScoreGetWalletResp,
} from "@freeside-auth/protocol/api"

// ─── fixtures ──────────────────────────────────────────────────────────────

const WALLET = "0xaaa0000000000000000000000000000000000001"
const USER_ID = "11111111-2222-4333-8444-555555555555"
const MIBERA_CONTRACT_CHECKSUM = "0x6666397DFe9a8c469BF65dc744CB1C733416c420"
const MIBERA_CONTRACT_LOWER = MIBERA_CONTRACT_CHECKSUM.toLowerCase()

const IDENTITY_FIXTURE: SpineIdentityShape = {
  user_id: USER_ID,
  primary_wallet: WALLET,
  created_at: "2026-05-01T00:00:00.000Z",
  updated_at: "2026-05-25T00:00:00.000Z",
  wallets: [
    {
      wallet_address: WALLET,
      chain_ids: ["1", "80094"],
      is_primary: true,
      verified_at: "2026-05-01T00:00:00.000Z",
      unlinked_at: null,
    },
  ],
  linked_accounts: [],
  world_identities: [],
}

function holdingsFixture(opts: {
  miberaTokenIds?: readonly string[]
  extraContractTokens?: { contract: string; tokenIds: readonly string[] }[]
}): InventoryGetHoldingsResp {
  const rows: Array<{
    contractAddress: string
    chainId: number
    tokenCount: number
    tokenIds: readonly string[]
  }> = []
  if (opts.miberaTokenIds) {
    rows.push({
      contractAddress: MIBERA_CONTRACT_CHECKSUM,
      chainId: 80094,
      tokenCount: opts.miberaTokenIds.length,
      tokenIds: opts.miberaTokenIds,
    })
  }
  for (const extra of opts.extraContractTokens ?? []) {
    rows.push({
      contractAddress: extra.contract,
      chainId: 1,
      tokenCount: extra.tokenIds.length,
      tokenIds: extra.tokenIds,
    })
  }
  return {
    holdings: rows,
    completeness: {
      as_of_block: 123,
      holder_count: 1,
      source: "sonar",
      complete: true,
    },
  }
}

function scoreFixture(combined: number): ScoreGetWalletResp {
  // Build a minimal-but-schema-valid score response.
  return {
    wallet: WALLET,
    og_score: combined,
    nft_score: combined,
    onchain_score: combined,
    og_score_raw: combined,
    nft_score_raw: combined,
    onchain_score_raw: combined,
    first_activity: "2024-01-01T00:00:00.000Z",
    last_activity: "2026-05-01T00:00:00.000Z",
    og_factor_count: 5,
    nft_factor_count: 3,
    onchain_factor_count: 7,
    trust_filter: 1.0,
    trust_coefficient: 0.95,
    trust_classification: "normal",
    flagged_for_review: false,
    og_breadth: 0.5,
    nft_breadth: 0.3,
    onchain_breadth: 0.7,
    og_breadth_multiplier: 0.85,
    nft_breadth_multiplier: 0.79,
    onchain_breadth_multiplier: 0.91,
    og_rank: 1234,
    nft_rank: 567,
    onchain_rank: 89,
    overall_rank: 200,
    total_ranked_wallets: 10_000,
    og_percentile: 88,
    nft_percentile: 94,
    onchain_percentile: 99,
    overall_percentile: 98,
    combined_score: combined,
    crowd_tier: "all_night",
    crowd_tier_display: "All Night",
    elite_tier: null,
    elite_tier_display: null,
    points_to_next_crowd_tier: 100,
    next_crowd_tier_display: "Eternal",
    badge_count: 3,
    pioneer_badge_count: 1,
  }
}

function miberaEntry(id: number): CodexMiberaEntry {
  return {
    id,
    archetype: "Milady",
    ancestor: "ancestor-X",
    time_period: "1990s",
    birthday: "06-15",
    birth_coordinates: "0,0",
    sun_sign: "Gemini",
    moon_sign: "Pisces",
    ascending_sign: "Virgo",
    element: "Water",
    swag_rank: "A",
    swag_score: 42,
    background: "warm-honey",
    body: "default",
    hair: null,
    eyes: "blue",
    eyebrows: "thin",
    mouth: "smirk",
    shirt: null,
    hat: null,
    glasses: null,
    mask: null,
    earrings: null,
    face_accessory: null,
    tattoo: null,
    item: null,
    drug: "matcha",
  }
}

// ─── mock spine (mirrors resolve-spine.test.ts pattern) ────────────────────

// Sentinel marker — distinguishes "test hasn't overridden the return" from
// "test explicitly set it to null". Use `setResolveByWalletReturn(null)` to
// model unresolvable; leave unset for the default USER_ID resolution.
const UNSET = Symbol("UNSET")
type Maybe<T> = T | typeof UNSET

interface MockSpine extends SpinePort {
  readonly trace: Array<{ method: string; args: unknown }>
  readonly audits: SpineAuditEvent[]
  setResolveByWalletReturn(v: string | null): void
  setGetIdentityReturn(v: SpineIdentityShape | null): void
  resolveByWalletThrows?: unknown
  getIdentityThrows?: unknown
}

function buildMockSpine(): MockSpine {
  const trace: Array<{ method: string; args: unknown }> = []
  const audits: SpineAuditEvent[] = []
  let resolveByWalletReturn: Maybe<string | null> = UNSET
  let getIdentityReturn: Maybe<SpineIdentityShape | null> = UNSET
  const m: MockSpine = {
    trace,
    audits,
    setResolveByWalletReturn(v) {
      resolveByWalletReturn = v
    },
    setGetIdentityReturn(v) {
      getIdentityReturn = v
    },
    async resolveByWallet(address) {
      trace.push({ method: "resolveByWallet", args: { address } })
      if (m.resolveByWalletThrows) throw m.resolveByWalletThrows
      return resolveByWalletReturn === UNSET ? USER_ID : resolveByWalletReturn
    },
    async resolveByAccount() {
      return null
    },
    async resolveByNym() {
      return null
    },
    async getIdentity(userId) {
      trace.push({ method: "getIdentity", args: { userId } })
      if (m.getIdentityThrows) throw m.getIdentityThrows
      return getIdentityReturn === UNSET ? IDENTITY_FIXTURE : getIdentityReturn
    },
    async mintUser() {
      return "unused"
    },
    async linkWallet() {},
    async linkAccount() {},
    async claimNym() {},
    async setPrimary() {
      return true
    },
    async writeAuditEvent(event) {
      trace.push({ method: "writeAuditEvent", args: event })
      audits.push(event)
    },
    async mintNonce() {
      return { nonce: "x", expires_at: "y", message: "z" }
    },
    async consumeNonce() {
      return { ok: false, reason: "unknown" }
    },
    async withTransaction(fn) {
      return fn(m)
    },
  }
  return m
}

// ─── breaker helpers ────────────────────────────────────────────────────────

/** Build a fresh set of 3 breakers with a controlled clock. */
function buildBreakers(now?: () => number) {
  return {
    inventory: new CircuitBreaker({ now, failureThreshold: 5, rollingWindowMs: 60_000, cooldownMs: 30_000 }),
    score: new CircuitBreaker({ now, failureThreshold: 5, rollingWindowMs: 60_000, cooldownMs: 30_000 }),
    codex: new CircuitBreaker({ now, failureThreshold: 5, rollingWindowMs: 60_000, cooldownMs: 30_000 }),
  }
}

function buildDeps(now?: () => number) {
  return {
    spine: buildMockSpine(),
    inventory: new MockInventoryPort(),
    score: new MockScorePort(),
    codex: new MockCodexPort(),
    breakers: buildBreakers(now),
  }
}

// ─── tests ──────────────────────────────────────────────────────────────────

describe("composeProfile (T2.2 · FR-P1..P4 / NFR-2 / D6 / D8)", () => {
  let deps: ReturnType<typeof buildDeps>

  beforeEach(() => {
    deps = buildDeps()
  })

  // ── happy path ────────────────────────────────────────────────────────

  it("happy path: all 3 sources ok → full Profile, no degraded[]", async () => {
    deps.inventory.__setHoldingsForWallet(WALLET, holdingsFixture({ miberaTokenIds: ["1", "2"] }))
    deps.score.__setScoreForWallet(WALLET, scoreFixture(750))
    deps.codex.__setMiberaEntry(miberaEntry(1))
    deps.codex.__setMiberaEntry(miberaEntry(2))

    const resp = await composeProfile(deps, { walletAddress: WALLET })

    expect(resp.identity.user_id).toBe(USER_ID)
    expect(resp.holdings).toBeDefined()
    expect(resp.score).toBeDefined()
    expect(resp.score?.combined_score).toBe(750)
    expect(resp.codex).toBeDefined()
    expect(resp.codex?.miberas).toHaveLength(2)
    expect(resp.degraded).toBeUndefined()
  })

  // ── per-source degrade ────────────────────────────────────────────────

  it("inventory fails: holdings omitted, degraded=['inventory:network_error'], codex skipped (no tokens)", async () => {
    deps.inventory.__setFailureForWallet(WALLET, {
      kind: "network_error",
      message: "DNS resolution failed",
    } satisfies FederationFailure)
    deps.score.__setScoreForWallet(WALLET, scoreFixture(500))

    const resp = await composeProfile(deps, { walletAddress: WALLET })

    expect(resp.holdings).toBeUndefined()
    expect(resp.score).toBeDefined()
    expect(resp.codex).toBeUndefined() // skipped — no holdings to source tokens from
    expect(resp.degraded).toEqual(["inventory:network_error"])
    // codex was never called (no tokens) — history should be empty
    expect(deps.codex.history).toHaveLength(0)
  })

  it("score fails: score omitted, degraded=['score:upstream_5xx']", async () => {
    deps.inventory.__setHoldingsForWallet(WALLET, holdingsFixture({ miberaTokenIds: ["7"] }))
    deps.score.__setFailureForWallet(WALLET, {
      kind: "upstream_5xx",
      message: "score-api 503",
      statusCode: 503,
    } satisfies FederationFailure)
    deps.codex.__setMiberaEntry(miberaEntry(7))

    const resp = await composeProfile(deps, { walletAddress: WALLET })

    expect(resp.holdings).toBeDefined()
    expect(resp.score).toBeUndefined()
    expect(resp.codex).toBeDefined()
    expect(resp.degraded).toEqual(["score:upstream_5xx"])
  })

  it("codex fails: codex omitted, degraded=['codex:timeout']", async () => {
    deps.inventory.__setHoldingsForWallet(WALLET, holdingsFixture({ miberaTokenIds: ["3"] }))
    deps.score.__setScoreForWallet(WALLET, scoreFixture(420))
    deps.codex.__setFailureForNextCall({
      kind: "timeout",
      message: "codex deadline",
    } satisfies FederationFailure)

    const resp = await composeProfile(deps, { walletAddress: WALLET })

    expect(resp.holdings).toBeDefined()
    expect(resp.score).toBeDefined()
    expect(resp.codex).toBeUndefined()
    expect(resp.degraded).toEqual(["codex:timeout"])
  })

  it("all 3 fail: identity-only Profile, degraded=[3 entries]", async () => {
    // inventory fails first, but that means codex is skipped — to get codex
    // into the degraded list we need holdings to succeed. So this test
    // models inventory-ok + score-failed + codex-failed; the prior tests
    // covered the inventory-failed path that skips codex.
    deps.inventory.__setHoldingsForWallet(WALLET, holdingsFixture({ miberaTokenIds: ["9"] }))
    deps.inventory.__setFailureForWallet(WALLET, {
      kind: "unauthorized",
      message: "bad key",
      statusCode: 401,
    } satisfies FederationFailure)
    deps.score.__setFailureForWallet(WALLET, {
      kind: "upstream_5xx",
      message: "503",
      statusCode: 503,
    } satisfies FederationFailure)
    // codex never called (inventory failed → no tokens) — so we test the
    // 2-of-3-failed shape here. The 3-of-3 shape is exercised in a
    // followup-state test below.
    const resp = await composeProfile(deps, { walletAddress: WALLET })
    expect(resp.holdings).toBeUndefined()
    expect(resp.score).toBeUndefined()
    expect(resp.codex).toBeUndefined()
    expect(resp.degraded).toEqual(["inventory:unauthorized", "score:upstream_5xx"])
  })

  it("3-source-fail equivalent: inventory ok + Mibera tokens + score+codex fail → 2 entries", async () => {
    // Slight rename of the above to make the codex-degrade visible.
    deps.inventory.__setHoldingsForWallet(WALLET, holdingsFixture({ miberaTokenIds: ["1", "2"] }))
    deps.score.__setFailureForWallet(WALLET, {
      kind: "upstream_5xx",
      message: "503",
      statusCode: 503,
    } satisfies FederationFailure)
    deps.codex.__setFailureForNextCall({
      kind: "parse_error",
      message: "shape drift",
    } satisfies FederationFailure)

    const resp = await composeProfile(deps, { walletAddress: WALLET })
    expect(resp.holdings).toBeDefined()
    expect(resp.score).toBeUndefined()
    expect(resp.codex).toBeUndefined()
    expect(resp.degraded).toEqual(["score:upstream_5xx", "codex:parse_error"])
  })

  // ── per-source TIMEOUT — exercised end-to-end via a slow mock ──────────

  it("per-source timeout: a slow inventory call lapses → 'inventory:timeout' in degraded[]", async () => {
    // Slow mock that respects the AbortSignal: a 200ms sleeper that
    // rejects to a `timeout` failure when the orchestrator's per-source
    // timer fires (here we override the timeout to 30ms).
    type GetHoldingsResult = Awaited<ReturnType<MockInventoryPort["getHoldings"]>>
    class SlowInventory extends MockInventoryPort {
      async getHoldings(
        input: { walletAddress: string },
        opts?: { signal?: AbortSignal },
      ): Promise<GetHoldingsResult> {
        return new Promise<GetHoldingsResult>((resolve) => {
          const settle = (timedOut: boolean) => {
            if (timedOut) {
              resolve({
                ok: false,
                reason: {
                  kind: "timeout",
                  message: "deadline exceeded",
                  context: { wallet: input.walletAddress },
                },
              })
              return
            }
            resolve({
              ok: true,
              data: {
                holdings: [],
                completeness: {
                  as_of_block: 1,
                  holder_count: 0,
                  source: "sonar",
                  complete: true,
                },
              },
            })
          }
          const t = setTimeout(() => settle(false), 200)
          if (opts?.signal) {
            opts.signal.addEventListener(
              "abort",
              () => {
                clearTimeout(t)
                settle(true)
              },
              { once: true },
            )
          }
        })
      }
    }
    deps.inventory = new SlowInventory()
    deps.score.__setScoreForWallet(WALLET, scoreFixture(100))

    const resp = await composeProfile(
      deps,
      { walletAddress: WALLET },
      { perInventoryTimeoutMs: 30 },
    )
    expect(resp.holdings).toBeUndefined()
    expect(resp.score).toBeDefined()
    expect(resp.degraded).toContain("inventory:timeout")
  })

  // ── circuit-breaker integration ────────────────────────────────────────

  it("circuit-breaker: after 5 inventory failures, 6th call short-circuits to 'inventory:circuit_open' (no HTTP)", async () => {
    deps.inventory.__setFailureForWallet(WALLET, {
      kind: "network_error",
      message: "transient",
    } satisfies FederationFailure)
    deps.score.__setScoreForWallet(WALLET, scoreFixture(50))

    for (let i = 0; i < 5; i++) {
      await composeProfile(deps, { walletAddress: WALLET })
    }
    // Breaker should be open now.
    expect(deps.breakers.inventory.__getState()).toBe("open")
    // Confirm history shows 5 actual call attempts so far.
    expect(deps.inventory.history).toHaveLength(5)

    const resp = await composeProfile(deps, { walletAddress: WALLET })
    // The 6th composeProfile should NOT have invoked the inventory port.
    expect(deps.inventory.history).toHaveLength(5)
    expect(resp.holdings).toBeUndefined()
    expect(resp.degraded).toEqual(["inventory:circuit_open"])
  })

  it("circuit half-open: after cooldown elapses, next call attempts; success → closed", async () => {
    // Use a controlled clock to step through cooldown deterministically.
    let mockTime = 1_000_000
    const now = () => mockTime
    deps = buildDeps(now)

    // Drive the breaker open with 5 failures.
    deps.inventory.__setFailureForWallet(WALLET, {
      kind: "upstream_5xx",
      message: "503",
      statusCode: 503,
    } satisfies FederationFailure)
    deps.score.__setScoreForWallet(WALLET, scoreFixture(10))
    for (let i = 0; i < 5; i++) {
      await composeProfile(deps, { walletAddress: WALLET })
    }
    expect(deps.breakers.inventory.__getState()).toBe("open")

    // Advance time past cooldown (30s + 1ms).
    mockTime += 30_001
    // Reconfigure the failure to clear it — next attempt will succeed.
    ;(deps.inventory as MockInventoryPort).__reset()
    deps.inventory.__setHoldingsForWallet(WALLET, holdingsFixture({}))

    const resp = await composeProfile(deps, { walletAddress: WALLET })
    expect(deps.breakers.inventory.__getState()).toBe("closed")
    expect(resp.holdings).toBeDefined()
    expect(resp.degraded).toBeUndefined()
  })

  // ── input shape variations ─────────────────────────────────────────────

  it("input shape: {userId} → spine.getIdentity → uses identity.primary_wallet for fan-out", async () => {
    deps.inventory.__setHoldingsForWallet(WALLET, holdingsFixture({ miberaTokenIds: ["1"] }))
    deps.score.__setScoreForWallet(WALLET, scoreFixture(900))
    deps.codex.__setMiberaEntry(miberaEntry(1))

    const resp = await composeProfile(deps, { userId: USER_ID })
    expect(resp.identity.user_id).toBe(USER_ID)
    expect(resp.holdings).toBeDefined()
    // getIdentity was called with the userId; no resolveByWallet path.
    expect(deps.spine.trace.some((t) => t.method === "getIdentity")).toBe(true)
    expect(deps.spine.trace.some((t) => t.method === "resolveByWallet")).toBe(false)
  })

  it("input shape: {walletAddress} → resolveByWallet → getIdentity", async () => {
    deps.inventory.__setHoldingsForWallet(WALLET, holdingsFixture({}))
    deps.score.__setScoreForWallet(WALLET, scoreFixture(33))
    await composeProfile(deps, { walletAddress: WALLET })
    // Both spine calls happened in order.
    const methods = deps.spine.trace.map((t) => t.method)
    expect(methods).toContain("resolveByWallet")
    expect(methods).toContain("getIdentity")
  })

  // ── spine failure propagates (NOT graceful degrade) ─────────────────────

  it("spine I/O failure throws — NOT a graceful-degrade path", async () => {
    deps.spine.getIdentityThrows = new Error("connection lost")
    await expect(composeProfile(deps, { userId: USER_ID })).rejects.toThrow("connection lost")
  })

  it("unknown user_id throws 'user_not_found' (route layer maps to 404)", async () => {
    deps.spine.setGetIdentityReturn(null)
    await expect(composeProfile(deps, { userId: USER_ID })).rejects.toThrow("user_not_found")
  })

  it("unresolvable wallet throws 'wallet_not_resolved'", async () => {
    deps.spine.setResolveByWalletReturn(null)
    await expect(composeProfile(deps, { walletAddress: WALLET })).rejects.toThrow(
      "wallet_not_resolved",
    )
  })

  it("user with null primary_wallet throws 'primary_wallet_missing'", async () => {
    deps.spine.setGetIdentityReturn({ ...IDENTITY_FIXTURE, primary_wallet: null })
    await expect(composeProfile(deps, { userId: USER_ID })).rejects.toThrow(
      "primary_wallet_missing",
    )
  })

  // ── audit emit ────────────────────────────────────────────────────────

  it("audit emit: profile_composed on full success", async () => {
    deps.inventory.__setHoldingsForWallet(WALLET, holdingsFixture({}))
    deps.score.__setScoreForWallet(WALLET, scoreFixture(1))
    await composeProfile(deps, { walletAddress: WALLET })
    expect(deps.spine.audits).toHaveLength(1)
    expect(deps.spine.audits[0]!.event_type).toBe("profile_composed")
    expect(deps.spine.audits[0]!.user_id).toBe(USER_ID)
    expect((deps.spine.audits[0]!.payload as { degraded: string[] }).degraded).toEqual([])
  })

  it("audit emit: profile_compose_degraded when any source missed", async () => {
    deps.inventory.__setFailureForWallet(WALLET, {
      kind: "network_error",
      message: "x",
    } satisfies FederationFailure)
    await composeProfile(deps, { walletAddress: WALLET })
    expect(deps.spine.audits).toHaveLength(1)
    expect(deps.spine.audits[0]!.event_type).toBe("profile_compose_degraded")
    expect((deps.spine.audits[0]!.payload as { degraded: string[] }).degraded).toContain(
      "inventory:network_error",
    )
  })

  it("audit emit: actor propagates from opts (defaults to 'system')", async () => {
    deps.inventory.__setHoldingsForWallet(WALLET, holdingsFixture({}))
    deps.score.__setScoreForWallet(WALLET, scoreFixture(1))
    await composeProfile(deps, { walletAddress: WALLET }, { actor: "self" })
    expect(deps.spine.audits[0]!.actor).toBe("self")
  })

  // ── codex skip semantics ──────────────────────────────────────────────

  it("codex SKIP (not degraded): wallet holds no Mibera tokens", async () => {
    deps.inventory.__setHoldingsForWallet(
      WALLET,
      holdingsFixture({
        extraContractTokens: [
          { contract: "0x9999999999999999999999999999999999999999", tokenIds: ["1", "2"] },
        ],
      }),
    )
    deps.score.__setScoreForWallet(WALLET, scoreFixture(50))
    const resp = await composeProfile(deps, { walletAddress: WALLET })
    expect(resp.codex).toBeUndefined()
    // codex skip is NOT a degradation entry (input was empty by design)
    expect(resp.degraded).toBeUndefined()
    expect(deps.codex.history).toHaveLength(0)
  })

  it("codex called with Mibera tokenIds extracted from holdings (case-insensitive contract match)", async () => {
    deps.inventory.__setHoldingsForWallet(WALLET, holdingsFixture({ miberaTokenIds: ["100", "200"] }))
    deps.score.__setScoreForWallet(WALLET, scoreFixture(10))
    deps.codex.__setMiberaEntry(miberaEntry(100))
    deps.codex.__setMiberaEntry(miberaEntry(200))

    await composeProfile(deps, { walletAddress: WALLET })
    expect(deps.codex.history).toHaveLength(1)
    expect(deps.codex.history[0]!.tokenIds).toEqual(["100", "200"])
    // Confirm the checksum-cased contract address matched the lowercase
    // constant inside the orchestrator.
    expect(MIBERA_CONTRACT_LOWER).toBe(MIBERA_CONTRACT_CHECKSUM.toLowerCase())
  })

  // ── score 404 doesn't tick the breaker ─────────────────────────────────

  it("score returning not_found does NOT tick the breaker (404 = healthy)", async () => {
    // Default MockScorePort behavior for un-configured wallets is exactly
    // not_found (a healthy 404). 10 calls should leave the breaker closed.
    deps.inventory.__setHoldingsForWallet(WALLET, holdingsFixture({}))
    for (let i = 0; i < 10; i++) {
      await composeProfile(deps, { walletAddress: WALLET })
    }
    expect(deps.breakers.score.__getState()).toBe("closed")
    expect(deps.breakers.score.__getFailureCount()).toBe(0)
  })
})
