---
title: svc-JWT Canonical Specification (S1)
cycle: w2.5-cluster-auth-custody-substrate
materializes: SDD §0a (pair-mode per-request model) + SDD §3.1 verify() type surface (corrected) + SDD §5.1 issuance endpoint + PRD F-S1.1 through F-S1.10
status: ratified-phase-0
date: 2026-05-26
---

# svc-JWT Canonical Specification (S1)

> **Reading order**: This spec is the canonical source-of-truth for the svc-JWT primitive. It materializes the SDD §0a pair-mode anchor (2026-05-25), which supersedes any iter-2 ReplayStore / verify-jti language remaining in the SDD body (§3.1, §4.3, §5.4, §5.7). The per-request use model (D2.5-12) structurally removes the verify-time replay store; the denylist (D2.5-11) is the only persistence-affecting verify-time check. Where this spec and the SDD body conflict, this spec wins (per Sprint 1 D-1.1 ratification mandate).

> **Scope**: Substrate-grade. Identity-api is the host. `@0xhoneyjar/auth` is the cluster-shared verifier library every cell imports. mint-api is the W3 first-consumer. activities-api is the forward-compat consumer.

> **Not in scope for V1**: KMS-backed svc-JWT signing (deferred per F-S1.8; documented upgrade path); per-request audit aggregation beyond `service_jwt_issuance`; cross-cluster federation; W2 user-JWT (Privy) coexistence beyond shared JWKS document.

---

## 1. Claim Schema

> **Materializes**: PRD F-S1.1 + SDD §3.1 `SvcJwtClaims`.

The svc-JWT carries seven canonical claims plus a `kid` header. All claims are mandatory. Effect.Schema is the canonical type; the schema is published in `@0xhoneyjar/auth` and consumed by every verifier.

```typescript
// @0xhoneyjar/auth/svc-jwt-claims.ts
import { Schema as S } from "@effect/schema"

export const SvcJwtClaims = S.Struct({
  iss: S.String,   // issuer — identity-api canonical URL (e.g. "https://identity.0xhoneyjar.xyz")
  aud: S.String,   // audience — target cell name (e.g. "mint-api")
  sub: S.String,   // subject — calling cell name (e.g. "activities-api")
  exp: S.Number,   // unix seconds — issuance time + ttl_sec (max 3600)
  nbf: S.Number,   // unix seconds — not-before, typically == iat
  role: S.String,  // capability claim (e.g. "mint.invoke", "activity.read")
  jti: S.String,   // jwt id — base64url(16 random bytes); recorded at issuance
})
export type SvcJwtClaims = S.Schema.Type<typeof SvcJwtClaims>
```

**Header**:

```typescript
export type SvcJwtHeader = {
  alg: "ES256"          // ADR-002 baseline — ECDSA P-256
  typ: "JWT"
  kid: string           // MUST be prefixed "svc-" (e.g. "svc-2026-05-26-a")
                        // user-JWT kids use "user-" prefix; verifier rejects
                        // wrong-prefix at structural stage (zero I/O).
}
```

**Claim invariants**:

- `iss` MUST be the identity-api canonical URL, matching the verifier's `expectedIss`. No wildcards.
- `aud` MUST be the **single** target cell name. No multi-aud arrays in V1 (Effect.Schema enforces `S.String`, not `S.Array(S.String)`). Multi-aud is deferred to V2 if a real composition surface demands it; until then, mint a separate svc-JWT per `aud`.
- `sub` MUST be the calling cell name, drawn from the operator-managed `operator_grants` allow-list at issuance time. Cells cannot mint svc-JWTs claiming to be other cells.
- `exp - iat` MUST be ≤ 3600 (1h max TTL). Identity-api enforces this at issuance; verifiers re-check via `exp` against now ± `skewSec` (default 30s).
- `nbf` MUST be ≤ `now + skewSec` at verify time (rejects future-dated tokens; closes a clock-skew attack class).
- `role` is an opaque capability string. The verifier's `expectedRole` is per-endpoint; matching is **exact-string**. No role hierarchies in V1.
- `jti` is base64url-encoded 16 random bytes (96 bits of entropy). Uniqueness is statistically global; identity-api records every issued jti in `service_jwt_issuance` for audit + denylist eligibility.
- `kid` header MUST start with `svc-`. The verifier's `expectedKidPrefix` defaults to `"svc-"` and rejects everything else (including the existing `"user-"` kids served from the same JWKS document — closes kid-confusion attacks).

**Why no `iat` claim**: Effect.Schema-typed `nbf` carries the same information (issuance time is observable as `nbf`); adding `iat` doubles the surface without adding security. Identity-api's `service_jwt_issuance` audit row carries `issued_at` (DB-side timestamp) which is the authoritative issuance time for audit purposes.

---

## 2. JWKS Layout

> **Materializes**: PRD F-S1.2 + F-S1.8 + SDD §5.2. Extends existing W2 `LocalEs256Signer` pattern at `src/jwt-mint.ts` (file/env-based; no DB).

JWKS is a **single document** at `GET /.well-known/jwks.json` containing **two distinct key classes**:

| kid pattern | Key class | Purpose | Source |
|---|---|---|---|
| `user-{rotation}` | User-JWT signing | Privy-backed user session tokens (W2) | Existing `LocalEs256Signer` (file/env) |
| `svc-{rotation}` | svc-JWT signing | Cell-to-cell service tokens (W2.5 S1) | NEW — separate `LocalEs256Signer` instance, separate key material |

**Rotation naming**: `{class}-{date}-{seq}`. Examples: `user-2026-05-26-a`, `svc-2026-05-26-a`. The `{seq}` letter ratchets only when same-date rotations occur (rare).

**File/env layout** (extends `src/jwt-mint.ts:FR-J2` LocalEs256Signer pattern):

```
SVC_JWT_SIGNING_KEY_PEM         # PEM-encoded P-256 private key (active svc-kid)
SVC_JWT_SIGNING_KEY_KID         # e.g. "svc-2026-05-26-a"
SVC_JWT_SIGNING_KEY_PEM_PREV    # PEM-encoded previous key (during rotation overlap; null otherwise)
SVC_JWT_SIGNING_KEY_KID_PREV    # e.g. "svc-2026-05-12-a" (overlap-window value)
```

Equivalent variables exist for the user-JWT class (`USER_JWT_SIGNING_KEY_PEM` etc.). The two classes are operationally independent — rotating the svc-kid does **not** affect user-JWT issuance and vice versa.

**JWKS document shape** (composed at runtime by identity-api):

```http
GET /.well-known/jwks.json HTTP/1.1
```

```json
{
  "keys": [
    {
      "kty": "EC",
      "crv": "P-256",
      "use": "sig",
      "alg": "ES256",
      "kid": "user-2026-05-26-a",
      "x": "...",
      "y": "..."
    },
    {
      "kty": "EC",
      "crv": "P-256",
      "use": "sig",
      "alg": "ES256",
      "kid": "svc-2026-05-26-a",
      "x": "...",
      "y": "..."
    },
    {
      "kty": "EC",
      "crv": "P-256",
      "use": "sig",
      "alg": "ES256",
      "kid": "svc-2026-05-12-a",
      "x": "...",
      "y": "..."
    }
  ]
}
```

The `svc-2026-05-12-a` entry above is the **previous svc-kid** during a rotation overlap window (see §7). When `SVC_JWT_SIGNING_KEY_PEM_PREV` is null, only the active `svc-` and `user-` kids appear.

**Verifier obligation**: cells fetching `/.well-known/jwks.json` MUST cache the document (cluster-baseline `JwksValidator` in `packages/adapters/src/jwks-validator.ts` already implements 1h fresh / 72h stale / 60s refresh-cooldown / single-flight dedup). svc-JWT verifiers consume the same cache as user-JWT verifiers; kid disambiguation handles class separation.

---

## 3. Issuance Model — PER-REQUEST

> **Materializes**: PRD F-S1.4 + F-S1.9 (AMENDED) + SDD §0a per-request anchor. Supersedes any earlier auto-refresh-at-90% language.

**Core rule**: Cells mint a **fresh svc-JWT before EACH cross-cell call**. There is no token reuse, no client-side cache, no refresh-at-90%-TTL. The svc-JWT is single-use by convention; replay is mechanically impossible because cells never reuse a token.

**Why per-request** (D2.5-12 rationale):

- Removes the entire verify-time replay-store complexity (no `service_jwt_replay` table; no `verify-jti` HTTP round-trip; no `ReplayStore` opt on `verify()`).
- Identity-api remains the single record of every issued jti (in `service_jwt_issuance`) — audit + denylist eligibility intact.
- The throughput cost is real but bounded: identity-api supports **1000 issuances/sec sustained** (single-Postgres scope). Future scale → svc-JWT issuance becomes its own scaling axis (see F-S1.9).
- Verifier hot path stays small: structural + sig + claims + denylist query. No write at verify time.

**Issuance-side audit** (replaces the verify-time replay store):

- Identity-api INSERTs one row into `service_jwt_issuance` per issued JWT, with `(jti, sub, aud, role, kid, iss, exp, issued_by, issued_at_cell_ip, ttl_sec)`.
- Retention: 90 days (rolling sweep via `pg_cron`); after 90 days the issuance audit is pruned but the jti is no longer denylist-eligible by design (TTL is 1h; a 90-day-old jti has been expired for 89.96 days).
- Audit event `auth.svc_jwt.issued` emitted to cluster audit log at issuance time (NF-Audit-2).

**Rate limit**: 1000 issuances/min/cell (raised from W2 user-JWT's 10/min/operator because per-request throughput requires the higher ceiling). Identity-api applies the limit per `cell_name` (from API-key lookup) before any DB write. Excess → HTTP 429 with `Retry-After`.

**Max TTL**: 3600s (1h). Identity-api rejects `ttl_sec > 3600` at issuance. The short TTL is the safety mechanism — replay window is bounded even in the (impossible-by-design) case that a cell were to leak a fresh JWT before using it.

**Client helper** (`@0xhoneyjar/auth/issuance-client.ts`):

- Connection-pooled HTTP client to identity-api `/v1/auth/service-jwt`.
- Retry-on-503 with bounded exponential backoff (3 retries, 100ms → 400ms → 1.6s).
- Never caches the resulting JWT — returns it directly to caller, which uses it once.
- Exposes a single function: `mint(sub, aud, role) → Promise<string>` returning the encoded JWT.

---

## 4. Issuance Endpoint Contract

> **Materializes**: PRD F-S1.5 + SDD §5.1 (with the cell-API-key auth model from §0a replacing the W2 user-JWT-operator gate).

```http
POST /v1/auth/service-jwt HTTP/1.1
Host: identity.0xhoneyjar.xyz
Content-Type: application/json
X-Cell-Api-Key: <argon2id-hashed-at-rest secret>
X-Cell-Name: activities-api
```

**Authentication**: cell-bound long-lived API key in `X-Cell-Api-Key` header. The header value is the raw key; identity-api hashes it via argon2id and matches against `cell_api_keys.key_hash` (filtered by `cell_name`). API keys are operator-issued at cell deploy time and rotated independently of svc-kid rotation.

**Authorization**: identity-api looks up `operator_grants` for the tuple `(sub=X-Cell-Name, aud=<request.aud>, role=<request.role>)`. Deny-all default — if no matching grant exists, the request returns 403 `NOT_GRANTED`. Grants are operator-managed via an out-of-band CLI; **grants in production require 2-of-3-operator approval** (per D2.5-7).

**Request body**:

```json
{
  "sub": "activities-api",
  "aud": "mint-api",
  "role": "mint.invoke",
  "ttl_sec": 3600
}
```

The `sub` in the body MUST match `X-Cell-Name`; mismatch returns 403 `SUB_MISMATCH` (defense-in-depth against API-key-leak-on-different-cell scenarios).

**Response 200** (operation succeeded; jti recorded in `service_jwt_issuance`):

```json
{
  "jwt": "eyJhbGciOiJFUzI1NiIsImtpZCI6InN2Yy0yMDI2LTA1LTI2LWEi...",
  "jti": "Yp3Q5w8aLm9N2bV4xT6sKg",
  "exp": 1717000000
}
```

**Error codes**:

| HTTP | Code | Trigger |
|---|---|---|
| 400 | `INVALID_BODY` | Malformed JSON; missing required field; non-string `sub` / `aud` / `role` |
| 401 | `MISSING_API_KEY` | `X-Cell-Api-Key` header absent |
| 401 | `INVALID_API_KEY` | Hash mismatch in `cell_api_keys`; cell revoked (`revoked_at IS NOT NULL`) |
| 403 | `SUB_MISMATCH` | Request body `sub` ≠ `X-Cell-Name` header |
| 403 | `NOT_GRANTED` | No matching row in `operator_grants` for `(sub, aud, role)` |
| 422 | `INVALID_TTL` | `ttl_sec` outside [60, 3600] |
| 429 | `RATE_LIMITED` | Cell exceeded 1000/min issuance budget; `Retry-After` header set |
| 503 | `ISSUANCE_DISABLED` | Global emergency flag `auth.svc_jwt.disable_issuance == true` flipped by operator |
| 503 | `DB_UNAVAILABLE` | Postgres write to `service_jwt_issuance` failed; fail-CLOSED — no JWT issued |

**Audit event**: every successful issuance emits `auth.svc_jwt.issued` with `{sub, aud, role, jti, kid, ttl_sec, cell_name, issued_at_cell_ip}` to the cluster audit log. Every failed issuance (`NOT_GRANTED`, `RATE_LIMITED`, `SUB_MISMATCH`, `INVALID_API_KEY`) emits `auth.svc_jwt.issuance_refused` with `{cell_name, attempted_sub, attempted_aud, attempted_role, refused_reason, cell_ip}`.

**Emergency disable**: operator-only HTTP path (out of W2.5 scope; tracked by operator runbook) flips `auth.svc_jwt.disable_issuance` to `true`. All subsequent issuance requests return 503 `ISSUANCE_DISABLED` until the flag is flipped back. Used during svc-key compromise (per PRD §5a.5).

---

## 5. Verifier Interface

> **Materializes**: PRD F-S1.3 + F-S1.6 + SDD §3.1 verify() type surface (corrected per §0a — **NO `replayStore` opt**).

```typescript
// @0xhoneyjar/auth/verify.ts (S1 verifier surface — post-§0a)

import { Schema as S } from "@effect/schema"
import { SvcJwtClaims } from "./svc-jwt-claims"

export type VerifyOpts = {
  expectedIss: string             // identity-api URL — issuer allowlist
  expectedAud: string             // this cell's own name — exact match
  expectedRole: string            // endpoint's required capability — exact match
  expectedKidPrefix?: string      // default "svc-" — rejects user-JWT kids
  jwksCache: JwksCache            // mandatory cache; per-request fetch is a DoS vector
  denylistCheck: DenylistCheck    // post-validation hook (§6 below); fail-CLOSED on DB unavailability
  skewSec?: number                // default 30
}

export type VerifyResult =
  | { ok: true; claims: SvcJwtClaims }
  | { ok: false; code: VerifyErrorCode; message: string }

export type VerifyErrorCode =
  | "MALFORMED"            // → HTTP 400 — structural parse fails (no I/O)
  | "INVALID_SIG"          // → HTTP 401 — sig validation failed (one I/O — JWKS fetch)
  | "EXPIRED"              // → HTTP 401 — exp ≤ now - skewSec
  | "NBF_FUTURE"           // → HTTP 401 — nbf > now + skewSec
  | "ISS_MISMATCH"         // → HTTP 401 — iss claim ≠ expectedIss
  | "KID_DISALLOWED"       // → HTTP 401 — kid prefix ≠ expectedKidPrefix
  | "ROLE_MISMATCH"        // → HTTP 403 — role claim ≠ expectedRole
  | "AUD_MISMATCH"         // → HTTP 403 — aud claim ≠ expectedAud
  | "JWKS_UNREACHABLE"     // → HTTP 503 — fail-CLOSED; no stale-cache fallback past 72h
  | "DENIED_BY_RULE"       // → HTTP 403 — denylist matched (§6)
  | "DENYLIST_UNAVAILABLE" // → HTTP 503 — fail-CLOSED; denylist DB unreachable

// JWKS cache contract — identical to existing W2 JwksValidator.
// Default impl: in-memory LRU with 1h TTL; rotation overlap MUST be ≥ 2h (§7).
export interface JwksCache {
  get(url: string): Promise<JwksKey[] | null>
  set(url: string, keys: JwksKey[], ttlSec: number): Promise<void>
}

// Denylist hook — pluggable (cells use HTTP indirection to identity-api by
// default; cells with direct identity-api-Postgres access can substitute
// a direct-DB impl). MUST propagate connection errors as thrown exceptions —
// fail-CLOSED only. See §6 for the contract.
export interface DenylistCheck {
  check(claims: SvcJwtClaims): Promise<
    | { denied: false }
    | { denied: true; reason: string; matched_rule_id: string }
  >
}

export declare function verify(jwt: string, opts: VerifyOpts): Promise<VerifyResult>
```

**Conformance invariant**: `verify()` MUST NOT throw on any input. All failure modes produce structured `VerifyResult`. Resolves F-S1.6 acceptance criteria.

**Order of operations** (mandatory; substrate-grade):

1. **Parse JWT structure** → `MALFORMED` on parse failure (no I/O).
2. **Decode header + claims** (no I/O).
3. **Validate `exp` / `nbf`** against now ± `skewSec` → `EXPIRED` / `NBF_FUTURE` (no I/O).
4. **Validate `iss`** matches `expectedIss` → `ISS_MISMATCH` (no I/O).
5. **Validate `kid` prefix** matches `expectedKidPrefix` → `KID_DISALLOWED` (no I/O).
6. **Fetch JWKS** via `jwksCache` → `JWKS_UNREACHABLE` on cache miss + fetch fail (one I/O — bounded by cache hit rate).
7. **Verify signature** → `INVALID_SIG` (no further I/O).
8. **Validate `aud`** matches `expectedAud` exactly → `AUD_MISMATCH` (no I/O).
9. **Validate `role`** matches `expectedRole` → `ROLE_MISMATCH` (no I/O).
10. **Denylist query** via `denylistCheck.check(claims)` → `DENIED_BY_RULE` on match, `DENYLIST_UNAVAILABLE` on thrown exception (one I/O — only reached after sig + claim checks pass).

Steps 1–9 are zero-I/O for invalid JWTs. An attacker flooding the verifier with malformed/expired/wrong-sig JWTs cannot trigger any denylist DB write or query — the denylist storage-DoS vector is closed.

**Explicit non-presence (§0a anchor)**: there is **NO `replayStore` opt** on `VerifyOpts`. There is **NO `checkAndRecord`** call in the order-of-ops. There is **NO `REPLAYED_JTI` error code**. These belonged to the iter-2 design that D2.5-12 structurally removed. Cells MUST NOT add a verify-time replay-store check; doing so would re-introduce the storage-DoS surface, the verify-jti HTTP round-trip, and the cell-bound `replay_api_keys` table — all of which the per-request model deletes by design.

**Performance target** (NF-Perf-1-AMENDED): verify end-to-end p95 < 30ms. Hot path: 0 DB I/O for invalid JWTs (steps 1–5); 1 cached JWKS lookup + sig verify for valid sig; 1 denylist query (Postgres-local with indexed lookup) for valid JWTs.

---

## 6. Denylist Hook

> **Materializes**: PRD F-S1.10 + D2.5-11 + SDD §0a denylist contract.

The denylist is the **only persistence-affecting verify-time check** under the per-request model. It exists to support emergency revocation (compromised svc-kid, leaked operator-grant, malicious cell).

**Table** (full DDL in `migrations-spec.md` D-1.5):

```sql
CREATE TABLE service_jwt_denylist (
  rule_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kid         TEXT NULL,
  jti         TEXT NULL,
  sub         TEXT NULL,
  reason      TEXT NOT NULL,
  denied_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  denied_by   TEXT NOT NULL,
  CONSTRAINT denylist_at_least_one_match CHECK (
    kid IS NOT NULL OR jti IS NOT NULL OR sub IS NOT NULL
  )
);

CREATE INDEX idx_denylist_kid ON service_jwt_denylist (kid) WHERE kid IS NOT NULL;
CREATE INDEX idx_denylist_jti ON service_jwt_denylist (jti) WHERE jti IS NOT NULL;
CREATE INDEX idx_denylist_sub ON service_jwt_denylist (sub) WHERE sub IS NOT NULL;
```

**Match semantics (any-match)**: a JWT is denied if **any** denylist row matches **any** of (kid, jti, sub) on the JWT. Examples:

- Rule `{kid: "svc-2026-05-12-a", reason: "key compromise"}` → every svc-JWT signed by that kid is denied, regardless of jti or sub.
- Rule `{jti: "Yp3Q5w8aLm9N2bV4xT6sKg", reason: "leaked at issuance"}` → that single JWT is denied.
- Rule `{sub: "compromised-cell", reason: "cell suspected compromised"}` → every svc-JWT minted with that cell as caller is denied (regardless of kid or aud).

**Verifier hook**: runs **after** sig + claim validation (step 10 in §5). The hook receives the validated `SvcJwtClaims` plus the decoded `kid` from the header, queries the denylist (any-match across all three fields), and returns either `{denied: false}` (proceed) or `{denied: true, reason, matched_rule_id}` (return `DENIED_BY_RULE` 403).

**HTTP indirection (default for cells without direct DB access)**: cells call identity-api's denylist-query endpoint (out of W2.5 Sprint 1 scope to specify the exact endpoint shape; the verifier interface treats the query as opaque). For Sprint 2 spec authoring: the endpoint is `POST /v1/auth/denylist/check` with cell-bound API-key auth (same `cell_api_keys` table as issuance).

> **STOP-AND-ASK**: the denylist HTTP endpoint shape (`/v1/auth/denylist/check`) is not specified in §0a or D2.5-11. The smallest defensible default is a read-only POST with the same `cell_api_keys` auth as issuance, returning `{denied: bool, reason?, matched_rule_id?}`. Sprint 2 D-2.X is the right place to firm this — flag it forward.

**Direct DB (for identity-api itself + cells with direct Postgres access)**: a `PostgresDenylistCheck` impl issues `SELECT 1 FROM service_jwt_denylist WHERE kid = $1 OR jti = $2 OR sub = $3 LIMIT 1` (any-match via OR-conditioned predicate; PG planner uses the per-column partial indexes above).

**Fail-CLOSED**: denylist DB unavailable → `DENYLIST_UNAVAILABLE` 503. Substrate-grade rigor (PRD NF-Sec-1); no cell opt-in for fail-open. The verifier MUST treat denylist unavailability as a hard failure.

**Denylist append**: operator-managed via out-of-band CLI; same 2-of-3-operator approval policy as `operator_grants` in production (D2.5-7). Append emits `auth.svc_jwt.denylist_appended` audit event with `{rule_id, kid, jti, sub, reason, denied_by}`.

---

## 7. JWKS Rotation Procedure

> **Materializes**: PRD F-S1.2 + NF-Ops-1 (overlap window ≥ 2 × default token TTL = 2h).

**svc-kid rotation is independent from user-kid rotation.** Rotating one does not require rotating the other. Operator may schedule them on different cadences (e.g., svc-kid rotated quarterly; user-kid rotated annually).

**Overlap window**: minimum **2 hours** (= 2 × max-TTL of 3600s). During overlap, both the new active svc-kid and the previous svc-kid appear in the JWKS document. Cells fetching JWKS during overlap see both keys; verifiers accept JWTs signed by either.

**Why 2× max-TTL**: any svc-JWT in flight at rotation time has at most 1h of remaining validity (since max TTL is 1h). A 2h overlap guarantees every in-flight JWT signed by the previous kid completes its lifecycle before the previous kid is removed from JWKS. **Cells using stale JWKS caches** (the existing `JwksValidator` has 1h fresh + 72h stale window) MUST refresh before the 2h overlap closes — operator runbook responsibility; cells holding a 72h-stale cache during a rotation will hard-fail on the next sig verify (`signature_invalid`).

**Procedure** (operator-driven; not Sprint 1 scope to script):

1. **Generate new key**: `openssl ecparam -genkey -name prime256v1 -noout -out svc-new.pem` (or equivalent via Hyper's key-management surface).
2. **Set environment**: write the new key + new kid to `SVC_JWT_SIGNING_KEY_PEM` + `SVC_JWT_SIGNING_KEY_KID`. Move the prior values to `SVC_JWT_SIGNING_KEY_PEM_PREV` + `SVC_JWT_SIGNING_KEY_KID_PREV`.
3. **Reload identity-api**: Railway environment reload (or equivalent) loads the new env. Identity-api re-instantiates both `LocalEs256Signer` instances (active + previous).
4. **Verify JWKS document**: `curl https://identity.0xhoneyjar.xyz/.well-known/jwks.json` returns both svc-kids alongside the user-kid(s).
5. **Watch overlap window**: 2h minimum. Operator may extend (no upper bound; overlap is forward-compatible).
6. **Retire previous kid**: clear `SVC_JWT_SIGNING_KEY_PEM_PREV` + `SVC_JWT_SIGNING_KEY_KID_PREV` (set both to empty). Reload. JWKS now contains only the new svc-kid (plus user-kid(s)).

**Issuance during overlap**: identity-api signs every new svc-JWT with the **active** key only. The previous key exists only in JWKS to validate svc-JWTs already in flight; identity-api does not issue new tokens signed by the previous key.

**Emergency rotation (svc-key compromise, per PRD §5a.5)**:

1. Operator flips `auth.svc_jwt.disable_issuance` = true (immediate; blocks new issuance).
2. Operator appends `{kid: <compromised_kid>}` rule to `service_jwt_denylist` (immediate; rejects all in-flight JWTs signed by that kid).
3. Operator follows steps 1–4 of the standard rotation (above).
4. Operator flips `auth.svc_jwt.disable_issuance` = false. Issuance resumes with the new kid.
5. Operator follows steps 5–6 of the standard rotation **with reduced overlap window** (since the compromised kid is denylist-blocked, the 2h overlap requirement is moot — operator may retire the previous kid immediately after step 4).

**Cross-reference**: this procedure extends the rotation pattern in `packages/adapters/src/jwks-validator.ts:248-291` (the JwksValidator's cache + stale-if-error logic). svc-JWT rotation reuses the same cache semantics; the only S1-specific addition is the **independence** of svc-kid from user-kid rotation.

---

## 8. Conformance Suite

> **Materializes**: PRD F-S1.6 + SDD §7.2.

Substrate-grade conformance is **11 scenarios** across the verifier surface. Each scenario is a self-contained test: given an input JWT + verify opts, the verifier MUST return the expected result. Scenarios run against the published `@0xhoneyjar/auth` library; identity-api and every consumer cell rerun the suite in CI as a gate.

| # | Scenario | Input | Expected | Cites |
|---|---|---|---|---|
| 1 | Valid svc-JWT | Well-formed JWT signed by active svc-kid; all claims match opts | `{ok: true, claims: <decoded>}` → HTTP 200 | F-S1.3, F-S1.6 |
| 2 | Invalid signature | Well-formed JWT; sig tampered (last byte flipped) | `{ok: false, code: "INVALID_SIG"}` → HTTP 401 | F-S1.3, SDD §3.1 step 7 |
| 3 | `role` mismatch | Sig valid; `role` claim ≠ `expectedRole` | `{ok: false, code: "ROLE_MISMATCH"}` → HTTP 403 | F-S1.3 |
| 4 | `aud` mismatch | Sig valid; `aud` claim ≠ `expectedAud` | `{ok: false, code: "AUD_MISMATCH"}` → HTTP 403 | F-S1.3 (PRD-HIGH/780) |
| 5 | `iss` mismatch | Sig valid; `iss` claim ≠ `expectedIss` | `{ok: false, code: "ISS_MISMATCH"}` → HTTP 401 | F-S1.3 (SDD-HIGH/720) |
| 6 | `kid` disallowed | Sig valid; `kid` header prefix ≠ `expectedKidPrefix` (e.g. a user-JWT kid sent to a svc-verifier) | `{ok: false, code: "KID_DISALLOWED"}` → HTTP 401 | F-S1.3 (SDD-HIGH/720) |
| 7 | Expired | Sig valid; `exp` ≤ now - `skewSec` | `{ok: false, code: "EXPIRED"}` → HTTP 401 | F-S1.3 |
| 8 | `nbf` future | Sig valid; `nbf` > now + `skewSec` | `{ok: false, code: "NBF_FUTURE"}` → HTTP 401 | F-S1.3 |
| 9 | Malformed | Garbage string (e.g. `"not.a.jwt"`); structural parse fails | `{ok: false, code: "MALFORMED"}` → HTTP 400 | F-S1.3, SDD §3.1 step 1 |
| 10 | JWKS unreachable | Sig valid in principle; JWKS endpoint returns 500 + no cached entry | `{ok: false, code: "JWKS_UNREACHABLE"}` → HTTP 503 | F-S1.3, SDD §6.2 (fail-CLOSED) |
| 11 | Denylist match | All claim checks pass; denylist contains a row matching `kid` OR `jti` OR `sub` | `{ok: false, code: "DENIED_BY_RULE"}` → HTTP 403 | F-S1.10, D2.5-11 |

**Explicit non-scenarios (§0a anchor)**: there are **NO replay-store conformance scenarios** in the suite. The iter-2 design's "replayed jti → 409" and "replay-store unavailable → 503" scenarios are absent because they are **mechanically impossible by design** under D2.5-12. A cell that never reuses a token cannot trigger a replay; identity-api never queries any replay structure at verify time, so the unavailability mode does not exist. Adding such scenarios in Sprint 2 onward would be a defect — file an issue per the inter-doc consistency check in the Sprint 1 build doc.

**Conformance enforcement**:

- Published in `@0xhoneyjar/auth/conformance/svc-jwt.test.ts`.
- Coverage targets: ≥ 90% line coverage, ≥ 80% branch coverage on the verifier code path (PRD M-3).
- Every consumer cell reruns the suite in its CI (mint-api, activities-api at minimum for V1). Failure blocks merge.
- Identity-api reruns the suite in its CI after every change to `service_jwt_issuance` / `service_jwt_denylist` / `cell_api_keys` / `operator_grants` migration touchpoints.

---

## Appendix A — Cross-Reference Index

| Spec section | PRD requirement | SDD reference |
|---|---|---|
| §1 Claim Schema | F-S1.1 | SDD §3.1 `SvcJwtClaims` (corrected per §0a) |
| §2 JWKS Layout | F-S1.2, F-S1.8 | SDD §5.2 + `src/jwt-mint.ts:FR-J2` |
| §3 Issuance Model | F-S1.4, F-S1.9 | SDD §0a per-request anchor |
| §4 Issuance Endpoint | F-S1.5 | SDD §5.1 (with §0a cell-API-key correction) |
| §5 Verifier Interface | F-S1.3, F-S1.6 | SDD §3.1 verify() (corrected — no `replayStore` opt) |
| §6 Denylist Hook | F-S1.10 | SDD §0a D2.5-11 |
| §7 JWKS Rotation | F-S1.2, NF-Ops-1 | `packages/adapters/src/jwks-validator.ts:248-291` |
| §8 Conformance Suite | F-S1.6 | SDD §7.2 (with §0a exclusions) |

## Appendix B — Related Sprint 1 Deliverables

- **D-1.5** `freeside-auth/grimoires/migrations-spec.md` — DDL specs for `service_jwt_issuance`, `service_jwt_denylist`, `cell_api_keys`, `operator_grants`.
- **D-1.7** `loa-freeside/grimoires/loa/runbooks/threat-model.md` — operational threat model; svc-kid compromise emergency procedures (§5a.5 cite source).
- **D-1.2** `freeside-mint/contracts/substrate/ROLES.md` — orthogonal to S1 but the 5-role taxonomy bounds what `role` claims svc-JWTs can carry on the mint-api side.

## Appendix C — Open Items Flagged Forward

| ID | Question | Smallest defensible default | Sprint where it lands |
|---|---|---|---|
| OQ-1 | Denylist HTTP endpoint shape (§6) | `POST /v1/auth/denylist/check` with `cell_api_keys` auth, returning `{denied, reason?, matched_rule_id?}` | Sprint 2 D-2.X |
| OQ-2 | Multi-aud support | Deferred to V2; mint a separate JWT per `aud` in V1 | post-W2.5 |
| OQ-3 | Role hierarchies | None in V1; exact-string match only | post-W2.5 |
