/**
 * resolve-spine.ts — engine-layer wallet-first resolvers + write orchestrators.
 *
 * T1.5 (bead arrakis-232n). This file is the L3 engine seam between route
 * handlers and the spine adapter. It provides:
 *   - thin pure-function wrappers around the port's read methods so the
 *     route layer can compose without importing the adapter directly
 *   - the `linkAccountWithAudit` + `linkWalletWithAudit` + `setPrimaryWithAudit`
 *     orchestrators that pair the spine write with the NFR-5 audit emit
 *   - the `resolveOrMintByWallet` helper that the T1.6 auth flow will
 *     consume (resolve-or-create on /v1/auth/verify), exposed here as a
 *     reusable building block instead of duplicated in route handler
 *
 * Dependency direction: engine depends on `@freeside-auth/ports` (the
 * SpinePort interface), NOT on `@freeside-auth/adapters` (the concrete
 * PostgresSpineAdapter). This keeps the arrow pointing the right way per
 * SDD §12.4 (ports = interfaces; adapters = implementations; engine
 * reasons through ports).
 *
 * Why an engine layer (vs direct adapter calls from routes):
 *   - PRD §4.2: "the existing 4-tier `resolve-tier` keeps its structure;
 *     Tier-4 (direct wallet) becomes primary, Tier-1 (dynamic_user_id)
 *     becomes backfill." That tier algorithm DOES NOT yet exist in the
 *     cycle-B foundation (no `resolve-tier.ts`); this file establishes the
 *     surface where the future tier algorithm composes. Today it's
 *     wallet-first single-tier; tomorrow `resolveByWallet` becomes the
 *     Tier-4 entry of a fallback chain. The route layer doesn't change.
 *   - SDD §1.4 "Resolve core" is described as engine-owned; the adapter is
 *     L4 boundary (I/O) and the engine is the L3 logic.
 *
 * Audit policy: every write that mutates user→credential bindings emits an
 * `audit_events` row. The `actor` parameter defaults to "system" — T1.6
 * auth will pass session subject; T4.1 will pass "sietch-redirect"; T1.5's
 * caller-without-context flows accept the default.
 *
 * Source: PRD v3.0 §4.2 (FR-R1..R6), SDD §1.4 + §3.2 (audit_events table) +
 * §5.3 (endpoint detail), T1.3 build notes (single-statement promote).
 */

import type {
  SpinePort,
  SpineLinkedAccountProvider,
  SpineIdentityShape,
} from "@freeside-auth/ports"

// ─── reads (FR-R1..R4) ─────────────────────────────────────────────────────

/** FR-R1: resolve a wallet address to a user_id. */
export async function resolveByWallet(
  spine: SpinePort,
  address: string,
): Promise<string | null> {
  return spine.resolveByWallet(normalizeAddress(address))
}

/** FR-R2: resolve a (provider, externalId) tuple to a user_id. */
export async function resolveByAccount(
  spine: SpinePort,
  provider: SpineLinkedAccountProvider,
  externalId: string,
): Promise<string | null> {
  return spine.resolveByAccount(provider, externalId)
}

/** FR-R3: resolve a per-world nym to a user_id. */
export async function resolveByNym(
  spine: SpinePort,
  worldSlug: string,
  nym: string,
): Promise<string | null> {
  return spine.resolveByNym(worldSlug, nym)
}

/**
 * FR-R4: get the full Identity for a user_id.
 *
 * Returns `null` if the user_id is not in the users table. Consumers
 * should treat that as the 404 path — there is no "anonymous user"
 * fallback at the spine layer (cycle-c's anon ResolveResult shape lives
 * one layer up in the bot UX, not in identity-api).
 */
export async function getIdentity(
  spine: SpinePort,
  userId: string,
): Promise<SpineIdentityShape | null> {
  return spine.getIdentity(userId)
}

// ─── writes with audit (FR-R6 + NFR-5) ─────────────────────────────────────

/**
 * Audit actor enum — keep this narrow so the audit log has a consistent
 * vocabulary. Routes pick one based on their auth path:
 *   - "system"          — T1.5 transitional default (no session context yet)
 *   - "self"            — T1.6 wallet-first auth (session subject = user)
 *   - "sietch-redirect" — T4.1 cycle-c link-verified-wallet redirect
 *   - "backfill"        — T4.x midi_profiles backfill migration writes
 *   - world_slug        — per-world admin writes (future)
 */
export type AuditActor = "system" | "self" | "sietch-redirect" | "backfill" | string

/**
 * Mint a new user. Pairs with `writeAuditEvent('user_minted')`.
 *
 * Caller is expected to follow with `linkWallet({... isPrimary: true})`
 * to bind the user; the T1.6 auth flow does both in sequence on first
 * /v1/auth/verify for a previously-unseen wallet.
 */
export async function mintUser(
  spine: SpinePort,
  opts: { actor?: AuditActor } = {},
): Promise<string> {
  const userId = await spine.mintUser()
  await spine.writeAuditEvent({
    event_type: "user_minted",
    user_id: userId,
    actor: opts.actor ?? "system",
    payload: {},
  })
  return userId
}

/**
 * FR-R6 link wallet + audit emit. Per T1.3 BEFORE-trigger amendment, a
 * single INSERT with `isPrimary=TRUE` is atomic — the trigger demotes any
 * prior primary before the partial-unique check fires. No caller-side
 * two-step demote required.
 *
 * Idempotency (NFR-7): if the wallet is already actively linked to the
 * same user, this raises a uniqueness violation on
 * `uq_wallet_links_active_address`. T1.6+ callers should `resolveByWallet`
 * first and short-circuit on match.
 *
 * Cross-user conflict: if the wallet is actively linked to a DIFFERENT
 * user, this also raises the same uniqueness violation. The route layer
 * (T4.1) applies D9 latest-wins policy server-side BEFORE this call to
 * decide whether to soft-unlink the prior binding first.
 */
export async function linkWalletWithAudit(
  spine: SpinePort,
  opts: {
    userId: string
    walletAddress: string
    chainIds?: readonly string[]
    isPrimary?: boolean
    actor?: AuditActor
  },
): Promise<void> {
  const walletAddress = normalizeAddress(opts.walletAddress)
  await spine.linkWallet({
    userId: opts.userId,
    walletAddress,
    chainIds: opts.chainIds,
    isPrimary: opts.isPrimary,
  })
  await spine.writeAuditEvent({
    event_type: "wallet_linked",
    user_id: opts.userId,
    actor: opts.actor ?? "system",
    payload: {
      wallet_address: walletAddress,
      chain_ids: opts.chainIds ?? [],
      is_primary: opts.isPrimary ?? false,
    },
  })
}

/**
 * FR-R6 link account + audit emit. The adapter raises
 * `SpineConflictError(kind='linked_account')` on (provider, external_id)
 * duplicate; the route layer maps that to 409 `cross_user_collision`.
 *
 * On conflict we DO emit a `conflict_rejected` audit row (NFR-5) before
 * re-raising — the audit log is the trail of all attempted writes,
 * including rejected ones (per PRD §4.2 + SDD §3.2 audit_events shape).
 */
export async function linkAccountWithAudit(
  spine: SpinePort,
  opts: {
    userId: string
    provider: SpineLinkedAccountProvider
    externalId: string
    actor?: AuditActor
  },
): Promise<void> {
  const actor = opts.actor ?? "system"
  try {
    await spine.linkAccount({
      userId: opts.userId,
      provider: opts.provider,
      externalId: opts.externalId,
    })
  } catch (err) {
    // Audit the rejection BEFORE re-raising; the route layer translates
    // the typed error into the 409 envelope.
    await spine.writeAuditEvent({
      event_type: "conflict_rejected",
      user_id: null, // pre-resolution conflict: we don't know whose user owns the existing row
      actor,
      payload: {
        conflict_kind: "linked_account",
        provider: opts.provider,
        external_id: opts.externalId,
        attempted_user_id: opts.userId,
      },
    })
    throw err
  }
  await spine.writeAuditEvent({
    event_type: "account_linked",
    user_id: opts.userId,
    actor,
    payload: {
      provider: opts.provider,
      external_id: opts.externalId,
    },
  })
}

/**
 * FR-R6 claim nym + audit emit. The adapter raises
 * `SpineConflictError(kind='world_identity')` on either the world-PK
 * `(user_id, world_slug)` violation (user already has a nym in this world)
 * OR the world-UNIQUE `(world_slug, nym)` violation (nym taken). The route
 * layer can distinguish via the error's `context` payload if needed.
 */
export async function claimNymWithAudit(
  spine: SpinePort,
  opts: {
    userId: string
    worldSlug: string
    nym: string
    actor?: AuditActor
  },
): Promise<void> {
  const actor = opts.actor ?? "system"
  try {
    await spine.claimNym({
      userId: opts.userId,
      worldSlug: opts.worldSlug,
      nym: opts.nym,
    })
  } catch (err) {
    await spine.writeAuditEvent({
      event_type: "conflict_rejected",
      user_id: opts.userId,
      actor,
      payload: {
        conflict_kind: "world_identity",
        world_slug: opts.worldSlug,
        nym: opts.nym,
      },
    })
    throw err
  }
  await spine.writeAuditEvent({
    event_type: "nym_claimed",
    user_id: opts.userId,
    actor,
    payload: {
      world_slug: opts.worldSlug,
      nym: opts.nym,
    },
  })
}

/**
 * FR-R5 setPrimary + audit emit. Single-statement (T1.3 BEFORE-trigger
 * payoff). Returns true if the promote took effect, false if no matching
 * active link was found (caller hadn't linked the wallet yet, or the link
 * is soft-unlinked).
 *
 * The audit is only emitted on success — a no-op call (not-found) leaves
 * the spine state untouched and warrants no audit row.
 */
export async function setPrimaryWithAudit(
  spine: SpinePort,
  opts: {
    userId: string
    walletAddress: string
    actor?: AuditActor
  },
): Promise<boolean> {
  const walletAddress = normalizeAddress(opts.walletAddress)
  const ok = await spine.setPrimary({
    userId: opts.userId,
    walletAddress,
  })
  if (!ok) return false
  await spine.writeAuditEvent({
    event_type: "primary_changed",
    user_id: opts.userId,
    actor: opts.actor ?? "system",
    payload: {
      to_wallet: walletAddress,
    },
  })
  return true
}

// ─── composite helpers (consumed by route handlers + the T1.6 auth flow) ───

/**
 * Resolve a wallet to a user_id; if not present, mint a new user and link
 * the wallet as primary. The atomic-feel "resolve-or-create" the T1.6
 * auth flow needs on /v1/auth/verify for a previously-unseen wallet.
 *
 * Not (yet) wrapped in an explicit BEGIN/COMMIT — each adapter call is its
 * own implicit transaction. A concurrent race where two requests with the
 * same fresh wallet both miss the resolve and both attempt to mint+link
 * results in:
 *   - Two `users` rows created (both succeed; PK is randomly-assigned UUID).
 *   - One linkWallet succeeds; the other raises
 *     `uq_wallet_links_active_address` uniqueness violation.
 *   - The losing caller catches and re-resolves; the now-existing wallet
 *     binds to the winner's user_id. The orphaned user_id has no wallet
 *     (resolver retry returns the winner's id; the orphan never resolves).
 *
 * v1 accepts the rare orphan-user-on-race tradeoff because the auth flow
 * isn't yet wired (T1.6) — the caller pattern that will need true atomicity
 * lands when T1.6 builds the verify orchestrator. Today this is a
 * convenience building block.
 *
 * Returns `{ userId, minted }` so callers can branch on first-time vs
 * returning (e.g., T1.6 may want to issue a "welcome" event differently
 * than a session-renewal event).
 */
export async function resolveOrMintByWallet(
  spine: SpinePort,
  opts: {
    walletAddress: string
    chainIds?: readonly string[]
    actor?: AuditActor
  },
): Promise<{ userId: string; minted: boolean }> {
  const walletAddress = normalizeAddress(opts.walletAddress)
  const existing = await resolveByWallet(spine, walletAddress)
  if (existing) {
    return { userId: existing, minted: false }
  }
  const userId = await mintUser(spine, { actor: opts.actor })
  await linkWalletWithAudit(spine, {
    userId,
    walletAddress,
    chainIds: opts.chainIds,
    isPrimary: true,
    actor: opts.actor,
  })
  return { userId, minted: true }
}

// ─── helpers ───────────────────────────────────────────────────────────────

/**
 * Address normalization: 0x-prefixed EVM addresses are stored in canonical
 * lowercase per SDD §3.2 ("store canonical lowercase"). The active-unique
 * index `uq_wallet_links_active_address` matches case-sensitively, so a
 * mixed-case write would create a duplicate row for the same human
 * wallet — we normalize at the engine seam.
 *
 * Non-0x addresses (e.g., a future Solana base58) pass through unchanged
 * — adding chain-specific normalizers when those chains land is a one-line
 * extension here.
 */
function normalizeAddress(address: string): string {
  if (address.startsWith("0x") || address.startsWith("0X")) {
    return address.toLowerCase()
  }
  return address
}
