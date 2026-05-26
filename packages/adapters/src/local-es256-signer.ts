/**
 * LocalEs256Signer — file/env-backed ES256 signer for svc-JWTs (W2.5 T-2.6).
 *
 * Materializes D-1.1 §2 (JWKS layout) + §3 (per-request issuance). The
 * signer holds the active svc-kid private key + kid value; produces a
 * compact-serialized JWT under the ES256 algorithm using `jose`.
 *
 * Env contract (D-1.1 §2):
 *   - SVC_JWT_SIGNING_KEY_PEM — PEM-encoded P-256 PKCS#8 private key
 *   - SVC_JWT_SIGNING_KEY_KID — active kid (e.g., "svc-2026-05-26-a")
 *   - SVC_JWT_SIGNING_KEY_PEM_PREV (optional) — previous key during rotation
 *   - SVC_JWT_SIGNING_KEY_KID_PREV (optional) — previous kid during rotation
 *
 * The PREV key/kid materialize the 2h overlap window from D-1.1 §7. T-2.6
 * does NOT consume the PREV pair (the route signs with the active kid only;
 * the PREV key exists in JWKS to validate in-flight tokens). PREV handling
 * lands when the JWKS endpoint composer is built (forward-track).
 *
 * Why this is a separate adapter (not inline in src/jwt-mint.ts):
 *   - svc-JWT signing is operationally independent from user-JWT signing
 *     (D-1.1 §2 — different kid prefix class, different rotation cadence,
 *     different key material entirely). Co-locating would couple two
 *     unrelated evolution paths.
 *   - The CLAUDE.md royal decree ("schemas live in protocol, signers live
 *     where the I/O lives") places this in the adapters package. The
 *     route handler at src/api/routes/v1/auth/service-jwt.ts depends on
 *     this through `@freeside-auth/adapters`.
 *   - The package has `jose` as a dep already (consumed by JwksValidator);
 *     no new root-level dep is needed.
 *
 * The `ServiceJwtSigner` interface is the minimal narrow surface the
 * route consumer needs. The concrete `LocalEs256Signer` class implements
 * it with `jose.SignJWT`; tests can substitute any object with the same
 * shape (e.g., a signer over a known fixture keypair for deterministic
 * JWT output).
 */

import { exportPKCS8, generateKeyPair, importPKCS8, SignJWT } from 'jose';

/**
 * Narrow ES256 signer surface consumed by the svc-JWT issuance route.
 *
 * Intentionally not generic: D-1.1 fixes the algorithm to ES256, so a
 * polymorphic-alg signer would be premature abstraction. If the cluster
 * ever needs a second algorithm class (e.g., EdDSA), THIS interface
 * stays at ES256 and a separate signer surface ships.
 */
export interface ServiceJwtSigner {
  /** Active svc-kid embedded into every produced JWT's protected header. */
  readonly kid: string;
  /**
   * Sign a claim payload as a compact-serialized ES256 JWT. The protected
   * header is fixed: `{ alg: "ES256", typ: "JWT", kid: this.kid }`.
   *
   * Callers MUST pre-populate iat/exp/nbf/iss/aud/sub/role/jti — this
   * signer does NOT decorate the payload (one substrate, no behavior
   * overlap with the route's claim-construction logic).
   */
  sign(payload: Record<string, unknown>): Promise<string>;
}

/**
 * Config for the local-key signer. `pkcs8Pem` is the PEM-encoded P-256
 * PKCS#8 private key; `kid` is the active svc-kid string.
 *
 * The constructor does NOT throw on bad inputs — `create()` does, async,
 * so the caller can `try/catch` the key-import failure (a malformed PEM
 * or a wrong-curve key would surface here).
 */
export interface LocalEs256SignerConfig {
  /** PEM-encoded P-256 PKCS#8 private key. */
  readonly pkcs8Pem: string;
  /** Active svc-kid (MUST start with `svc-`). */
  readonly kid: string;
}

/**
 * Build a `ServiceJwtSigner` over a local in-memory ES256 key.
 *
 * Async because `jose.importPKCS8` is async (it routes through the
 * WebCrypto subtle API which is promise-shaped). Throws on:
 *   - kid that doesn't start with `svc-` (D-1.1 §1 header invariant).
 *   - PEM that doesn't parse as a P-256 PKCS#8 private key.
 *
 * Failure-mode policy: throw early at construction time, NOT lazily at
 * first sign — operators get a clean boot-time error instead of the
 * first /v1/auth/service-jwt request 500-ing.
 */
export async function createLocalEs256Signer(
  config: LocalEs256SignerConfig,
): Promise<ServiceJwtSigner> {
  if (!config.kid.startsWith('svc-')) {
    throw new Error(
      `LocalEs256Signer: kid must start with "svc-" (got: ${config.kid}). ` +
        'User-class kids carry the "user-" prefix; mixing the two breaks ' +
        'verifier kid-prefix disambiguation (D-1.1 §1).',
    );
  }
  const key = await importPKCS8(config.pkcs8Pem, 'ES256');
  return {
    kid: config.kid,
    async sign(payload: Record<string, unknown>): Promise<string> {
      return new SignJWT(payload)
        .setProtectedHeader({ alg: 'ES256', typ: 'JWT', kid: config.kid })
        .sign(key);
    },
  };
}

/**
 * Build a `ServiceJwtSigner` from the canonical env vars
 * (`SVC_JWT_SIGNING_KEY_PEM` + `SVC_JWT_SIGNING_KEY_KID`).
 *
 * Throws when either env var is unset or empty (production fail-fast).
 * Use `createLocalEs256Signer` directly for test fixtures with in-test
 * keypairs.
 */
/**
 * TEST HELPER — generate a fresh in-memory ES256 keypair and return the
 * PKCS#8 PEM for use in test fixtures.
 *
 * NOT for production use. Production keys are operator-generated and
 * stored in env/secret-manager per the rotation runbook (D-1.1 §7); a
 * test fixture should NEVER survive into a prod build.
 *
 * Lives here because:
 *   (a) `jose` is a workspace-local dep of @freeside-auth/adapters; the
 *       in-repo TS path resolution puts this package's node_modules on
 *       the resolution chain for any consumer that imports from
 *       @freeside-auth/adapters.
 *   (b) Test files at src/api/__tests__/ live outside the adapters
 *       package's resolution scope and CANNOT import jose directly.
 *       Re-exporting the small subset they need here closes the gap.
 *
 * Mirrors the pattern of `src/api/spine.ts:__setSpineForTest` — minimal
 * test seam, named with the test-only marker.
 */
export async function __generateTestEs256KeyMaterial(): Promise<{
  pkcs8Pem: string;
}> {
  const { privateKey } = await generateKeyPair('ES256', { extractable: true });
  const pkcs8Pem = await exportPKCS8(privateKey);
  return { pkcs8Pem };
}

export async function createLocalEs256SignerFromEnv(): Promise<ServiceJwtSigner> {
  const pem = process.env.SVC_JWT_SIGNING_KEY_PEM;
  const kid = process.env.SVC_JWT_SIGNING_KEY_KID;
  if (!pem || !kid) {
    throw new Error(
      'LocalEs256Signer: SVC_JWT_SIGNING_KEY_PEM and SVC_JWT_SIGNING_KEY_KID ' +
        'must both be set in env (D-1.1 §2 file/env layout). Why: identity-api ' +
        'signs svc-JWTs with the cell-shared ES256 key declared in JWKS. Fix: ' +
        'provision the key pair via the operator rotation runbook and export ' +
        'both env vars before boot.',
    );
  }
  return createLocalEs256Signer({ pkcs8Pem: pem, kid });
}
