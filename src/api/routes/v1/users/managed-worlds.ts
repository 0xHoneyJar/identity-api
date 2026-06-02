/**
 * GET /v1/users/{id}/managed-worlds — the CM→world authorization read
 * (C-2, bead arrakis-491i).
 *
 * Returns the worlds a given user MANAGES:
 *   { user_id, worlds: [{ world_slug, granted_at }, ...] }
 *
 * This is the SoR read that freeside-config (C-1) calls to authorize a
 * community-manager (CM) theme write. Management is an IDENTITY fact, so it
 * lives in the spine (this building); freeside-config consumes it.
 *
 * ── Auth gate (TWO accepted callers — composed, NOT `.auth()` sugar) ─────────
 *
 * The endpoint serves two distinct callers, so it does its OWN gate inside
 * the handler rather than chaining `.auth()` (which hard-rejects any request
 * lacking a bearer JWT — that would break the service path):
 *
 *   1. SELF (the dashboard) — a CM resolves THEIR OWN managed worlds with
 *      their bearer JWT. Authorized iff the verified `jwt.sub` === the path
 *      `{id}`. A CM may NOT read another user's grants via the bearer path
 *      (no cross-user read for end users).
 *
 *   2. SERVICE (freeside-config / another building) — resolves ANY user's
 *      managed worlds via the shared `X-Service-Token` header. This reuses
 *      the EXACT same service-to-service gate `src/api/routes/link.ts` uses
 *      (constant-time compare against `LINK_SERVICE_TOKEN`). A valid service
 *      token authorizes any `{id}` — it is the cross-user read path.
 *
 * A request is authorized iff (valid service token) OR (valid bearer JWT
 * whose sub === id). Otherwise:
 *   - 400 invalid_param   — `{id}` is not a UUID
 *   - 401 unauthorized    — neither gate satisfied (no/invalid token + no/
 *                           invalid JWT)
 *   - 403 forbidden       — valid bearer JWT but its sub ≠ the requested id
 *                           (authenticated, but not authorized for this user)
 *
 * Bearer verification reuses `verifyJwt` from `@hyper/auth-jwt` against the
 * same `JWT_SECRET` the `.auth()`-gated routes use (HS256 today; flips to
 * ES256 with the rest of the auth surface per src/auth.ts sprint-1.1 #3).
 *
 * ── NOT a 404 on empty ──────────────────────────────────────────────────────
 * A user who manages nothing returns 200 `{ user_id, worlds: [] }`. "Not a
 * manager" is a valid state, not a not-found. We do NOT pre-check that the
 * user exists (the world_managers FK guarantees a non-existent user has zero
 * edges → empty list naturally).
 *
 * ── GRANT-ISSUANCE is OUT OF SCOPE (C-2 invariant) ──────────────────────────
 * This endpoint READS the relation. The write path (who may ADD a manager) is
 * a follow-up — it can reuse the operator_grants 2-of-3 machinery or a
 * dedicated admin endpoint. Not built here. See the C-2 handoff.
 */

import { createHash, timingSafeEqual } from "node:crypto"
import { jsonResponse, badRequest, unauthorized } from "@hyper/core"
import { verifyJwt } from "@hyper/auth-jwt"
import { route, JWT_SECRET } from "../../../../auth"
import { getSpine } from "../../../spine"
import { getManagedWorlds } from "@freeside-auth/engine"
import { UserIdParamSchema } from "@freeside-auth/protocol/api"

// 403 envelope — authenticated (valid JWT) but not authorized for this id.
// Hyper's @hyper/core exposes 401 (`unauthorized`) and 404 (`notFound`) but
// not a 403 helper; we mint it directly to keep the envelope shape consistent
// with the others ({ code, message }).
function forbidden(body: { code: string; message: string }): Response {
  return jsonResponse(403, body)
}

/**
 * Resolve the service token at request time (tests set the env after module
 * load; production sets it once at boot). Reuses the SAME env var as
 * src/api/routes/link.ts so service callers present one shared secret to the
 * building, not a per-endpoint zoo of tokens.
 */
function getServiceToken(): string | null {
  const v = process.env.LINK_SERVICE_TOKEN
  return v && v.length > 0 ? v : null
}

/**
 * Constant-time service-token compare (identical to link.ts). Plain `!==`
 * leaks the configured prefix via timing on a shared-secret boundary; hashing
 * both to fixed-size SHA-256 digests + `timingSafeEqual` neutralizes it.
 */
function serviceTokenMatches(provided: string | null, configured: string): boolean {
  if (provided === null) return false
  const a = createHash("sha256").update(provided, "utf8").digest()
  const b = createHash("sha256").update(configured, "utf8").digest()
  return timingSafeEqual(a, b)
}

/**
 * Verify the bearer JWT (if present) and return its `sub`, or null if there's
 * no usable bearer token / it fails verification. NEVER throws — a malformed
 * token resolves to null (the handler then falls through to the 401 path),
 * mirroring the L7 hardening posture in src/auth.ts (bad token ≠ 500).
 */
async function verifiedSub(req: Request): Promise<string | null> {
  const h = req.headers.get("authorization")
  if (!h) return null
  const [type, value] = h.split(" ")
  if (type?.toLowerCase() !== "bearer" || !value) return null
  try {
    const { payload } = await verifyJwt(value, {
      secret: JWT_SECRET,
      algorithms: ["HS256"], // TODO(sprint-1.1-3): ES256 with the rest of the auth surface
    })
    return typeof payload.sub === "string" && payload.sub.length > 0 ? payload.sub : null
  } catch {
    // JwtError / SyntaxError / TypeError on a garbage token → unauthenticated,
    // NOT a 500. Same discrimination as src/auth.ts hardenAuthMiddleware.
    return null
  }
}

export const getManagedWorldsRoute = route
  .get("/v1/users/:id/managed-worlds")
  .meta({
    summary: "Return the worlds a user manages (CM→world authorization read)",
    mcp: {
      title: "Get user's managed worlds",
      description:
        "Returns the worlds a given user manages — the SoR freeside-config " +
        "calls to authorize a community-manager theme write. Auth: the user's " +
        "own bearer JWT (sub === id), OR a service X-Service-Token (any id). " +
        "200 + { user_id, worlds: [] } when the user manages nothing.",
    },
  })
  .handle(async (c) => {
    const params = c.params as { id?: string }

    // Validate the path param first — a malformed id is a 400 regardless of
    // auth (don't leak auth state behind a bad-input response).
    const parsed = UserIdParamSchema.safeParse(params.id)
    if (!parsed.success) {
      return badRequest({
        code: "invalid_param",
        message: "id is not a valid UUID",
        param: "id",
        issues: parsed.error.issues.map((i) => i.message),
      } as never)
    }
    const userId = parsed.data

    const req = (c as unknown as { req: Request }).req

    // ── Gate 1: service token (cross-user read; any id) ─────────────────────
    const configuredToken = getServiceToken()
    const presentedToken = req.headers.get("x-service-token")
    const serviceAuthed =
      configuredToken !== null && serviceTokenMatches(presentedToken, configuredToken)

    // ── Gate 2: self bearer JWT (sub must equal the requested id) ────────────
    let authorized = serviceAuthed
    if (!authorized) {
      const sub = await verifiedSub(req)
      if (sub === null) {
        // No service token AND no/invalid bearer JWT → unauthenticated.
        return unauthorized({
          code: "unauthorized",
          message:
            "provide a valid bearer JWT (to read your own managed worlds) " +
            "or a valid X-Service-Token (to read another user's)",
        } as never)
      }
      if (sub !== userId) {
        // Authenticated, but a non-service caller may only read their OWN
        // managed worlds. Cross-user reads require the service token.
        return forbidden({
          code: "forbidden",
          message: "a bearer caller may only read their own managed worlds",
        })
      }
      authorized = true
    }

    // Authorized (service OR self). Read the relation.
    const worlds = await getManagedWorlds(getSpine(), userId)
    return jsonResponse(200, {
      user_id: userId,
      worlds,
    })
  })
