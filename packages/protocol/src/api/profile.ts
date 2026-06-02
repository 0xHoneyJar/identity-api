/**
 * /v1/profile + /v1/mibera/dimensions request/response schemas.
 *
 * **T2.2 (this commit)** seals the `ProfileRespSchema` shape against the
 * three concrete federation Zod schemas + the spine Identity shape. The
 * route handler is still 501 (T2.3 wires it); the SDK's typed
 * `client.profile.get(...)` now returns a strongly-typed `ProfileResp`
 * instead of a `{ ... unknown ... }` envelope.
 *
 * Per FR-P3 (no-embed) the response surfaces holdings/score/codex via
 * READ-TIME COMPOSE — identity-api stores none of them. Each compose
 * block is `.optional()` because any of the three may have degraded out
 * (see `degraded[]` below).
 *
 * Per FR-P2 (graceful degrade): the response is ALWAYS 200; a downstream
 * miss appears as a string in `degraded[]` (kebab `<source>:<reason>`,
 * e.g. `"inventory:timeout"`, `"score:upstream_5xx"`, `"codex:circuit_open"`),
 * and the missed source's compose block is OMITTED.
 *
 * Why `codex` (not `content` as the T1.1 stub had): the bead T2.2 spec
 * names the field after the federated building (`codex`), matching the
 * `holdings` (inventory-api) / `score` (score-api) naming. `content` was
 * placeholder; T2.2 picks the canonical name.
 */

import { z } from "zod"
import { IdentityRespSchema, UserIdParamSchema, WalletAddressParamSchema } from "./resolve"
import { DisplaySourceSchema } from "./identity-resolve"
import {
  CodexGetMiberaBatchRespSchema,
  CodexMiberaEntrySchema,
  InventoryGetHoldingsRespSchema,
  ScoreGetWalletRespSchema,
} from "./federation/index"

// ─── /v1/profile (FR-P1, T2.3 wires the route) ──────────────────────────────

/**
 * Query: world slug + ONE OF (userId, wallet). Validated client-side AND
 * server-side. Note: the existing route stub still declares this via
 * `.body(...)`; T1.10 doesn't move it to `.query(...)` (Hyper doesn't ship
 * that builder yet — see SDD T2.3 follow-up).
 */
export const ProfileQuerySchema = z.object({
  world: z.string().min(1),
  userId: UserIdParamSchema.optional(),
  wallet: WalletAddressParamSchema.optional(),
})
export type ProfileQuery = z.infer<typeof ProfileQuerySchema>

/**
 * Profile response shape (T2.2 seal · T2.3 route wiring).
 *
 * Structure:
 *   - `identity`  — spine row (FR-R4 SpineIdentityShape, ALWAYS present)
 *   - `holdings`  — inventory-api compose block (optional · omitted on degrade)
 *   - `score`     — score-api compose block (optional · omitted on degrade)
 *   - `codex`     — mibera-codex compose block (optional · omitted on degrade)
 *   - `degraded`  — `["<source>:<reason>", ...]` strings for any compose
 *                   block that missed (omitted when empty)
 *
 * `degraded[]` value vocabulary (per orchestrator):
 *   - `<source>` ∈ {"inventory", "score", "codex"}
 *   - `<reason>` ∈ FederationFailureKind ∪ {"circuit_open"}
 *     (timeout, unauthorized, not_found, upstream_5xx, parse_error,
 *      network_error, circuit_open)
 *
 * Identity is non-optional because the spine is the SoR — a spine failure
 * propagates as a real 5xx (NOT a graceful-degrade case). NFR-2 isolates
 * compose downstream failures from auth/resolve; the spine is the auth/
 * resolve substrate itself.
 */
export const ProfileRespSchema = z.object({
  identity: IdentityRespSchema,
  /**
   * A5 (#11 Phase 1): the privacy-default display block, computed via the SAME
   * resolveDisplayName the /v1/identity/resolve merge uses (the two endpoints
   * AGREE). OPTIONAL + additive — present only when the request scopes a
   * `world` AND the user has an eligible registry name. The generated
   * MIBERA-XXXX handle is the floor; `display_source` NEVER reports the raw
   * address as the default (privacy by default).
   */
  display: z
    .object({
      display_name: z.string(),
      display_source: DisplaySourceSchema,
    })
    .optional(),
  holdings: InventoryGetHoldingsRespSchema.optional(),
  score: ScoreGetWalletRespSchema.optional(),
  codex: CodexGetMiberaBatchRespSchema.optional(),
  degraded: z.array(z.string()).optional(),
})
export type ProfileResp = z.infer<typeof ProfileRespSchema>

// ─── /v1/mibera/dimensions (FR-M1, G-6, T3.1 sealed by composeMiberaDimensions) ──

export const MiberaDimensionsQuerySchema = z.object({
  userId: UserIdParamSchema.optional(),
  wallet: WalletAddressParamSchema.optional(),
})
export type MiberaDimensionsQuery = z.infer<typeof MiberaDimensionsQuerySchema>

/**
 * Mibera dimensions response — T3.1 seal.
 *
 * `tokens` is `CodexMiberaEntry[]` VERBATIM (per bead arrakis-8qpm
 * "verbatim no re-derive"). The codex entry shape lives at
 * `./federation/codex.ts::CodexMiberaEntrySchema` — anything that uses
 * MiberaDimensionsResp.tokens is reading codex's wire shape directly.
 *
 * Three observable states for `tokens`:
 *   - `tokens: CodexMiberaEntry[]` (possibly empty) — inventory + codex
 *     reached; wallet's Mibera traits (or `[]` if wallet holds no Mibera).
 *   - `tokens` OMITTED — either inventory or codex degraded; the relevant
 *     entry in `degraded[]` explains which side missed.
 *
 * `user_id` and `primary_wallet` are non-optional because the spine is
 * the SoR — failure there propagates as a 5xx, NOT a degraded response.
 * (The T1.1 stub had both optional; T3.1 tightens after the spine
 * contract proved itself in T1.5+.)
 */
export const MiberaDimensionsRespSchema = z.object({
  user_id: z.string().uuid(),
  primary_wallet: z.string(),
  tokens: z.array(CodexMiberaEntrySchema).optional(),
  degraded: z.array(z.string()).optional(),
})
export type MiberaDimensionsResp = z.infer<typeof MiberaDimensionsRespSchema>
