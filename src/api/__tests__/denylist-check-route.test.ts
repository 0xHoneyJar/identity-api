/**
 * denylist-check-route.test.ts — T-2.7 integration tests for
 * POST /v1/auth/denylist/check (bead arrakis-v175).
 *
 * Exercises:
 *   - Auth gate: missing/wrong X-Cell-Api-Key or X-Cell-Name → 401.
 *   - Argon2 verifier unconfigured → 503 DENYLIST_UNCONFIGURED.
 *   - Denylist match → 200 { denied: true, reason, ruleId }.
 *   - Denylist miss → 200 { denied: false }.
 *   - Postgres outage on denylist query → 503 DENYLIST_UNAVAILABLE.
 *
 * Pattern: ephemeral port, mock Bun.SQL via __setSqlForTest, mock
 * argon2 verifier via __setArgon2VerifierForTest.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import type { IArgon2idVerifier } from '@freeside-auth/adapters';
import app from '../index';
import {
  __setArgon2VerifierForTest,
  __resetArgon2VerifierForTest,
  __setSqlForTest,
  __resetSqlForTest,
} from '../routes/v1/auth/denylist/check';

// ─── Mock argon2id verifier — plain-string compare (test only) ─────────

class MockArgon2idVerifier implements IArgon2idVerifier {
  public throwOnVerify = false;

  async verify(rawKey: string, storedHash: string): Promise<boolean> {
    if (this.throwOnVerify) {
      throw new Error('argon2 internal error');
    }
    // Test-only: hash is the plain key prefixed with "h:".
    return storedHash === `h:${rawKey}`;
  }
}

// ─── Mock Bun.SQL — tagged template that records calls + returns rows ──

interface SqlCall {
  template: string;
  values: unknown[];
}

interface MockSqlState {
  calls: SqlCall[];
  cellApiKeyRows: Array<{ id: string; key_hash: string }>;
  denylistRows: Array<{ rule_id: string; reason: string }>;
  throwOnCellApiKey: boolean;
  throwOnDenylist: boolean;
}

function makeMockSql(state: MockSqlState): unknown {
  // Bun.SQL is a tagged template function: `sql\`SELECT ... ${v}\``
  function sql(strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> {
    const template = strings.join('?');
    state.calls.push({ template, values });
    if (template.includes('cell_api_keys')) {
      if (state.throwOnCellApiKey) {
        return Promise.reject(new Error('PG outage on cell_api_keys'));
      }
      return Promise.resolve(state.cellApiKeyRows);
    }
    if (template.includes('service_jwt_denylist')) {
      if (state.throwOnDenylist) {
        return Promise.reject(new Error('PG outage on service_jwt_denylist'));
      }
      return Promise.resolve(state.denylistRows);
    }
    return Promise.resolve([]);
  }
  return sql;
}

// ─── Fixtures ──────────────────────────────────────────────────────────

const CELL_NAME = 'mint-api';
const CELL_KEY = 'cell-key-secret-1234';
const CELL_HASH = `h:${CELL_KEY}`;
const KID = 'svc-2026-05-26-a';
const JTI = 'Yp3Q5w8aLm9N2bV4xT6sKg';
const SUB = 'activities-api';

// ─── Boot/teardown ─────────────────────────────────────────────────────

let baseUrl: string;
let verifier: MockArgon2idVerifier;
let sqlState: MockSqlState;

beforeAll(async () => {
  app.listen({ port: 0, hostname: '127.0.0.1', banner: false });
  const port = app.server?.port;
  if (!port) throw new Error('test boot: app.server.port unavailable');
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await app.stop();
  __resetArgon2VerifierForTest();
  __resetSqlForTest();
});

beforeEach(() => {
  verifier = new MockArgon2idVerifier();
  __setArgon2VerifierForTest(verifier);
  sqlState = {
    calls: [],
    cellApiKeyRows: [{ id: 'cak-id-1', key_hash: CELL_HASH }],
    denylistRows: [],
    throwOnCellApiKey: false,
    throwOnDenylist: false,
  };
  // Bun.SQL is a tagged template; cast as SQL to satisfy __setSqlForTest's signature.
  __setSqlForTest(
    makeMockSql(sqlState) as unknown as Parameters<typeof __setSqlForTest>[0],
  );
});

// ─── Helper ────────────────────────────────────────────────────────────

async function postDenylistCheck(opts: {
  cellName?: string | null;
  apiKey?: string | null;
  body?: object | string;
}): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.cellName !== null && opts.cellName !== undefined) {
    headers['x-cell-name'] = opts.cellName;
  }
  if (opts.apiKey !== null && opts.apiKey !== undefined) {
    headers['x-cell-api-key'] = opts.apiKey;
  }
  const body =
    opts.body === undefined
      ? JSON.stringify({ kid: KID, jti: JTI, sub: SUB })
      : typeof opts.body === 'string'
        ? opts.body
        : JSON.stringify(opts.body);
  const res = await fetch(`${baseUrl}/v1/auth/denylist/check`, {
    method: 'POST',
    headers,
    body,
  });
  return {
    status: res.status,
    body: (await res.json()) as Record<string, unknown>,
  };
}

// ─── Auth gate ─────────────────────────────────────────────────────────

describe('POST /v1/auth/denylist/check — auth gate', () => {
  it('401 when X-Cell-Api-Key is missing', async () => {
    const { status, body } = await postDenylistCheck({
      cellName: CELL_NAME,
      apiKey: null,
    });
    expect(status).toBe(401);
    expect(body.code).toBe('INVALID_CELL_KEY');
  });

  it('401 when X-Cell-Name is missing', async () => {
    const { status, body } = await postDenylistCheck({
      cellName: null,
      apiKey: CELL_KEY,
    });
    expect(status).toBe(401);
    expect(body.code).toBe('INVALID_CELL_KEY');
  });

  it('401 when X-Cell-Api-Key does not match the stored argon2 hash', async () => {
    const { status, body } = await postDenylistCheck({
      cellName: CELL_NAME,
      apiKey: 'wrong-key',
    });
    expect(status).toBe(401);
    expect(body.code).toBe('INVALID_CELL_KEY');
  });

  it('401 when cell row is missing (revoked or unknown cell)', async () => {
    sqlState.cellApiKeyRows = []; // no active key
    const { status, body } = await postDenylistCheck({
      cellName: CELL_NAME,
      apiKey: CELL_KEY,
    });
    expect(status).toBe(401);
    expect(body.code).toBe('INVALID_CELL_KEY');
  });

  it('401 when cell_name fails slug-shape regex (defense-in-depth)', async () => {
    const { status, body } = await postDenylistCheck({
      cellName: 'BAD..cell',
      apiKey: CELL_KEY,
    });
    expect(status).toBe(401);
    expect(body.code).toBe('INVALID_CELL_KEY');
  });

  it('401 when cell_api_keys DB query throws (treated as unauthenticated)', async () => {
    sqlState.throwOnCellApiKey = true;
    const { status, body } = await postDenylistCheck({
      cellName: CELL_NAME,
      apiKey: CELL_KEY,
    });
    expect(status).toBe(401);
    expect(body.code).toBe('INVALID_CELL_KEY');
  });

  it('401 when argon2 verifier throws (fail-CLOSED on verify error)', async () => {
    verifier.throwOnVerify = true;
    const { status, body } = await postDenylistCheck({
      cellName: CELL_NAME,
      apiKey: CELL_KEY,
    });
    expect(status).toBe(401);
    expect(body.code).toBe('INVALID_CELL_KEY');
  });
});

// ─── Unconfigured verifier ─────────────────────────────────────────────

describe('POST /v1/auth/denylist/check — unconfigured', () => {
  it('503 DENYLIST_UNCONFIGURED when no argon2 verifier is wired', async () => {
    __resetArgon2VerifierForTest();
    const { status, body } = await postDenylistCheck({
      cellName: CELL_NAME,
      apiKey: CELL_KEY,
    });
    expect(status).toBe(503);
    expect(body.code).toBe('DENYLIST_UNCONFIGURED');
  });
});

// ─── Denylist query ────────────────────────────────────────────────────

describe('POST /v1/auth/denylist/check — denylist query', () => {
  it('200 { denied: false } on cache/DB miss', async () => {
    sqlState.denylistRows = [];
    const { status, body } = await postDenylistCheck({
      cellName: CELL_NAME,
      apiKey: CELL_KEY,
    });
    expect(status).toBe(200);
    expect(body).toEqual({ denied: false });
  });

  it('200 { denied: true, reason, ruleId } on match', async () => {
    sqlState.denylistRows = [
      { rule_id: 'rule-deadbeef', reason: 'key compromise' },
    ];
    const { status, body } = await postDenylistCheck({
      cellName: CELL_NAME,
      apiKey: CELL_KEY,
    });
    expect(status).toBe(200);
    expect(body).toEqual({
      denied: true,
      reason: 'key compromise',
      ruleId: 'rule-deadbeef',
    });
  });

  it('503 DENYLIST_UNAVAILABLE on Postgres outage at denylist query', async () => {
    sqlState.throwOnDenylist = true;
    const { status, body } = await postDenylistCheck({
      cellName: CELL_NAME,
      apiKey: CELL_KEY,
    });
    expect(status).toBe(503);
    expect(body.code).toBe('DENYLIST_UNAVAILABLE');
  });

  it('passes (kid, jti, sub) to the SQL query', async () => {
    sqlState.denylistRows = [];
    await postDenylistCheck({
      cellName: CELL_NAME,
      apiKey: CELL_KEY,
      body: { kid: 'svc-test', jti: 'jti-xyz', sub: 'mint-api' },
    });
    const denylistCall = sqlState.calls.find((c) =>
      c.template.includes('service_jwt_denylist'),
    );
    expect(denylistCall).toBeDefined();
    expect(denylistCall!.values).toEqual(['svc-test', 'jti-xyz', 'mint-api']);
  });
});

// ─── Request body validation ───────────────────────────────────────────

describe('POST /v1/auth/denylist/check — body schema', () => {
  it('400 when kid is missing', async () => {
    const { status } = await postDenylistCheck({
      cellName: CELL_NAME,
      apiKey: CELL_KEY,
      body: { jti: JTI, sub: SUB },
    });
    expect(status).toBe(400);
  });

  it('400 when jti is empty string', async () => {
    const { status } = await postDenylistCheck({
      cellName: CELL_NAME,
      apiKey: CELL_KEY,
      body: { kid: KID, jti: '', sub: SUB },
    });
    expect(status).toBe(400);
  });

  it('400 on unknown keys (strict body schema)', async () => {
    const { status } = await postDenylistCheck({
      cellName: CELL_NAME,
      apiKey: CELL_KEY,
      body: { kid: KID, jti: JTI, sub: SUB, extra: 'x' },
    });
    expect(status).toBe(400);
  });
});
