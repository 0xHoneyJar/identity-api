/**
 * /v1/users/{id}/managed-worlds response Zod schemas (C-2, bead arrakis-491i).
 *
 * The CM→world authorization read surface. Returns the worlds a given user
 * MANAGES — the SoR that freeside-config (C-1) calls to authorize a
 * community-manager theme write.
 *
 * Schema library — ZOD (deliberate): the entire `api/*` route-schema family
 * is zod-bound because Hyper's `.body(...)` + the `zodConverter` OpenAPI
 * plugin (src/api/index.ts) generate the spec from zod schemas. The cluster's
 * "new protocol types use Effect.Schema" direction (the W2.5 svc-jwt CLAIM
 * types) applies to standalone protocol/claim shapes, NOT to the HTTP route
 * I/O schemas in this directory — mixing Effect.Schema here would break
 * OpenAPI generation + the typed-SDK derivation (`z.infer<>`). This file
 * follows the established `api/resolve.ts` / `api/profile.ts` precedent.
 *
 * Pattern B (T1.10): server route AND typed SDK both import from here — one
 * source of truth, no codegen step.
 */

import { z } from "zod"
import { UserIdParamSchema, WorldSlugParamSchema } from "./resolve"

// Re-export the path-param schema so the route + SDK validate `{id}` against
// the same `z.string().uuid()` rule the resolve endpoints use.
export { UserIdParamSchema }

// ─── response schema (C-2) ───────────────────────────────────────────────────

/**
 * One managed-world entry. Mirrors `@freeside-auth/ports#SpineManagedWorld`
 * exactly (the row shape `PostgresSpineAdapter.getManagedWorlds` returns).
 *
 * `world_slug` reuses the resolve family's `WorldSlugParamSchema` regex so
 * the wire shape is validated against the same lowercase-slug rule the rest
 * of the spine enforces. `granted_at` is an ISO-8601 timestamp string (the
 * spine returns timestamptz as a string, same as every other `*_at` field).
 */
export const ManagedWorldSchema = z.object({
  world_slug: WorldSlugParamSchema,
  granted_at: z.string(),
})
export type ManagedWorld = z.infer<typeof ManagedWorldSchema>

/**
 * GET /v1/users/{id}/managed-worlds response.
 *
 *   { user_id: <uuid>, worlds: [{ world_slug, granted_at }, ...] }
 *
 * `worlds` is `[]` for a user who manages nothing (a valid, non-error state —
 * the endpoint is always 200 for an authorized caller; "not a manager" is an
 * empty list, not a 404).
 */
export const ManagedWorldsRespSchema = z.object({
  user_id: z.string().uuid(),
  worlds: z.array(ManagedWorldSchema).readonly(),
})
export type ManagedWorldsResp = z.infer<typeof ManagedWorldsRespSchema>
