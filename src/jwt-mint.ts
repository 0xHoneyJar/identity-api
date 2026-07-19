/**
 * src/jwt-mint.ts — user-session JWT minter (T1.6 + D-JWT-001).
 *
 * Preferred path (D-JWT-001 / FR-J2): ES256 via `createLocalUserEs256Signer`
 * when `USER_JWT_SIGNING_KEY_PEM` + `USER_JWT_SIGNING_KEY_KID` are set.
 * Public keys are published on `/.well-known/jwks.json` (user- plane).
 *
 * Transition fallback (non-production only): HS256 against JWT_SECRET so
 * existing tests and local boots keep working until user keys are provisioned.
 * Production (`NODE_ENV=production`) requires user ES256 keys and fails loud.
 *
 * Per PRD §4.4 (FR-J1..J3) the long-term posture is:
 *   - FR-J1: mint-jwt-orchestrator constructs claims, NEVER signs.
 *   - FR-J2: LocalUserEs256Signer; JWKS at /.well-known/jwks.json,
 *            overlap-window key rotation.
 *   - FR-J3: HttpJWTSigner seam — swap to platform Rust gateway /issue
 *            with a one-line change.
 *
 * Claims shape (T1.6):
 *   {
 *     sub:    <user_id (UUID)>,
 *     wallets: [{ chain: 'ethereum', address: <primary wallet> }],
 *     tenant: 'freeside',
 *     iss:    'identity-api',
 *     aud:    'freeside',
 *     iat:    <unix>,
 *     exp:    <unix + 3600>,
 *     jti:    <uuid v4>,
 *     v:      1,
 *   }
 *
 * SECURITY NOTES:
 *   - ES256: private key stays in env; JWKS publishes verification material only.
 *   - HS256 fallback: JWT_SECRET is the verification key — a leak = forgeable
 *     tokens. Production must not use this path.
 *   - jti is UUIDv4; denylist is V2.
 *   - exp is 1h per PRD §4.4 FR-J2 / Lock-8.
 */

import {
  createLocalUserEs256Signer,
  type UserJwtSigner,
} from "@freeside-auth/adapters"
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
  /** Signing algorithm used for this token (`ES256` preferred, `HS256` fallback). */
  readonly alg: "ES256" | "HS256"
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

/** Cached user signer: undefined = not probed, null = HS256 fallback. */
let _userSigner: UserJwtSigner | null | undefined

/**
 * Resolve the user ES256 signer from env, or null when falling back to HS256.
 * Production requires USER_JWT_SIGNING_KEY_PEM + USER_JWT_SIGNING_KEY_KID.
 */
export async function resolveUserSessionSigner(): Promise<UserJwtSigner | null> {
  if (_userSigner !== undefined) return _userSigner

  const pem = process.env.USER_JWT_SIGNING_KEY_PEM
  const kid = process.env.USER_JWT_SIGNING_KEY_KID

  if (pem && kid) {
    _userSigner = await createLocalUserEs256Signer({ pkcs8Pem: pem, kid })
    return _userSigner
  }

  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "jwt-mint: USER_JWT_SIGNING_KEY_PEM and USER_JWT_SIGNING_KEY_KID are required " +
        "in production (D-JWT-001). Why: user-session mint must be ES256 with " +
        "user- kids published on JWKS; HS256 is transition-only. Fix: provision " +
        "keys per grimoires/runbooks/user-session-es256.md.",
    )
  }

  console.warn(
    "[jwt-mint] USER_JWT_SIGNING_KEY_PEM / USER_JWT_SIGNING_KEY_KID unset; " +
      "falling back to HS256 (JWT_SECRET). Set user ES256 keys for D-JWT-001 parity.",
  )
  _userSigner = null
  return null
}

/** Test seam — clear the cached signer between cases. */
export function __resetUserSessionSignerForTest(): void {
  _userSigner = undefined
}

/**
 * Mint a session JWT.
 *
 * ES256 when user signing keys are configured; otherwise HS256 (non-prod only).
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

  const signer = await resolveUserSessionSigner()
  if (signer) {
    const token = await signer.sign(claims as unknown as Record<string, unknown>)
    return { token, expiresAt: exp, jti, alg: "ES256", claims }
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
    alg: "HS256",
    claims,
  }
}

// ─── HS256 signing primitive (transition fallback) ─────────────────────────

/**
 * Minimal HS256 signer for the non-prod fallback path. Matches the verifier
 * in src/hyper/auth-jwt/jwt.ts (HMAC SHA-256 via SubtleCrypto).
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
