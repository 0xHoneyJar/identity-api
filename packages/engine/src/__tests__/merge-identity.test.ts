/**
 * merge-identity.test.ts — unit tests for the pure per-wallet merge resolver
 * (bd-2wo.38.2 · SDD §7.2 cases 1-3, 7-10).
 *
 * The route's integration tests (src/api/__tests__/identity-resolve-route.test.ts)
 * cover the batch/degrade/HTTP surface; this file pins the priority algorithm.
 */

import { describe, expect, it } from "bun:test"
import type { SpineIdentityShape } from "@freeside-auth/ports"
import type { ResolvedIdentity } from "@freeside-auth/protocol/api/federation/score"
import { mergeIdentity } from "../merge-identity"

const WALLET = "0xabc0000000000000000000000000000000000001"
const USER_ID = "11111111-1111-4111-8111-111111111111"

function spine(over: Partial<SpineIdentityShape> = {}): SpineIdentityShape {
  return {
    user_id: USER_ID,
    primary_wallet: WALLET,
    created_at: "2026-06-01T00:00:00.000Z",
    updated_at: "2026-06-01T00:00:00.000Z",
    wallets: [
      {
        wallet_address: WALLET,
        chain_ids: ["1"],
        is_primary: true,
        verified_at: "2026-06-01T00:00:00.000Z",
        unlinked_at: null,
      },
    ],
    linked_accounts: [],
    world_identities: [],
    ...over,
  }
}

function resolved(over: Partial<ResolvedIdentity> = {}): ResolvedIdentity {
  return {
    wallet: WALLET,
    ens_name: null,
    beraname: null,
    basename: null,
    twitter_handle: null,
    display_name: "0xabc0…0001", // score self-truncation when no real name
    pfp_url: null,
    twitter_source: null,
    ...over,
  }
}

const DISCORD = {
  provider: "discord" as const,
  external_id: "123456789012345678",
  verified_at: "2026-06-01T00:00:00.000Z",
  unlinked_at: null,
}

describe("mergeIdentity — priority precedence (§7.2 case 1)", () => {
  it("world_nym wins when world_slug given + nym present (over discord + score)", () => {
    const e = mergeIdentity({
      wallet: WALLET,
      spine: spine({
        linked_accounts: [DISCORD],
        world_identities: [{ world_slug: "mibera", nym: "honeybadger", joined_at: "x" }],
      }),
      enrich: resolved({ beraname: "hb.bera", display_name: "hb.bera" }),
      worldSlug: "mibera",
      degraded: false,
    })
    expect(e.display_source).toBe("world_nym")
    expect(e.display_name).toBe("honeybadger")
  })

  it("discord wins when no nym (over score)", () => {
    const e = mergeIdentity({
      wallet: WALLET,
      spine: spine({ linked_accounts: [DISCORD] }),
      enrich: resolved({ beraname: "hb.bera", display_name: "hb.bera" }),
      worldSlug: "mibera",
      degraded: false,
    })
    expect(e.display_source).toBe("discord")
    expect(e.display_name).toBe(DISCORD.external_id)
  })

  it("score wins when no nym/discord and a real onchain name exists", () => {
    const e = mergeIdentity({
      wallet: WALLET,
      spine: spine(),
      enrich: resolved({ beraname: "hb.bera", display_name: "hb.bera" }),
      degraded: false,
    })
    expect(e.display_source).toBe("score")
    expect(e.display_name).toBe("hb.bera")
  })

  it("address is the final fallback (no nym/discord/score-name)", () => {
    const e = mergeIdentity({
      wallet: WALLET,
      spine: spine(),
      enrich: undefined,
      degraded: true,
    })
    expect(e.display_source).toBe("address")
    expect(e.display_name).toBe(WALLET)
    expect(e.degraded).toBe(true)
  })

  it("unresolved wallet (spine null) → user_id null, address tier", () => {
    const e = mergeIdentity({ wallet: WALLET, spine: null, enrich: undefined, degraded: false })
    expect(e.user_id).toBeNull()
    expect(e.display_source).toBe("address")
    expect(e.display_name).toBe(WALLET)
  })
})

describe("mergeIdentity — no beraname/ENS/twitter re-derivation (§7.2 case 2)", () => {
  it("all three names present → display_source stays 'score' (not 'twitter'/'beraname'); raw fields pass through", () => {
    const e = mergeIdentity({
      wallet: WALLET,
      spine: spine(),
      enrich: resolved({
        beraname: "hb.bera",
        ens_name: "hb.eth",
        twitter_handle: "hb",
        display_name: "hb.bera",
      }),
      degraded: false,
    })
    expect(e.display_source).toBe("score")
    expect(e.display_name).toBe("hb.bera")
    // Raw passthrough — echoed verbatim, do NOT influence display_source.
    expect(e.beraname).toBe("hb.bera")
    expect(e.ens_name).toBe("hb.eth")
    expect(e.twitter_handle).toBe("hb")
  })
})

describe("mergeIdentity — discord shape (§7.2 case 3)", () => {
  it("active discord → { id, linked:true }", () => {
    const e = mergeIdentity({ wallet: WALLET, spine: spine({ linked_accounts: [DISCORD] }), enrich: undefined, degraded: true })
    expect(e.discord).toEqual({ id: DISCORD.external_id, linked: true })
  })

  it("soft-unlinked discord → { id, linked:false } AND does NOT win the display tier", () => {
    const e = mergeIdentity({
      wallet: WALLET,
      spine: spine({
        linked_accounts: [{ ...DISCORD, unlinked_at: "2026-06-01T01:00:00.000Z" }],
      }),
      enrich: undefined,
      degraded: true,
    })
    expect(e.discord).toEqual({ id: DISCORD.external_id, linked: false })
    expect(e.display_source).toBe("address") // falls through, NOT "discord"
  })

  it("no discord row → discord null, never a username field", () => {
    const e = mergeIdentity({ wallet: WALLET, spine: spine(), enrich: undefined, degraded: true })
    expect(e.discord).toBeNull()
  })
})

describe("mergeIdentity — reachable + is_primary (§7.2 cases 7-8)", () => {
  it("reachable is 'unknown' in v1", () => {
    const e = mergeIdentity({ wallet: WALLET, spine: spine(), enrich: undefined, degraded: false })
    expect(e.reachable).toBe("unknown")
  })

  it("is_primary_wallet comes from spine wallet_links.is_primary (true)", () => {
    const e = mergeIdentity({ wallet: WALLET, spine: spine(), enrich: undefined, degraded: false })
    expect(e.is_primary_wallet).toBe(true)
  })

  it("is_primary_wallet false when the spine row is not primary", () => {
    const e = mergeIdentity({
      wallet: WALLET,
      spine: spine({
        wallets: [
          { wallet_address: WALLET, chain_ids: ["1"], is_primary: false, verified_at: "x", unlinked_at: null },
        ],
      }),
      enrich: undefined,
      degraded: false,
    })
    expect(e.is_primary_wallet).toBe(false)
  })
})

describe("mergeIdentity — world_slug scoping (§7.2 case 9)", () => {
  it("omitted world_slug → world_nym tier never selected (skips to next tier)", () => {
    const e = mergeIdentity({
      wallet: WALLET,
      spine: spine({ world_identities: [{ world_slug: "mibera", nym: "honeybadger", joined_at: "x" }] }),
      enrich: undefined,
      // worldSlug omitted
      degraded: true,
    })
    expect(e.display_source).toBe("address")
  })

  it("world_slug present but no matching nym → world_nym skipped", () => {
    const e = mergeIdentity({
      wallet: WALLET,
      spine: spine({ world_identities: [{ world_slug: "other-world", nym: "honeybadger", joined_at: "x" }] }),
      enrich: undefined,
      worldSlug: "mibera",
      degraded: true,
    })
    expect(e.display_source).toBe("address")
  })
})

describe("mergeIdentity — score tier requires a REAL onchain name (§7.2 case 10, OQ-6)", () => {
  it("score reached but beraname/ens/twitter all null (display_name self-truncated) → address, NOT score", () => {
    const e = mergeIdentity({
      wallet: WALLET,
      spine: spine(),
      enrich: resolved({ display_name: "0xabc0…0001" }), // names all null
      degraded: false,
    })
    expect(e.display_source).toBe("address")
    expect(e.display_name).toBe(WALLET)
    expect(e.degraded).toBe(false)
  })

  it("any one name non-null → score tier with score's display_name", () => {
    const e = mergeIdentity({
      wallet: WALLET,
      spine: spine(),
      enrich: resolved({ ens_name: "hb.eth", display_name: "hb.eth" }),
      degraded: false,
    })
    expect(e.display_source).toBe("score")
    expect(e.display_name).toBe("hb.eth")
  })
})
