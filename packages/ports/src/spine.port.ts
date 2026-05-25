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

// ─── auth_nonces lifecycle (T1.4 · FR-A1) ──────────────────────────────────

/**
 * Signature scheme used to construct the challenge message. Mirrors the
 * `CHECK (scheme IN ('siwe','eip191'))` constraint on `auth_nonces.scheme`
 * (SDD §3.2).
 *
 *   - `siwe`   — EIP-4361 message; primary per FR-A1.
 *   - `eip191` — legacy `personal_sign` envelope; supported for the
 *                Sietch-compatible fallback path.
 */
export type SpineNonceScheme = "siwe" | "eip191"

/** Input shape for `mintNonce`. TTL defaults to 300s server-side. */
export interface MintNonceInput {
  /** Signature scheme the caller will use to sign the returned `message`. */
  readonly scheme: SpineNonceScheme
  /** The exact string the wallet will sign. Stored verbatim for replay-defense. */
  readonly message: string
  /** Optional wallet hint (NULLable until verify per SDD §3.2). */
  readonly walletAddress?: string | null
  /** Override server default (300s) only when test/operator requires it. */
  readonly ttlSec?: number
}

/** Mint result — the random nonce string + the absolute expiry. */
export interface MintNonceResult {
  /** Base64URL-encoded 32 bytes from a CSPRNG (43 chars, URL-safe). */
  readonly nonce: string
  /** Absolute expiry timestamp (ISO 8601, UTC). */
  readonly expires_at: string
}

/** Input shape for `consumeNonce`. */
export interface ConsumeNonceInput {
  /** Nonce string presented by the verifier. */
  readonly nonce: string
  /** Scheme the verifier claims it used to sign — MUST match the minted row. */
  readonly expectedScheme: SpineNonceScheme
}

/**
 * Outcome of `consumeNonce` — discriminated on `ok` so the auth flow can map
 * each rejection class to a precise 401 envelope (CHALLENGE_EXPIRED,
 * CHALLENGE_USED, etc.) per SDD §5.2 + §5.6.
 *
 *   - `unknown`         — no such nonce row (typo, replay against rotated DB)
 *   - `used`            — already consumed (single-use enforcement)
 *   - `expired`         — past `expires_at` (TTL fence)
 *   - `scheme_mismatch` — verifier's `expectedScheme` differs from the
 *                         minted row's scheme; refuse to verify under the
 *                         wrong recovery primitive.
 */
export type ConsumeNonceResult =
  | { readonly ok: true; readonly message: string; readonly wallet_address: string | null }
  | { readonly ok: false; readonly reason: "unknown" | "used" | "expired" | "scheme_mismatch" }

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

  // auth_nonces lifecycle (T1.4 · FR-A1) ----------------------------------
  // The nonce is part of the spine PG (same DB connection, same audit chain);
  // extending SpinePort keeps one port per bounded context and lets T1.6's
  // /v1/auth/challenge + /v1/auth/verify reuse the existing `getSpine()`
  // singleton wiring from `src/api/spine.ts`. See T1.4 build notes for the
  // alternative (a separate `NoncePort`) and why this layout was chosen.

  /**
   * Mint a fresh nonce row. Server generates a 32-byte CSPRNG nonce
   * (`crypto.randomBytes(32)` → base64url) and inserts it with the caller's
   * scheme + message + (optional) wallet hint + computed `expires_at`.
   *
   * Returns the nonce + absolute expiry. NEVER returns an already-used
   * nonce — collisions on the UNIQUE constraint surface as a write error
   * (which the engine layer can retry transparently; the 256-bit collision
   * probability is cryptographically negligible).
   */
  mintNonce(input: MintNonceInput): Promise<MintNonceResult>

  /**
   * Atomically consume a nonce.
   *
   * Implementation MUST use a single `UPDATE ... RETURNING` statement
   * conditioned on `used_at IS NULL` AND `expires_at > NOW()` AND `scheme = $`.
   * The atomic UPDATE-RETURNING pattern is non-negotiable: a read-then-write
   * implementation has a TOCTOU race where two concurrent verify calls for
   * the same nonce both pass the read check, both proceed to verify, and
   * both succeed — defeating single-use semantics (FR-A1 SDD §5.2 step 3).
   *
   * If the UPDATE-RETURNING returns 0 rows, a follow-up SELECT classifies
   * the rejection: `unknown` / `used` / `expired` / `scheme_mismatch` so the
   * route layer can map to the right 401 envelope.
   */
  consumeNonce(input: ConsumeNonceInput): Promise<ConsumeNonceResult>
}
