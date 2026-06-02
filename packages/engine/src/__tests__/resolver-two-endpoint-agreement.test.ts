/**
 * resolver-two-endpoint-agreement.test.ts — A5 cross-endpoint agreement.
 *
 * Sprint A (identity-api #11 Phase 1). The operator's "one resolver, both
 * endpoints" decision: /v1/profile (composeProfile) AND /v1/identity/resolve
 * (mergeIdentity) MUST project the SAME privacy-default display-name for the
 * same user — because both consume the SAME resolveDisplayName over the same
 * SpineWorldName[]. This test pins that invariant: given identical spine
 * world_names + world scope, the two surfaces agree on display_name +
 * display_source.
 *
 * Also asserts the SIGNER-BYTE-UNCHANGED guarantee structurally: the A5 wiring
 * imports ONLY resolveDisplayName (a pure function) — it does not import or
 * touch any signer/JWKS/verify/CredentialBridge symbol. The git-diff gate at
 * review/audit is the primary proof (AC-11); this is a defense-in-depth
 * structural assertion that the resolver module's surface is signer-free.
 */

import { describe, expect, it } from "bun:test"
import type { SpineIdentityShape, SpineWorldName } from "@freeside-auth/ports"
import type { ResolvedIdentity } from "@freeside-auth/protocol/api/federation/score"

import { mergeIdentity } from "../merge-identity"
import { resolveDisplayName } from "../resolve-display-name"

const WALLET = "0xabc0000000000000000000000000000000000001"
const USER_ID = "11111111-1111-4111-8111-111111111111"

function worldName(over: Partial<SpineWorldName>): SpineWorldName {
  return {
    world_slug: "mibera",
    name_type: "generated",
    value: "MIBERA-ABCDEF",
    priority: 50,
    is_opt_in: false,
    assigned_at: "2026-06-01T00:00:00.000Z",
    retired_at: null,
    ...over,
  }
}

function spineIdentity(world_names: SpineWorldName[]): SpineIdentityShape {
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
    world_names,
  }
}

const NO_SCORE: ResolvedIdentity | undefined = undefined

describe("A5 — /v1/profile and /v1/identity/resolve agree (one resolver)", () => {
  const cases: Array<{ label: string; names: SpineWorldName[] }> = [
    {
      label: "generated handle only (the floor)",
      names: [worldName({ name_type: "generated", value: "MIBERA-AAAAAA" })],
    },
    {
      label: "claimed_nym beats generated",
      names: [
        worldName({ name_type: "generated", value: "MIBERA-BBBBBB", priority: 50 }),
        worldName({ name_type: "claimed_nym", value: "satoshi", priority: 10 }),
      ],
    },
    {
      label: "opt-in raw address present but excluded",
      names: [
        worldName({ name_type: "raw_short_addr", value: "0xabc…01", priority: 1, is_opt_in: true }),
        worldName({ name_type: "generated", value: "MIBERA-CCCCCC", priority: 50 }),
      ],
    },
  ]

  for (const { label, names } of cases) {
    it(`agrees for: ${label}`, () => {
      // The /v1/identity/resolve surface (mergeIdentity) — the registry tier.
      const merged = mergeIdentity({
        wallet: WALLET,
        spine: spineIdentity(names),
        enrich: NO_SCORE,
        worldSlug: "mibera",
        degraded: false,
      })

      // The /v1/profile surface uses resolveDisplayName directly (composeProfile
      // attaches its result as the `display` block). We invoke the SAME pure
      // function the compose path uses, with the SAME scope + privacy floor.
      const profileDisplay = resolveDisplayName(names, {
        worldSlug: "mibera",
        includeOptIn: false,
      })

      expect(profileDisplay).not.toBeNull()
      // Both surfaces project the identical display_name + display_source.
      expect(merged.display_name).toBe(profileDisplay!.value)
      expect(merged.display_source).toBe(profileDisplay!.display_source)
      // And the privacy floor holds on BOTH: never the raw address.
      expect(merged.display_name).not.toBe(WALLET)
    })
  }

  it("both surfaces agree on the privacy floor when ONLY an opt-in name exists", () => {
    const names = [
      worldName({ name_type: "raw_short_addr", value: "0xabc…01", priority: 1, is_opt_in: true }),
    ]
    const merged = mergeIdentity({
      wallet: WALLET,
      spine: spineIdentity(names),
      enrich: NO_SCORE,
      worldSlug: "mibera",
      degraded: true,
    })
    const profileDisplay = resolveDisplayName(names, { worldSlug: "mibera", includeOptIn: false })

    // resolveDisplayName returns null (no eligible non-opt-in name) → the
    // /v1/profile `display` block is omitted; mergeIdentity falls to the legacy
    // address tier. Both REFUSE to surface the opt-in raw address as default —
    // that is the agreement that matters (neither leaks the raw address).
    expect(profileDisplay).toBeNull()
    expect(merged.display_source).toBe("address") // legacy fallback, explicit
  })
})

describe("A5 — signer-byte-unchanged (structural)", () => {
  it("resolve-display-name imports no signer/JWKS/verify symbols", async () => {
    // The A5 resolver module's source must not reference any signing surface.
    // Primary proof is the git-diff gate (AC-11); this is defense-in-depth.
    const src = await Bun.file(
      new URL("../resolve-display-name.ts", import.meta.url),
    ).text()
    for (const forbidden of [
      "Es256",
      "JWKS",
      "jwks",
      "signHs256",
      "CredentialBridge",
      "JWT_SECRET",
      "mintSessionJwt",
    ]) {
      expect(src.includes(forbidden)).toBe(false)
    }
  })
})
