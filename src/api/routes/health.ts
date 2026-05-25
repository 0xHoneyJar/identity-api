/**
 * Health route — public, no auth, no MCP exposure.
 *
 * Returns `{ok: true}` for Railway healthcheck (and any external uptime
 * probe). Heeds T1.0 verdict landmine L1 indirectly: this route only
 * succeeds if the listener bound to 0.0.0.0 (see src/api/index.ts).
 */

import { ok } from "@hyper/core"
import { route } from "../../auth"

export const health = route
  .get("/health")
  .meta({ summary: "Liveness check (Railway probe)" })
  .handle(() => ok({ ok: true as const }))
