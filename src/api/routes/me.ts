/**
 * /v1/me — JWT-bearer authenticated identity (SDD §5.2 / FR-A3).
 *
 * T1.5 (bead arrakis-232n) — wires the route to engine `getIdentity`.
 *
 * Auth: the route is gated by `.auth()` (RouteBuilder.prototype.auth,
 * pre-installed by src/auth.ts at module load — L4 fix). On a valid JWT
 * the middleware populates:
 *   - `ctx.ctx.jwt`  → the verified JWT payload (sub, iss, exp, etc.)
 *   - `ctx.ctx.user` → { sub, scope } (default loader)
 * On a missing/invalid JWT the middleware returns 401 before this handler
 * runs — we can rely on `ctx.ctx.jwt.sub` being present here.
 *
 * Spec note (SDD §5.2): the route returns `{ user_id, primary_wallet }`.
 * For the v1 ergonomic surface we return the FULL Identity shape (same as
 * /v1/identity/:userId) since the caller usually wants the wallets[] +
 * linked_accounts[] for downstream rendering anyway. The doc lists the
 * minimum surface; we add the rest as a strict superset (callers that
 * read only `user_id`/`primary_wallet` continue to work).
 *
 * UserId source: `sub` in the JWT payload, which T1.6 will populate with
 * the spine user_id at /v1/auth/verify. Until T1.6 lands, the only way to
 * exercise this route is with a hand-minted HS256 JWT whose `sub` is a
 * known user_id (UUID) in the spine — the integration tests use exactly
 * that pattern.
 *
 * 404 contract: a session whose `sub` is not in the users table returns
 * 404 (not 401) — the JWT is valid, the user is just gone. This shouldn't
 * happen in practice (users are append-only via mint) but the 404 is the
 * principled response if it does (e.g., manual DB cleanup, time-travel).
 */

import { jsonResponse, notFound, unauthorized } from "@hyper/core"
import { route } from "../../auth"
import { getSpine } from "../spine"
import { getIdentity } from "@freeside-auth/engine"
import { z } from "zod"

const meBuilder = route
  .get("/v1/me")
  .meta({
    summary: "Return the JWT-bearing caller's user_id + primary wallet (+ full identity)",
    mcp: {
      title: "Get authenticated identity",
      description:
        "Returns the user_id and primary wallet for the bearer-JWT holder, plus the full Identity shape. Per FR-A3.",
    },
  }) as unknown as { auth: () => typeof routeBuilderShim }

// Hyper's `.auth()` sugar returns a builder whose only relevant member here
// is `.handle()`. The local `routeBuilderShim` type captures that contract
// without depending on Hyper's internals (which the L4 fix workaround in
// src/auth.ts also uses).
declare const routeBuilderShim: {
  handle: (
    h: (c: {
      ctx: { jwt?: { sub?: string } | undefined; user?: { sub?: string } | undefined }
    }) => unknown,
  ) => unknown
}

// JWT sub must be a UUID v4 (T1.6 will mint it from the spine user_id).
const _SubUuid = z.string().uuid()

export const me = meBuilder.auth().handle(async (c) => {
  const sub = c.ctx.jwt?.sub ?? c.ctx.user?.sub
  if (typeof sub !== "string" || sub.length === 0) {
    // .auth() should have rejected before this point, but defense in depth:
    return unauthorized({ code: "missing_sub", message: "JWT sub claim absent" } as never)
  }
  const parsed = _SubUuid.safeParse(sub)
  if (!parsed.success) {
    return unauthorized({
      code: "invalid_sub",
      message: "JWT sub is not a UUID",
    } as never)
  }
  const identity = await getIdentity(getSpine(), parsed.data)
  if (!identity) {
    return notFound({
      code: "not_found",
      message: "JWT sub references a user not in the spine",
    } as never)
  }
  return jsonResponse(200, identity)
})
