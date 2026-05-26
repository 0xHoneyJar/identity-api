/**
 * SvcJwtClaims (Effect.Schema TS binding) — W2.5 cluster auth substrate.
 *
 * Materializes the canonical svc-JWT claim schema from D-1.1 §1
 * (`grimoires/svc-jwt-spec.md`, ratified at commit `ce0bb8a` in branch
 * `feat/w2.5-sprint-1-spec-docs`). The svc-JWT is the **cell-to-cell**
 * service-token primitive — distinct from the W2 **user-JWT** at
 * `./jwt-claims.ts` (Privy-backed user-session tokens). The two token
 * classes share the same JWKS document but disambiguate via `kid`
 * prefix: user-kids carry the `user-` prefix and svc-kids carry the
 * `svc-` prefix (D-1.1 §1 + §2). Verifiers reject wrong-prefix kids at
 * the structural stage (zero I/O) to close kid-confusion attacks.
 *
 * **First Effect.Schema artifact in the cluster.** This module
 * inaugurates the zod→Effect.Schema transition for `identity-api`
 * `packages/protocol`. Per operator-memory `freeside-effect-transition`
 * (2026-05-26), the cluster is mid-transition: NEW protocol-layer types
 * use `@effect/schema`; the legacy zod schemas in this package
 * (`jwt-claims.ts`, `identity-component.ts`, `credential-dynamic.ts`,
 * `resolve-result.ts`, `user.ts`, `wallet.ts`) stay zod for the
 * transition window. SvcJwtClaims is intentionally authored beside
 * the W2 zod JWTClaimSchema, not in place of it (SDD §1.4 — two
 * different token classes).
 *
 * **Header invariants** (D-1.1 §1):
 * - `alg` MUST be the literal `"ES256"` (ADR-002 baseline — ECDSA P-256).
 * - `kid` MUST start with `"svc-"`. A verifier configured with
 *   `expectedKidPrefix = "svc-"` rejects user-kids (and any other
 *   prefix class) before fetching JWKS.
 *
 * **Claim invariants** (D-1.1 §1; mechanically enforced where Effect.Schema
 * is the right surface, annotated otherwise):
 * - `iss` — identity-api canonical URL; verifier compares against
 *   `expectedIss` (string-equality, no wildcards).
 * - `aud` — single target cell name. V1 enforces single-aud via
 *   `S.String` (NOT `S.Array(S.String)`). Multi-aud is deferred to V2.
 * - `sub` — calling cell name. At issuance, identity-api ensures
 *   `sub` is drawn from the operator-managed `operator_grants`
 *   allow-list (defense-in-depth against API-key-leak-on-different-cell
 *   scenarios; see svc-jwt-spec §4).
 * - `exp` / `nbf` — unix seconds. Issuance enforces `exp - iat ≤ 3600`
 *   (1h max TTL). Verifiers re-check `exp` against `now ± skewSec`
 *   (default 30s) and `nbf ≤ now + skewSec`.
 * - `role` — opaque capability string. Verifier matches against
 *   `expectedRole` by exact-string equality (no role hierarchies in V1).
 * - `jti` — base64url-encoded 16 random bytes (96 bits of entropy).
 *   Uniqueness is statistically global; identity-api records every
 *   issued jti in `service_jwt_issuance` for audit + denylist
 *   eligibility. The schema accepts any non-empty string — encoding
 *   validation is the issuer's responsibility (already enforced at
 *   issuance time, redundant at verify time).
 *
 * **Per-request use model** (D-1.1 §3 + SDD §0a anchor): cells mint a
 * fresh svc-JWT before EACH cross-cell call. No token reuse, no
 * client-side cache, no refresh-at-90%-TTL. Replay-store complexity is
 * structurally removed; the denylist (D-1.1 §6) is the only
 * persistence-affecting verify-time check.
 *
 * Source-of-truth: `grimoires/svc-jwt-spec.md` §1 (commit `ce0bb8a`).
 * Sibling pattern: `./jwt-claims.ts` (W2 user-JWT, zod).
 */

import { Schema as S } from '@effect/schema';
import { Either } from 'effect';

/**
 * Canonical svc-JWT claim set (D-1.1 §1). All seven claims are mandatory.
 *
 * Effect.Schema enforces presence + type. Claim-value semantics (issuer
 * URL identity, exp-window bounds, role allowlist) are the verifier's
 * responsibility (D-1.1 §5 order-of-operations) and are NOT modeled
 * here — keeping the schema substrate-shaped lets identity-api,
 * mint-api, activities-api, and the cluster `@0xhoneyjar/auth`
 * verifier library all consume the same `SvcJwtClaims` while applying
 * their own per-endpoint policies.
 */
// Security-critical claims (sub/iss/aud/role/jti) refuse empty strings —
// `S.String` alone accepts `""`, which would silently authorize a JWT with
// a blank subject/issuer/audience/capability/id (per BB F-003).
const NonEmptyString = S.String.pipe(S.minLength(1));

// `iat`/`exp`/`nbf` are unix-seconds — integers, not arbitrary numbers
// (per BB F-006). Non-negative; verifiers further check against now ± skew.
const UnixSeconds = S.Number.pipe(S.int(), S.positive());

export const SvcJwtClaims = S.Struct({
  iss: NonEmptyString,    // issuer — identity-api canonical URL (e.g. "https://identity.0xhoneyjar.xyz")
  aud: NonEmptyString,    // audience — target cell name (e.g. "mint-api"); SINGLE-aud V1
  sub: NonEmptyString,    // subject — calling cell name (e.g. "activities-api")
  iat: UnixSeconds,       // issued-at — unix seconds; per BB F-004, referenced by exp invariant `exp - iat ≤ 3600`
  exp: UnixSeconds,       // expiry — issuance time + ttl_sec (max 3600 per D-1.1 §3)
  nbf: UnixSeconds,       // not-before — typically == iat
  role: NonEmptyString,   // capability claim (e.g. "mint.invoke", "activity.read")
  jti: NonEmptyString,    // jwt id — base64url(16 random bytes); recorded at issuance
});

/**
 * Canonical Effect.Schema-derived type alias. The `S.Schema.Type<typeof X>`
 * idiom is the Effect-ecosystem equivalent of zod's `z.infer<typeof X>`.
 */
export type SvcJwtClaims = S.Schema.Type<typeof SvcJwtClaims>;

/**
 * Canonical svc-JWT header schema (D-1.1 §1 header constraint).
 *
 * - `alg` is the **literal** `"ES256"` (not an open string) — non-ES256
 *   tokens MUST be rejected structurally.
 * - `typ` is the **literal** `"JWT"` (standard JOSE header type).
 * - `kid` is a string with a `"svc-"` startsWith refinement — a
 *   user-kid (`user-2026-05-26-a`) sent to a svc-verifier fails
 *   structural validation here, before any JWKS fetch.
 *
 * The startsWith refinement composes with the verifier's
 * `expectedKidPrefix` (default `"svc-"`). The schema fixes the lower
 * bound (must start with `svc-`); the verifier can additionally
 * constrain via opts but cannot widen.
 */
// `kid` must have a NON-EMPTY suffix after `svc-` — bare `"svc-"` would
// pass the startsWith refinement but is not a valid kid (BB F-005).
// `^svc-.+$` ensures both the prefix AND at least one character of suffix.
export const SvcJwtHeader = S.Struct({
  alg: S.Literal('ES256'),
  typ: S.Literal('JWT'),
  kid: S.String.pipe(S.pattern(/^svc-.+$/)),
});

export type SvcJwtHeader = S.Schema.Type<typeof SvcJwtHeader>;

/**
 * Validation envelope for `decodeSvcJwtClaims` and `decodeSvcJwtHeader`.
 *
 * Discriminated on `ok`. On `ok: false` the `error` field carries a
 * human-readable summary suitable for logging (Effect.Schema's
 * `ParseError.message` carries the structured tree, but stringification
 * gives a single-line digest fit for audit envelopes).
 *
 * Why we expose a non-Effect wrapper API: the route handler (in `src/api/`)
 * lives outside the workspace tree where `@effect/schema` resolves at the
 * type-checker level. A thin sync-wrapper here keeps the route module
 * free of Effect imports while preserving the schema as single source of
 * truth (W2.5 T-2.6).
 */
export type SchemaValidationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string };

/**
 * Decode + validate an unknown value against `SvcJwtClaims`. Returns a
 * discriminated-union envelope; never throws.
 *
 * Used by the svc-JWT issuance route to re-validate the produced JWT's
 * claim segment after signing, closing the encode-bug class (D-1.1 §4
 * post-task brief invariant — fail at the issuer rather than ship a
 * malformed token to verifiers).
 */
export function decodeSvcJwtClaims(input: unknown): SchemaValidationResult<SvcJwtClaims> {
  const result = S.decodeUnknownEither(SvcJwtClaims)(input);
  if (Either.isRight(result)) {
    return { ok: true, value: result.right };
  }
  return { ok: false, error: result.left.message };
}

/**
 * Decode + validate an unknown value against `SvcJwtHeader`. Same shape +
 * non-throwing posture as `decodeSvcJwtClaims`; used to confirm the produced
 * JWT's protected header carries the correct `alg`, `typ`, and `kid`-prefix
 * invariants (D-1.1 §1).
 */
export function decodeSvcJwtHeader(input: unknown): SchemaValidationResult<SvcJwtHeader> {
  const result = S.decodeUnknownEither(SvcJwtHeader)(input);
  if (Either.isRight(result)) {
    return { ok: true, value: result.right };
  }
  return { ok: false, error: result.left.message };
}
