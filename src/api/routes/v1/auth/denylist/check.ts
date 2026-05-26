/**
 * POST /v1/auth/denylist/check — cell-API-key-authenticated denylist
 * lookup (W2.5 sprint-2, T-2.7, bead arrakis-v175).
 *
 * Materializes D-1.1 §6 of `grimoires/svc-jwt-spec.md`:
 *   - Cells without direct identity-api-Postgres access query the denylist
 *     via this endpoint.
 *   - Auth gate: same `X-Cell-Api-Key` + `X-Cell-Name` model as the
 *     issuance endpoint (T-2.6's `POST /v1/auth/service-jwt`). Argon2id
 *     hash compare against `cell_api_keys.key_hash` filtered by
 *     `cell_name` + `revoked_at IS NULL`.
 *   - Read-only: this endpoint performs NO writes. Its only DB I/O is the
 *     denylist SELECT (and the cell-API-key SELECT for auth).
 *   - Fail-CLOSED on Postgres outage: returns 503 `DENYLIST_UNAVAILABLE`.
 *
 * **CONJUNCTIVE null-as-wildcard match** semantics (per BB-002 inline
 * clarification of the "any-match" tongue-handle in D-1.1 §6):
 *
 *   A JWT (kid, jti, sub) is denied by a rule iff EVERY non-null field
 *   of the rule matches the JWT's corresponding field. A null rule field
 *   is a wildcard.
 *
 *   SQL: `(kid IS NULL OR kid = $1) AND (jti IS NULL OR jti = $2) AND (sub IS NULL OR sub = $3)`
 *
 * **Coordination with T-2.6** (issuance endpoint at `POST /v1/auth/service-jwt`):
 *   The argon2id verifier is shared via the `IArgon2idVerifier` contract
 *   in `packages/adapters/src/argon2-params.ts`. T-2.6 ships the concrete
 *   implementation backed by an argon2 lib; T-2.7's route uses it via
 *   the contract surface. The concrete impl is injected via the
 *   `__setArgon2VerifierForTest` test seam (production wiring is the
 *   forward-compat hook for T-2.6's commit).
 */

import { SQL } from 'bun';
import { jsonResponse } from '@hyper/core';
import { z } from 'zod';
import { route } from '../../../../../auth';
import {
  BunSqlDenylistCheck,
  ARGON2ID_PARAMS,
  type IArgon2idVerifier,
} from '@freeside-auth/adapters';

// ─── Request/response schemas ──────────────────────────────────────────

/**
 * Request body shape — strict; rejects unknown keys to catch typos /
 * misuse. The three string fields are taken verbatim from the caller's
 * JWT claims (kid from header; jti + sub from payload).
 */
export const DenylistCheckReqSchema = z
  .object({
    kid: z.string().min(1),
    jti: z.string().min(1),
    sub: z.string().min(1),
  })
  .strict();

export type DenylistCheckReq = z.infer<typeof DenylistCheckReqSchema>;

// ─── Argon2id verifier — pluggable via the IArgon2idVerifier contract ──
//
// T-2.6 is expected to land the concrete impl. Until then, this module
// holds a NULL verifier; production deploys MUST inject a real verifier
// via `__setArgon2VerifierForTest` (the same seam works in production
// boot — call once at module load order, BEFORE the first request).
//
// Rationale for null default: the route MUST fail-CLOSED if no verifier
// is wired. A "permissive default" (e.g. plain-string compare) is a
// security regression waiting to happen — explicit injection prevents it.

let _verifier: IArgon2idVerifier | null = null;

/**
 * Install an `IArgon2idVerifier` for production OR tests. Production
 * deploys call this at boot from a wiring file once T-2.6's concrete
 * impl lands.
 *
 * **Production wiring path** (forward-compat, NOT yet wired):
 *
 * ```ts
 * import { Argon2idVerifier } from "@freeside-auth/adapters"; // T-2.6
 * import { __setArgon2VerifierForTest } from "./check";
 * __setArgon2VerifierForTest(new Argon2idVerifier(ARGON2ID_PARAMS));
 * ```
 *
 * The `__setForTest` naming retains the test-seam convention even though
 * it's the production-wiring hook too (matches `__setSpineForTest` in
 * `src/api/spine.ts`).
 */
export function __setArgon2VerifierForTest(verifier: IArgon2idVerifier): void {
  _verifier = verifier;
}

export function __resetArgon2VerifierForTest(): void {
  _verifier = null;
}

// ─── Bun.SQL singleton (lazy-built from env, like src/api/spine.ts) ────

let _sql: SQL | null = null;

function getSql(): SQL {
  if (_sql) return _sql;
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "src/api/routes/v1/auth/denylist/check.ts: DATABASE_URL is unset.\n" +
        "  Why: the denylist-check endpoint queries cell_api_keys + service_jwt_denylist.\n" +
        "  Fix: set DATABASE_URL (Railway sets this automatically).",
    );
  }
  _sql = new SQL(url);
  return _sql;
}

export function __setSqlForTest(sql: SQL): void {
  _sql = sql;
}

export function __resetSqlForTest(): void {
  _sql = null;
}

// ─── Cell-API-key auth helper ──────────────────────────────────────────

interface CellApiKeyRow {
  id: string;
  key_hash: string;
}

/**
 * Verify the presented `X-Cell-Api-Key` against the stored argon2id hash
 * for the `X-Cell-Name` cell. Returns true iff:
 *   - The headers are both present + non-empty.
 *   - A row exists in `cell_api_keys` with `cell_name = $cellName` AND
 *     `revoked_at IS NULL` (the active-key partial unique index).
 *   - The argon2id verifier confirms `presentedKey` hashes to the row's
 *     `key_hash` under the pinned `ARGON2ID_PARAMS`.
 *
 * Fail-CLOSED: any DB error or verifier exception is treated as
 * unauthenticated. Constant-time semantics come from the argon2 lib
 * (NOT from this function's structure — we use early-return for clarity,
 * but the actual hash compare is what matters for timing).
 */
async function verifyCellApiKey(
  sql: SQL,
  verifier: IArgon2idVerifier,
  cellName: string | null,
  presentedKey: string | null,
): Promise<boolean> {
  if (!cellName || !presentedKey) return false;
  if (cellName.length === 0 || presentedKey.length === 0) return false;

  // Defense-in-depth: enforce the slug shape at the read seam too.
  // The DB CHECK constraint (chk_cell_name_slug) makes invalid values
  // unstorable; this regex prevents a malicious caller from probing
  // for SQL-injection or unicode-confusable header values before the DB
  // even sees them.
  if (!/^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$/.test(cellName)) {
    return false;
  }

  let rows: CellApiKeyRow[];
  try {
    rows = (await (sql as unknown as {
      (
        strings: TemplateStringsArray,
        ...values: unknown[]
      ): Promise<CellApiKeyRow[]>;
    })`
      SELECT id, key_hash
      FROM cell_api_keys
      WHERE cell_name = ${cellName} AND revoked_at IS NULL
      LIMIT 1
    `) as CellApiKeyRow[];
  } catch {
    // DB outage on the auth-row lookup → treat as unauthenticated (the
    // route's denylist SELECT will also fail, but we return 401 here
    // rather than 503 to avoid leaking which side of the auth gate
    // failed). Forensic visibility comes from the cluster audit log.
    return false;
  }

  if (!Array.isArray(rows) || rows.length === 0) return false;
  const row = rows[0]!;

  try {
    return await verifier.verify(presentedKey, row.key_hash);
  } catch {
    return false;
  }
}

// ─── The route ─────────────────────────────────────────────────────────

export const denylistCheck = route
  .post('/v1/auth/denylist/check')
  .body(DenylistCheckReqSchema)
  .meta({
    summary:
      'Query the svc-JWT denylist for a (kid, jti, sub) triple — read-only.',
    mcp: {
      title: 'Check svc-JWT denylist',
      description:
        'Cells without direct identity-api-Postgres access POST here to ' +
        'evaluate the post-validation denylist hook (D-1.1 §6). CONJUNCTIVE ' +
        'null-as-wildcard match. Auth: X-Cell-Api-Key + X-Cell-Name.',
    },
  })
  .handle(async (c) => {
    // Fail-CLOSED if no argon2 verifier is wired. This is a misconfiguration
    // signal — the route MUST not be reachable in prod without the verifier
    // injected at boot. We return 503 ISSUANCE_UNCONFIGURED so the operator
    // immediately recognizes a config gap (mirrors src/api/routes/link.ts's
    // `LINK_SERVICE_TOKEN` unconfigured posture at line 70).
    if (_verifier === null) {
      return jsonResponse(503, {
        code: 'DENYLIST_UNCONFIGURED',
        message:
          'denylist-check is not wired: argon2id verifier missing. Operator ' +
          'must inject IArgon2idVerifier at boot via __setArgon2VerifierForTest.',
      });
    }

    // Extract auth headers. Hyper's `c.req` is the underlying Request.
    const req = (c as unknown as { req: Request }).req;
    const cellName = req.headers.get('x-cell-name');
    const apiKey = req.headers.get('x-cell-api-key');

    let sql: SQL;
    try {
      sql = getSql();
    } catch {
      // DATABASE_URL missing — same posture as the auth check failure.
      return jsonResponse(503, {
        code: 'DENYLIST_UNAVAILABLE',
        message: 'denylist datastore is not configured',
      });
    }

    const authOk = await verifyCellApiKey(sql, _verifier, cellName, apiKey);
    if (!authOk) {
      // Single envelope for all auth failure modes (missing header, wrong
      // cell name, revoked key, argon2 mismatch). Do not differentiate —
      // any leak of the failure mode helps an attacker enumerate.
      return jsonResponse(401, {
        code: 'INVALID_CELL_KEY',
        message: 'invalid or missing cell API key',
      });
    }

    // Body is the validated DenylistCheckReq.
    const body = (c as unknown as { body: DenylistCheckReq }).body;

    // Run the denylist query.
    const denylist = new BunSqlDenylistCheck(
      sql as unknown as ConstructorParameters<typeof BunSqlDenylistCheck>[0],
    );
    try {
      const result = await denylist.matches(body.kid, body.jti, body.sub);
      if (result.denied) {
        return jsonResponse(200, {
          denied: true,
          reason: result.reason,
          ruleId: result.ruleId,
        });
      }
      return jsonResponse(200, { denied: false });
    } catch {
      // Fail-CLOSED on Postgres outage per D-1.1 §6 + NF-Sec-1.
      return jsonResponse(503, {
        code: 'DENYLIST_UNAVAILABLE',
        message: 'denylist datastore is unreachable',
      });
    }
  });

// Quiet the "imported but unused" lint for ARGON2ID_PARAMS — it's the
// pinning anchor that downstream operators must reference when wiring
// the concrete verifier. Comment makes the dependency grep-discoverable.
void ARGON2ID_PARAMS;
