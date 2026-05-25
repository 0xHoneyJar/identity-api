/**
 * SpinePort — interface for the central identity-api SoR (T1.5).
 *
 * Per [[freeside-as-identity-spine]] + PRD v3.0 D1 (writer graduation):
 * identity-api OWNS the canonical 7-table spine landed in migrations 0001
 * + 0002 (users / wallet_links / linked_accounts / worlds / world_identity
 * + audit_events + auth_nonces). This port is the dependency-inverted
 * surface the engine reasons against; concrete impls live in
 * `@freeside-auth/adapters` (PostgresSpineAdapter).
 *
 * Per SDD §12.4: ports = interfaces; adapters = implementations. The
 * engine `resolve-spine.ts` orchestrators take a `SpinePort` (this
 * interface), NOT the concrete adapter class — keeps the dependency arrow
 * pointing the right way (adapters → engine, not engine → adapters).
 *
 * Differs from `TenantAdapter` (the cycle-B per-tenant read port):
 *   - TenantAdapter is polymorphic across tenant substrate shapes
 *     (split/unified/config/legacy) and read-only on `midi_profiles`-style
 *     external substrates.
 *   - SpinePort is mono-schema (the spine), bidirectional (reads + writes),
 *     and the WRITE authority for FR-R6.
 *
 * Conflict policy contract (D9 / cycle-c FR-L3): the write methods
 * `linkAccount` and `claimNym` throw a typed `SpineConflictError`
 * (re-exported from this package via adapters) on unique-constraint
 * violation; route handlers map that to a 409 envelope. The exact error
 * class lives with the impl to keep this port pure-interface.
 *
 * Source: PRD v3.0 §4.2, SDD §3.2 + §3.5 + §5.3, T1.3 build notes.
 */

// ─── shared types ──────────────────────────────────────────────────────────

/** Provider enum — mirrors the CHECK constraint on linked_accounts.provider. */
export type SpineLinkedAccountProvider = "discord" | "telegram" | "dynamic_user_id"

/** Single wallet_links row as the spine sees it. */
export interface SpineWallet {
  readonly wallet_address: string
  readonly chain_ids: readonly string[]
  readonly is_primary: boolean
  readonly verified_at: string
  readonly unlinked_at: string | null
}

/** Single linked_accounts row as the spine sees it. */
export interface SpineLinkedAccount {
  readonly provider: SpineLinkedAccountProvider
  readonly external_id: string
  readonly verified_at: string
  readonly unlinked_at: string | null
}

/** Single world_identity row as the spine sees it. */
export interface SpineWorldIdentity {
  readonly world_slug: string
  readonly nym: string
  readonly joined_at: string
}

/**
 * Composite identity (FR-R4 return shape) — a user + all their bindings.
 * Used by `getIdentity` and consumed by `getProfile` (T2.3) to seed the
 * read-time compose.
 */
export interface SpineIdentityShape {
  readonly user_id: string
  readonly primary_wallet: string | null
  readonly created_at: string
  readonly updated_at: string
  readonly wallets: readonly SpineWallet[]
  readonly linked_accounts: readonly SpineLinkedAccount[]
  readonly world_identities: readonly SpineWorldIdentity[]
}

/** Audit event input — JSONB payload is caller-structured. */
export interface SpineAuditEvent {
  readonly event_type: string
  readonly user_id?: string | null
  readonly actor?: string | null
  readonly payload: Record<string, unknown>
}

// ─── the port ──────────────────────────────────────────────────────────────

/**
 * The central spine SoR port. Adapter impl: PostgresSpineAdapter
 * (@freeside-auth/adapters, T1.5).
 *
 * All methods are async and connection-pool-backed. Engine consumers
 * (resolve-spine.ts) compose these into the orchestrators route handlers
 * actually call.
 */
export interface SpinePort {
  // reads (FR-R1..R4)
  resolveByWallet(address: string): Promise<string | null>
  resolveByAccount(
    provider: SpineLinkedAccountProvider,
    externalId: string,
  ): Promise<string | null>
  resolveByNym(worldSlug: string, nym: string): Promise<string | null>
  getIdentity(userId: string): Promise<SpineIdentityShape | null>

  // writes (FR-R6)
  mintUser(): Promise<string>
  linkWallet(opts: {
    userId: string
    walletAddress: string
    chainIds?: readonly string[]
    isPrimary?: boolean
  }): Promise<void>
  linkAccount(opts: {
    userId: string
    provider: SpineLinkedAccountProvider
    externalId: string
  }): Promise<void>
  claimNym(opts: {
    userId: string
    worldSlug: string
    nym: string
  }): Promise<void>

  // primary swap (FR-R5)
  setPrimary(opts: { userId: string; walletAddress: string }): Promise<boolean>

  // audit (NFR-5)
  writeAuditEvent(event: SpineAuditEvent): Promise<void>
}
