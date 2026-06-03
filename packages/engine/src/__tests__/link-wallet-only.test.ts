/**
 * link-wallet-only.test.ts — engine orchestrator tests (A3).
 *
 * Sprint A (identity-api #11 Phase 1). `linkWalletOnly` admits WALLET-ONLY
 * users (no discord) to the spine — the path the discord-required
 * `linkVerifiedWallet` cannot serve (link-verified-wallet.ts:54 hard-requires
 * discordId; protocol enforces z.string().min(1)). 189 of 192 midi users are
 * wallet-only and thus invisible to the SoR; this orchestrator + the A6
 * backfill make them visible.
 *
 * Mirrors linkVerifiedWallet MINUS the discord axis:
 *   resolveByWallet → mintUser if unknown → linkWalletWithAudit(isPrimary) →
 *   optional linkAccountWithAudit(provider='dynamic_user_id') →
 *   claim-or-import the generated name → umbrella link_wallet_only audit.
 *
 * The HARD invariant (tested): NEVER writes provider='discord'.
 *
 * Uses the same in-memory MockSpine pattern as resolve-spine.test.ts (records
 * a method trace; pass-through withTransaction).
 */

import { beforeEach, describe, expect, it } from "bun:test"
import type {
  SpineAuditEvent,
  SpineLinkedAccountProvider,
  SpinePort,
} from "@freeside-auth/ports"

import { linkWalletOnly, type WalletOnlyConflictResolver } from "../link-wallet-only"

interface MockSpine extends SpinePort {
  trace: Array<{ method: string; args: unknown }>
  audits: SpineAuditEvent[]
  resolveByWalletReturns?: string | null
  mintUserReturns?: string
  failOn?: string // method name that throws mid-transaction
}

function buildMockSpine(): MockSpine {
  const trace: Array<{ method: string; args: unknown }> = []
  const audits: SpineAuditEvent[] = []
  const fail = (method: string) => {
    if (m.failOn === method) throw new Error(`simulated failure in ${method}`)
  }
  const m: MockSpine = {
    trace,
    audits,
    async resolveByWallet(address) {
      trace.push({ method: "resolveByWallet", args: { address } })
      return m.resolveByWalletReturns ?? null
    },
    async resolveByAccount(provider, externalId) {
      trace.push({ method: "resolveByAccount", args: { provider, externalId } })
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
      trace.push({ method: "mintUser", args: {} })
      fail("mintUser")
      return m.mintUserReturns ?? "00000000-0000-0000-0000-000000000001"
    },
    async linkWallet(opts) {
      trace.push({ method: "linkWallet", args: opts })
      fail("linkWallet")
    },
    async linkAccount(opts) {
      trace.push({ method: "linkAccount", args: opts })
      fail("linkAccount")
    },
    async claimNym(opts) {
      trace.push({ method: "claimNym", args: opts })
    },
    async claimGeneratedName(opts) {
      trace.push({ method: "claimGeneratedName", args: opts })
      fail("claimGeneratedName")
      return "MIBERA-ABCDEF"
    },
    async importName(opts) {
      trace.push({ method: "importName", args: opts })
      fail("importName")
    },
    async setPrimary() {
      return true
    },
    async writeAuditEvent(event) {
      trace.push({ method: "writeAuditEvent", args: event })
      audits.push(event)
    },
    async mintNonce() {
      throw new Error("not used")
    },
    async consumeNonce() {
      throw new Error("not used")
    },
    async withTransaction<T>(fn: (spine: SpinePort) => Promise<T>): Promise<T> {
      // Pass-through txn stub. On throw, the real PG would ROLLBACK; the mock
      // records the partial trace so the test can assert no audit committed.
      return fn(m)
    },
  }
  return m
}

const WALLET = "0xABCdef0000000000000000000000000000000001"
const WALLET_LOWER = WALLET.toLowerCase()

function providers(spine: MockSpine): SpineLinkedAccountProvider[] {
  return spine.trace
    .filter((t) => t.method === "linkAccount")
    .map((t) => (t.args as { provider: SpineLinkedAccountProvider }).provider)
}

describe("linkWalletOnly engine orchestrator (A3)", () => {
  let spine: MockSpine

  beforeEach(() => {
    spine = buildMockSpine()
  })

  // ── HARD invariant: NEVER discord ────────────────────────────────────────────

  it("NEVER writes provider='discord' (the wallet-only invariant)", async () => {
    await linkWalletOnly(spine, { worldSlug: "mibera", walletAddress: WALLET })
    expect(providers(spine)).not.toContain("discord")
  })

  // ── new user → mint + link primary + claim generated name ────────────────────

  it("mints a user, links the wallet as primary, and claims a generated name (no importedNames)", async () => {
    const result = await linkWalletOnly(spine, { worldSlug: "mibera", walletAddress: WALLET })
    expect(result.ok).toBe(true)
    expect(result.idempotent).toBe(false)
    expect(result.walletAddress).toBe(WALLET_LOWER)
    expect(result.generatedName).toBe("MIBERA-ABCDEF")

    const methods = spine.trace.map((t) => t.method)
    expect(methods).toContain("mintUser")
    // wallet linked as primary
    const linkWallet = spine.trace.find((t) => t.method === "linkWallet")
    expect((linkWallet!.args as { isPrimary: boolean }).isPrimary).toBe(true)
    expect((linkWallet!.args as { walletAddress: string }).walletAddress).toBe(WALLET_LOWER)
    // generated name claimed (NOT imported)
    expect(methods).toContain("claimGeneratedName")
    expect(methods).not.toContain("importName")
  })

  // ── importedNames present → ABSORB (importName), do NOT regenerate ────────────

  it("ABSORBS importedNames via importName (does NOT call claimGeneratedName)", async () => {
    const result = await linkWalletOnly(spine, {
      worldSlug: "mibera",
      walletAddress: WALLET,
      importedNames: [
        { nameType: "generated", value: "MIBERA-123456" },
        { nameType: "claimed_nym", value: "satoshi" },
      ],
    })
    expect(result.ok).toBe(true)
    const methods = spine.trace.map((t) => t.method)
    expect(methods).not.toContain("claimGeneratedName") // absorbed, not regenerated
    const imports = spine.trace.filter((t) => t.method === "importName")
    expect(imports.length).toBe(2)
    const importedValues = imports.map((t) => (t.args as { value: string }).value)
    expect(importedValues).toEqual(["MIBERA-123456", "satoshi"])
    // generatedName echoes the absorbed `generated` value (what honey-road shows)
    expect(result.generatedName).toBe("MIBERA-123456")
  })

  // ── dynamic_user_id optional link ────────────────────────────────────────────

  it("links dynamic_user_id when supplied (never discord)", async () => {
    await linkWalletOnly(spine, {
      worldSlug: "mibera",
      walletAddress: WALLET,
      dynamicUserId: "dyn-7777",
    })
    expect(providers(spine)).toEqual(["dynamic_user_id"])
  })

  it("does NOT link dynamic_user_id when absent", async () => {
    await linkWalletOnly(spine, { worldSlug: "mibera", walletAddress: WALLET })
    expect(providers(spine)).toEqual([])
  })

  // ── idempotency ───────────────────────────────────────────────────────────────

  it("is idempotent: an already-linked wallet returns idempotent:true with no new user", async () => {
    spine.resolveByWalletReturns = "existing-user-id"
    const result = await linkWalletOnly(spine, { worldSlug: "mibera", walletAddress: WALLET })
    expect(result.ok).toBe(true)
    expect(result.idempotent).toBe(true)
    expect(result.userId).toBe("existing-user-id")
    const methods = spine.trace.map((t) => t.method)
    expect(methods).not.toContain("mintUser") // no duplicate user
    expect(methods).not.toContain("linkWallet") // wallet already linked
  })

  // ── atomicity: a forced mid-transaction failure leaves NO umbrella audit ──────

  it("atomicity: a failure during name-claim aborts and writes no umbrella audit", async () => {
    spine.failOn = "claimGeneratedName"
    let threw = false
    try {
      await linkWalletOnly(spine, { worldSlug: "mibera", walletAddress: WALLET })
    } catch {
      threw = true
    }
    expect(threw).toBe(true)
    // The umbrella link_wallet_only audit must NOT have committed — it is the
    // LAST write, after the claim that failed.
    const umbrella = spine.audits.find((a) => a.event_type === "link_wallet_only")
    expect(umbrella).toBeUndefined()
  })

  // ── umbrella audit on success ────────────────────────────────────────────────

  it("emits a link_wallet_only umbrella audit on success", async () => {
    await linkWalletOnly(spine, {
      worldSlug: "mibera",
      walletAddress: WALLET,
      dynamicUserId: "dyn-1",
    })
    const umbrella = spine.audits.find((a) => a.event_type === "link_wallet_only")
    expect(umbrella).toBeDefined()
    expect(umbrella!.payload.world_slug).toBe("mibera")
    expect(umbrella!.payload.wallet_address).toBe(WALLET_LOWER)
    expect(umbrella!.payload.idempotent).toBe(false)
    // NO discord_id key in the wallet-only umbrella payload.
    expect(umbrella!.payload.discord_id).toBeUndefined()
  })

  // ── injectable conflict resolver ─────────────────────────────────────────────

  it("honors an injected conflict resolver (default = first-claim / idempotent-noop)", async () => {
    spine.resolveByWalletReturns = "prior-user"
    // A custom resolver that forces a fresh mint even on an existing wallet
    // would be unusual, but the seam must exist. Here we assert the DEFAULT
    // resolver yields idempotent-noop for an existing wallet.
    const customResolver: WalletOnlyConflictResolver = (state) =>
      state.walletUser === null
        ? { kind: "create_user" }
        : { kind: "idempotent_noop", userId: state.walletUser }
    const result = await linkWalletOnly(
      spine,
      { worldSlug: "mibera", walletAddress: WALLET },
      { resolver: customResolver },
    )
    expect(result.idempotent).toBe(true)
    expect(result.userId).toBe("prior-user")
  })
})
