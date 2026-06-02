/**
 * Identity-resolve facade — request + response wire shapes (bd-2wo.38).
 *
 * The v1 `POST /v1/identity/resolve` merge facade: the dashboard hands a batch
 * of wallets and receives ONE pre-merged identity per (unique) wallet, so it
 * re-derives nothing. The merge — spine join (SoR) + score-api onchain
 * enrichment, display-name priority applied ONCE — happens server-side. See
 * `grimoires/loa/sdd.md` (PRD v3.0 G-5 / bd-2wo.38).
 *
 * Pattern B (T1.10): the server route AND the dashboard's `IDENTITY_RESOLVE_URL`
 * mock-fallback both import these sealed schemas. `IdentityResolveRespSchema` is
 * the single source of truth for that mock (bd-2wo.38.3).
 */

import { z } from "zod"
import { WalletAddressParamSchema, WorldSlugParamSchema } from "./resolve"

// ─── request ────────────────────────────────────────────────────────────────

/**
 * Batch of ≤100 wallets + optional world scope. `world_slug` is FACADE-internal
 * (it selects the spine `world_nym` display tier) and is NOT forwarded to
 * score-api (score-api is wallet-only). `WalletAddressParamSchema` is plain
 * `0x`+40hex, case-INSENSITIVE — the route lowercase-normalizes + dedupes.
 */
export const IdentityResolveReqSchema = z.object({
  wallets: z.array(WalletAddressParamSchema).min(1).max(100),
  world_slug: WorldSlugParamSchema.optional(),
})
export type IdentityResolveReq = z.infer<typeof IdentityResolveReqSchema>

// ─── response ─────────────────────────────────────────────────────────────

/** Which priority tier produced the FINAL `display_name`. */
export const DisplaySourceSchema = z.enum(["world_nym", "discord", "score", "address"])
export type DisplaySource = z.infer<typeof DisplaySourceSchema>

/**
 * `reachable` tri-state on the wire as a string enum (`"true"|"false"|"unknown"`)
 * — a JSON boolean can't carry the third state without `null`, and `null` is
 * ambiguous with "field absent". v1 returns `"unknown"` for the wallet-only
 * majority; #11 (P1) populates the true/false distinction later. (SDD OQ-5,
 * operator pin 2026-06-01.)
 */
export const ReachableSchema = z.enum(["true", "false", "unknown"])
export type Reachable = z.infer<typeof ReachableSchema>

/**
 * Discord surface — `{ id, linked }` only. The spine has NO username/handle
 * column (`linked_accounts` is `(provider, external_id, verified_at,
 * unlinked_at)`), so `id` is the discord `external_id` and `linked` reflects
 * whether an active (un-unlinked) row exists.
 */
export const IdentityResolveDiscordSchema = z.object({
  id: z.string(),
  linked: z.boolean(),
})
export type IdentityResolveDiscord = z.infer<typeof IdentityResolveDiscordSchema>

/** One pre-merged identity per (unique, normalized) wallet. */
export const IdentityResolveEntrySchema = z.object({
  wallet: z.string(), // normalized (lowercased) echo
  user_id: z.string().uuid().nullable(), // null when the wallet is unlinked
  display_name: z.string(), // FINAL merged name
  display_source: DisplaySourceSchema, // which tier won
  discord: IdentityResolveDiscordSchema.nullable(),
  beraname: z.string().nullable(), // raw passthrough (tooltip)
  ens_name: z.string().nullable(), // raw passthrough (tooltip)
  twitter_handle: z.string().nullable(), // raw passthrough (tooltip)
  reachable: ReachableSchema, // tri-state; v1 → "unknown"
  is_primary_wallet: z.boolean(), // from spine wallet_links.is_primary
  degraded: z.boolean(), // score enrichment unavailable (per-batch)
})
export type IdentityResolveEntry = z.infer<typeof IdentityResolveEntrySchema>

/** One entry per unique input wallet, order-stable (first-seen). */
export const IdentityResolveRespSchema = z.object({
  results: z.array(IdentityResolveEntrySchema),
})
export type IdentityResolveResp = z.infer<typeof IdentityResolveRespSchema>
