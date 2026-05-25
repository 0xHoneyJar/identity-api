/**
 * src/auth.ts — central auth/session/csrf re-export.
 *
 * Defuses two landmines identified in the T1.0 spike verdict
 * (`grimoires/loa/spikes/t1.0-hyper-verdict.md`):
 *
 *   L4: `.auth()` is added to `RouteBuilder.prototype` at plugin-construction
 *       time by `authJwtPlugin`. Module-eval `route.X().auth()` definitions
 *       race plugin boot and 500 with "route.X(...).auth is not a function".
 *       FIX: install the .auth() method eagerly at module load via
 *       `installAuthMethod(authJwt(config))` — BEFORE any route file imports
 *       `route` from here and chains `.auth()`.
 *
 *   L5: `csrfGuard()` only issues the csrf cookie on responses from routes
 *       where it's installed. If session-bearing routes don't include
 *       `csrfGuard()` in their middleware chain, the cookie never gets set
 *       and the first mutation 403s with no recourse.
 *       FIX: a `withSession()` helper that bundles `session({...}) + csrfGuard()`.
 *       Always call `.use(...withSession())` — never one without the other.
 *
 * Discipline: every file in `src/api/` that needs auth/session imports
 * `route, withSession` from THIS file, NOT from `@hyper/*` directly. This
 * makes the L4/L5 pairing enforceable by code review (a `.auth()` chain that
 * imported `route` from `@hyper/core` directly is grep-detectable).
 *
 * Sprint-1.1 follow-up #3 — ES256 swap: this module currently uses HS256
 * per the T1.0 spike. SDD FR-J2 specifies ES256 (D7). Either (a) verify
 * `@hyper/auth-jwt` supports ES256 in `jwt.ts`, or (b) swap to an in-house
 * `jose`-based verifier reusing `packages/adapters/src/jwks-validator.ts`.
 * TODO(T-future/sprint-1.1-3): perform the swap; this comment is the seam.
 */

import { route, type Middleware } from "@hyper/core"
import { authJwt, installAuthMethod } from "@hyper/auth-jwt"
import { csrfGuard, memorySessions, session, type SessionStore } from "@hyper/session"

// ---------------------------------------------------------------------------
// Secret loading + fail-fast validation.
//
// `authJwt` and `session` both enforce MIN_*_SECRET_BYTES=32 at boot (their
// own check throws with a helpful "fix:" message). We re-validate up front
// so a developer who forgot to set the env vars hits a single clean error
// instead of two-pass failures from inside the plugin constructors.
// ---------------------------------------------------------------------------
function loadSecret(envName: string, dev_fallback_length = 32): string {
  const v = process.env[envName]
  if (v && v.length >= 32) return v
  // Dev-only: synthesize a 32-byte secret so the module loads. The plugin's
  // own validateJwtSecret/validateSessionSecret will accept it. PRODUCTION
  // MUST set both; this branch keeps `bun --hot src/api/index.ts` working
  // out of the box during development.
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      `auth.ts: ${envName} is unset or shorter than 32 bytes. Why: HS256 ` +
        `secrets <32 bytes are brute-forceable. Fix: set ${envName} in ` +
        `Railway env (\`openssl rand -base64 48\`).`,
    )
  }
  process.stderr.write(
    `[auth.ts] warning: ${envName} unset in dev; using ephemeral synthesized secret. ` +
      `Set ${envName} for stable sessions across restarts.\n`,
  )
  return "dev-only-".padEnd(dev_fallback_length, "y")
}

export const JWT_SECRET = loadSecret("JWT_SECRET")
export const SESSION_SECRET = loadSecret("SESSION_SECRET")

// ---------------------------------------------------------------------------
// L4 fix: install .auth() on RouteBuilder.prototype BEFORE any route file
// chains it. Anything that imports `route` from this module is now safe to
// call `.auth()` because the runtime patch has already been applied.
// ---------------------------------------------------------------------------
const jwtMw = authJwt({
  secret: JWT_SECRET,
  algorithms: ["HS256"], // TODO(sprint-1.1-3): swap to ["ES256"] — see header comment
})
installAuthMethod(jwtMw)

// Re-export `route` so consumers import it from here (not from @hyper/core).
// The import-order discipline is: any module that imports `route` MUST get
// it from `./auth` — making the L4 fix transitively guaranteed.
export { route }

// ---------------------------------------------------------------------------
// L5 fix: `withSession()` bundles `session(...)` + `csrfGuard()` so they're
// always paired. Spread into `.use(...)`:
//
//   import { route, withSession } from "./auth"
//   route.post("/v1/...").use(...withSession()).body(Schema).handle(...)
//
// `csrfGuard()` is the cookie-issuer; without it on the first session-bearing
// response, mutating requests have no token to echo. The guard's
// `isEstablished` check means login itself is exempt (so a login route
// inside `withSession()` works).
// ---------------------------------------------------------------------------
let _sharedStore: SessionStore | null = null
function defaultStore(): SessionStore {
  // Dev-default: memory store. Sprint-1.x follow-up: swap to pgSessions()
  // backed by the spine PG (or sqlite for single-instance Railway). The
  // module-level cache keeps the SAME store across the whole process so
  // sessions issued on one request are visible to subsequent ones.
  if (!_sharedStore) _sharedStore = memorySessions()
  return _sharedStore
}

export function withSession(): [Middleware, Middleware] {
  return [
    session({
      secret: SESSION_SECRET,
      cookieName: "idapi_sess",
      store: defaultStore(),
    }) as Middleware,
    csrfGuard() as Middleware,
  ]
}

/**
 * Chain helper — applies both session + csrfGuard to a RouteBuilder.
 *
 * Hyper's `RouteBuilder.use(mw)` takes exactly one middleware (NOT a spread).
 * `withSession()` returns the pair, but you can't `.use(...withSession())`
 * because `.use()` is unary. Either chain `.use(mws[0]).use(mws[1])` or call
 * this helper.
 *
 *   import { route, applyWithSession } from "../auth"
 *   const r = applyWithSession(route.post("/v1/..."))
 *     .body(Schema)
 *     .handle(...)
 *
 * Returns a RouteBuilder of the same shape (chainable).
 */
// biome-ignore lint/suspicious/noExplicitAny: generic over arbitrary RouteBuilder state
export function applyWithSession<R extends { use(mw: Middleware): R }>(builder: R): R {
  const [sess, csrf] = withSession()
  return builder.use(sess).use(csrf)
}

// ---------------------------------------------------------------------------
// `withAuth()` is the JWT-bearer-token analog: composes the same auth check
// `.auth()` does, but as a middleware spread so it can be combined with other
// middlewares (e.g. rate limit) on a single chain. For most routes,
// `.auth()` sugar is cleaner; this is the escape hatch.
//
// Currently a no-op stub — the JWT middleware is already installed on
// RouteBuilder.prototype via installAuthMethod above. Reserved for future
// per-route layered auth (e.g. service-to-service bearer + user JWT).
// ---------------------------------------------------------------------------
export function withAuth(): [] {
  return []
}
