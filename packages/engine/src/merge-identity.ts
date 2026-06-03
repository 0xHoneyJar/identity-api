/**
 * merge-identity.ts — the pure per-wallet merge for `POST /v1/identity/resolve`
 * (bd-2wo.38.2 · SDD §1.5).
 *
 * Joins the local spine identity (SoR) with score-api's group-aware onchain
 * enrichment and applies the display-name priority ONCE, server-side:
 *
 *   registry > world_nym(denorm) > discord(id-only) > score display_name > address
 *
 * The REGISTRY tier (`resolveDisplayName` over spine.world_names) leads: it is
 * the SAME source-of-truth `composeProfile`/`/v1/profile` uses, so both
 * endpoints project the IDENTICAL display (the "one resolver" invariant). The
 * `world_nym` denorm (migration 0008/0009 recompute cache) is now just the
 * registry's cache, so it serves ONLY as a fallback for users with a populated
 * nym but NO registry rows (the original discord users, pre-name-model). Before
 * bd-3xj the denorm led; migration 0009 began populating `world_identity.nym`
 * for every registry user, which made `mergeIdentity` report `display_source=
 * "world_nym"` while `/v1/profile` reported the registry source — the two
 * endpoints disagreed. Registry-first restores agreement.
 *
 * The `score` tier fires ONLY when score resolved a REAL onchain name
 * (`beraname | ens_name | twitter_handle` non-null). score-api's `display_name`
 * is NEVER null — it self-truncates to the wallet when no name exists — so
 * gating on a real name keeps `display_source="address"` an honest outcome
 * (operator decision 2026-06-01 · SDD OQ-6). This reads the passthrough name
 * fields for PRESENCE only; it does NOT re-derive the beraname>ENS>twitter
 * chain (score-vs-identity boundary).
 *
 * Pure — no I/O. The route does the spine reads + the single batched score
 * call, then calls this once per wallet.
 */

import type { SpineIdentityShape } from "@freeside-auth/ports"
import type { ResolvedIdentity } from "@freeside-auth/protocol/api/federation/score"
import type { IdentityResolveEntry } from "@freeside-auth/protocol/api/identity-resolve"
import { resolveDisplayName } from "./resolve-display-name"

export interface MergeIdentityInput {
  /** The normalized (lowercased) wallet — echoed in the entry. */
  readonly wallet: string
  /** Spine identity for the wallet's user, or null when the wallet is unlinked. */
  readonly spine: SpineIdentityShape | null
  /** score-api enrichment for this wallet, or undefined when score degraded/missing. */
  readonly enrich: ResolvedIdentity | undefined
  /** Optional world scope — selects the `world_nym` tier when present + matched. */
  readonly worldSlug?: string | undefined
  /** Batch-level: the single score-api call failed (per-batch, not per-wallet). */
  readonly degraded: boolean
}

/** Merge one wallet's spine + score data into the sealed response entry. */
export function mergeIdentity(input: MergeIdentityInput): IdentityResolveEntry {
  const { wallet, spine, enrich, worldSlug, degraded } = input

  // Discord: surface the ACTIVE link if present, else a soft-unlinked row
  // (OQ-4 default: keep the id visible with linked:false). The display TIER
  // only fires for an active discord (below).
  const discordRows = spine?.linked_accounts.filter((a) => a.provider === "discord") ?? []
  const activeDiscord = discordRows.find((a) => a.unlinked_at === null)
  const anyDiscord = activeDiscord ?? discordRows[0]
  const discord = anyDiscord
    ? { id: anyDiscord.external_id, linked: anyDiscord.unlinked_at === null }
    : null

  // world_nym tier — only when a world_slug is supplied AND the user has a nym
  // in that world.
  const worldNym =
    worldSlug !== undefined
      ? spine?.world_identities.find((w) => w.world_slug === worldSlug)?.nym
      : undefined

  // A5 (#11 Phase 1): the privacy-default registry name. The SAME
  // resolveDisplayName the /v1/profile compose uses — so both endpoints + JWT
  // display claims project the IDENTICAL spine. Scoped to the requested world;
  // privacy floor (includeOptIn:false) means the raw shortened address can
  // NEVER surface here as the default. Returns null for a user with no eligible
  // registry name (empty world_names, or no name in this world) — then the
  // legacy `address` fallback applies (backward compat).
  const registryName =
    spine !== null
      ? resolveDisplayName(spine.world_names, {
          ...(worldSlug !== undefined ? { worldSlug } : {}),
          includeOptIn: false,
        })
      : null

  let display_name: string
  let display_source: IdentityResolveEntry["display_source"]
  if (registryName !== null) {
    // SoT FIRST — the privacy-default registry name (generated handle or claimed
    // nym), resolved from spine.world_names via the SAME resolveDisplayName that
    // composeProfile/`/v1/profile` uses. Leading with it keeps BOTH endpoints in
    // agreement (bd-3xj). resolveDisplayName already guaranteed the value is
    // non-opt-in (the privacy floor), so the raw address can never surface here.
    display_name = registryName.value
    display_source = registryName.display_source
  } else if (worldNym !== undefined) {
    // Legacy fallback — the `world_identity.nym` denorm WITHOUT registry rows
    // (the original discord users, pre-name-model). Post-backfill every registry
    // user also has a registry row, so this fires only for the pre-name-model
    // tail whose nym is not yet mirrored in world_names.
    display_name = worldNym
    display_source = "world_nym"
  } else if (activeDiscord !== undefined) {
    display_name = activeDiscord.external_id
    display_source = "discord"
  } else if (
    enrich !== undefined &&
    (enrich.beraname !== null || enrich.ens_name !== null || enrich.twitter_handle !== null)
  ) {
    // score resolved a REAL onchain name → consume its display_name as ONE tier.
    display_name = enrich.display_name
    display_source = "score"
  } else {
    // Legacy fallback — ONLY for users with no registry name in this world
    // (pre-backfill, or a non-registry world). Once the backfill runs, every
    // mibera user has at least a generated handle, so this path is the
    // genuinely-nameless tail.
    display_name = wallet
    display_source = "address"
  }

  const is_primary_wallet =
    spine?.wallets.find((w) => w.wallet_address === wallet)?.is_primary ?? false

  return {
    wallet,
    user_id: spine?.user_id ?? null,
    display_name,
    display_source,
    discord,
    beraname: enrich?.beraname ?? null,
    ens_name: enrich?.ens_name ?? null,
    twitter_handle: enrich?.twitter_handle ?? null,
    reachable: "unknown",
    is_primary_wallet,
    degraded,
  }
}
