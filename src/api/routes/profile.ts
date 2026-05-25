/**
 * Profile + Mibera dimensions — read-time compose endpoints (SDD §5.4).
 *
 * STUB: T1.1 wires the route surface; real fan-out compose (inventory + score
 * + codex) lands in T2.3 (bead arrakis-eqxj) for /v1/profile and T3.2 (bead
 * arrakis-g407) for /v1/mibera/dimensions.
 *
 * Both routes degradable per NFR-2 (D6 isolation): downstream miss → partial
 * result with `degraded[]` flag, NEVER a 5xx.
 */

import { jsonResponse } from "@hyper/core"
import { route } from "../../auth"
// T1.10 — query schemas hoisted to @freeside-auth/protocol/api so the SDK
// can expose typed query-param surfaces today, even though the routes
// themselves are 501 stubs until T2.3 / T3.2.
import {
  ProfileQuerySchema as ProfileQuery,
  MiberaDimensionsQuerySchema as MiberaDimensionsQuery,
} from "@freeside-auth/protocol/api"

const NOT_IMPL_T2_3 = { error: "not_implemented", task: "T2.3", bead: "arrakis-eqxj" } as const
const NOT_IMPL_T3_2 = { error: "not_implemented", task: "T3.2", bead: "arrakis-g407" } as const

// ---------------------------------------------------------------------------
// GET /v1/profile (FR-P1)
//
// Query params: `world=:worldSlug` + either `userId` or `wallet`. Hyper
// query-param schemas would be declared via .body() once Hyper supports
// query-param Standard Schemas. For now the request-body Zod sits as the
// canonical shape; the runtime ignores it for GET. Future: when Hyper ships
// `.query(Schema)`, swap in.
// ---------------------------------------------------------------------------

export const getProfile = route
  .get("/v1/profile")
  .body(ProfileQuery)
  .meta({
    summary: "Return composed profile (spine + holdings + score + content)",
    mcp: {
      title: "Get profile",
      description:
        "Read-time compose: resolve user, fan out to inventory + score + codex. Returns Profile with degraded[] flag on downstream miss. Per FR-P1.",
    },
  })
  .handle(() => jsonResponse(501, NOT_IMPL_T2_3))

// ---------------------------------------------------------------------------
// GET /v1/mibera/dimensions (FR-M1, headline G-6 — honey-road slice)
// ---------------------------------------------------------------------------
export const getMiberaDimensions = route
  .get("/v1/mibera/dimensions")
  .body(MiberaDimensionsQuery)
  .meta({
    summary: "Return Mibera 7-dim + grail dimensions composed across inventory + codex + score",
    mcp: {
      title: "Get Mibera dimensions",
      description:
        "Resolves wallet → holdings → 7-dim traits + grail from codex; joins score. Self-view (G-6). Per FR-M1.",
    },
  })
  .handle(() => jsonResponse(501, NOT_IMPL_T3_2))
