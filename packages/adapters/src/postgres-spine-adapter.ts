/**
 * PostgresSpineAdapter — the SoR write surface for the identity-api spine.
 *
 * T1.5 (bead arrakis-232n). Implements the write authority FR-R6 promised
 * the operator at D1 ("identity-api OWNS the canonical spine: mint user,
 * write wallet[], link credentials"). All reads + writes target the 7-table
 * spine landed in migration 0001 + the BEFORE-trigger landed in 0002.
 *
 * Why a NEW adapter (instead of extending PostgresSplitAdapter):
 *   - PostgresSplitAdapter is the cycle-B per-tenant READ adapter that
 *     implements the polymorphic `TenantAdapter` port over `midi_profiles`.
 *     Its surface is `resolveCredential` / `fetchClaims` / `ping`; it has
 *     no concept of "the spine" and is parameterized by `TenantConfig`.
 *   - This adapter implements ONE schema (the spine), exposes spine-specific
 *     writes (mintUser, linkWallet, linkAccount, claimNym, setPrimary), and
 *     uses `Bun.SQL` (matches the migration runner, source-distribution
 *     discipline — zero extra deps).
 *   - Mixing them would (a) bloat the cycle-B per-tenant adapter with
 *     unrelated write semantics, and (b) tightly couple two evolution paths
 *     that have nothing to do with each other (per-tenant read shapes vs
 *     central SoR mutation contract).
 *
 * Concurrency posture: a single `Bun.SQL` instance is reused across all
 * adapter method calls. `Bun.SQL` pools connections internally (per Bun
 * docs), so this is the single-pool service-grade discipline NFR-3 implies.
 * Tests can inject a separately-constructed `SQL` (or a mock-friendly
 * subset via the `SpineSqlLike` interface) for isolation.
 *
 * Error policy (per PRD §3 D9 + SDD §8.2):
 *   - Resolve methods return `null` on not-found; never throw on the
 *     not-found path.
 *   - Write methods throw `SpineConflictError` on unique-constraint
 *     violations (linkAccount on duplicate (provider, external_id);
 *     claimNym on duplicate (world_slug, nym)). The route handler maps
 *     these to 409 `cross_user_collision` (or the world-identity analog).
 *   - All other PG errors surface as-is for the framework's 500 path.
 *
 * Source: PRD v3.0 §4.2, SDD §3.2 (DDL — note BEFORE-amended) + §3.5
 * (data access patterns) + §5.3 (endpoint detail) + §8.2 (conflict policy).
 */

import { SQL } from "bun"
import type {
  SpinePort,
  SpineLinkedAccountProvider,
  SpineIdentityShape,
  SpineAuditEvent,
} from "@freeside-auth/ports"

// Re-export the port types under the adapter package for ergonomic
// consumption — callers that import the adapter often want the shapes too.
export type {
  SpinePort,
  SpineLinkedAccountProvider,
  SpineWallet,
  SpineLinkedAccount,
  SpineWorldIdentity,
  SpineIdentityShape,
  SpineAuditEvent,
} from "@freeside-auth/ports"

// Legacy aliases retained for ergonomic local naming inside the adapter
// implementation (and for any T1.5+ callers that imported these names from
// an earlier draft of the adapter — kept as type-only aliases).
export type LinkedAccountProvider = SpineLinkedAccountProvider
export type SpineIdentity = SpineIdentityShape
export type SpineAuditEventInput = SpineAuditEvent

// ─── errors ─────────────────────────────────────────────────────────────────

/**
 * Conflict error raised when a write hits a UNIQUE constraint that
 * indicates the resource is already bound to a different owner.
 *
 * Per PRD §3 D9 + cycle-c FR-L3 (latest-wins single-axis; hard-fail on
 * `cross_user_collision`): the route handler maps this to a 409 response
 * with the structured error envelope.
 *
 * `kind` distinguishes the two write paths so the route layer can pick the
 * right error code:
 *   - "linked_account" → linkAccount duplicate (provider, external_id) →
 *     route returns 409 cross_user_collision.
 *   - "world_identity" → claimNym duplicate (world_slug, nym) → route
 *     returns 409 nym_taken (a world-local conflict, NOT cross-user).
 */
export type SpineConflictKind = "linked_account" | "world_identity"

export class SpineConflictError extends Error {
  constructor(
    message: string,
    public readonly kind: SpineConflictKind,
    public readonly context?: Record<string, unknown>,
  ) {
    super(`[spine-conflict:${kind}] ${message}`)
    this.name = "SpineConflictError"
  }
}

// ─── connection shape ───────────────────────────────────────────────────────

/**
 * Subset of `Bun.SQL` this adapter uses. Stating it explicitly (instead of
 * importing `SQL` as the parameter type everywhere) keeps the test seam
 * minimal — a mock can implement just these three method signatures.
 *
 * Note: `Bun.SQL` is callable as a tag function (`sql` template literal)
 * AND has an `.unsafe()` method. We model both.
 */
export interface SpineSqlLike {
  // biome-ignore lint/suspicious/noExplicitAny: Bun.SQL is a tag function over a heterogenous template
  (strings: TemplateStringsArray, ...values: unknown[]): Promise<any>
  unsafe(query: string): Promise<unknown>
  close(): Promise<void>
}

// ─── adapter ────────────────────────────────────────────────────────────────

/**
 * The spine SoR adapter. Construct ONCE per process (the underlying
 * `Bun.SQL` pools connections); pass into the engine resolvers + route
 * handlers as a shared singleton.
 */
export class PostgresSpineAdapter implements SpinePort {
  readonly sql: SpineSqlLike

  /**
   * @param connectionStringOrSql Either a Postgres connection string (we
   * construct the `Bun.SQL` instance) or a pre-built `SpineSqlLike` (for
   * test injection or single-process sharing).
   */
  constructor(connectionStringOrSql: string | SpineSqlLike) {
    if (typeof connectionStringOrSql === "string") {
      this.sql = new SQL(connectionStringOrSql) as unknown as SpineSqlLike
    } else {
      this.sql = connectionStringOrSql
    }
  }

  /** Close the underlying connection pool. Call on graceful shutdown. */
  async close(): Promise<void> {
    await this.sql.close()
  }

  // ── reads (FR-R1..R4) ─────────────────────────────────────────────────────

  /**
   * FR-R1: resolveByWallet — return `user_id` for an active wallet link.
   *
   * The active partial-unique index `uq_wallet_links_active_address`
   * guarantees at most one active row per wallet. Soft-unlinked rows
   * (`unlinked_at IS NOT NULL`) are excluded.
   */
  async resolveByWallet(address: string): Promise<string | null> {
    const sql = this.sql
    const rows = (await sql`
      SELECT user_id FROM wallet_links
       WHERE wallet_address = ${address}
         AND unlinked_at IS NULL
       LIMIT 1
    `) as Array<{ user_id: string }>
    return rows[0]?.user_id ?? null
  }

  /**
   * FR-R2: resolveByAccount — return `user_id` for a (provider, external_id)
   * tuple. The composite is the PK on `linked_accounts` so this is a
   * covering index lookup.
   *
   * Note: we DO NOT filter by `unlinked_at IS NULL` here because the
   * (provider, external_id) PK is unique across all rows, active or not.
   * A soft-unlinked account still resolves to its prior user_id — callers
   * who need active-only must read the row + check unlinked_at.
   *
   * v1: soft-unlink is wired in the table but not yet exposed by any
   * write path; revisit if/when an account-unlink endpoint lands.
   */
  async resolveByAccount(
    provider: SpineLinkedAccountProvider,
    externalId: string,
  ): Promise<string | null> {
    const sql = this.sql
    const rows = (await sql`
      SELECT user_id FROM linked_accounts
       WHERE provider = ${provider}
         AND external_id = ${externalId}
       LIMIT 1
    `) as Array<{ user_id: string }>
    return rows[0]?.user_id ?? null
  }

  /**
   * FR-R3: resolveByNym — return `user_id` for a (world_slug, nym).
   *
   * The `UNIQUE(world_slug, nym)` constraint on `world_identity` guarantees
   * one row per (world, nym). Nyms are world-scoped — the same nym can
   * exist in different worlds.
   */
  async resolveByNym(worldSlug: string, nym: string): Promise<string | null> {
    const sql = this.sql
    const rows = (await sql`
      SELECT user_id FROM world_identity
       WHERE world_slug = ${worldSlug}
         AND nym = ${nym}
       LIMIT 1
    `) as Array<{ user_id: string }>
    return rows[0]?.user_id ?? null
  }

  /**
   * FR-R4: getIdentity — return the full composite Identity for a user.
   *
   * Implementation: four targeted queries (users + wallets + accounts +
   * world_identities) over the indexed FKs. We deliberately do NOT do this
   * as one mega-JOIN-with-arrays because:
   *   - PG's array_agg + jsonb_agg over multiple LEFT JOINs duplicates rows
   *     by Cartesian product (wallets × accounts × worlds) before grouping;
   *     for typical user shapes this is fine, but a heavy user (10 wallets +
   *     20 accounts + 5 worlds = 1000 row product) is gratuitous.
   *   - Four small indexed lookups is < 100ms p95 trivially (NFR-1).
   *   - Readability beats single-round-trip cleverness here.
   *
   * Returns `null` if the user_id isn't in the users table.
   */
  async getIdentity(userId: string): Promise<SpineIdentityShape | null> {
    const sql = this.sql
    const userRows = (await sql`
      SELECT user_id, primary_wallet, created_at, updated_at
        FROM users WHERE user_id = ${userId}
    `) as Array<{
      user_id: string
      primary_wallet: string | null
      created_at: string
      updated_at: string
    }>
    const user = userRows[0]
    if (!user) return null

    const walletRows = (await sql`
      SELECT wallet_address, chain_ids, is_primary, verified_at, unlinked_at
        FROM wallet_links
       WHERE user_id = ${userId}
       ORDER BY is_primary DESC, verified_at ASC
    `) as Array<{
      wallet_address: string
      chain_ids: string[] | null
      is_primary: boolean
      verified_at: string
      unlinked_at: string | null
    }>

    const accountRows = (await sql`
      SELECT provider, external_id, verified_at, unlinked_at
        FROM linked_accounts
       WHERE user_id = ${userId}
       ORDER BY verified_at ASC
    `) as Array<{
      provider: SpineLinkedAccountProvider
      external_id: string
      verified_at: string
      unlinked_at: string | null
    }>

    const worldRows = (await sql`
      SELECT world_slug, nym, joined_at
        FROM world_identity
       WHERE user_id = ${userId}
       ORDER BY joined_at ASC
    `) as Array<{ world_slug: string; nym: string; joined_at: string }>

    return {
      user_id: user.user_id,
      primary_wallet: user.primary_wallet,
      created_at: user.created_at,
      updated_at: user.updated_at,
      wallets: walletRows.map((w) => ({
        wallet_address: w.wallet_address,
        chain_ids: w.chain_ids ?? [],
        is_primary: w.is_primary,
        verified_at: w.verified_at,
        unlinked_at: w.unlinked_at,
      })),
      linked_accounts: accountRows.map((a) => ({
        provider: a.provider,
        external_id: a.external_id,
        verified_at: a.verified_at,
        unlinked_at: a.unlinked_at,
      })),
      world_identities: worldRows.map((wi) => ({
        world_slug: wi.world_slug,
        nym: wi.nym,
        joined_at: wi.joined_at,
      })),
    }
  }

  // ── writes (FR-R6) ────────────────────────────────────────────────────────

  /**
   * FR-R6 mint: create a new user_id. `users` has all defaults, so
   * `INSERT ... DEFAULT VALUES RETURNING user_id` is the minimal write.
   *
   * Caller typically follows with `linkWallet(... isPrimary=true)` to bind
   * the user to a wallet. The two writes are not transactionalized here
   * because the route handler / auth-verify orchestrator owns the
   * surrounding txn — adapter mints are reentrant building blocks.
   */
  async mintUser(): Promise<string> {
    const sql = this.sql
    const rows = (await sql`
      INSERT INTO users DEFAULT VALUES RETURNING user_id
    `) as Array<{ user_id: string }>
    const id = rows[0]?.user_id
    if (!id) {
      throw new Error("PostgresSpineAdapter.mintUser: INSERT returned no row")
    }
    return id
  }

  /**
   * FR-R6 link wallet: bind a wallet to a user, optionally promoting it
   * to primary. Per T1.3 BEFORE-trigger amendment, a single `isPrimary=TRUE`
   * INSERT is atomic — the trigger demotes any prior primary first, so the
   * partial-unique `uq_wallet_links_one_primary_per_user` sees a consistent
   * state and is satisfied. No caller-side two-step demote is required.
   *
   * Conflict: an active link to a DIFFERENT user for the same wallet hits
   * `uq_wallet_links_active_address` and raises a PG uniqueness violation.
   * That class of conflict is rare (it means a wallet is already bound
   * elsewhere); we surface as the underlying PG error rather than a typed
   * `SpineConflictError` because the caller (link-verified-wallet at T4.1)
   * needs to inspect WHO claims the wallet to apply D9 latest-wins policy
   * server-side — that decision belongs in the route layer, not here.
   *
   * Re-linking the same (wallet, user) pair: also raises the active-address
   * uniqueness violation. The caller should resolveByWallet first; if the
   * existing user_id matches, treat as no-op (NFR-7 idempotency). If it
   * differs, apply D9.
   */
  async linkWallet(opts: {
    userId: string
    walletAddress: string
    chainIds?: readonly string[]
    isPrimary?: boolean
  }): Promise<void> {
    const sql = this.sql
    const chainIds = (opts.chainIds ?? []) as string[]
    const isPrimary = opts.isPrimary ?? false
    // Bun.SQL cannot infer an empty JS array's PG column type from context
    // (it binds as a literal '' which PG rejects with `22P02 array value
    // must start with "{"`). Build the PG array literal string explicitly
    // and cast at the parameter site. The trigger 0002 verifies behavior
    // works correctly with `chain_ids DEFAULT '{}'`, which is the same
    // wire-shape we're feeding here.
    const chainIdsLiteral = `{${chainIds
      .map((id) => `"${id.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`)
      .join(",")}}`
    await sql`
      INSERT INTO wallet_links (wallet_address, user_id, chain_ids, is_primary)
      VALUES (${opts.walletAddress}, ${opts.userId}, ${chainIdsLiteral}::text[], ${isPrimary})
    `
  }

  /**
   * FR-R6 link account: bind an off-chain provider account to a user.
   *
   * `(provider, external_id)` is the PK — duplicates RAISE. The PG error
   * class for a unique violation on this index is `23505`; we trap that
   * and raise a typed `SpineConflictError(kind='linked_account')` so the
   * route handler at /v1/link/verified-wallet returns 409 with the
   * `cross_user_collision` envelope (per D9 / cycle-c FR-L3).
   *
   * Provider value MUST be one of `discord|telegram|dynamic_user_id`
   * (enforced by the CHECK constraint in 0001).
   */
  async linkAccount(opts: {
    userId: string
    provider: SpineLinkedAccountProvider
    externalId: string
  }): Promise<void> {
    const sql = this.sql
    try {
      await sql`
        INSERT INTO linked_accounts (user_id, provider, external_id)
        VALUES (${opts.userId}, ${opts.provider}, ${opts.externalId})
      `
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new SpineConflictError(
          `(${opts.provider}, ${opts.externalId}) is already linked to another user`,
          "linked_account",
          {
            provider: opts.provider,
            external_id: opts.externalId,
            attempted_user_id: opts.userId,
          },
        )
      }
      throw err
    }
  }

  /**
   * FR-R6 claim nym: bind a per-world nym to a user. World-local; the same
   * nym can exist in different worlds.
   *
   * Two constraints on `world_identity`:
   *   - PK `(user_id, world_slug)` — a user has at most one nym per world.
   *   - UNIQUE `(world_slug, nym)` — a nym is unique within a world (FR-R3).
   *
   * BOTH classes of violation map to `kind='world_identity'`. The route
   * layer can disambiguate via the underlying SpineConflictError.context.
   * In v1 we don't distinguish at the type level because both are 409 on
   * the same endpoint and both render the same "nym already claimed in
   * this world" UX message.
   */
  async claimNym(opts: {
    userId: string
    worldSlug: string
    nym: string
  }): Promise<void> {
    const sql = this.sql
    try {
      await sql`
        INSERT INTO world_identity (user_id, world_slug, nym)
        VALUES (${opts.userId}, ${opts.worldSlug}, ${opts.nym})
      `
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new SpineConflictError(
          `(${opts.worldSlug}, ${opts.nym}) is already claimed`,
          "world_identity",
          {
            world_slug: opts.worldSlug,
            nym: opts.nym,
            attempted_user_id: opts.userId,
          },
        )
      }
      throw err
    }
  }

  /**
   * FR-R5: promote a wallet to primary in ONE statement.
   *
   * Per T1.3 BEFORE-trigger amendment, this single UPDATE is atomic:
   *   1. Trigger fires BEFORE the partial-unique check on the new tuple.
   *   2. Trigger's demote pass clears any prior primary for the same user.
   *   3. Trigger's mirror updates users.primary_wallet (+ updated_at).
   *   4. Partial-unique check on the new tuple sees a consistent state.
   *
   * Returns true if a row was updated (wallet was found + bound to user),
   * false if no rows matched (caller didn't link the wallet yet, or the
   * link is soft-unlinked).
   *
   * Re-promoting an already-primary row is a no-op for the partial-unique
   * (self-exclusion clause in the trigger) and a one-row idempotent
   * UPDATE to users.primary_wallet. Test 7 in primary_wallet_trigger.test
   * covers the self-reset path.
   */
  async setPrimary(opts: {
    userId: string
    walletAddress: string
  }): Promise<boolean> {
    const sql = this.sql
    // Bun.SQL returns the result array with metadata; we read affectedRows
    // off the array's `count` property (Bun docs) — failing that, fall back
    // to "did the row exist & become primary" via a follow-up SELECT.
    // We use the SELECT-after pattern because Bun.SQL's affected-rows
    // surface varies by version and the SELECT is cheap (indexed).
    await sql`
      UPDATE wallet_links
         SET is_primary = TRUE
       WHERE wallet_address = ${opts.walletAddress}
         AND user_id = ${opts.userId}
         AND unlinked_at IS NULL
    `
    const check = (await sql`
      SELECT is_primary FROM wallet_links
       WHERE wallet_address = ${opts.walletAddress}
         AND user_id = ${opts.userId}
         AND unlinked_at IS NULL
    `) as Array<{ is_primary: boolean }>
    return check[0]?.is_primary === true
  }

  // ── audit (NFR-5) ─────────────────────────────────────────────────────────

  /**
   * Append-only audit event write. Per SDD §3.2: append-only is enforced
   * by code discipline (no UPDATE/DELETE routes); we do NOT add a PG RULE
   * so backfill restoration can legitimately rewrite rows.
   *
   * The `payload` JSONB is opaque to the adapter — callers structure it
   * per event type. Common payload keys:
   *   - wallet_linked: { wallet_address, chain_ids, is_primary }
   *   - account_linked: { provider, external_id }
   *   - primary_changed: { from_wallet, to_wallet }
   *   - conflict_rejected: { conflict_kind, attempted_user_id, claimed_by }
   *
   * `actor` defaults to 'system' when unset — T1.5 callers without session
   * context (e.g., a backfill-style write) get this default. T1.6 auth will
   * populate it with the session subject; T4.1 link-verified-wallet uses
   * 'sietch-redirect'.
   */
  async writeAuditEvent(input: SpineAuditEvent): Promise<void> {
    const sql = this.sql
    const actor = input.actor ?? "system"
    const userId = input.user_id ?? null
    // Bun.SQL serializes JS objects to JSONB natively when bound to a
    // JSONB column — pass the object directly. Using
    // `${JSON.stringify(payload)}::jsonb` would store the SERIALIZED
    // STRING as a JSONB string-value (not an object), so `payload->>'key'`
    // returns null and `payload.key` is undefined on read. Verified
    // empirically against postgres:18.1 + Bun.SQL 1.3.x.
    await sql`
      INSERT INTO audit_events (event_type, user_id, actor, payload)
      VALUES (${input.event_type}, ${userId}, ${actor}, ${input.payload})
    `
  }
}

// ─── helpers ────────────────────────────────────────────────────────────────

/**
 * PG unique-violation detection.
 *
 * Bun.SQL surfaces PG errors as objects with `code` and/or `errno`
 * matching PG's SQLSTATE. `23505` is `unique_violation` per PG docs.
 * Some clients also stamp the constraint name on `.constraint_name` or
 * `.detail`; we accept either path for the SQLSTATE check.
 */
function isUniqueViolation(err: unknown): boolean {
  if (err === null || typeof err !== "object") return false
  const e = err as { code?: unknown; errno?: unknown; message?: unknown }
  if (e.code === "23505") return true
  if (e.errno === "23505") return true
  // Fallback: the message contains the duplicate-key signature. Bun.SQL on
  // some PG versions reports the full PG error text rather than the SQLSTATE
  // on the .code property; the string match guards that path.
  if (typeof e.message === "string" && e.message.includes("duplicate key value violates unique constraint")) {
    return true
  }
  return false
}
