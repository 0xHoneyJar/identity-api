/**
 * PostgresDenylistCheck — direct-DB `DenylistCheck` impl for the W2.5
 * svc-JWT verifier (D-1.1 §6).
 *
 * Used by identity-api itself (which has direct PG access) and by cells
 * that opt into direct-DB lookup (rare; most cells go through the
 * HTTP indirection at `POST /v1/auth/denylist/check`).
 *
 * Match semantics — null-as-wildcard CONJUNCTIVE (per migration 0006
 * `service_jwt_denylist` SDD §4.3a clarification; BB-002 inline comment):
 *
 *   A JWT (kid_j, jti_j, sub_j) is denied by a rule (kid_r, jti_r, sub_r)
 *   iff EVERY non-null field of the rule matches the JWT's corresponding
 *   field. A null rule field is a wildcard ("matches anything").
 *
 *   Canonical SQL:
 *     SELECT rule_id, reason FROM service_jwt_denylist
 *     WHERE (kid IS NULL OR kid = $1)
 *       AND (jti IS NULL OR jti = $2)
 *       AND (sub IS NULL OR sub = $3)
 *     LIMIT 1;
 *
 *   The DB-side CHECK constraint forbids the all-null rule (which would
 *   deny every JWT); at least one of (kid, jti, sub) MUST be non-null
 *   per row.
 *
 * Fail-CLOSED contract: connection errors propagate as thrown exceptions.
 * The verifier translates these to `DENYLIST_UNAVAILABLE` 503 per NF-Sec-1.
 * This adapter does NOT swallow errors — that's the verifier's policy
 * layer, not the adapter's.
 *
 * Source-of-truth: `grimoires/svc-jwt-spec.md` §6; migration
 * `0006_svc_jwt_denylist.up.sql`.
 */

import type { DenylistCheck } from './svc-jwt-verifier';
import type { PgPoolLike } from './postgres-split-adapter';

// Re-export PgPoolLike so callers importing this module get the shape they need.
export type { PgPoolLike } from './postgres-split-adapter';

interface DenylistRow {
  rule_id: string;
  reason: string;
}

const DENYLIST_QUERY = `
  SELECT rule_id, reason
  FROM service_jwt_denylist
  WHERE (kid IS NULL OR kid = $1)
    AND (jti IS NULL OR jti = $2)
    AND (sub IS NULL OR sub = $3)
  LIMIT 1
`;

/**
 * Direct-Postgres denylist adapter (pg-pool-shaped). Wraps a pg pool
 * with the canonical any-match CONJUNCTIVE query.
 *
 * @example
 *   const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
 *   const denylistCheck = new PostgresDenylistCheck(pool);
 *   const result = await denylistCheck.matches(kid, jti, sub);
 */
export class PostgresDenylistCheck implements DenylistCheck {
  constructor(private readonly pool: PgPoolLike) {}

  async matches(
    kid: string,
    jti: string,
    sub: string,
  ): Promise<
    | { denied: true; reason: string; ruleId: string }
    | { denied: false }
  > {
    // Propagate connection errors. The verifier wraps this in a try/catch
    // and emits DENYLIST_UNAVAILABLE — but the adapter MUST NOT mask the
    // failure (fail-CLOSED contract per D-1.1 §6 + NF-Sec-1).
    const result = await this.pool.query<DenylistRow>(DENYLIST_QUERY, [kid, jti, sub]);
    if (result.rows.length === 0) {
      return { denied: false };
    }
    const row = result.rows[0]!;
    return {
      denied: true,
      reason: row.reason,
      ruleId: row.rule_id,
    };
  }
}

/**
 * Bun.SQL-shaped interface — matches the project-wide convention used by
 * `PostgresSpineAdapter` (`packages/adapters/src/postgres-spine-adapter.ts`).
 * The denylist endpoint at `src/api/routes/v1/auth/denylist/check.ts`
 * uses this variant because identity-api is built on Bun.SQL.
 */
export interface BunSqlLike {
  // biome-ignore lint/suspicious/noExplicitAny: Bun.SQL is a tag function over heterogeneous template values.
  (strings: TemplateStringsArray, ...values: unknown[]): Promise<any>;
}

/**
 * Bun.SQL-backed denylist adapter. Identical query semantics as
 * `PostgresDenylistCheck`; differs only in driver shape.
 *
 * @example
 *   import { SQL } from "bun"
 *   const sql = new SQL(process.env.DATABASE_URL!) as unknown as BunSqlLike
 *   const denylistCheck = new BunSqlDenylistCheck(sql)
 */
export class BunSqlDenylistCheck implements DenylistCheck {
  constructor(private readonly sql: BunSqlLike) {}

  async matches(
    kid: string,
    jti: string,
    sub: string,
  ): Promise<
    | { denied: true; reason: string; ruleId: string }
    | { denied: false }
  > {
    // Bun.SQL's tagged template embeds parameters as positional placeholders
    // internally; the CONJUNCTIVE null-as-wildcard predicate shape matches
    // the migration-0006 commentary in `migrations-spec.md` D-1.5 §2 +
    // `0006_svc_jwt_denylist.up.sql`.
    const rows = (await this.sql`
      SELECT rule_id, reason
      FROM service_jwt_denylist
      WHERE (kid IS NULL OR kid = ${kid})
        AND (jti IS NULL OR jti = ${jti})
        AND (sub IS NULL OR sub = ${sub})
      LIMIT 1
    `) as DenylistRow[];

    if (!Array.isArray(rows) || rows.length === 0) {
      return { denied: false };
    }
    const row = rows[0]!;
    return {
      denied: true,
      reason: row.reason,
      ruleId: row.rule_id,
    };
  }
}
