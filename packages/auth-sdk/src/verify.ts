/**
 * svc-JWT verifier — auth-sdk public surface.
 *
 * Thin re-export of the verify function + types from
 * `@freeside-auth/adapters`. The implementation lives in adapters/; this
 * SDK exposes it to vendored consumers as the substrate-shared contract.
 *
 * Per the build doc anti-pattern ban: NO inlining of implementation here.
 * If a consumer vendors `auth-sdk/src/`, they MUST also vendor the
 * transitive `adapters/src/svc-jwt-verifier.ts` + `denylist-postgres.ts`.
 * See registry.json #transitive.
 *
 * Spec: `grimoires/svc-jwt-spec.md` §5 (D-1.1 10-step verify pipeline) +
 * §6 (denylist CONJUNCTIVE null-as-wildcard match).
 *
 * **EXPLICIT NON-PRESENCE** (D-1.1 §0a anchor, propagated): there is NO
 * `replayStore` opt on `VerifyOpts`; there is NO `REPLAYED_JTI` error
 * code. The per-request issuance model (D2.5-12) structurally removed
 * the verify-time replay store. The denylist hook is the only
 * persistence-affecting verify-time check. Cells MUST NOT add a
 * replay-store check; doing so re-introduces the storage-DoS surface.
 */

export {
  verifySvcJwt,
  type SvcJwtClaims,
  type SvcJwtJwksCache,
  type DenylistCheck,
  type SvcJwtVerifyOpts,
  type SvcJwtVerifyErrorCode,
  type SvcJwtVerifyResult,
} from '@freeside-auth/adapters';
