/**
 * Minimal JWT verify for Hyper auth-jwt.
 *
 * Dual-path (D-JWT-001 transition):
 *   - HS256 / HS384 / HS512 — HMAC via SubtleCrypto + `secret`
 *   - ES256 — jose `jwtVerify` / `createLocalJWKSet` against `jwks.keys`
 *
 * We explicitly do NOT sign here — issuance lives in jwt-mint / LocalEs256*.
 */

import { timingSafeEqual } from "node:crypto"
import { createLocalJWKSet, jwtVerify, type JWK } from "jose"

export type JwtAlgorithm = "HS256" | "HS384" | "HS512" | "ES256"

export interface JwtHeader {
  readonly alg: string
  readonly kid?: string
  readonly typ?: string
}

export interface JwtPayload {
  readonly iss?: string
  readonly aud?: string | readonly string[]
  readonly sub?: string
  readonly exp?: number
  readonly nbf?: number
  readonly iat?: number
  readonly scope?: string
  readonly [k: string]: unknown
}

export interface VerifyOptions {
  readonly secret?: string | Uint8Array
  /** Local JWKS for ES256 verification (user-plane keys). */
  readonly jwks?: { readonly keys: readonly JWK[] }
  /** Optional pre-imported public keys for ES256 (alternative to jwks). */
  readonly publicKeys?: readonly CryptoKey[]
  readonly algorithms?: readonly JwtAlgorithm[]
  readonly issuer?: string
  readonly audience?: string
  readonly clockToleranceSec?: number
}

export class JwtError extends Error {
  constructor(
    readonly code: string,
    msg: string,
  ) {
    super(msg)
  }
}

const SUPPORTED_HS: Record<"HS256" | "HS384" | "HS512", "SHA-256" | "SHA-384" | "SHA-512"> = {
  HS256: "SHA-256",
  HS384: "SHA-384",
  HS512: "SHA-512",
}

function isHsAlg(alg: string): alg is "HS256" | "HS384" | "HS512" {
  return alg === "HS256" || alg === "HS384" || alg === "HS512"
}

export async function verifyJwt(
  token: string,
  options: VerifyOptions,
): Promise<{ header: JwtHeader; payload: JwtPayload }> {
  const parts = token.split(".")
  if (parts.length !== 3) throw new JwtError("invalid_token", "malformed jwt")
  const [h, p, sig] = parts

  let header: JwtHeader
  let payload: JwtPayload
  try {
    header = JSON.parse(b64urlToUtf8(h!)) as JwtHeader
    payload = JSON.parse(b64urlToUtf8(p!)) as JwtPayload
  } catch {
    throw new JwtError("invalid_token", "malformed jwt")
  }

  const alg = header.alg
  const allowed = new Set<string>(options.algorithms ?? ["HS256"])
  if (!allowed.has(alg)) throw new JwtError("alg_not_allowed", `disallowed alg: ${alg}`)

  if (isHsAlg(alg)) {
    const digest = SUPPORTED_HS[alg]
    if (!options.secret) throw new JwtError("no_secret", "secret required for HMAC")
    const key = await crypto.subtle.importKey(
      "raw",
      (typeof options.secret === "string"
        ? new TextEncoder().encode(options.secret)
        : options.secret) as BufferSource,
      { name: "HMAC", hash: digest },
      false,
      ["sign"],
    )
    const signed = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${h}.${p}`))
    const expected = new Uint8Array(signed)
    const actual = b64urlToBytes(sig!)
    if (
      expected.length !== actual.length ||
      !timingSafeEqual(Buffer.from(expected), Buffer.from(actual))
    ) {
      throw new JwtError("bad_signature", "jwt signature mismatch")
    }
  } else if (alg === "ES256") {
    await verifyEs256(token, options)
    // jose already validated claims when using jwtVerify; re-run shared
    // checks below for a single code path / consistent JwtError codes.
  } else {
    throw new JwtError("alg_unsupported", `unsupported alg: ${alg}`)
  }

  const now = Math.floor(Date.now() / 1000)
  const skew = options.clockToleranceSec ?? 30
  if (typeof payload.exp === "number" && now > payload.exp + skew) {
    throw new JwtError("expired", "jwt expired")
  }
  if (typeof payload.nbf === "number" && now + skew < payload.nbf) {
    throw new JwtError("not_yet_valid", "jwt not yet valid")
  }
  if (options.issuer && payload.iss !== options.issuer) {
    throw new JwtError("bad_issuer", `issuer ${payload.iss ?? ""} != ${options.issuer}`)
  }
  if (options.audience) {
    const aud = payload.aud
    const ok = Array.isArray(aud) ? aud.includes(options.audience) : aud === options.audience
    if (!ok) throw new JwtError("bad_audience", "aud mismatch")
  }
  return { header, payload }
}

/**
 * Verify an ES256 compact JWT against local JWKS or pre-imported public keys.
 * Uses jose for signature verification only (claim checks stay in verifyJwt).
 */
async function verifyEs256(token: string, options: VerifyOptions): Promise<void> {
  const skew = options.clockToleranceSec ?? 30

  if (options.jwks?.keys?.length) {
    const JWKS = createLocalJWKSet({ keys: [...options.jwks.keys] })
    try {
      // Disable jose claim checks — shared path below owns JwtError codes.
      await jwtVerify(token, JWKS, {
        algorithms: ["ES256"],
        clockTolerance: skew,
        // Pass through optional issuer/audience so jose can short-circuit,
        // but we still re-check below for consistent error codes.
        ...(options.issuer ? { issuer: options.issuer } : {}),
        ...(options.audience ? { audience: options.audience } : {}),
      })
      return
    } catch (e) {
      mapJoseVerifyError(e)
    }
  }

  if (options.publicKeys?.length) {
    let lastErr: unknown
    for (const key of options.publicKeys) {
      try {
        await jwtVerify(token, key, {
          algorithms: ["ES256"],
          clockTolerance: skew,
          ...(options.issuer ? { issuer: options.issuer } : {}),
          ...(options.audience ? { audience: options.audience } : {}),
        })
        return
      } catch (e) {
        lastErr = e
      }
    }
    mapJoseVerifyError(lastErr)
  }

  throw new JwtError("no_jwks", "jwks or publicKeys required for ES256")
}

function mapJoseVerifyError(e: unknown): never {
  if (e instanceof JwtError) throw e
  const msg = e instanceof Error ? e.message : String(e)
  const lower = msg.toLowerCase()
  if (lower.includes("exp") || lower.includes("timestamp check failed")) {
    throw new JwtError("expired", "jwt expired")
  }
  if (lower.includes("nbf")) {
    throw new JwtError("not_yet_valid", "jwt not yet valid")
  }
  if (lower.includes("issuer") || lower.includes('"iss"')) {
    throw new JwtError("bad_issuer", "issuer mismatch")
  }
  if (lower.includes("audience") || lower.includes('"aud"')) {
    throw new JwtError("bad_audience", "aud mismatch")
  }
  if (lower.includes("no applicable key") || lower.includes('"kid"')) {
    throw new JwtError("bad_signature", "jwt signature mismatch")
  }
  throw new JwtError("bad_signature", "jwt signature mismatch")
}

export type { JWK }

function b64urlToUtf8(s: string): string {
  return new TextDecoder().decode(b64urlToBytes(s))
}
function b64urlToBytes(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? 0 : 4 - (s.length % 4)
  const b64 = (s + "====".slice(0, pad)).replace(/-/g, "+").replace(/_/g, "/")
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}
