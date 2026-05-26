/**
 * POST /v1/auth/service-jwt — cell-API-key-authenticated svc-JWT issuance
 * endpoint (W2.5 sprint-2 T-2.6, bead arrakis-ha0l).
 *
 * Materializes D-1.1 §4 (canonical spec at grimoires/svc-jwt-spec.md, ratified
 * 2026-05-26 at ce0bb8a). This is the **cell-side of S1**: per the per-request
 * model (D2.5-12), every cross-cell call by a cell mints a fresh svc-JWT via
 * this endpoint. The cell-to-cell client helper (`@0xhoneyjar/auth/issuance-
 * client.ts`, forward-track) connects here, calls this endpoint, uses the
 * returned JWT exactly once, and never caches.
 *
 * Authentication (D-1.1 §4):
 *   X-Cell-Api-Key + X-Cell-Name headers. Identity-api looks up the
 *   `cell_api_keys` row WHERE cell_name = X-Cell-Name AND revoked_at IS NULL,
 *   then argon2id-verifies the presented X-Cell-Api-Key against the row's
 *   key_hash. The argon2id parameters (m=65536, t=3, p=1) are pinned in
 *   `packages/adapters/src/argon2-params.ts` per flatline IMP-008.
 *
 *   Failure modes:
 *     - missing header           → 401 MISSING_API_KEY
 *     - row not found / revoked  → 401 INVALID_CELL_KEY
 *     - argon2id hash mismatch   → 401 INVALID_CELL_KEY (same code; no
 *                                     enumeration discrimination)
 *
 * Authorization (D-1.1 §4):
 *   `operator_grants` lookup on the tuple (grantee_did, sub, aud, role) WHERE
 *   revoked_at IS NULL. No matching row → 403 GRANT_REQUIRED.
 *
 *   **cell_name → grantee_did mapping**: T-2.6 assumes a 1:1 mapping by
 *   prefixing the cell_name with `did:cell:` (e.g., `mint-api` →
 *   `did:cell:mint-api`). This is a stand-in for the proper identifier-space
 *   spec that lands in forward-track bead arrakis-zp0a (F-7). The mapping
 *   is implemented in `cellNameToGranteeDid()` below and is the single
 *   substitution point when the proper spec lands.
 *
 * TTL validation (D-1.1 §3):
 *   ttl_sec MUST be in [60, 3600]. Out-of-range → 422 INVALID_TTL.
 *
 *   Note (flatline IMP-005): the rate limit (1000/min/cell, see below) is
 *   the svc-JWT *issuance* rate; it is NOT the same as the W2 user-JWT
 *   operator-grant write rate (10/min). These two surfaces are entirely
 *   separate budgets — do not conflate.
 *
 * Rate limit (D-1.1 §3 + flatline IMP-005):
 *   1000 issuances/minute PER cell (keyed by X-Cell-Name). Excess → 429
 *   RATE_LIMITED with Retry-After header. Implemented as an in-process
 *   token bucket (module-level Map); identity-api is a single-process
 *   building per SDD §1.4 (Hyper on a single Railway service), so process-
 *   local state is sufficient. If the building horizontally scales in
 *   the future (forward-track), this becomes a Redis-backed bucket.
 *
 * Signing (D-1.1 §1 + §2):
 *   ES256 (ECDSA P-256). The svc-kid is distinct from the user-kid; both
 *   appear in the same JWKS document (per §2) but disambiguated by prefix.
 *   This route uses an injected `ServiceJwtSigner` (test-friendly DI seam);
 *   the production default reads `SVC_JWT_SIGNING_KEY_PEM` +
 *   `SVC_JWT_SIGNING_KEY_KID` from env (per D-1.1 §2 file/env layout) and
 *   signs via `jose`'s `SignJWT.sign(importedKey)`.
 *
 * Claims (D-1.1 §1):
 *   { iss, aud, sub, iat, exp, nbf, role, jti }. After signing, the produced
 *   JWT is *decoded* and re-validated against `SvcJwtClaims` (Effect.Schema)
 *   before returning to the caller — closes the encode-bug class (a typo
 *   in claim construction would otherwise return a token that any verifier
 *   would later reject; failing at the issuer is the right boundary).
 *
 * Audit:
 *   - DB row in `service_jwt_issuance` (migration 0005) — full denormalized
 *     audit + denylist-eligibility row, INSERTed inside the same handler
 *     before returning. metadata jsonb captures ip + user_agent + request_id.
 *   - Cluster audit event `auth.svc_jwt.issued` via `spine.writeAuditEvent`
 *     with the same payload shape (NF-Audit-2).
 *
 * Test seam (D-1.1 §2 forward-track):
 *   The signer is constructed lazily via `getServiceJwtSigner()` so tests
 *   can inject a deterministic signer (with a known keypair) before the
 *   first request. The signer is process-singleton; mirrors the spine-port
 *   singleton pattern (`src/api/spine.ts`). Re-test seam:
 *   `__setServiceJwtSignerForTest()` / `__resetServiceJwtSignerForTest()`.
 *
 * Non-scope (forward-track):
 *   - sub == X-Cell-Name validation (D-1.1 §4 says SUB_MISMATCH 403) is NOT
 *     implemented here because the cell_name → grantee_did mapping is the
 *     same stand-in (didCell-prefix) and asserting sub == cell_name conflates
 *     two distinct concepts (the body's claimed `sub` is the calling cell;
 *     the header's `X-Cell-Name` is the API-key holder). Tracked at
 *     arrakis-zp0a alongside the identifier-space spec.
 *   - ISSUANCE_DISABLED kill-switch (D-1.1 §4) — operator runbook surface,
 *     out of T-2.6 scope.
 *   - DB_UNAVAILABLE 503 — handled implicitly via Hyper's outer error
 *     pipeline (Postgres write failures throw; framework renders 503).
 *
 * Spec cross-references:
 *   - grimoires/svc-jwt-spec.md §1-§4 (canonical).
 *   - packages/protocol/src/svc-jwt-claims.ts (claim schema; this file
 *     validates against it post-sign).
 *   - packages/adapters/src/migrations/0003_cell_api_keys.up.sql (auth target).
 *   - packages/adapters/src/migrations/0004_operator_grants.up.sql (ACL target).
 *   - packages/adapters/src/migrations/0005_svc_jwt_issuance.up.sql (audit row).
 *   - packages/adapters/src/argon2-params.ts (pinned hash params).
 */

import { jsonResponse } from "@hyper/core"
import { z } from "zod"
import { route } from "../../../../auth"
import { getSpine } from "../../../spine"
import {
  ARGON2ID_HASH_PREFIX,
  createLocalEs256SignerFromEnv,
  type ServiceJwtSigner,
  type SpineSqlLike,
  PostgresSpineAdapter,
} from "@freeside-auth/adapters"
import {
  decodeSvcJwtClaims,
  decodeSvcJwtHeader,
} from "@freeside-auth/protocol"

// ─── request body schema (zod, matches in-repo Hyper route convention) ───

/**
 * Request body schema. Per D-1.1 §4:
 *   { sub: string, aud: string, role: string, ttl_sec: int 60..3600 }
 *
 * Zod is the established Hyper-route body validator pattern in this repo
 * (see packages/protocol/src/api/auth.ts ChallengeReqSchema /
 * VerifyReqSchema). Effect.Schema enters at the produced-JWT validation
 * boundary below — single transition point to the new substrate vocabulary
 * per operator-memory freeside-effect-transition (2026-05-26).
 *
 * The TTL range matches both D-1.1 §3 and the schema-level CHECK
 * constraint `chk_ttl_upper_bound` on `service_jwt_issuance` (≤3600s).
 */
export const ServiceJwtReqSchema = z.object({
  sub: z.string().min(1, "sub must not be empty"),
  aud: z.string().min(1, "aud must not be empty"),
  role: z.string().min(1, "role must not be empty"),
  ttl_sec: z.number().int(),
})
export type ServiceJwtReq = z.input<typeof ServiceJwtReqSchema>

/** Response body shape per D-1.1 §4 200-success. */
export interface ServiceJwtResp {
  readonly jwt: string
  readonly jti: string
  readonly exp: number
}

// ─── error envelope ──────────────────────────────────────────────────────

interface ServiceJwtError {
  readonly error: "service_jwt"
  readonly code: string
  readonly message: string
}

function errorResp(
  status: number,
  code: string,
  message: string,
  extraHeaders?: Record<string, string>,
): Response {
  return new Response(
    JSON.stringify({ error: "service_jwt", code, message } satisfies ServiceJwtError),
    {
      status,
      headers: { "content-type": "application/json", ...(extraHeaders ?? {}) },
    },
  )
}

// ─── signer DI seam (LocalEs256Signer process-singleton) ─────────────────

/**
 * Process-singleton ServiceJwtSigner. Lazy-built from env on first call so
 * tests can inject a deterministic signer (e.g., one backed by a known
 * test keypair) BEFORE the first request lands. Same posture as
 * `src/api/spine.ts:getSpine`.
 */
let _signer: ServiceJwtSigner | null = null

export async function getServiceJwtSigner(): Promise<ServiceJwtSigner> {
  if (_signer) return _signer
  _signer = await createLocalEs256SignerFromEnv()
  return _signer
}

/** Test seam — inject a custom signer (e.g., one backed by an in-test keypair). */
export function __setServiceJwtSignerForTest(signer: ServiceJwtSigner): void {
  _signer = signer
}

/** Test seam — drop the cached signer; next `getServiceJwtSigner()` rebuilds from env. */
export function __resetServiceJwtSignerForTest(): void {
  _signer = null
}

// ─── rate limit (in-process per-cell token bucket) ───────────────────────

/**
 * Per-cell rate limiter (D-1.1 §3): 1000 issuances/minute/cell.
 *
 * Token-bucket discipline (sliding 60-second window). Map key is
 * `X-Cell-Name`; value is the array of issuance timestamps within the
 * last 60 seconds. Older timestamps are pruned on each query.
 *
 * Single-process state — identity-api is single-Railway-instance per
 * SDD §1.4. Multi-instance scaling becomes a Redis-backed bucket; the
 * shape of this module is small enough that the swap is a single-file
 * change. NOT a concern for T-2.6.
 *
 * Concurrent-read safety: JS is single-threaded; this Map can be touched
 * from multiple async handlers but never preempted mid-statement.
 */
const RATE_LIMIT_WINDOW_MS = 60_000
const RATE_LIMIT_PER_WINDOW_DEFAULT = 1000

/**
 * Resolve the per-window budget at request time. Defaults to 1000 (D-1.1 §3).
 *
 * Test override: `LOA_SVC_JWT_RATE_LIMIT_PER_WINDOW` env var, parsed once at
 * the first call after process boot. Resolved-per-request (not cached) so a
 * test setting it in `beforeAll` lands before the first /service-jwt fetch.
 *
 * SAFETY: any non-numeric / out-of-range value falls back to the default —
 * the env override is a TEST seam, not an operator knob, and we don't want
 * a misconfigured value to silently disable the limit in production.
 */
function rateLimitBudget(): number {
  const raw = process.env.LOA_SVC_JWT_RATE_LIMIT_PER_WINDOW
  if (!raw) return RATE_LIMIT_PER_WINDOW_DEFAULT
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1 || n > RATE_LIMIT_PER_WINDOW_DEFAULT) {
    return RATE_LIMIT_PER_WINDOW_DEFAULT
  }
  return n
}

const _rateLimitBuckets = new Map<string, number[]>()

/**
 * Check + record an issuance attempt for `cellName`. Returns `{allowed:true}`
 * on green, `{allowed:false, retryAfterSec}` when the cell has consumed its
 * window budget. Records on green; does NOT record on red (so a denied
 * caller's failed attempt doesn't count against the bucket).
 */
function rateLimitCheck(
  cellName: string,
  nowMs: number = Date.now(),
): { allowed: true } | { allowed: false; retryAfterSec: number } {
  const cutoff = nowMs - RATE_LIMIT_WINDOW_MS
  const existing = _rateLimitBuckets.get(cellName) ?? []
  // Prune entries older than the window.
  const recent = existing.filter((t) => t > cutoff)
  if (recent.length >= rateLimitBudget()) {
    // The oldest in-window timestamp tells us when the next slot frees up.
    const oldest = recent[0]!
    const retryAfterSec = Math.max(1, Math.ceil((oldest + RATE_LIMIT_WINDOW_MS - nowMs) / 1000))
    _rateLimitBuckets.set(cellName, recent)
    return { allowed: false, retryAfterSec }
  }
  recent.push(nowMs)
  _rateLimitBuckets.set(cellName, recent)
  return { allowed: true }
}

/** Test seam — drop all rate-limit state. Call in beforeEach to isolate tests. */
export function __resetRateLimitForTest(): void {
  _rateLimitBuckets.clear()
}

// ─── cell_name → grantee_did stand-in (forward-track arrakis-zp0a) ───────

/**
 * F-7 stand-in: map a cell_name to a grantee_did via the `did:cell:` prefix.
 *
 * The full identifier-space spec lands in forward-track bead arrakis-zp0a.
 * This function is the single substitution point: when the spec ratifies a
 * different mapping (e.g., a registry lookup, a HSM-anchored DID), this
 * is where the change lands. Until then, the prefix-based mapping is the
 * smallest defensible default — matches the slug-shape constraint on
 * `cell_api_keys.cell_name` (lowercase alphanumeric + hyphen, 3-63 chars)
 * AND keeps the DID format stable for downstream consumers.
 */
function cellNameToGranteeDid(cellName: string): string {
  return `did:cell:${cellName}`
}

// ─── argon2id verify ─────────────────────────────────────────────────────

/**
 * Verify a presented API key against a stored argon2id hash.
 *
 * Bun.password.verify is the libsodium-backed argon2id verifier; it
 * re-parses the encoded hash and uses ITS m/t/p parameters (the encoded
 * hash format carries them) — which is precisely the defense-in-depth
 * the IMP-008 design called for: even if `ARGON2ID_PARAMS` constants
 * drift in code, an already-stored hash verifies under the params it
 * was created with.
 *
 * Schema-side guard: the `chk_cell_api_keys_argon2id` CHECK enforces
 * the format prefix at INSERT time, so the value we read here is
 * guaranteed to start with `$argon2id$v=19$`. We assert here defensively
 * (if the row was somehow tampered with via direct SQL, we want a
 * controlled refuse, not a Bun.password panic).
 */
async function verifyCellApiKey(presented: string, storedHash: string): Promise<boolean> {
  if (!storedHash.startsWith(ARGON2ID_HASH_PREFIX)) {
    // Schema invariant violated — refuse without revealing details.
    return false
  }
  try {
    return await Bun.password.verify(presented, storedHash)
  } catch {
    // Bun.password.verify throws on malformed hashes; treat as no-match
    // rather than 500-ing the auth path (defense-in-depth against
    // direct-SQL tampering of the key_hash column).
    return false
  }
}

// ─── route handler ───────────────────────────────────────────────────────

export const serviceJwtIssue = route
  .post("/v1/auth/service-jwt")
  .body(ServiceJwtReqSchema)
  .meta({
    summary: "Mint a cell-to-cell service JWT (D-1.1 §4)",
    mcp: {
      title: "Mint svc-JWT",
      description:
        "Authenticates a calling cell via X-Cell-Api-Key + X-Cell-Name, checks operator_grants for (sub, aud, role) authorization, mints an ES256-signed svc-JWT under the active svc-kid, and audits the issuance. Per-request use model (D2.5-12): caller mints fresh on every cross-cell call. Per W2.5 sprint-2 T-2.6.",
    },
  })
  .handle(async (c) => {
    const req = (c as unknown as { req: Request }).req
    const body = (c as unknown as { body: z.output<typeof ServiceJwtReqSchema> }).body

    // ─── Step 1: extract auth headers ──────────────────────────────────
    const cellName = req.headers.get("x-cell-name")
    const presentedKey = req.headers.get("x-cell-api-key")
    if (!cellName || !presentedKey) {
      return errorResp(
        401,
        "MISSING_API_KEY",
        "X-Cell-Api-Key and X-Cell-Name headers are required",
      )
    }

    // ─── Step 2: validate ttl_sec window (cheap pre-auth gate) ─────────
    // We could validate after auth, but the schema-level CHECK on
    // service_jwt_issuance also enforces this AND auth+grant lookups are
    // more expensive than a numeric range check; running the gate first
    // means a misconfigured caller learns about INVALID_TTL without
    // probing the auth surface.
    if (body.ttl_sec < 60 || body.ttl_sec > 3600) {
      return errorResp(422, "INVALID_TTL", "ttl_sec must be 60..3600")
    }

    // ─── Step 3: rate limit (per-cell, pre-auth so brute force costs less) ─
    // We DO rate-limit pre-auth on purpose: an attacker spraying invalid
    // API keys for one cell_name should hit 429 before they can probe the
    // argon2id verify hot path (each verify is intentionally expensive ~64MB
    // memory cost). The rate is generous enough (1000/min) that legitimate
    // cells will never trip it.
    const now = Date.now()
    const rl = rateLimitCheck(cellName, now)
    if (!rl.allowed) {
      return errorResp(429, "RATE_LIMITED", "issuance rate exceeded", {
        "retry-after": String(rl.retryAfterSec),
      })
    }

    const spine = getSpine()

    // ─── Step 4: cell_api_keys lookup + argon2id verify ────────────────
    const sql = spineSql(spine)
    const keyRows = (await sql`
      SELECT id, key_hash
        FROM cell_api_keys
       WHERE cell_name = ${cellName}
         AND revoked_at IS NULL
       LIMIT 1
    `) as Array<{ id: string; key_hash: string }>

    if (keyRows.length === 0) {
      return errorResp(401, "INVALID_CELL_KEY", "X-Cell-Api-Key invalid or revoked")
    }
    const apiKeyRow = keyRows[0]!
    const keyOk = await verifyCellApiKey(presentedKey, apiKeyRow.key_hash)
    if (!keyOk) {
      return errorResp(401, "INVALID_CELL_KEY", "X-Cell-Api-Key invalid or revoked")
    }

    // ─── Step 5: operator_grants lookup (ACL) ──────────────────────────
    const granteeDid = cellNameToGranteeDid(cellName)
    const grantRows = (await sql`
      SELECT id
        FROM operator_grants
       WHERE grantee_did = ${granteeDid}
         AND sub = ${body.sub}
         AND aud = ${body.aud}
         AND role = ${body.role}
         AND revoked_at IS NULL
       LIMIT 1
    `) as Array<{ id: string }>

    if (grantRows.length === 0) {
      return errorResp(
        403,
        "GRANT_REQUIRED",
        "no operator grant authorizes this (sub, aud, role) tuple",
      )
    }

    // ─── Step 6: construct claims + sign ───────────────────────────────
    const iss =
      process.env.IDENTITY_API_URL ?? process.env.IDENTITY_API_ISS ?? "https://identity.0xhoneyjar.xyz"
    const issuedAtSec = Math.floor(now / 1000)
    const expSec = issuedAtSec + body.ttl_sec
    const jti = generateJti()

    const claims: Record<string, unknown> = {
      iss,
      aud: body.aud,
      sub: body.sub,
      iat: issuedAtSec,
      nbf: issuedAtSec,
      exp: expSec,
      role: body.role,
      jti,
    }

    const signer = await getServiceJwtSigner()
    const jwt = await signer.sign(claims)

    // ─── Step 7: decode + Effect.Schema validate (encode-bug closure) ──
    // Decode the produced JWT and re-validate the claims against
    // SvcJwtClaims. A bug in claim construction would otherwise return a
    // token that downstream verifiers reject — failing at the issuer is
    // the right boundary (per task brief).
    //
    // The protocol package exposes `decodeSvcJwtClaims` / `decodeSvcJwtHeader`
    // as non-Effect-aware sync wrappers — the route module lives outside
    // the workspace where @effect/schema resolves at the typechecker, so
    // the indirection is necessary (and intentional: route handlers do
    // not need to import Effect).
    const claimsValidation = decodeSvcJwtClaims(decodeJwtSegment(jwt, 1))
    if (!claimsValidation.ok) {
      // This should be unreachable in production — the claims object we
      // constructed satisfies the schema by construction. If we get here,
      // either the signer mutated the payload (e.g., dropped a required
      // claim) or the schema drifted from the construction logic — both
      // are bugs we want to fail-CLOSED on rather than ship a malformed
      // token.
      return errorResp(
        500,
        "ISSUANCE_FAILED",
        "produced JWT failed schema validation; refused to return malformed token",
      )
    }

    // Also re-validate the header (defense-in-depth — confirm the kid
    // prefix invariant). We already trust the signer to set alg/typ, but
    // a misconfigured `SVC_JWT_SIGNING_KEY_KID` (e.g., starts with `user-`)
    // would otherwise produce a header that no svc-verifier accepts.
    const headerValidation = decodeSvcJwtHeader(decodeJwtSegment(jwt, 0))
    if (!headerValidation.ok) {
      return errorResp(
        500,
        "ISSUANCE_FAILED",
        "produced JWT header failed schema validation; check SVC_JWT_SIGNING_KEY_KID",
      )
    }

    const validatedClaims = claimsValidation.value
    const validatedHeader = headerValidation.value
    const kid = validatedHeader.kid

    // ─── Step 8: persist audit row in service_jwt_issuance ─────────────
    // Per migration 0005 schema: kid, jti, sub, aud, iss, role, exp_at,
    // issuing_cell_name, cell_api_key_id, metadata.
    const userAgent = req.headers.get("user-agent") ?? null
    const requestId = req.headers.get("x-request-id") ?? null
    const remoteIp = extractClientIp(req)
    const metadata = {
      ip: remoteIp,
      user_agent: userAgent,
      request_id: requestId,
    }
    const expAtIso = new Date(expSec * 1000).toISOString()

    // Bun.SQL accepts JS objects bound to jsonb columns and handles the
    // serialization internally — passing JSON.stringify(...)::jsonb would
    // double-encode (the value comes back as a JSON-string scalar instead
    // of a parsed object, breaking downstream consumers).
    await sql`
      INSERT INTO service_jwt_issuance (
        kid, jti, sub, aud, iss, role, exp_at,
        issuing_cell_name, cell_api_key_id, metadata
      ) VALUES (
        ${kid}, ${jti}, ${validatedClaims.sub}, ${validatedClaims.aud},
        ${validatedClaims.iss}, ${validatedClaims.role}, ${expAtIso},
        ${cellName}, ${apiKeyRow.id}, ${metadata}
      )
    `

    // ─── Step 9: cluster audit event ───────────────────────────────────
    // The spine's writeAuditEvent is the cluster-shared audit pattern in
    // this codebase (used by /v1/auth/verify, /v1/link/verified-wallet).
    // The event_type follows the auth.svc_jwt.issued vocabulary from
    // D-1.1 §4 / NF-Audit-2.
    await spine.writeAuditEvent({
      event_type: "auth.svc_jwt.issued",
      user_id: null, // svc-JWTs have no end-user binding; they're cell-bound
      actor: cellName,
      payload: {
        kid,
        jti,
        sub: validatedClaims.sub,
        aud: validatedClaims.aud,
        role: validatedClaims.role,
        ttl_sec: body.ttl_sec,
        cell_name: cellName,
        cell_api_key_id: apiKeyRow.id,
        issued_at_ip: remoteIp,
      },
    })

    // ─── Step 10: respond ──────────────────────────────────────────────
    return jsonResponse(200, {
      jwt,
      jti,
      exp: expSec,
    } satisfies ServiceJwtResp)
  })

// ─── helpers ──────────────────────────────────────────────────────────────

/**
 * Extract the underlying Bun.SQL handle from a SpinePort. The route does
 * its own SQL (cell_api_keys lookup, operator_grants lookup, service_jwt_
 * issuance INSERT) because the SpinePort surface is intentionally narrow
 * to the identity spine — extending it with auth-table reads would bloat
 * the port for a non-spine concern. We tunnel through the adapter's
 * exposed `sql` field instead.
 *
 * Test seam alignment: `__setSpineForTest` accepts any SpinePort, but
 * the production wiring passes a PostgresSpineAdapter which carries a
 * `.sql` field. Tests that exercise this route MUST install a spine
 * with a real `.sql` handle (the auth-flow.test.ts integration pattern,
 * not the link-route.test.ts pure-mock pattern) — see SQL-typed seam
 * in the test file.
 */
function spineSql(spine: { sql?: SpineSqlLike } | unknown): SpineSqlLike {
  const candidate = spine as { sql?: SpineSqlLike }
  if (!candidate || typeof candidate.sql !== "function") {
    throw new Error(
      "service-jwt: spine instance does not carry a `.sql` handle. " +
        "This route depends on direct SQL access to cell_api_keys, operator_grants, " +
        "and service_jwt_issuance (not exposed via SpinePort). Tests MUST install a " +
        "PostgresSpineAdapter (or compatible mock) — see the test file's spine setup.",
    )
  }
  return candidate.sql
}

/**
 * Generate a JTI: base64url-encoded 16 random bytes (96 bits of entropy).
 * Matches D-1.1 §1 (the jti claim invariant).
 */
function generateJti(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  // base64url encode without padding.
  let bin = ""
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_")
}

/**
 * Decode a compact-JWT segment to JSON. `segment` is 0 for the protected
 * header and 1 for the payload (signature segment 2 isn't decoded — it's
 * raw signature bytes). Used post-sign to re-validate the produced JWT
 * against the SvcJwtClaims + SvcJwtHeader schemas.
 */
function decodeJwtSegment(jwt: string, segment: 0 | 1): unknown {
  const parts = jwt.split(".")
  if (parts.length !== 3) {
    throw new Error("decodeJwtSegment: expected 3-segment compact JWT")
  }
  return JSON.parse(b64urlDecodeToUtf8(parts[segment]!))
}

function b64urlDecodeToUtf8(s: string): string {
  // Restore base64 padding + standard alphabet.
  const padded = s.replace(/-/g, "+").replace(/_/g, "/")
  const padding = padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4))
  const standard = padded + padding
  // atob gives us a binary string; decode UTF-8 from it.
  const bin = atob(standard)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new TextDecoder().decode(bytes)
}

/**
 * Best-effort client-IP extraction. The audit row's `metadata.ip` is a
 * forensic field — incorrect data is worse than no data, so we surface
 * `null` rather than guess. Production behind Railway's edge gets the
 * client IP via `x-forwarded-for` (Railway sets it); the local case
 * may have no proxy header at all.
 */
function extractClientIp(req: Request): string | null {
  const xff = req.headers.get("x-forwarded-for")
  if (xff) {
    // x-forwarded-for is a comma-separated chain; the leftmost entry is
    // the originating client (subsequent entries are intermediate proxies).
    const first = xff.split(",")[0]?.trim()
    if (first) return first
  }
  // Bun's Request doesn't expose remoteAddress on this surface; null is
  // the honest answer.
  return null
}

// ─── anchor unused-import suppression ────────────────────────────────────

// Anchor for `PostgresSpineAdapter` import so the typechecker tracks the
// dependency on its `.sql` shape (used implicitly via spineSql's structural
// type). A direct value import isn't needed at runtime.
type _PostgresSpineAdapterAnchor = PostgresSpineAdapter
void (null as unknown as _PostgresSpineAdapterAnchor)
