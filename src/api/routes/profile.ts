/**
 * Profile + Mibera dimensions — read-time compose endpoints (SDD §5.4).
 *
 * T2.3 (bead arrakis-eqxj) wires `composeProfile` into /v1/profile.
 * T3.2 (bead arrakis-g407) remains a 501 stub.
 *
 * Both routes degradable per NFR-2 (D6 isolation): downstream miss → partial
 * result with `degraded[]` flag, NEVER a 5xx. The orchestrator throws ONLY
 * on spine failure; the 3 known throw kinds map to 404 envelopes here,
 * everything else propagates to the global error handler as 5xx.
 */

import { jsonResponse } from "@hyper/core"
import { route } from "../../auth"
import { getSpine } from "../spine"
import { getInventory } from "../inventory"
import { getScore } from "../score"
import { getCodex } from "../codex"
import {
  CircuitBreaker,
  composeMiberaDimensions,
  composeProfile,
} from "@freeside-auth/engine"
// T1.10 — query schemas hoisted to @freeside-auth/protocol/api so the SDK
// can expose typed query-param surfaces today, even though /v1/mibera/dimensions
// is still a 501 stub until T3.2.
import {
  ProfileQuerySchema as ProfileQuery,
  MiberaDimensionsQuerySchema as MiberaDimensionsQuery,
} from "@freeside-auth/protocol/api"


// ---------------------------------------------------------------------------
// Module-level circuit breakers — one per federation source.
//
// In-memory state per NFR-3 (single Railway instance). Survives across
// requests until process restart. Per-source independence (one breaker per
// source, not shared) so one source's outage can't open the breaker for the
// other two — see compose-profile.ts:91 + t2.2-compose-orchestrator-notes.md §3.
// ---------------------------------------------------------------------------

const breakers = {
  inventory: new CircuitBreaker(),
  score: new CircuitBreaker(),
  codex: new CircuitBreaker(),
}

// ---------------------------------------------------------------------------
// GET /v1/profile (FR-P1)
//
// Query params: `world` + either `userId` or `wallet`. Read at runtime from
// `c.query` (the lazy URL-search getter Hyper exposes) and validated by
// ProfileQuerySchema in-handler — Hyper's `.body()` schema only runs for
// methods that have request bodies (POST/PUT/PATCH; see app.ts:526), so a
// GET-route `.body()` is a NO-OP at runtime. The SDK already imports the
// schema from `@freeside-auth/protocol/api` for the caller-side typed surface.
//
// `world` is pass-through in v1 — the federation sources are world-agnostic
// (Mibera-specific world filtering is a T3+ surface; see t2.2 notes §6).
// ---------------------------------------------------------------------------

export const getProfile = route
  .get("/v1/profile")
  .meta({
    summary: "Return composed profile (spine + holdings + score + codex)",
    mcp: {
      title: "Get profile",
      description:
        "Read-time compose: resolve user, fan out to inventory + score + codex. Returns Profile with degraded[] flag on downstream miss. Per FR-P1.",
    },
  })
  .handle(async (c) => {
    // Hyper exposes `c.query` as a lazy Record<string,string>; the static
    // type is `unknown` until the route declares a .query(Schema) (Hyper
    // hasn't shipped that builder — see app.ts:411). Validate via
    // ProfileQuery in-handler so the wire contract has a single source.
    const parsed = ProfileQuery.safeParse(
      (c as unknown as { query: Record<string, string> }).query,
    )
    if (!parsed.success) {
      return jsonResponse(400, {
        code: "invalid_param",
        message: parsed.error.issues[0]?.message ?? "invalid query",
        issues: parsed.error.issues,
      })
    }
    const q = parsed.data
    // ProfileQuerySchema enforces `userId` + `wallet` are each optional but
    // doesn't enforce XOR. Runtime guards: exactly ONE must be provided.
    // Both → 400 (rejects ambiguous subject; prevents a stale or conflicting
    // userId from silently overriding a supplied wallet). Neither → 400.
    if (!q.userId && !q.wallet) {
      return jsonResponse(400, {
        code: "invalid_param",
        message: "must provide one of: userId, wallet",
      })
    }
    if (q.userId && q.wallet) {
      return jsonResponse(400, {
        code: "invalid_param",
        message: "provide only one of: userId, wallet",
      })
    }
    const input = q.userId
      ? { userId: q.userId }
      : { walletAddress: q.wallet! }
    try {
      const profile = await composeProfile(
        {
          spine: getSpine(),
          inventory: getInventory(),
          score: getScore(),
          codex: getCodex(),
          breakers,
        },
        input,
        // A5 (#11 Phase 1): scope the privacy-default display block to the
        // request's `world` so /v1/profile and /v1/identity/resolve agree.
        { actor: "system", worldSlug: q.world },
      )
      return jsonResponse(200, profile)
    } catch (err) {
      const msg = (err as Error).message
      if (
        msg === "user_not_found" ||
        msg === "wallet_not_resolved" ||
        msg === "primary_wallet_missing"
      ) {
        return jsonResponse(404, { code: "not_found", reason: msg })
      }
      throw err // real spine I/O → 5xx via global error handler
    }
  })

// ---------------------------------------------------------------------------
// GET /v1/mibera/dimensions (FR-M1 / G-6 — honey-road slice · T3.1)
//
// Same query-param surfacing approach as /v1/profile: read from `c.query`,
// validate with MiberaDimensionsQuerySchema in-handler. No `world` param —
// Mibera is implicit.
//
// Single-subject self-view default (bead arrakis-8qpm + PRD §9 Q1): the
// route resolves either the supplied userId/wallet OR (in a future commit)
// the JWT-bearing session's user. v1 ships the explicit userId/wallet
// variant; aggregate queryHolders is a swappable additive route, NOT a
// T3.1 blocker.
// ---------------------------------------------------------------------------

export const getMiberaDimensions = route
  .get("/v1/mibera/dimensions")
  .meta({
    summary: "Return per-token Mibera trait dimensions (codex shape, verbatim)",
    mcp: {
      title: "Get Mibera dimensions",
      description:
        "Resolves wallet → holdings → Mibera tokenIds → codex per-token traits. Self-view (G-6). Per FR-M1.",
    },
  })
  .handle(async (c) => {
    const parsed = MiberaDimensionsQuery.safeParse(
      (c as unknown as { query: Record<string, string> }).query,
    )
    if (!parsed.success) {
      return jsonResponse(400, {
        code: "invalid_param",
        message: parsed.error.issues[0]?.message ?? "invalid query",
        issues: parsed.error.issues,
      })
    }
    const q = parsed.data
    // Same strict-XOR contract as /v1/profile — single subject per call.
    if (!q.userId && !q.wallet) {
      return jsonResponse(400, {
        code: "invalid_param",
        message: "must provide one of: userId, wallet",
      })
    }
    if (q.userId && q.wallet) {
      return jsonResponse(400, {
        code: "invalid_param",
        message: "provide only one of: userId, wallet",
      })
    }
    const input = q.userId
      ? { userId: q.userId }
      : { walletAddress: q.wallet! }
    try {
      const result = await composeMiberaDimensions(
        {
          spine: getSpine(),
          inventory: getInventory(),
          codex: getCodex(),
          // Reuse the module-level breakers — inventory + codex outages
          // are upstream-property, not endpoint-property; both /v1/profile
          // and /v1/mibera/dimensions should respect the same trip.
          breakers: {
            inventory: breakers.inventory,
            codex: breakers.codex,
          },
        },
        input,
        { actor: "system" },
      )
      return jsonResponse(200, result)
    } catch (err) {
      const msg = (err as Error).message
      if (
        msg === "user_not_found" ||
        msg === "wallet_not_resolved" ||
        msg === "primary_wallet_missing"
      ) {
        return jsonResponse(404, { code: "not_found", reason: msg })
      }
      throw err
    }
  })

// ─── test seam ──────────────────────────────────────────────────────────
//
// Module-level breakers are SHARED across tests by construction. Tests that
// want to start from a clean breaker state (or rely on the breaker being
// closed at boot) reset via this helper. Mirrors the spine.ts /
// inventory.ts __resetForTest convention.

/** Reset all module-level breakers to closed state. Test only. */
export function __resetBreakersForTest(): void {
  breakers.inventory = new CircuitBreaker()
  breakers.score = new CircuitBreaker()
  breakers.codex = new CircuitBreaker()
}
