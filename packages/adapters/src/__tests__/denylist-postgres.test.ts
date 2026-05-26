/**
 * PostgresDenylistCheck tests — verify the CONJUNCTIVE null-as-wildcard
 * query shape + error propagation.
 *
 * These tests exercise the adapter against an injected `PgPoolLike` stub
 * (the canonical query is short and the only behavior worth testing is
 * the query SHAPE + error propagation contract). Real-Postgres
 * integration coverage is part of the migration-runner tests (see
 * `migrate.test.ts`).
 */

import { describe, expect, it } from 'bun:test';
import { PostgresDenylistCheck, type PgPoolLike } from '../denylist-postgres';

interface QueryCall {
  sql: string;
  params: unknown[];
}

class MockPool implements PgPoolLike {
  public calls: QueryCall[] = [];
  public nextResult: { rows: unknown[] } = { rows: [] };
  public nextError: Error | null = null;

  async query<T = unknown>(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: T[] }> {
    this.calls.push({ sql: text, params: params ?? [] });
    if (this.nextError) {
      throw this.nextError;
    }
    return this.nextResult as { rows: T[] };
  }
}

describe('PostgresDenylistCheck — canonical query shape', () => {
  it('issues SELECT with CONJUNCTIVE null-as-wildcard predicates', async () => {
    const pool = new MockPool();
    const denylist = new PostgresDenylistCheck(pool);
    await denylist.matches('svc-2026-05-26-a', 'jti-abc', 'activities-api');

    expect(pool.calls).toHaveLength(1);
    const call = pool.calls[0]!;
    // Verify the predicate shape (kid IS NULL OR kid = $1) AND ... AND ...
    expect(call.sql).toContain('kid IS NULL OR kid = $1');
    expect(call.sql).toContain('jti IS NULL OR jti = $2');
    expect(call.sql).toContain('sub IS NULL OR sub = $3');
    // Verify CONJUNCTIVE (AND, not OR).
    expect(call.sql).toMatch(/kid = \$1\)\s*AND/);
    expect(call.sql).toMatch(/jti = \$2\)\s*AND/);
    // Verify LIMIT 1.
    expect(call.sql).toMatch(/LIMIT 1/);
    expect(call.params).toEqual(['svc-2026-05-26-a', 'jti-abc', 'activities-api']);
  });

  it('returns { denied: false } when no rows match', async () => {
    const pool = new MockPool();
    pool.nextResult = { rows: [] };
    const denylist = new PostgresDenylistCheck(pool);
    const result = await denylist.matches('svc-k', 'jti', 'sub');
    expect(result).toEqual({ denied: false });
  });

  it('returns { denied: true, reason, ruleId } on match', async () => {
    const pool = new MockPool();
    pool.nextResult = {
      rows: [{ rule_id: 'rule-deadbeef', reason: 'key compromise' }],
    };
    const denylist = new PostgresDenylistCheck(pool);
    const result = await denylist.matches('svc-k', 'jti', 'sub');
    expect(result).toEqual({
      denied: true,
      reason: 'key compromise',
      ruleId: 'rule-deadbeef',
    });
  });

  it('propagates connection errors (fail-CLOSED contract per D-1.1 §6 + NF-Sec-1)', async () => {
    const pool = new MockPool();
    pool.nextError = new Error('Postgres connection refused');
    const denylist = new PostgresDenylistCheck(pool);
    await expect(denylist.matches('svc-k', 'jti', 'sub')).rejects.toThrow(
      'Postgres connection refused',
    );
  });
});

describe('PostgresDenylistCheck — null-as-wildcard CONJUNCTIVE semantics', () => {
  // These tests exercise the SQL semantics by verifying which params the
  // adapter sends + trusting Postgres's predicate evaluator. The CHECK
  // constraint on `service_jwt_denylist` (at-least-one of kid/jti/sub
  // is non-null per row) ensures the all-null rule cannot exist in the
  // DB; the adapter does not need to defend against it client-side.

  it('passes (kid, jti, sub) in order — match semantics rely on the WHERE clause', async () => {
    const pool = new MockPool();
    const denylist = new PostgresDenylistCheck(pool);
    await denylist.matches('svc-2026-05-26-a', 'jti-xyz', 'mint-api');
    expect(pool.calls[0]!.params).toEqual([
      'svc-2026-05-26-a',
      'jti-xyz',
      'mint-api',
    ]);
  });
});
