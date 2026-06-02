/**
 * resolve-display-name.test.ts — the privacy-default resolver (A4).
 *
 * Sprint A (identity-api #11 Phase 1). `resolveDisplayName` projects a user's
 * SpineWorldName[] into a single display-name + source, applying the privacy
 * floor: the generated MIBERA-XXXX handle is the DEFAULT-display floor; the
 * raw shortened address is an explicit, NEVER-default opt-in.
 *
 * THE LOAD-BEARING INVARIANT (tested first + hardest):
 *   resolveDisplayName(names, { includeOptIn: false }) NEVER returns a
 *   raw_short_addr value — even when it is the ONLY name present. The raw
 *   address is STRUCTURALLY UNREACHABLE as the default. This is the anonymity
 *   guarantee for the community; it is a structural property of the function,
 *   not a runtime check that can be bypassed.
 *
 * The function is PURE (no I/O). It is the in-memory twin of the SQL
 * recompute trigger in migration 0008 — the two MUST agree.
 */

import { describe, expect, it } from "bun:test"
import type { SpineWorldName } from "@freeside-auth/ports"

import { resolveDisplayName } from "../resolve-display-name"

function name(over: Partial<SpineWorldName>): SpineWorldName {
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

describe("resolveDisplayName privacy-default resolver (A4)", () => {
  // ── THE PRIVACY INVARIANT ─────────────────────────────────────────────────────

  it("NEVER returns the raw address as default — even when it is the ONLY name", () => {
    const onlyRawAddr = [
      name({ name_type: "raw_short_addr", value: "0xAB…01", priority: 90, is_opt_in: true }),
    ]
    const result = resolveDisplayName(onlyRawAddr, { includeOptIn: false })
    // The raw address is structurally unreachable as default: no non-opt-in
    // name exists, so the resolver returns null (NOT the opt-in raw address).
    expect(result).toBeNull()
  })

  it("the privacy invariant holds across an arbitrary set as long as every non-opt-in is absent", () => {
    // Multiple opt-in names of different shapes; none may surface as default.
    const allOptIn = [
      name({ name_type: "raw_short_addr", value: "0xAB…01", priority: 90, is_opt_in: true }),
      name({ name_type: "raw_full_addr", value: "0xABCDEF...", priority: 80, is_opt_in: true }),
    ]
    expect(resolveDisplayName(allOptIn, { includeOptIn: false })).toBeNull()
  })

  it("an opt-in name with a DECEPTIVELY LOW priority still never wins the default", () => {
    // Even if a raw_short_addr is mis-seeded at priority 1 (lower than the
    // generated handle), is_opt_in=false is the gate — not priority.
    const names = [
      name({ name_type: "raw_short_addr", value: "0xAB…01", priority: 1, is_opt_in: true }),
      name({ name_type: "generated", value: "MIBERA-AAAAAA", priority: 50, is_opt_in: false }),
    ]
    const result = resolveDisplayName(names, { includeOptIn: false })
    expect(result).not.toBeNull()
    expect(result!.value).toBe("MIBERA-AAAAAA")
    expect(result!.display_source).toBe("generated")
  })

  // ── priority ordering (lower wins) ────────────────────────────────────────────

  it("returns the lowest-priority active non-opt-in name", () => {
    const names = [
      name({ name_type: "generated", value: "MIBERA-AAAAAA", priority: 50 }),
      name({ name_type: "claimed_nym", value: "satoshi", priority: 10 }),
    ]
    const result = resolveDisplayName(names, { includeOptIn: false })
    expect(result!.value).toBe("satoshi")
    expect(result!.display_source).toBe("claimed_nym")
  })

  it("falls back to the generated handle (the floor) when no claimed_nym exists", () => {
    const names = [name({ name_type: "generated", value: "MIBERA-BBBBBB", priority: 50 })]
    const result = resolveDisplayName(names, { includeOptIn: false })
    expect(result!.value).toBe("MIBERA-BBBBBB")
    expect(result!.display_source).toBe("generated")
  })

  // ── retired exclusion ─────────────────────────────────────────────────────────

  it("excludes retired names; falls through to the next active one", () => {
    const names = [
      name({ name_type: "claimed_nym", value: "old", priority: 10, retired_at: "2026-06-01T00:00:00Z" }),
      name({ name_type: "generated", value: "MIBERA-CCCCCC", priority: 50 }),
    ]
    const result = resolveDisplayName(names, { includeOptIn: false })
    expect(result!.value).toBe("MIBERA-CCCCCC") // retired claimed_nym skipped
    expect(result!.display_source).toBe("generated")
  })

  // ── per-world isolation ───────────────────────────────────────────────────────

  it("a name in world X never resolves for world Y", () => {
    const names = [
      name({ world_slug: "other-world", name_type: "claimed_nym", value: "elsewhere", priority: 10 }),
      name({ world_slug: "mibera", name_type: "generated", value: "MIBERA-DDDDDD", priority: 50 }),
    ]
    const result = resolveDisplayName(names, { includeOptIn: false, worldSlug: "mibera" })
    expect(result!.value).toBe("MIBERA-DDDDDD") // other-world's claimed_nym excluded
    expect(result!.world_slug).toBe("mibera")
  })

  // ── opt-in path ────────────────────────────────────────────────────────────────

  it("with includeOptIn:true, raw_short_addr becomes selectable (the explicit opt-in)", () => {
    const names = [
      name({ name_type: "raw_short_addr", value: "0xAB…01", priority: 90, is_opt_in: true }),
    ]
    const result = resolveDisplayName(names, { includeOptIn: true })
    expect(result!.value).toBe("0xAB…01")
    expect(result!.display_source).toBe("raw_short_addr")
  })

  it("with includeOptIn:true, a non-opt-in name STILL wins on lower priority", () => {
    const names = [
      name({ name_type: "raw_short_addr", value: "0xAB…01", priority: 90, is_opt_in: true }),
      name({ name_type: "claimed_nym", value: "vitalik", priority: 10, is_opt_in: false }),
    ]
    const result = resolveDisplayName(names, { includeOptIn: true })
    expect(result!.value).toBe("vitalik") // priority 10 beats 90
    expect(result!.display_source).toBe("claimed_nym")
  })

  // ── empty / edge ────────────────────────────────────────────────────────────────

  it("returns null for an empty name set", () => {
    expect(resolveDisplayName([], { includeOptIn: false })).toBeNull()
    expect(resolveDisplayName([], { includeOptIn: true })).toBeNull()
  })

  it("defaults includeOptIn to false (privacy by default)", () => {
    const onlyRawAddr = [
      name({ name_type: "raw_short_addr", value: "0xAB…01", priority: 90, is_opt_in: true }),
    ]
    // No options object → must behave as includeOptIn:false (the privacy floor).
    expect(resolveDisplayName(onlyRawAddr)).toBeNull()
  })

  // ── deterministic tie-break ──────────────────────────────────────────────────

  it("breaks priority ties deterministically (assigned_at then value)", () => {
    const names = [
      name({ name_type: "claimed_nym", value: "bbb", priority: 10, assigned_at: "2026-06-02T00:00:00Z" }),
      name({ name_type: "claimed_nym", value: "aaa", priority: 10, assigned_at: "2026-06-01T00:00:00Z" }),
    ]
    const result = resolveDisplayName(names, { includeOptIn: false })
    // Earlier assigned_at wins the tie.
    expect(result!.value).toBe("aaa")
  })
})
