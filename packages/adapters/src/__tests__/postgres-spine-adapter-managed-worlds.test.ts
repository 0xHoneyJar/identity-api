/**
 * postgres-spine-adapter-managed-worlds.test.ts — C-2 getManagedWorlds
 * SQL-shape + row-mapping unit tests (bead arrakis-491i).
 *
 * Strategy: a mock `SpineSqlLike` (the adapter's documented test seam) so
 * these tests run WITHOUT a Postgres scratch DB — they assert the query
 * shape (table + WHERE + ORDER BY) and the row → SpineManagedWorld mapping.
 * The DB-backed behavioral tests (FK CASCADE, real ordering, isolation) live
 * in postgres-spine-adapter.test.ts behind the TEST_DATABASE_URL gate.
 *
 * Mirrors the mock-pool pattern used by postgres-split-adapter.test.ts; here
 * we model `Bun.SQL`'s tagged-template shape via SpineSqlLike instead of the
 * `PgPoolLike.query(text, params)` shape (the spine adapter is Bun.SQL-native).
 */

import { describe, expect, it } from "bun:test"
import { PostgresSpineAdapter, type SpineSqlLike } from "../postgres-spine-adapter"

interface CapturedCall {
  readonly text: string
  readonly values: readonly unknown[]
}

/**
 * Minimal `SpineSqlLike` mock. Captures the assembled SQL text (template
 * strings joined) + the interpolated values, and returns a canned row set.
 * Only the tagged-template call path is exercised by getManagedWorlds; the
 * other members throw if touched (they should not be).
 */
function buildMockSql(rows: unknown[]): { sql: SpineSqlLike; calls: CapturedCall[] } {
  const calls: CapturedCall[] = []
  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ text: strings.join("?"), values })
    return Promise.resolve(rows)
    // biome-ignore lint/suspicious/noExplicitAny: model Bun.SQL's heterogenous tag-fn surface
  }) as any
  sql.unsafe = () => {
    throw new Error("mock: unsafe() not expected in getManagedWorlds")
  }
  sql.close = () => Promise.resolve()
  sql.begin = () => {
    throw new Error("mock: begin() not expected in getManagedWorlds")
  }
  return { sql: sql as SpineSqlLike, calls }
}

describe("PostgresSpineAdapter.getManagedWorlds (C-2 · mock SQL)", () => {
  it("queries world_managers by user_id, ORDER BY granted_at ASC", async () => {
    const { sql, calls } = buildMockSql([])
    const adapter = new PostgresSpineAdapter(sql)
    const userId = "11111111-2222-4333-8444-555555555555"

    await adapter.getManagedWorlds(userId)

    expect(calls).toHaveLength(1)
    const text = calls[0]!.text
    expect(text).toContain("FROM world_managers")
    expect(text).toContain("WHERE user_id =")
    expect(text).toContain("ORDER BY granted_at ASC")
    // user_id is the single interpolated value.
    expect(calls[0]!.values).toEqual([userId])
  })

  it("maps rows → { world_slug, granted_at } and drops granted_by", async () => {
    const { sql } = buildMockSql([
      { world_slug: "thj", granted_at: "2026-01-01T00:00:00.000Z", granted_by: "op-1" },
      { world_slug: "mibera", granted_at: "2026-02-01T00:00:00.000Z", granted_by: null },
    ])
    const adapter = new PostgresSpineAdapter(sql)

    const got = await adapter.getManagedWorlds("11111111-2222-4333-8444-555555555555")

    expect(got).toEqual([
      { world_slug: "thj", granted_at: "2026-01-01T00:00:00.000Z" },
      { world_slug: "mibera", granted_at: "2026-02-01T00:00:00.000Z" },
    ])
    // granted_by is NOT surfaced on the read shape, even if the row carried it.
    expect(got[0]!).not.toHaveProperty("granted_by")
  })

  it("returns [] for a user with no management edges", async () => {
    const { sql } = buildMockSql([])
    const adapter = new PostgresSpineAdapter(sql)
    const got = await adapter.getManagedWorlds("11111111-2222-4333-8444-555555555555")
    expect(got).toEqual([])
  })
})
