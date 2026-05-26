/**
 * svc-JWT Verifier — W2.5 cluster-auth substrate (D-1.1 §5).
 *
 * Materializes the canonical svc-JWT verify() surface from the ratified
 * Sprint 1 spec at `grimoires/svc-jwt-spec.md` §5. Implements the 10-step
 * order-of-operations pipeline that returns a structured `VerifyResult`
 * for every input — NEVER throws.
 *
 * Per-request model (D2.5-12 / SDD §0a anchor):
 *   svc-JWTs are minted FRESH per cross-cell call. There is no token
 *   reuse, no client-side cache, no refresh-at-90%-TTL. Replay is
 *   mechanically infeasible inside the bounded TTL (≤1h). The verifier
 *   carries NO replay-store opt; the denylist (D-1.1 §6) is the only
 *   persistence-affecting verify-time check.
 *
 *   EXPLICIT NON-PRESENCE (§0a): there is NO `replayStore` opt on
 *   `VerifyOpts`; there is NO `checkAndRecord` call in the order-of-ops;
 *   there is NO `REPLAYED_JTI` error code. These belonged to the iter-2
 *   design that D2.5-12 structurally removed. Cells MUST NOT add a
 *   verify-time replay-store check; doing so re-introduces the storage-DoS
 *   surface, the verify-jti HTTP round-trip, and the cell-bound
 *   `replay_api_keys` table — all of which the per-request model deletes
 *   by design.
 *
 * Conformance: 11 scenarios per D-1.1 §8 + total-function fuzz cases
 * (verify('') / verify('bogus') / verify(undefined) all return without
 * throwing). See svc-jwt-verifier.test.ts.
 *
 * Source-of-truth: `grimoires/svc-jwt-spec.md` §5 (commit ce0bb8a).
 * Sibling: `./jwks-validator.ts` (W2 user-JWT cache pattern; reused
 * conceptually for the JwksCache contract).
 */

import { jwtVerify, importJWK, decodeProtectedHeader, decodeJwt, type JWK } from 'jose';
import { Schema as S } from '@effect/schema';
import { Either } from 'effect';
import {
  SvcJwtClaims as SvcJwtClaimsSchema,
  SvcJwtHeader as SvcJwtHeaderSchema,
} from '@freeside-auth/protocol';

// ─── Public types ──────────────────────────────────────────────────────

/**
 * SvcJwtClaims type alias — re-exported via the Effect.Schema-derived
 * type from `@freeside-auth/protocol/svc-jwt-claims`. Consumers of
 * `VerifyResult` get strongly-typed claims on success.
 */
export type SvcJwtClaims = S.Schema.Type<typeof SvcJwtClaimsSchema>;

/**
 * JWKS cache contract (D-1.1 §5; identical to W2 JwksValidator's cache
 * surface). svc-JWT verifiers consume the SAME cache as user-JWT
 * verifiers; the kid-prefix disambiguation (§5 step 5) handles class
 * separation. Per-request JWKS fetch is a DoS vector — the cache is
 * MANDATORY.
 */
export interface JwksCache {
  /** Returns cached keys for the URL or null on cache miss. */
  get(url: string): Promise<JWK[] | null>;
  /** Populates the cache with freshly-fetched keys for the given URL. */
  set(url: string, keys: JWK[], ttlSec: number): Promise<void>;
}

/**
 * Denylist hook (D-1.1 §6). The verifier calls `matches(kid, jti, sub)`
 * at step 10 (after sig + claim validation). Connection errors MUST be
 * thrown — the verifier translates them to `DENYLIST_UNAVAILABLE` 503
 * (fail-CLOSED per NF-Sec-1).
 *
 * Implementations:
 *   - `PostgresDenylistCheck` (in `./denylist-postgres.ts`) — direct DB
 *     query for identity-api itself + cells with direct PG access.
 *   - HTTP indirection — cells without direct PG access POST to
 *     `/v1/auth/denylist/check` (see `src/api/routes/v1/auth/denylist/check.ts`).
 */
export interface DenylistCheck {
  matches(
    kid: string,
    jti: string,
    sub: string,
  ): Promise<
    | { denied: true; reason: string; ruleId: string }
    | { denied: false }
  >;
}

/**
 * Verify options surface (D-1.1 §5).
 *
 * **EXPLICIT NON-PRESENCE**: there is NO `replayStore` opt. The
 * per-request issuance model (D2.5-12) structurally removed the
 * verify-time replay store. Adding it back would re-introduce the
 * storage-DoS surface and the verify-jti HTTP round-trip; both are
 * deleted by design.
 */
export interface VerifyOpts {
  /** identity-api URL — issuer allowlist (exact match, no wildcards). */
  expectedIss: string;
  /** This cell's own name — exact match. */
  expectedAud: string;
  /** Endpoint's required capability — exact-string match. */
  expectedRole: string;
  /** Default "svc-" — rejects user-JWT kids (and other prefix classes). */
  expectedKidPrefix?: string;
  /** Mandatory cache; per-request JWKS fetch is a DoS vector. */
  jwksCache: JwksCache;
  /** Post-validation hook (§6); fail-CLOSED on DB unavailability. */
  denylistCheck: DenylistCheck;
  /** Default 30s clock-skew tolerance. */
  skewSec?: number;
  /** JWKS URL — pass-through to jwksCache.get(url). */
  jwksUrl: string;
  /**
   * Test-injectable JWKS fetch (on cache miss). Default: globalThis.fetch.
   * Tests pass a stub; production uses fetch directly.
   */
  fetch?: (url: string) => Promise<Response>;
  /**
   * Test-injectable clock (unix seconds). Default: Date.now()/1000.
   */
  now?: () => number;
}

/**
 * Result codes (D-1.1 §5). HTTP status mapping is the CALLER's job —
 * route handlers translate `VerifyErrorCode` → HTTP status per the
 * vocabulary documented in the spec.
 */
export type VerifyErrorCode =
  | 'MALFORMED' // → HTTP 400 — structural parse fails (no I/O)
  | 'INVALID_SIG' // → HTTP 401 — sig validation failed (one I/O — JWKS fetch)
  | 'EXPIRED' // → HTTP 401 — exp ≤ now - skewSec
  | 'NBF_FUTURE' // → HTTP 401 — nbf > now + skewSec
  | 'ISS_MISMATCH' // → HTTP 401 — iss claim ≠ expectedIss
  | 'KID_DISALLOWED' // → HTTP 401 — kid prefix ≠ expectedKidPrefix
  | 'ROLE_MISMATCH' // → HTTP 403 — role claim ≠ expectedRole
  | 'AUD_MISMATCH' // → HTTP 403 — aud claim ≠ expectedAud
  | 'JWKS_UNREACHABLE' // → HTTP 503 — fail-CLOSED; no stale fallback past 72h
  | 'DENIED_BY_RULE' // → HTTP 403 — denylist matched (§6)
  | 'DENYLIST_UNAVAILABLE'; // → HTTP 503 — fail-CLOSED; denylist DB unreachable

export type VerifyResult =
  | { ok: true; claims: SvcJwtClaims }
  | { ok: false; code: VerifyErrorCode; message: string; ruleId?: string };

// ─── Implementation ────────────────────────────────────────────────────

const DEFAULT_KID_PREFIX = 'svc-';
const DEFAULT_SKEW_SEC = 30;
const JWKS_CACHE_TTL_SEC = 60 * 60; // 1h (matches W2 JwksValidator)

/**
 * Verify a svc-JWT per D-1.1 §5 10-step pipeline.
 *
 * Hot path:
 *   Steps 1–5 (parse + claim shape + exp/nbf + iss + kid-prefix): zero I/O.
 *     An attacker flooding the verifier with malformed/expired/wrong-iss
 *     JWTs can NEVER trigger a JWKS fetch or denylist query.
 *   Step 6 (JWKS): one I/O, bounded by cache hit rate (1h fresh window).
 *   Step 7 (sig verify): zero I/O (uses cached key material).
 *   Steps 8–9 (aud + role): zero I/O.
 *   Step 10 (denylist): one I/O. Only reached after sig + claim checks pass.
 *
 * Per `verify() MUST NOT throw` invariant: every exception path inside
 * is caught and translated to a structured `{ ok: false, code, message }`.
 */
export async function verify(jwt: string, opts: VerifyOpts): Promise<VerifyResult> {
  const skewSec = opts.skewSec ?? DEFAULT_SKEW_SEC;
  const expectedKidPrefix = opts.expectedKidPrefix ?? DEFAULT_KID_PREFIX;
  const now = opts.now ? opts.now() : Math.floor(Date.now() / 1000);

  // ─── Step 1: parse JWT structure (no I/O) ─────────────────────────
  if (typeof jwt !== 'string' || jwt.length === 0) {
    return {
      ok: false,
      code: 'MALFORMED',
      message: 'JWT is empty or not a string',
    };
  }
  const parts = jwt.split('.');
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) {
    return {
      ok: false,
      code: 'MALFORMED',
      message: 'JWT must have three non-empty dot-separated parts',
    };
  }

  // ─── Step 2: decode header + claims (no I/O) ──────────────────────
  let rawHeader: unknown;
  try {
    rawHeader = decodeProtectedHeader(jwt);
  } catch {
    return {
      ok: false,
      code: 'MALFORMED',
      message: 'JWT header is not decodable',
    };
  }

  // Validate header structure via Effect.Schema (alg/typ literals + kid pattern).
  const headerEither = S.decodeUnknownEither(SvcJwtHeaderSchema)(rawHeader);
  if (Either.isLeft(headerEither)) {
    // Header schema mismatch — wrong alg, wrong typ, or kid that doesn't
    // start with `svc-` AND have a non-empty suffix. Determine the
    // specific code: a kid that exists but doesn't match the expected
    // prefix → KID_DISALLOWED; everything else → MALFORMED.
    const h = rawHeader as { kid?: unknown; alg?: unknown };
    if (typeof h.kid === 'string' && !h.kid.startsWith(expectedKidPrefix)) {
      return {
        ok: false,
        code: 'KID_DISALLOWED',
        message: `kid prefix ${JSON.stringify(h.kid)} does not match expected ${JSON.stringify(expectedKidPrefix)}`,
      };
    }
    // alg-not-ES256 / typ-not-JWT / structurally-broken kid → MALFORMED.
    return {
      ok: false,
      code: 'MALFORMED',
      message: 'JWT header failed schema validation',
    };
  }
  const header = headerEither.right;
  const kid = header.kid;

  // Defense-in-depth: the schema pattern is /^svc-.+$/ which already
  // enforces the default `expectedKidPrefix === "svc-"`. But callers MAY
  // pass a different `expectedKidPrefix` (e.g. a stricter custom prefix).
  // Re-check here.
  if (!kid.startsWith(expectedKidPrefix)) {
    return {
      ok: false,
      code: 'KID_DISALLOWED',
      message: `kid prefix ${JSON.stringify(kid)} does not match expected ${JSON.stringify(expectedKidPrefix)}`,
    };
  }

  let rawClaims: unknown;
  try {
    rawClaims = decodeJwt(jwt);
  } catch {
    return {
      ok: false,
      code: 'MALFORMED',
      message: 'JWT payload is not decodable',
    };
  }

  // ─── Step 3: exp / nbf vs now ± skewSec (no I/O) ──────────────────
  // We do a soft exp/nbf check here BEFORE schema validation to ensure
  // expiration takes precedence over schema drift (an expired JWT should
  // surface as EXPIRED, not MALFORMED, even if a future field changes).
  // We then run schema validation to ensure all required fields are present.
  const claimsCandidate = rawClaims as {
    exp?: unknown;
    nbf?: unknown;
    iss?: unknown;
    aud?: unknown;
    sub?: unknown;
    role?: unknown;
    jti?: unknown;
    iat?: unknown;
  };

  if (typeof claimsCandidate.exp === 'number') {
    if (claimsCandidate.exp <= now - skewSec) {
      return {
        ok: false,
        code: 'EXPIRED',
        message: `JWT expired: exp=${claimsCandidate.exp} ≤ now-skew=${now - skewSec}`,
      };
    }
  }
  if (typeof claimsCandidate.nbf === 'number') {
    if (claimsCandidate.nbf > now + skewSec) {
      return {
        ok: false,
        code: 'NBF_FUTURE',
        message: `JWT not yet valid: nbf=${claimsCandidate.nbf} > now+skew=${now + skewSec}`,
      };
    }
  }

  // ─── Step 4: iss claim matches expectedIss (no I/O) ───────────────
  if (claimsCandidate.iss !== opts.expectedIss) {
    return {
      ok: false,
      code: 'ISS_MISMATCH',
      message: `iss claim ${JSON.stringify(claimsCandidate.iss)} does not match expected ${JSON.stringify(opts.expectedIss)}`,
    };
  }

  // Now run the full schema validation — guarantees all required fields
  // are present and well-typed for downstream consumers.
  const claimsEither = S.decodeUnknownEither(SvcJwtClaimsSchema)(rawClaims);
  if (Either.isLeft(claimsEither)) {
    return {
      ok: false,
      code: 'MALFORMED',
      message: 'JWT claims failed schema validation',
    };
  }
  const claims = claimsEither.right;

  // ─── Step 5: kid prefix re-check (already done above) ─────────────
  // (KID_DISALLOWED is checked twice — once at header schema time, once
  // here against the caller's `expectedKidPrefix` override. Per §5 step 5.)
  // No-op at this position; included for spec-step traceability.

  // ─── Step 6: fetch JWKS via cache (one I/O) ───────────────────────
  let jwks: JWK[];
  try {
    const cached = await opts.jwksCache.get(opts.jwksUrl);
    if (cached !== null) {
      jwks = cached;
    } else {
      const fetchImpl = opts.fetch ?? ((url: string) => globalThis.fetch(url));
      const res = await fetchImpl(opts.jwksUrl);
      if (!res.ok) {
        return {
          ok: false,
          code: 'JWKS_UNREACHABLE',
          message: `JWKS fetch returned ${res.status}`,
        };
      }
      const body = (await res.json()) as { keys?: unknown };
      if (!body || !Array.isArray(body.keys)) {
        return {
          ok: false,
          code: 'JWKS_UNREACHABLE',
          message: 'JWKS response shape invalid',
        };
      }
      jwks = body.keys as JWK[];
      try {
        await opts.jwksCache.set(opts.jwksUrl, jwks, JWKS_CACHE_TTL_SEC);
      } catch {
        // Cache write failure is not fatal; we have the keys in hand.
      }
    }
  } catch {
    return {
      ok: false,
      code: 'JWKS_UNREACHABLE',
      message: 'JWKS fetch threw',
    };
  }

  const jwk = jwks.find((k) => k.kid === kid);
  if (!jwk) {
    // BB F-003 fix: kid passed the prefix check (step 5) but no matching
    // key is currently published — semantically a KID_DISALLOWED (the kid
    // is not in the trust set), NOT JWKS_UNREACHABLE (the JWKS document
    // IS reachable; it just doesn't carry this kid). The previous code
    // mapped this to 503, which gave operators a misleading error class
    // during normal rotation-overlap windows + impossible-kid attacks.
    // Cells holding a JWT under a retired kid get 401 KID_DISALLOWED;
    // they can re-mint with the current kid (per-request issuance model).
    return {
      ok: false,
      code: 'KID_DISALLOWED',
      message: `no JWK matches kid ${JSON.stringify(kid)} (rotation overlap, retired kid, or impossible kid)`,
    };
  }

  // ─── Step 7: signature verify (no further I/O) ────────────────────
  try {
    const key = await importJWK(jwk, 'ES256');
    // Use jose's jwtVerify but DO NOT pass issuer/audience options —
    // we've already validated those in steps 4 + 8 via our own logic.
    // BB F-001 fix: clockTolerance now mirrors our manual `skewSec` (step
    // 3) so jose's internal exp/nbf check aligns with ours. The earlier
    // clockTolerance:0 created a double-check that returned INVALID_SIG
    // for tokens within our manual tolerance window (semantically EXPIRED).
    await jwtVerify(jwt, key, { clockTolerance: skewSec });
  } catch {
    return {
      ok: false,
      code: 'INVALID_SIG',
      message: 'signature verification failed',
    };
  }

  // ─── Step 8: aud === expectedAud (no I/O) ─────────────────────────
  if (claims.aud !== opts.expectedAud) {
    return {
      ok: false,
      code: 'AUD_MISMATCH',
      message: `aud claim ${JSON.stringify(claims.aud)} does not match expected ${JSON.stringify(opts.expectedAud)}`,
    };
  }

  // ─── Step 9: role === expectedRole (no I/O) ───────────────────────
  if (claims.role !== opts.expectedRole) {
    return {
      ok: false,
      code: 'ROLE_MISMATCH',
      message: `role claim ${JSON.stringify(claims.role)} does not match expected ${JSON.stringify(opts.expectedRole)}`,
    };
  }

  // ─── Step 10: denylist query (one I/O) ────────────────────────────
  try {
    const denylistResult = await opts.denylistCheck.matches(kid, claims.jti, claims.sub);
    if (denylistResult.denied) {
      return {
        ok: false,
        code: 'DENIED_BY_RULE',
        message: `denylist rule matched: ${denylistResult.reason}`,
        ruleId: denylistResult.ruleId,
      };
    }
  } catch {
    return {
      ok: false,
      code: 'DENYLIST_UNAVAILABLE',
      message: 'denylist DB unreachable; fail-CLOSED per NF-Sec-1',
    };
  }

  // ─── Success ──────────────────────────────────────────────────────
  return { ok: true, claims };
}
