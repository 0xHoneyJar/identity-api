/**
 * resolve-display-name.ts — the privacy-default name resolver (A4 ·
 * identity-api #11 Phase 1).
 *
 * Projects a user's SpineWorldName[] (the typed name registry from migration
 * 0008) into a single display-name + source, applying the PRIVACY FLOOR:
 *
 *   - The generated MIBERA-XXXX handle is the DEFAULT-display floor.
 *   - The raw shortened address (a name with is_opt_in=true, name_type
 *     'raw_short_addr') is an explicit, NEVER-default opt-in.
 *
 * THE LOAD-BEARING INVARIANT (resolve-display-name.test.ts proves it):
 *   resolveDisplayName(names, { includeOptIn: false }) NEVER returns an opt-in
 *   name — even when it is the ONLY name present. The raw address is
 *   STRUCTURALLY UNREACHABLE as the default: the filter removes opt-in names
 *   BEFORE selection, so the only way to surface one is to explicitly pass
 *   includeOptIn:true. There is no priority value low enough to bypass the
 *   filter — opt-in status is the gate, not priority.
 *
 * This is the IN-MEMORY TWIN of the SQL recompute trigger in 0008 (which
 * recomputes world_identity.nym from the lowest-priority ACTIVE NON-OPT-IN
 * name). The two MUST agree — same filter (active + non-opt-in for the
 * default), same ordering (priority ASC, then assigned_at ASC, then value ASC).
 *
 * Pure — no I/O. Consumed by /v1/profile (compose-profile.ts) and
 * /v1/identity/resolve (merge-identity.ts) + JWT display claims (A5) so every
 * surface projects the SAME spine.
 */

import type { SpineWorldName } from "@freeside-auth/ports"
import type { DisplaySource } from "@freeside-auth/protocol/api/identity-resolve"

export interface ResolveDisplayNameOptions {
  /**
   * When false (the DEFAULT — privacy by default), opt-in names
   * (is_opt_in=true, e.g. raw_short_addr) are STRUCTURALLY EXCLUDED from
   * selection — they can never be the resolved default. When true, opt-in
   * names become selectable (still subject to priority ordering, so a
   * lower-priority non-opt-in name still wins).
   */
  readonly includeOptIn?: boolean
  /**
   * Optional world scope — when set, only names for this world are considered
   * (per-world isolation). When omitted, all worlds' names compete (used when
   * the caller has already scoped the SpineWorldName[] to one world).
   */
  readonly worldSlug?: string
}

export interface ResolvedDisplayName {
  readonly value: string
  readonly display_source: DisplaySource
  readonly world_slug: string
  readonly name_type: string
}

/**
 * Map a registry `name_type` to the closed `DisplaySource` enum. Known mibera
 * types map 1:1; an unknown authored type falls back to `claimed_nym` (the
 * authored tier) so the wire enum stays closed without dropping the result.
 * Opt-in raw-address types map to `raw_short_addr`.
 */
function displaySourceFor(name: SpineWorldName): DisplaySource {
  switch (name.name_type) {
    case "generated":
      return "generated"
    case "claimed_nym":
      return "claimed_nym"
    case "raw_short_addr":
      return "raw_short_addr"
    default:
      // Unknown registry type. Opt-in → treat as a raw-address-class opt-in
      // surface; otherwise as an authored claimed name. This keeps the closed
      // wire enum valid for forward-added registry types without a protocol
      // bump on every new name_type.
      return name.is_opt_in ? "raw_short_addr" : "claimed_nym"
  }
}

/**
 * Resolve the display-name for a user from their typed name rows.
 *
 * Returns the lowest-priority ACTIVE name (retired_at IS NULL) that passes the
 * opt-in filter, or null when no eligible name exists. Ties are broken
 * deterministically (assigned_at ASC, then value ASC) to match the SQL
 * trigger's ORDER BY.
 */
export function resolveDisplayName(
  names: readonly SpineWorldName[],
  options: ResolveDisplayNameOptions = {},
): ResolvedDisplayName | null {
  const includeOptIn = options.includeOptIn ?? false

  const eligible = names.filter((n) => {
    if (n.retired_at !== null) return false // active only
    if (options.worldSlug !== undefined && n.world_slug !== options.worldSlug) return false
    // THE PRIVACY GATE: when not opting in, opt-in names are structurally
    // removed BEFORE selection. No priority can bypass this.
    if (!includeOptIn && n.is_opt_in) return false
    return true
  })

  if (eligible.length === 0) return null

  // Lowest priority wins; deterministic tie-break (assigned_at ASC, value ASC)
  // mirrors the 0008 recompute trigger's ORDER BY priority ASC, assigned_at
  // ASC, value ASC.
  const winner = eligible.reduce((best, cur) => {
    if (cur.priority !== best.priority) return cur.priority < best.priority ? cur : best
    if (cur.assigned_at !== best.assigned_at) return cur.assigned_at < best.assigned_at ? cur : best
    return cur.value < best.value ? cur : best
  })

  return {
    value: winner.value,
    display_source: displaySourceFor(winner),
    world_slug: winner.world_slug,
    name_type: winner.name_type,
  }
}
