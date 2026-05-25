/**
 * src/auth.ts — central auth/session/csrf re-export.
 *
 * Defuses three landmines identified in the T1.0 spike verdict
 * (`grimoires/loa/spikes/t1.0-hyper-verdict.md`):
 *
 *   L4: `.auth()` is added to `RouteBuilder.prototype` at plugin-construction
 *       time by `authJwtPlugin`. Module-eval `route.X().auth()` definitions
 *       race plugin boot and 500 with "route.X(...).auth is not a function".
 *       FIX: install the .auth() method eagerly at module load via
 *       `installAuthMethod(hardenedAuthMw)` — BEFORE any route file imports
 *       `route` from here and chains `.auth()`.
 *
 *   L5: `csrfGuard()` only issues the csrf cookie on responses from routes
 *       where it's installed. If session-bearing routes don't include
 *       `csrfGuard()` in their middleware chain, the cookie never gets set
 *       and the first mutation 403s with no recourse.
 *       FIX: a `withSession()` helper that bundles `session({...}) + csrfGuard()`.
 *       Always call `.use(...withSession())` — never one without the other.
 *
 *   L7: malformed bearer JWT (token that isn't base64-decodable as JSON) →
 *       500 `JSON Parse error`, not the expected 401. `auth-jwt/jwt.ts`'s
 *       `verifyJwt` calls `JSON.parse(b64urlToUtf8(h))` for the header +
 *       payload — a non-JSON garbage payload throws `SyntaxError`, which
 *       leaks past the middleware's `catch (e) { if (e instanceof JwtError)`
 *       narrow-catch.
 *       FIX (T1.6 LBR-3 / path I): wrap the installed auth middleware here
 *       so SyntaxError / TypeError are caught and converted to 401, KEEPING
 *       vendored Hyper pristine (no hyper.lock.json drift). The upstream
 *       in-vendored-source patch is Sprint-1.1 follow-up #6.
 *
 * Discipline: every file in `src/api/` that needs auth/session imports
 * `route, withSession` from THIS file, NOT from `@hyper/*` directly. This
 * makes the L4/L5/L7 pairing enforceable by code review (a `.auth()` chain
 * that imported `route` from `@hyper/core` directly is grep-detectable).
 *
 * Sprint-1.1 follow-up #3 — ES256 swap: this module currently uses HS256
 * per the T1.0 spike. SDD FR-J2 specifies ES256 (D7). Either (a) verify
 * `@hyper/auth-jwt` supports ES256 in `jwt.ts`, or (b) swap to an in-house
 * `jose`-based verifier reusing `packages/adapters/src/jwks-validator.ts`.
 * TODO(T-future/sprint-1.1-3): perform the swap; this comment is the seam.
 */

import { route, type Middleware } from "@hyper/core"
import { authJwt, installAuthMethod, JwtError } from "@hyper/auth-jwt"
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
//
// L7 fix (T1.6 LBR-3): hardenAuthMiddleware wraps the vendored authJwt
// middleware to catch SyntaxError / TypeError (and any other non-JwtError
// crypto-adjacent throw) and convert to 401 instead of letting them surface
// as a 500. The hardened middleware is what gets installed onto the
// RouteBuilder prototype; every `.auth()` chain transitively uses the wrap.
//
// We DON'T patch src/hyper/auth-jwt/jwt.ts directly (path-II option in the
// brief) — keeps hyper.lock.json pristine. Sprint-1.1 follow-up #6 will land
// the upstream patch + remove this wrap.
// ---------------------------------------------------------------------------
const jwtMw = authJwt({
  secret: JWT_SECRET,
  algorithms: ["HS256"], // TODO(sprint-1.1-3): swap to ["ES256"] — see header comment
})
const hardenedJwtMw = hardenAuthMiddleware(jwtMw)
installAuthMethod(hardenedJwtMw)

// Re-export `route` so consumers import it from here (not from @hyper/core).
// The import-order discipline is: any module that imports `route` MUST get
// it from `./auth` — making the L4 fix transitively guaranteed.
export { route }

// ---------------------------------------------------------------------------
// hardenAuthMiddleware — L7 / LBR-3 wrap.
//
// The vendored authJwt middleware's structure is:
//   async ({ ctx, req, next }) => {
//     const token = extract(req)
//     if (!token) return unauthorized('missing_token')
//     try {
//       const { payload } = await verifyJwt(token, config)
//       // … populate ctx.user / ctx.jwt
//       return next()
//     } catch (e) {
//       if (e instanceof JwtError) return unauthorized(e.code)
//       throw e   // ← THIS leaks SyntaxError/TypeError as 500
//     }
//   }
//
// The narrow-catch on `JwtError` is the issue. `verifyJwt` calls
// `JSON.parse(b64urlToUtf8(headerSegment))` and `JSON.parse(b64urlToUtf8(
// payloadSegment))` without wrapping — a non-JSON-decodable garbage segment
// throws a vanilla `SyntaxError` that bypasses the catch. Hyper's outer
// pipeline turns the rethrow into 500.
//
// We wrap: anything thrown that's NOT a JwtError AND looks like attacker-
// controlled-input parse failure (SyntaxError, TypeError) becomes 401. We
// LET genuine application errors (Error subclasses outside the parse-error
// class, async exceptions from downstream middleware) propagate as 5xx.
//
// Discrimination criteria:
//   - SyntaxError (covers `JSON.parse` failures including from b64urlToUtf8
//     producing invalid UTF-8 → atob throws SyntaxError too)
//   - TypeError (covers `s.split('.')` returning unexpected shapes / similar
//     coercion failures from a token that isn't a 3-segment string)
// Everything else: rethrow.
//
// Response shape mirrors the underlying middleware's 401 shape so consumers
// see consistent error envelopes regardless of failure class.
// ---------------------------------------------------------------------------
function hardenAuthMiddleware(inner: Middleware): Middleware {
  return async (args) => {
    try {
      return await inner(args)
    } catch (e) {
      if (e instanceof JwtError) {
        // The inner middleware should already convert JwtError → 401, but
        // defense-in-depth: if a JwtError escapes the inner catch (e.g.,
        // upstream code-path change leaves a path uncovered), we still
        // return 401 rather than 500.
        return unauthorized401("invalid_token")
      }
      if (e instanceof SyntaxError || e instanceof TypeError) {
        // The L7 leak path: malformed base64 / non-JSON token payload.
        // 401 is the right code (the caller's token is bad), NOT 500.
        return unauthorized401("malformed_token")
      }
      // Genuine downstream error — let it propagate; Hyper's outer error
      // pipeline will render the appropriate 5xx with request_id.
      throw e
    }
  }
}

/** 401 envelope matching the vendored auth-jwt middleware's shape. */
function unauthorized401(code: string): Response {
  return new Response(JSON.stringify({ error: "unauthorized", code }), {
    status: 401,
    headers: {
      "content-type": "application/json",
      // Mirror the vendored hyper auth-jwt header for consistency.
      "www-authenticate": 'Bearer realm="hyper", error="invalid_token"',
    },
  })
}

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
