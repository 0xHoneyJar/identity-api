/**
 * src/jwt-mint.ts — minimal JWT minter for T1.6.
 *
 * The verify path's last step is "issue a session JWT" — for v1 we mint
 * HS256 against the same JWT_SECRET the verifier uses. This module is the
 * minimum needed for T1.6's verify endpoint.
 *
 * Per PRD §4.4 (FR-J1..J3) the long-term posture is:
 *   - FR-J1: mint-jwt-orchestrator constructs claims, NEVER signs.
 *   - FR-J2: LocalEs256Signer adapter; own JWKS at /.well-known/jwks.json,
 *            overlap-window key rotation (harvested from loa-freeside).
 *   - FR-J3: HttpJWTSigner seam — swap to platform Rust gateway /issue
 *            with a one-line change.
 *
 * This module is the V1-PROVISIONAL signer:
 *   - HS256 (Sprint-1.1 follow-up #3 swaps to ES256 via jose).
 *   - Inline construction + signing — no port indirection yet.
 *   - Same JWT_SECRET from src/auth.ts (so the verifier mounted there
 *     accepts what we mint here).
 *
 * Claims shape (T1.6):
 *   {
 *     sub:    <user_id (UUID)>,
 *     wallets: [{ chain: 'ethereum', address: <primary wallet> }],
 *     tenant: 'freeside',   // default; per-world tokens land in T2.x
 *     iss:    'identity-api',
 *     aud:    'freeside',   // per-world audience lands in T2.x
 *     iat:    <unix>,
 *     exp:    <unix + 3600>,
 *     jti:    <uuid v4>,
 *     v:      1,
 *   }
 *
 * This is a STRICT SUBSET of `packages/protocol/jwt-claims.schema.json` —
 * the schema's full surface (tier, display_name, discord_id, nft_id, etc.)
 * is populated by the compose edge (T2.x) when world context is known. T1.6
 * mints the minimum-viable session claim that unlocks /v1/me (FR-A3).
 *
 * Why we DON'T import the protocol's JWTClaim Zod schema for runtime
 * construction: we'd need to forward 11 required fields (some optional we
 * intentionally leave unset). Constructing the literal object inline keeps
 * this v1-provisional minter readable; the schema validates the shape on
 * the verifier side (the consumer can call assertTenantBoundary). When
 * the LocalEs256Signer lands at Sprint-1.1 #3, the construction will use
 * `JWTClaimSchema.parse(payload)` as the gate before signing.
 *
 * SECURITY NOTES:
 *   - The HS256 secret IS the verification key — the same JWT_SECRET that
 *     authJwt validates against. A leak of JWT_SECRET = forgeable tokens.
 *     Production MUST set JWT_SECRET via env (the loadSecret check in
 *     src/auth.ts fail-fasts in NODE_ENV=production if unset/short).
 *   - jti is UUIDv4 from crypto.randomUUID — collision space is 2^122,
 *     not enforced by a denylist in V1 (per protocol schema docstring:
 *     "jti denylist is V2"). Until V2, jti is a unique identifier but
 *     NOT a revocation handle.
 *   - exp is 1h per PRD §4.4 FR-J2 ("1h TTL per Lock-8"). Clock-skew
 *     tolerance is the verifier's job (Hyper's verifyJwt has 30s default).
 */

import { JWT_SECRET } from "./auth"

/** Default session TTL = 1 hour (per loa-freeside Lock-8). */
const DEFAULT_TTL_SECONDS = 3600

/** Default issuer + audience for v1 (per-world variations land in T2.x). */
const DEFAULT_ISSUER = "identity-api"
const DEFAULT_TENANT = "freeside"
const DEFAULT_AUDIENCE = "freeside"

/**
 * Input to mintSessionJwt. The route handler at /v1/auth/verify constructs
 * this from `{ user_id, primary_wallet }` after the spine commit succeeds.
 */
export interface MintSessionJwtInput {
  /** Canonical user_id (UUID v4) — populated into JWT `sub`. */
  readonly sub: string
  /**
   * Primary wallet at session-mint time. Goes into `wallets[]` as a single
   * entry; multi-wallet hydration is a compose-time concern (T2.x will
   * populate the full wallets[] from getIdentity). For T1.6 the session
   * just needs the wallet that authenticated.
   *
   * If null (theoretically possible for a user with no active link, though
   * we never mint such a session in T1.6's flow), the wallets[] is empty.
   */
  readonly primaryWallet: string | null
  /**
   * Issued-at override (unix seconds). Defaults to NOW. Tests set this
   * deterministically; production should leave it unset.
   */
  readonly iat?: number
  /** TTL override (seconds). Default 3600. */
  readonly ttlSec?: number
  /**
   * Tenant slug override. Defaults to 'freeside'. T2.x's world-aware
   * sessions will populate this per-world.
   */
  readonly tenant?: string
  /** Audience override. Defaults to 'freeside'. */
  readonly audience?: string
}

/** Mint result — the encoded JWT + the absolute expiry (echoed to the client). */
export interface MintSessionJwtResult {
  readonly token: string
  readonly expiresAt: number // unix seconds
  readonly jti: string
  // Echo the claims we minted for downstream introspection (audit log
  // payload, integration test assertions). Subset of JWTClaim — matches the
  // shape we encode into the token.
  readonly claims: {
    readonly sub: string
    readonly wallets: ReadonlyArray<{ chain: "ethereum"; address: string }>
    readonly tenant: string
    readonly iss: string
    readonly aud: string
    readonly iat: number
    readonly exp: number
    readonly jti: string
    readonly v: 1
  }
}

/**
 * Mint a session JWT.
 *
 * HS256 signing using SubtleCrypto + the JWT_SECRET. No port indirection
 * (yet) — Sprint-1.1 #3 swaps this for an ES256 LocalSigner via the
 * `JWTSigner` port.
 */
export async function mintSessionJwt(input: MintSessionJwtInput): Promise<MintSessionJwtResult> {
  const now = input.iat ?? Math.floor(Date.now() / 1000)
  const ttl = input.ttlSec ?? DEFAULT_TTL_SECONDS
  const exp = now + ttl
  const jti = crypto.randomUUID()
  const tenant = input.tenant ?? DEFAULT_TENANT
  const audience = input.audience ?? DEFAULT_AUDIENCE
  const wallets = input.primaryWallet
    ? ([{ chain: "ethereum" as const, address: input.primaryWallet }] as const)
    : ([] as const)

  const claims = {
    sub: input.sub,
    wallets,
    tenant,
    iss: DEFAULT_ISSUER,
    aud: audience,
    iat: now,
    exp,
    jti,
    v: 1 as const,
  }

  const token = await signHs256(
    { alg: "HS256", typ: "JWT" },
    claims as unknown as Record<string, unknown>,
    JWT_SECRET,
  )

  return {
    token,
    expiresAt: exp,
    jti,
    claims,
  }
}

// ─── HS256 signing primitive ───────────────────────────────────────────────

/**
 * Minimal HS256 signer. Matches the test helper pattern in
 * src/api/__tests__/routes.test.ts but lives in production code so the
 * route handler at /v1/auth/verify can produce valid tokens.
 *
 * Verified-against: src/hyper/auth-jwt/jwt.ts (the verifier) uses the same
 * `crypto.subtle.importKey` + `crypto.subtle.sign` pattern for HMAC SHA-256,
 * so the wire shape we produce here is byte-for-byte what the verifier
 * accepts.
 */
async function signHs256(
  header: { alg: "HS256"; typ: "JWT" },
  payload: Record<string, unknown>,
  secret: string,
): Promise<string> {
  const enc = new TextEncoder()
  const headerEnc = b64url(JSON.stringify(header))
  const payloadEnc = b64url(JSON.stringify(payload))
  const data = `${headerEnc}.${payloadEnc}`
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )
  const sigBuf = await crypto.subtle.sign("HMAC", key, enc.encode(data))
  const sigB64 = b64url(arrayBufferToBinary(sigBuf))
  return `${data}.${sigB64}`
}

function b64url(s: string): string {
  return btoa(s).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_")
}

function arrayBufferToBinary(buf: ArrayBuffer): string {
  return String.fromCharCode(...new Uint8Array(buf))
}
