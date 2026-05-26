/**
 * service-jwt.test.ts — T-2.6 integration tests for POST /v1/auth/service-jwt
 * (W2.5 sprint-2, bead arrakis-ha0l).
 *
 * Exercises the full handler against a real Postgres scratch DB:
 *   200 happy: valid cell-API-key + matching operator_grants → ES256 JWT
 *   200 invariant: produced JWT decodes against SvcJwtClaims cleanly
 *   200 invariant: service_jwt_issuance row written with kid + jti + sub + aud + role
 *   401 INVALID_CELL_KEY: argon2id mismatch
 *   401 INVALID_CELL_KEY: row revoked (revoked_at IS NOT NULL)
 *   401 MISSING_API_KEY: header absent
 *   403 GRANT_REQUIRED: valid cell-API-key but no operator_grants row
 *   422 INVALID_TTL: ttl_sec < 60
 *   422 INVALID_TTL: ttl_sec > 3600
 *   429 RATE_LIMITED: budget+1th request from same cell trips the limit
 *   400 (zod): empty sub at body-validation stage
 *   400 (zod): empty role at body-validation stage
 *
 * Pattern: mirrors `auth-flow.test.ts` (real PG, ephemeral port, real spine
 * adapter, full HTTP shape). Diverges in that this route doesn't need the
 * nonce table — we seed `cell_api_keys` + `operator_grants` directly via
 * `bookkeepingSql`.
 *
 * Test fixtures:
 *   - A deterministic ES256 signer constructed from a freshly-generated
 *     keypair at beforeAll. Test envs don't carry SVC_JWT_SIGNING_KEY_PEM,
 *     and we don't want each test to mint its own — one signer, one kid,
 *     reused across cases.
 *   - The rate-limit budget is lowered to 3/min via the
 *     LOA_SVC_JWT_RATE_LIMIT_PER_WINDOW env override, so the "429" test
 *     doesn't have to fire 1001 requests.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import { SQL } from "bun"
import { resolve } from "node:path"
import {
  __generateTestEs256KeyMaterial,
  ARGON2ID_HASH_PREFIX,
  BUN_PASSWORD_HASH_OPTIONS,
  createLocalEs256Signer,
  type ServiceJwtSigner,
} from "../../../../../../packages/adapters/src"
import { migrate } from "../../../../../../packages/adapters/src/migrate"
import { PostgresSpineAdapter } from "../../../../../../packages/adapters/src/postgres-spine-adapter"
import app from "../../../../index"
import { __resetSpineForTest, __setSpineForTest } from "../../../../spine"
import {
  __resetRateLimitForTest,
  __resetServiceJwtSignerForTest,
  __setServiceJwtSignerForTest,
} from "../service-jwt"

// ─── env + paths ─────────────────────────────────────────────────────────

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL
const MIGRATIONS_DIR = resolve(
  __dirname,
  "..",
  "..",
  "..",
  "..",
  "..",
  "..",
  "packages",
  "adapters",
  "src",
  "migrations",
)

const SCRATCH_DB_HINTS = ["test", "scratch", "ephemeral", "ci", "tmp", "preview"]
function looksLikeScratchUrl(url: string): boolean {
  try {
    const u = new URL(url)
    const dbName = u.pathname.replace(/^\//, "").toLowerCase()
    if (!dbName) return false
    return SCRATCH_DB_HINTS.some((hint) => dbName.includes(hint))
  } catch {
    return false
  }
}

/**
 * Reset the W2.5 sprint-2 auth tables to a known-empty state. We TRUNCATE
 * rather than DROP because the migrations were already applied at beforeAll
 * — re-DROP/CREATE on every test would slow the suite materially.
 *
 * Order matters because service_jwt_issuance.cell_api_key_id FKs
 * cell_api_keys.id; we TRUNCATE ... CASCADE so the issuance rows clear
 * alongside.
 */
async function clearAuthState(sql: SQL): Promise<void> {
  await sql.unsafe(`
    TRUNCATE TABLE
      service_jwt_issuance,
      service_jwt_denylist,
      operator_grants,
      cell_api_keys,
      audit_events
    RESTART IDENTITY CASCADE;
  `)
}

/**
 * Drop EVERY table this suite touches before re-migrating from clean. The
 * sibling `auth-flow.test.ts:dropAllSpineState` drops only the 0001/0002
 * spine tables; when both suites run in the same `bun test` invocation,
 * we need to wipe the W2.5 sprint-2 tables too (otherwise 0003+ migrations
 * encounter "relation already exists"). Idempotent + IF EXISTS so order
 * doesn't matter.
 */
async function dropEverything(sql: SQL): Promise<void> {
  await sql.unsafe(`
    DROP TABLE IF EXISTS service_jwt_issuance CASCADE;
    DROP TABLE IF EXISTS service_jwt_denylist CASCADE;
    DROP TABLE IF EXISTS operator_grants CASCADE;
    DROP TABLE IF EXISTS cell_api_keys CASCADE;
    DROP FUNCTION IF EXISTS jsonb_string_array_unique(jsonb);
    DROP FUNCTION IF EXISTS jsonb_array_all_strings(jsonb);
    DROP TRIGGER IF EXISTS trg_sync_primary_wallet ON wallet_links;
    DROP FUNCTION IF EXISTS sync_primary_wallet();
    DROP TABLE IF EXISTS auth_nonces CASCADE;
    DROP TABLE IF EXISTS audit_events CASCADE;
    DROP TABLE IF EXISTS world_identity CASCADE;
    DROP TABLE IF EXISTS worlds CASCADE;
    DROP TABLE IF EXISTS linked_accounts CASCADE;
    DROP TABLE IF EXISTS wallet_links CASCADE;
    DROP TABLE IF EXISTS users CASCADE;
    DROP TABLE IF EXISTS schema_migrations CASCADE;
  `)
}

// ─── test fixtures ────────────────────────────────────────────────────────

const CELL_NAME = "mint-api"
const CELL_API_KEY_RAW = "test-cell-key-7e0a31"
const GRANTEE_DID = `did:cell:${CELL_NAME}`
const GRANT_SUB = "activities-api"
const GRANT_AUD = CELL_NAME
const GRANT_ROLE = "mint.invoke"
const ISS = "https://identity.test.0xhoneyjar.xyz"
const SIGNING_KID = "svc-test-2026-05-26-a"
const RATE_LIMIT_TEST_BUDGET = 3

interface SuccessBody {
  jwt: string
  jti: string
  exp: number
}

interface ErrorBody {
  error: "service_jwt"
  code: string
  message: string
}

// ─── boot/teardown ────────────────────────────────────────────────────────

describe.skipIf(!TEST_DATABASE_URL)("/v1/auth/service-jwt (T-2.6)", () => {
  const databaseUrl = TEST_DATABASE_URL as string
  let baseUrl: string
  let realSpine: PostgresSpineAdapter
  let bookkeepingSql: SQL
  let signer: ServiceJwtSigner
  let apiKeyHash: string
  let cellApiKeyId: string
  let prevIdentityApiUrl: string | undefined
  let prevRateLimit: string | undefined

  beforeAll(async () => {
    if (!looksLikeScratchUrl(databaseUrl)) {
      throw new Error(
        `service-jwt.test: TEST_DATABASE_URL DB name does not look scratch-shaped (expected substring: ${SCRATCH_DB_HINTS.join(", ")}). Refusing to operate on non-scratch DB.`,
      )
    }
    // Wipe + re-migrate. We DROP every table before migrating because the
    // sibling auth-flow.test.ts:dropAllSpineState only drops 0001/0002
    // tables; in a shared-DB run, the sprint-2 tables (cell_api_keys,
    // operator_grants, service_jwt_*) would otherwise stick around and
    // the migration runner would conflict on the next 0003 application.
    const dropSql = new SQL(databaseUrl)
    try {
      await dropEverything(dropSql)
    } finally {
      await dropSql.close()
    }
    await migrate({ databaseUrl, migrationsDir: MIGRATIONS_DIR, verb: "up" })

    realSpine = new PostgresSpineAdapter(databaseUrl)
    __setSpineForTest(realSpine)
    bookkeepingSql = new SQL(databaseUrl)

    // Build a deterministic ES256 signer over a fresh keypair. The kid
    // matches the D-1.1 §1 invariant (starts with "svc-"). The keypair
    // never leaves this process so there's no key material in the
    // committed test code.
    const { pkcs8Pem } = await __generateTestEs256KeyMaterial()
    signer = await createLocalEs256Signer({ pkcs8Pem, kid: SIGNING_KID })
    __setServiceJwtSignerForTest(signer)

    // Env: pin issuer URL + lower rate-limit budget so the 429 test fires
    // after RATE_LIMIT_TEST_BUDGET requests instead of 1001.
    prevIdentityApiUrl = process.env.IDENTITY_API_URL
    prevRateLimit = process.env.LOA_SVC_JWT_RATE_LIMIT_PER_WINDOW
    process.env.IDENTITY_API_URL = ISS
    process.env.LOA_SVC_JWT_RATE_LIMIT_PER_WINDOW = String(RATE_LIMIT_TEST_BUDGET)

    // Pre-hash the cell-API key (slow — ~64MB argon2id work — so we do it
    // ONCE at boot and reuse the hash across all tests).
    apiKeyHash = await Bun.password.hash(CELL_API_KEY_RAW, BUN_PASSWORD_HASH_OPTIONS)
    expect(apiKeyHash.startsWith(ARGON2ID_HASH_PREFIX)).toBe(true)

    app.listen({ port: 0, hostname: "127.0.0.1", banner: false })
    const port = app.server?.port
    if (!port) throw new Error("service-jwt.test: app.server.port unavailable after listen")
    baseUrl = `http://127.0.0.1:${port}`
  })

  afterAll(async () => {
    // Defensive teardown: each resource may be undefined if beforeAll
    // threw partway. We don't want afterAll to mask an earlier failure
    // with a "Cannot read property 'close' of undefined" of its own.
    try { await app.stop() } catch {}
    if (realSpine) await realSpine.close()
    if (bookkeepingSql) await bookkeepingSql.close()
    __resetSpineForTest()
    __resetServiceJwtSignerForTest()
    __resetRateLimitForTest()

    if (prevIdentityApiUrl === undefined) delete process.env.IDENTITY_API_URL
    else process.env.IDENTITY_API_URL = prevIdentityApiUrl
    if (prevRateLimit === undefined) delete process.env.LOA_SVC_JWT_RATE_LIMIT_PER_WINDOW
    else process.env.LOA_SVC_JWT_RATE_LIMIT_PER_WINDOW = prevRateLimit
  })

  beforeEach(async () => {
    await clearAuthState(bookkeepingSql)
    __resetRateLimitForTest()
    // Seed an active cell_api_keys row + an operator_grants row covering
    // the default tuple. Tests can mutate or omit as needed.
    const ins = (await bookkeepingSql`
      INSERT INTO cell_api_keys (cell_name, key_hash, issued_by)
      VALUES (${CELL_NAME}, ${apiKeyHash}, ${"did:test:operator-1"})
      RETURNING id
    `) as Array<{ id: string }>
    cellApiKeyId = ins[0]!.id
    await bookkeepingSql`
      INSERT INTO operator_grants (grantee_did, sub, aud, role, is_production, granted_by_array)
      VALUES (${GRANTEE_DID}, ${GRANT_SUB}, ${GRANT_AUD}, ${GRANT_ROLE}, false, '[]'::jsonb)
    `
  })

  // ─── helpers ─────────────────────────────────────────────────────────

  async function postIssue(
    body: Partial<{ sub: string; aud: string; role: string; ttl_sec: number }>,
    headers: Partial<{ apiKey: string | null; cellName: string | null }> = {},
  ): Promise<{ status: number; body: SuccessBody | ErrorBody }> {
    const h: Record<string, string> = { "content-type": "application/json" }
    if (headers.apiKey !== null) h["x-cell-api-key"] = headers.apiKey ?? CELL_API_KEY_RAW
    if (headers.cellName !== null) h["x-cell-name"] = headers.cellName ?? CELL_NAME
    const res = await fetch(`${baseUrl}/v1/auth/service-jwt`, {
      method: "POST",
      headers: h,
      body: JSON.stringify({
        sub: body.sub ?? GRANT_SUB,
        aud: body.aud ?? GRANT_AUD,
        role: body.role ?? GRANT_ROLE,
        ttl_sec: body.ttl_sec ?? 3600,
      }),
    })
    return { status: res.status, body: (await res.json()) as SuccessBody | ErrorBody }
  }

  function decodeJwtPayload(jwt: string): Record<string, unknown> {
    const segs = jwt.split(".")
    if (segs.length !== 3) throw new Error("not a 3-segment JWT")
    const padded = segs[1]!.replace(/-/g, "+").replace(/_/g, "/")
    const padding = padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4))
    return JSON.parse(atob(padded + padding))
  }

  function decodeJwtHeader(jwt: string): Record<string, unknown> {
    const segs = jwt.split(".")
    if (segs.length !== 3) throw new Error("not a 3-segment JWT")
    const padded = segs[0]!.replace(/-/g, "+").replace(/_/g, "/")
    const padding = padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4))
    return JSON.parse(atob(padded + padding))
  }

  // ─── happy path ──────────────────────────────────────────────────────

  it("200 happy: valid cell key + matching grant → ES256 svc-JWT", async () => {
    const { status, body } = await postIssue({})
    expect(status).toBe(200)
    const ok = body as SuccessBody
    expect(ok.jwt.split(".")).toHaveLength(3)
    expect(ok.jti).toMatch(/^[A-Za-z0-9_-]{22}$/) // 16-byte base64url
    expect(ok.exp).toBeGreaterThan(Math.floor(Date.now() / 1000))
  })

  it("200: produced JWT carries the canonical SvcJwtClaims shape", async () => {
    const { status, body } = await postIssue({})
    expect(status).toBe(200)
    const ok = body as SuccessBody

    // Header invariants (D-1.1 §1)
    const header = decodeJwtHeader(ok.jwt)
    expect(header.alg).toBe("ES256")
    expect(header.typ).toBe("JWT")
    expect(header.kid).toBe(SIGNING_KID)

    // Claim invariants (D-1.1 §1)
    const claims = decodeJwtPayload(ok.jwt)
    expect(claims.iss).toBe(ISS)
    expect(claims.aud).toBe(GRANT_AUD)
    expect(claims.sub).toBe(GRANT_SUB)
    expect(claims.role).toBe(GRANT_ROLE)
    expect(typeof claims.iat).toBe("number")
    expect(typeof claims.nbf).toBe("number")
    expect(typeof claims.exp).toBe("number")
    expect(claims.iat).toBe(claims.nbf)
    expect((claims.exp as number) - (claims.iat as number)).toBe(3600)
    expect(typeof claims.jti).toBe("string")
    expect((claims.jti as string).length).toBeGreaterThan(0)
  })

  it("200: service_jwt_issuance audit row written with denormalized fields", async () => {
    const { status, body } = await postIssue({ ttl_sec: 600 })
    expect(status).toBe(200)
    const ok = body as SuccessBody

    const rows = (await bookkeepingSql`
      SELECT kid, jti, sub, aud, iss, role, issuing_cell_name, cell_api_key_id, metadata
        FROM service_jwt_issuance
       WHERE jti = ${ok.jti}
    `) as Array<{
      kid: string
      jti: string
      sub: string
      aud: string
      iss: string
      role: string
      issuing_cell_name: string
      cell_api_key_id: string
      metadata: Record<string, unknown>
    }>
    expect(rows).toHaveLength(1)
    const row = rows[0]!
    expect(row.kid).toBe(SIGNING_KID)
    expect(row.sub).toBe(GRANT_SUB)
    expect(row.aud).toBe(GRANT_AUD)
    expect(row.iss).toBe(ISS)
    expect(row.role).toBe(GRANT_ROLE)
    expect(row.issuing_cell_name).toBe(CELL_NAME)
    expect(row.cell_api_key_id).toBe(cellApiKeyId)
    // metadata jsonb shape: { ip, user_agent, request_id } — keys are
    // always present even when their values are null (the handler captures
    // null for any missing header so the audit shape is consistent).
    expect(Object.keys(row.metadata)).toContain("ip")
    expect(Object.keys(row.metadata)).toContain("user_agent")
    expect(Object.keys(row.metadata)).toContain("request_id")
  })

  it("200: auth.svc_jwt.issued event written to cluster audit log", async () => {
    const { status, body } = await postIssue({})
    expect(status).toBe(200)
    const ok = body as SuccessBody

    const events = (await bookkeepingSql`
      SELECT event_type, actor, payload
        FROM audit_events
       WHERE event_type = 'auth.svc_jwt.issued'
    `) as Array<{ event_type: string; actor: string; payload: Record<string, unknown> }>
    expect(events.length).toBeGreaterThanOrEqual(1)
    const ev = events.find((e) => (e.payload as { jti?: string }).jti === ok.jti)
    expect(ev).toBeDefined()
    expect(ev!.actor).toBe(CELL_NAME)
    expect(ev!.payload.kid).toBe(SIGNING_KID)
    expect(ev!.payload.role).toBe(GRANT_ROLE)
  })

  // ─── auth rejections ─────────────────────────────────────────────────

  it("401 MISSING_API_KEY: X-Cell-Api-Key header absent", async () => {
    const { status, body } = await postIssue({}, { apiKey: null })
    expect(status).toBe(401)
    expect((body as ErrorBody).code).toBe("MISSING_API_KEY")
  })

  it("401 MISSING_API_KEY: X-Cell-Name header absent", async () => {
    const { status, body } = await postIssue({}, { cellName: null })
    expect(status).toBe(401)
    expect((body as ErrorBody).code).toBe("MISSING_API_KEY")
  })

  it("401 INVALID_CELL_KEY: wrong API key (argon2id mismatch)", async () => {
    const { status, body } = await postIssue({}, { apiKey: "totally-wrong-key" })
    expect(status).toBe(401)
    expect((body as ErrorBody).code).toBe("INVALID_CELL_KEY")
  })

  it("401 INVALID_CELL_KEY: row revoked (revoked_at IS NOT NULL)", async () => {
    await bookkeepingSql`
      UPDATE cell_api_keys SET revoked_at = NOW() WHERE cell_name = ${CELL_NAME}
    `
    const { status, body } = await postIssue({})
    expect(status).toBe(401)
    expect((body as ErrorBody).code).toBe("INVALID_CELL_KEY")
  })

  // ─── ACL rejection ───────────────────────────────────────────────────

  it("403 GRANT_REQUIRED: valid API key but no matching operator_grants row", async () => {
    // Drop the seeded grant; the cell-API-key auth still passes but ACL
    // should reject for (sub, aud, role) tuple absence.
    await bookkeepingSql`DELETE FROM operator_grants`
    const { status, body } = await postIssue({})
    expect(status).toBe(403)
    expect((body as ErrorBody).code).toBe("GRANT_REQUIRED")
  })

  it("403 GRANT_REQUIRED: grant exists but is revoked", async () => {
    await bookkeepingSql`
      UPDATE operator_grants SET revoked_at = NOW()
       WHERE grantee_did = ${GRANTEE_DID} AND sub = ${GRANT_SUB} AND aud = ${GRANT_AUD} AND role = ${GRANT_ROLE}
    `
    const { status, body } = await postIssue({})
    expect(status).toBe(403)
    expect((body as ErrorBody).code).toBe("GRANT_REQUIRED")
  })

  it("403 GRANT_REQUIRED: requesting a different role than granted", async () => {
    const { status, body } = await postIssue({ role: "mint.admin" })
    expect(status).toBe(403)
    expect((body as ErrorBody).code).toBe("GRANT_REQUIRED")
  })

  // ─── TTL validation ──────────────────────────────────────────────────

  it("422 INVALID_TTL: ttl_sec < 60", async () => {
    const { status, body } = await postIssue({ ttl_sec: 30 })
    expect(status).toBe(422)
    expect((body as ErrorBody).code).toBe("INVALID_TTL")
  })

  it("422 INVALID_TTL: ttl_sec > 3600", async () => {
    const { status, body } = await postIssue({ ttl_sec: 7200 })
    expect(status).toBe(422)
    expect((body as ErrorBody).code).toBe("INVALID_TTL")
  })

  it("200: ttl_sec at lower bound (60s) accepted", async () => {
    const { status } = await postIssue({ ttl_sec: 60 })
    expect(status).toBe(200)
  })

  it("200: ttl_sec at upper bound (3600s) accepted", async () => {
    const { status } = await postIssue({ ttl_sec: 3600 })
    expect(status).toBe(200)
  })

  // ─── rate limit ──────────────────────────────────────────────────────

  it("429 RATE_LIMITED: budget+1th request from same cell trips the limit", async () => {
    // Budget is RATE_LIMIT_TEST_BUDGET; the first BUDGET requests succeed,
    // the next one returns 429 with Retry-After.
    for (let i = 0; i < RATE_LIMIT_TEST_BUDGET; i++) {
      const r = await fetch(`${baseUrl}/v1/auth/service-jwt`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-cell-api-key": CELL_API_KEY_RAW,
          "x-cell-name": CELL_NAME,
        },
        body: JSON.stringify({
          sub: GRANT_SUB,
          aud: GRANT_AUD,
          role: GRANT_ROLE,
          ttl_sec: 3600,
        }),
      })
      expect(r.status).toBe(200)
    }
    const r = await fetch(`${baseUrl}/v1/auth/service-jwt`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-cell-api-key": CELL_API_KEY_RAW,
        "x-cell-name": CELL_NAME,
      },
      body: JSON.stringify({
        sub: GRANT_SUB,
        aud: GRANT_AUD,
        role: GRANT_ROLE,
        ttl_sec: 3600,
      }),
    })
    expect(r.status).toBe(429)
    const j = (await r.json()) as ErrorBody
    expect(j.code).toBe("RATE_LIMITED")
    expect(r.headers.get("retry-after")).toBeTruthy()
    expect(Number(r.headers.get("retry-after"))).toBeGreaterThan(0)
  })

  // ─── body validation ─────────────────────────────────────────────────

  it("400: empty sub rejected by Zod (NonEmptyString invariant)", async () => {
    const res = await fetch(`${baseUrl}/v1/auth/service-jwt`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-cell-api-key": CELL_API_KEY_RAW,
        "x-cell-name": CELL_NAME,
      },
      body: JSON.stringify({
        sub: "",
        aud: GRANT_AUD,
        role: GRANT_ROLE,
        ttl_sec: 3600,
      }),
    })
    expect(res.status).toBe(400)
  })

  it("400: empty role rejected by Zod (NonEmptyString invariant)", async () => {
    const res = await fetch(`${baseUrl}/v1/auth/service-jwt`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-cell-api-key": CELL_API_KEY_RAW,
        "x-cell-name": CELL_NAME,
      },
      body: JSON.stringify({
        sub: GRANT_SUB,
        aud: GRANT_AUD,
        role: "",
        ttl_sec: 3600,
      }),
    })
    expect(res.status).toBe(400)
  })

  it("400: non-integer ttl_sec rejected by Zod", async () => {
    const res = await fetch(`${baseUrl}/v1/auth/service-jwt`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-cell-api-key": CELL_API_KEY_RAW,
        "x-cell-name": CELL_NAME,
      },
      body: JSON.stringify({
        sub: GRANT_SUB,
        aud: GRANT_AUD,
        role: GRANT_ROLE,
        ttl_sec: 3600.5,
      }),
    })
    expect(res.status).toBe(400)
  })
})
