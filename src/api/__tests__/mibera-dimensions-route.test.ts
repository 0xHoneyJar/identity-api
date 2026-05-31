/**
 * mibera-dimensions-route.test.ts — T3.1 integration tests for
 * GET /v1/mibera/dimensions (bead arrakis-8qpm).
 *
 * Three acceptance shapes per the build doc:
 *
 *   1. happy-path — wallet with Mibera tokenIds → codex traits returned
 *      (CodexMiberaEntry shape verbatim per FR-M3 "no re-derive").
 *
 *   2. no-mibera path — wallet without Mibera holdings → tokens=[],
 *      no degraded entries.
 *
 *   3. codex-down path — wallet with Mibera tokens + codex failure →
 *      tokens omitted, degraded[codex:upstream_5xx], 200 status.
 *
 * Mirrors profile-route.test.ts pattern: ephemeral port, mock spine +
 * mock federation singletons, breakers reset between tests.
 *
 * Note: T3.1 uses the SAME module-level breakers as T2.3 (one upstream
 * outage = both endpoints respect the trip). __resetBreakersForTest()
 * resets them per-test for isolation.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import type {
  SpineAuditEvent,
  SpineIdentityShape,
  SpinePort,
} from "@freeside-auth/ports"
import type { CodexMiberaEntry } from "@freeside-auth/protocol/api"
import app from "../index"
import { __resetSpineForTest, __setSpineForTest } from "../spine"
import {
  __resetInventoryForTest,
  __setInventoryForTest,
} from "../inventory"
import {
  __resetScoreForTest,
  __setScoreForTest,
} from "../score"
import {
  __resetCodexForTest,
  __setCodexForTest,
} from "../codex"
import { __resetBreakersForTest } from "../routes/profile"
import { MockInventoryPort } from "../../../packages/adapters/src/__tests__/mock-inventory"
import { MockScorePort } from "../../../packages/adapters/src/__tests__/mock-score"
import { MockCodexPort } from "../../../packages/adapters/src/__tests__/mock-codex"

// ─── mock spine ─────────────────────────────────────────────────────────────

interface MockSpine extends SpinePort {
  readonly audits: SpineAuditEvent[]
  getIdentityReturns?: SpineIdentityShape | null
  resolveByWalletReturns?: string | null
}

function buildMockSpine(): MockSpine {
  const audits: SpineAuditEvent[] = []
  const m: MockSpine = {
    audits,
    async resolveByWallet() {
      return m.resolveByWalletReturns ?? null
    },
    async resolveByAccount() {
      return null
    },
    async resolveByNym() {
      return null
    },
    async getIdentity() {
      return m.getIdentityReturns ?? null
    },
    // C-2 (bead arrakis-491i): SpinePort gained getManagedWorlds; stub.
    async getManagedWorlds() {
      return []
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
    async writeAuditEvent(event) {
      audits.push(event)
    },
    async mintNonce() {
      return {
        nonce: "test-mock-nonce",
        expires_at: "2026-05-25T00:05:00.000Z",
        message: "test-mock-message",
      }
    },
    async consumeNonce() {
      return { ok: true as const, message: "test-mock-message", wallet_address: null }
    },
    async withTransaction<T>(fn: (spine: SpinePort) => Promise<T>): Promise<T> {
      return fn(m)
    },
  }
  return m
}

// ─── fixtures ──────────────────────────────────────────────────────────────

const FIXTURE_USER_ID = "11111111-2222-4333-8444-555555555555"
const FIXTURE_WALLET = "0xabc0000000000000000000000000000000000001"
const FIXTURE_IDENTITY: SpineIdentityShape = {
  user_id: FIXTURE_USER_ID,
  primary_wallet: FIXTURE_WALLET,
  created_at: "2026-05-25T00:00:00.000Z",
  updated_at: "2026-05-25T00:00:00.000Z",
  wallets: [
    {
      wallet_address: FIXTURE_WALLET,
      chain_ids: ["80094"],
      is_primary: true,
      verified_at: "2026-05-25T00:00:00.000Z",
      unlinked_at: null,
    },
  ],
  linked_accounts: [],
  world_identities: [],
}

const MIBERA_CONTRACT = "0x6666397dfe9a8c469bf65dc744cb1c733416c420"

// Construct a valid CodexMiberaEntry fixture — every field matches the codex
// wire schema (packages/protocol/src/api/federation/codex.ts:140-169).
function buildMiberaEntry(tokenId: number, overrides: Partial<CodexMiberaEntry> = {}): CodexMiberaEntry {
  const base: CodexMiberaEntry = {
    id: tokenId,
    archetype: "Milady",
    ancestor: "test-ancestor",
    time_period: "1990s",
    birthday: "1995-07-22",
    birth_coordinates: "40.7,-74.0",
    sun_sign: "Cancer",
    moon_sign: "Aries",
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
    drug: "honey-tea",
  }
  return { ...base, ...overrides }
}

// ─── boot/teardown ──────────────────────────────────────────────────────────

let baseUrl: string
let mockSpine: MockSpine
let mockInventory: MockInventoryPort
let mockScore: MockScorePort
let mockCodex: MockCodexPort

beforeAll(async () => {
  mockSpine = buildMockSpine()
  mockInventory = new MockInventoryPort()
  mockScore = new MockScorePort()
  mockCodex = new MockCodexPort()
  __setSpineForTest(mockSpine)
  __setInventoryForTest(mockInventory)
  __setScoreForTest(mockScore)
  __setCodexForTest(mockCodex)
  app.listen({ port: 0, hostname: "127.0.0.1", banner: false })
  const port = app.server?.port
  if (!port) throw new Error("test boot: app.server.port unavailable after listen({port:0})")
  baseUrl = `http://127.0.0.1:${port}`
})

afterAll(async () => {
  await app.stop()
  __resetSpineForTest()
  __resetInventoryForTest()
  __resetScoreForTest()
  __resetCodexForTest()
  __resetBreakersForTest()
})

beforeEach(() => {
  mockSpine.resolveByWalletReturns = undefined
  mockSpine.getIdentityReturns = undefined
  mockSpine.audits.length = 0
  mockInventory.__reset()
  mockScore.__reset()
  mockCodex.__reset()
  __resetBreakersForTest()
})

afterEach(() => {
  // Restore default federation singletons in case a test swapped to a
  // custom port.
  __setInventoryForTest(mockInventory)
  __setCodexForTest(mockCodex)
})

// ─── helpers ────────────────────────────────────────────────────────────────

interface MiberaDimensionsRespBody {
  user_id: string
  primary_wallet: string
  tokens?: CodexMiberaEntry[]
  degraded?: string[]
}

async function getMiberaDimensionsByWallet(wallet: string): Promise<{
  status: number
  body: MiberaDimensionsRespBody
}> {
  const url = `${baseUrl}/v1/mibera/dimensions?wallet=${encodeURIComponent(wallet)}`
  const res = await fetch(url)
  const body = (await res.json()) as MiberaDimensionsRespBody
  return { status: res.status, body }
}

// ─── happy-path ─────────────────────────────────────────────────────────────

describe("GET /v1/mibera/dimensions — happy-path (T3.1)", () => {
  it("returns 200 with codex traits verbatim for a wallet's Mibera tokens", async () => {
    mockSpine.resolveByWalletReturns = FIXTURE_USER_ID
    mockSpine.getIdentityReturns = FIXTURE_IDENTITY
    mockInventory.__setHoldingsForWallet(FIXTURE_WALLET, {
      holdings: [
        {
          contractAddress: MIBERA_CONTRACT,
          chainId: 80094,
          tokenCount: 2,
          tokenIds: ["7", "42"],
        },
      ],
      completeness: {
        as_of_block: 1,
        holder_count: 1,
        source: "sonar",
        complete: true,
      },
    })
    const m7 = buildMiberaEntry(7, { archetype: "Freetekno", element: "Fire", swag_rank: "S" })
    const m42 = buildMiberaEntry(42, { archetype: "Milady", element: "Water", swag_rank: "Ss" })
    mockCodex.__setMiberaEntry(m7)
    mockCodex.__setMiberaEntry(m42)

    const { status, body } = await getMiberaDimensionsByWallet(FIXTURE_WALLET)
    expect(status).toBe(200)
    expect(body.user_id).toBe(FIXTURE_USER_ID)
    expect(body.primary_wallet).toBe(FIXTURE_WALLET)
    expect(body.tokens).toBeDefined()
    expect(body.tokens).toHaveLength(2)
    // VERBATIM: every codex field present on the response without re-shaping.
    const t7 = body.tokens!.find((t) => t.id === 7)!
    expect(t7.archetype).toBe("Freetekno")
    expect(t7.element).toBe("Fire")
    expect(t7.swag_rank).toBe("S")
    expect(t7.sun_sign).toBe("Cancer")
    expect(t7.drug).toBe("honey-tea")
    expect(body.degraded).toBeUndefined()
    // Audit emitted with the non-degraded variant.
    expect(mockSpine.audits[mockSpine.audits.length - 1]?.event_type).toBe(
      "mibera_dimensions_composed",
    )
  })
})

// ─── no-mibera path ─────────────────────────────────────────────────────────

describe("GET /v1/mibera/dimensions — no-mibera (T3.1)", () => {
  it("returns 200 with tokens=[] when wallet has no Mibera holdings", async () => {
    mockSpine.resolveByWalletReturns = FIXTURE_USER_ID
    mockSpine.getIdentityReturns = FIXTURE_IDENTITY
    mockInventory.__setHoldingsForWallet(FIXTURE_WALLET, {
      holdings: [
        // A non-Mibera holding — filtered out by extractMiberaTokens.
        {
          contractAddress: "0x1111111111111111111111111111111111111111",
          chainId: 1,
          tokenCount: 1,
          tokenIds: ["1"],
        },
      ],
      completeness: {
        as_of_block: 1,
        holder_count: 1,
        source: "sonar",
        complete: true,
      },
    })

    const { status, body } = await getMiberaDimensionsByWallet(FIXTURE_WALLET)
    expect(status).toBe(200)
    expect(body.tokens).toEqual([])
    // No-Mibera is a normal-shape response — no degraded entries.
    expect(body.degraded).toBeUndefined()
    // Audit emitted with the non-degraded variant (no failure).
    expect(mockSpine.audits[mockSpine.audits.length - 1]?.event_type).toBe(
      "mibera_dimensions_composed",
    )
  })

  it("returns 200 with tokens=[] when wallet holds zero NFTs at all", async () => {
    mockSpine.resolveByWalletReturns = FIXTURE_USER_ID
    mockSpine.getIdentityReturns = FIXTURE_IDENTITY
    // Default mock inventory return is empty holdings + complete=true.

    const { status, body } = await getMiberaDimensionsByWallet(FIXTURE_WALLET)
    expect(status).toBe(200)
    expect(body.tokens).toEqual([])
    expect(body.degraded).toBeUndefined()
  })
})

// ─── codex-down path ────────────────────────────────────────────────────────

describe("GET /v1/mibera/dimensions — codex-down (T3.1)", () => {
  it("returns 200 with tokens omitted + degraded[codex:upstream_5xx] when codex fails", async () => {
    mockSpine.resolveByWalletReturns = FIXTURE_USER_ID
    mockSpine.getIdentityReturns = FIXTURE_IDENTITY
    mockInventory.__setHoldingsForWallet(FIXTURE_WALLET, {
      holdings: [
        {
          contractAddress: MIBERA_CONTRACT,
          chainId: 80094,
          tokenCount: 1,
          tokenIds: ["7"],
        },
      ],
      completeness: {
        as_of_block: 1,
        holder_count: 1,
        source: "sonar",
        complete: true,
      },
    })
    mockCodex.__setFailureForNextCall({
      kind: "upstream_5xx",
      message: "test: codex 503",
      statusCode: 503,
    })

    const { status, body } = await getMiberaDimensionsByWallet(FIXTURE_WALLET)
    expect(status).toBe(200)
    expect(body.user_id).toBe(FIXTURE_USER_ID)
    expect(body.tokens).toBeUndefined()
    expect(body.degraded).toContain("codex:upstream_5xx")
    expect(mockSpine.audits[mockSpine.audits.length - 1]?.event_type).toBe(
      "mibera_dimensions_composed_degraded",
    )
  })

  it("returns 200 with tokens omitted + degraded[inventory:upstream_5xx] when inventory fails — codex SKIPPED (no double-count)", async () => {
    mockSpine.resolveByWalletReturns = FIXTURE_USER_ID
    mockSpine.getIdentityReturns = FIXTURE_IDENTITY
    mockInventory.__setFailureForWallet(FIXTURE_WALLET, {
      kind: "upstream_5xx",
      message: "test: inventory 503",
      statusCode: 503,
    })

    const { status, body } = await getMiberaDimensionsByWallet(FIXTURE_WALLET)
    expect(status).toBe(200)
    expect(body.tokens).toBeUndefined()
    expect(body.degraded).toContain("inventory:upstream_5xx")
    // No codex degraded entry — codex was SKIPPED (no Mibera input).
    expect(body.degraded).not.toContain("codex:upstream_5xx")
    expect(body.degraded).not.toContain("codex:not_found")
  })
})

// ─── 4xx mappings ───────────────────────────────────────────────────────────

describe("GET /v1/mibera/dimensions — 4xx mappings", () => {
  it("400 when neither userId nor wallet provided", async () => {
    const res = await fetch(`${baseUrl}/v1/mibera/dimensions`)
    expect(res.status).toBe(400)
    const body = (await res.json()) as { code: string }
    expect(body.code).toBe("invalid_param")
  })

  it("400 when BOTH userId and wallet are provided (strict XOR — FAGAN iter-1 finding)", async () => {
    const res = await fetch(
      `${baseUrl}/v1/mibera/dimensions?userId=${FIXTURE_USER_ID}&wallet=${FIXTURE_WALLET}`,
    )
    expect(res.status).toBe(400)
    const body = (await res.json()) as { code: string; message: string }
    expect(body.code).toBe("invalid_param")
    expect(body.message).toContain("only one of")
  })

  it("404 when wallet is unresolvable", async () => {
    mockSpine.resolveByWalletReturns = null
    const res = await fetch(
      `${baseUrl}/v1/mibera/dimensions?wallet=${FIXTURE_WALLET}`,
    )
    expect(res.status).toBe(404)
    const body = (await res.json()) as { code: string; reason: string }
    expect(body.code).toBe("not_found")
    expect(body.reason).toBe("wallet_not_resolved")
  })

  it("400 on malformed wallet", async () => {
    const res = await fetch(`${baseUrl}/v1/mibera/dimensions?wallet=not-an-address`)
    expect(res.status).toBe(400)
  })
})
