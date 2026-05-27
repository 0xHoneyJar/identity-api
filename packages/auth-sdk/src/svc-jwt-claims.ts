/**
 * svc-JWT claims — auth-sdk public surface.
 *
 * Thin re-export of the canonical Effect.Schema artifacts from
 * `@freeside-auth/protocol`. The schemas live in protocol/; this SDK
 * exposes them to vendored consumers as the substrate-shared contract.
 *
 * Per the build doc anti-pattern ban: NO inlining of implementation here.
 * If a consumer vendors `auth-sdk/src/`, they MUST also vendor the
 * transitive `protocol/src/svc-jwt-claims.ts`. See registry.json #transitive.
 *
 * Source-of-truth: `packages/protocol/src/svc-jwt-claims.ts`.
 * Spec: `grimoires/svc-jwt-spec.md` §1 (D-1.1 header + claim invariants).
 */

export {
  SvcJwtClaims,
  SvcJwtHeader,
  decodeSvcJwtClaims,
  decodeSvcJwtHeader,
  type SchemaValidationResult,
} from '@freeside-auth/protocol';
