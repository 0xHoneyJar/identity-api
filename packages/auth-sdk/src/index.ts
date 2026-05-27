/**
 * @freeside-auth/auth-sdk — svc-JWT verifier SDK (source-distributed).
 *
 * Cell-side typed verifier for cluster service-to-service JWTs. Consumed
 * via vendoring (shadcn-style `add` pattern) per PRD v3.0 §11 — NOT an
 * npm package. See README.md §Vendoring for the canonical instructions.
 *
 * Sibling package: `@freeside-auth/identity-client` (HTTP client). This
 * package is the **crypto/verification** surface; identity-client is the
 * **HTTP** surface. Both ship source-distributed; both vendor via the
 * same shadcn `add` pattern. They coexist; different concerns.
 *
 * Surface (barrel):
 *   - `verifySvcJwt` + verifier types — from `./verify`
 *   - `SvcJwtClaims` + `SvcJwtHeader` Effect schemas (value + type per
 *     Effect convention) + decoders — from `./svc-jwt-claims`
 *   - `InMemoryJwksCache` + `LruJwksCache` — from `./jwks-cache`
 *   - `runConformanceSuite` — from `./conformance` (the substrate-grade
 *     M-3 gate that downstream cells run against their own wrapped
 *     verifier instance)
 *
 * Spec: `grimoires/svc-jwt-spec.md` (D-1.1).
 * Vendor registry: `./registry.json` (file list + transitive list + peer deps).
 */

export {
  verifySvcJwt,
  type SvcJwtJwksCache,
  type DenylistCheck,
  type SvcJwtVerifyOpts,
  type SvcJwtVerifyErrorCode,
  type SvcJwtVerifyResult,
} from './verify';

// `SvcJwtClaims` + `SvcJwtHeader` are Effect schemas — per the
// `@effect/schema` convention they are runtime VALUES that also carry
// a derivable TS type via `S.Schema.Type<typeof X>`. The type alias
// `type SvcJwtClaims` exported from `./verify` is structurally
// equivalent; we let the schema-as-value carry it through the barrel
// to avoid duplicate-export naming conflicts.
export {
  SvcJwtClaims,
  SvcJwtHeader,
  decodeSvcJwtClaims,
  decodeSvcJwtHeader,
  type SchemaValidationResult,
} from './svc-jwt-claims';

export {
  InMemoryJwksCache,
  LruJwksCache,
  type JwksCacheOptions,
  type LruJwksCacheOptions,
} from './jwks-cache';

export {
  runConformanceSuite,
  type ConformanceFixtures,
  type ConformanceResult,
  type ConformanceScenarioResult,
} from './conformance/index';
