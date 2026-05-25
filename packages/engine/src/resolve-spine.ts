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
 * the wallet as primary. The atomic "resolve-or-create" the T1.6 auth
 * flow consumes from /v1/auth/verify for a previously-unseen wallet.
 *
 * T1.6 LBR-1 — TRANSACTIONAL POSTURE:
 *   Callers SHOULD wrap this in `spine.withTransaction(async (tx) => { ... })`
 *   so the read-then-write of resolveByWallet + mintUser + linkWallet
 *   commits as one atomic unit. Concurrent verify calls for the same
 *   fresh wallet will then serialize at the `uq_wallet_links_active_address`
 *   uniqueness check — the loser catches the conflict (re-thrown as
 *   `SpineConflictError(kind: 'wallet_link')`) and re-resolves to the
 *   winner's user_id with NO partial mint visible outside the txn.
 *
 *   THIS function transparently handles the conflict-retry inside its own
 *   logic, so the caller's contract is simple: "give me back a stable
 *   user_id for this wallet, atomically." The caller still needs to wrap
 *   the OUTER `withTransaction` so the ROLLBACK on conflict cleans up the
 *   orphan mint — see the T1.6 verify route handler for the canonical
 *   usage pattern.
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
  try {
    await linkWalletWithAudit(spine, {
      userId,
      walletAddress,
      chainIds: opts.chainIds,
      isPrimary: true,
      actor: opts.actor,
    })
  } catch (err) {
    // LBR-1 race-loser path: another concurrent verify call won the
    // linkWallet → its txn committed first → our linkWallet raises
    // `uq_wallet_links_active_address` (PG 23505) because the wallet is
    // now ACTIVE-linked to the winner's user_id.
    //
    // Critical: we must signal the caller's wrapping txn to ROLLBACK
    // (rolling back the orphan `users` row our mintUser just inserted),
    // and the caller's retry must re-resolve to the winner's user_id.
    //
    // Two layers of contract:
    //  (a) The caller wraps THIS function inside spine.withTransaction; on
    //      our re-throw, that txn aborts and the orphan user is GONE
    //      (rolled back). So at the DB layer, no orphan persists.
    //  (b) The route handler in T1.6 catches our re-thrown error, re-runs
    //      resolveOrMintByWallet (now in a NEW txn) — and the resolveByWallet
    //      at the top short-circuits to the winner's user_id.
    if (isWalletLinkConflict(err)) {
      throw new WalletLinkRaceError(walletAddress)
    }
    throw err
  }
  return { userId, minted: true }
}

/**
 * LBR-1 race-loser signal — the linkWallet step lost a race to a
 * concurrent verify call that also minted+linked the same wallet first.
 *
 * The route handler catches this, ROLLBACKs its txn (cleaning up the
 * orphan mintUser row), and re-runs resolveOrMintByWallet — the
 * second pass's resolveByWallet finds the winner's existing link and
 * returns that user_id.
 *
 * Why a dedicated error class vs reusing SpineConflictError: the
 * adapter's SpineConflictError is RAISED from linkAccount + claimNym
 * (the D9 conflict paths). The wallet-link race is structurally a
 * different conflict class — it's NOT a cross-user collision (no D9
 * applies), it's transient concurrent-creation noise. Keeping it as a
 * separate error class lets the route handler treat them differently:
 *   - SpineConflictError(kind: 'wallet_link'-ish) — would be a misnomer
 *     because the adapter currently raises this from linkAccount, not
 *     linkWallet
 *   - WalletLinkRaceError — explicitly "retry resolve, don't 409"
 */
export class WalletLinkRaceError extends Error {
  constructor(public readonly walletAddress: string) {
    super(
      `[wallet-link-race] concurrent verify lost the link race for ${walletAddress}; rollback + re-resolve`,
    )
    this.name = "WalletLinkRaceError"
  }
}

/** Heuristic: is this PG error from a wallet_links uniqueness violation? */
function isWalletLinkConflict(err: unknown): boolean {
  if (err === null || typeof err !== "object") return false
  const e = err as { code?: unknown; message?: unknown; constraint_name?: unknown }
  const code = e.code === "23505"
  if (!code) return false
  // Narrow further to the active-address index when surfaced — defends
  // against the (rare) case where some other uniqueness violation on the
  // same INSERT path bubbles up. Bun.SQL may surface constraint name on
  // `.constraint_name` or in `.message` text.
  const cn = typeof e.constraint_name === "string" ? e.constraint_name : ""
  const msg = typeof e.message === "string" ? e.message : ""
  return (
    cn === "uq_wallet_links_active_address" ||
    cn === "uq_wallet_links_one_primary_per_user" ||
    msg.includes("uq_wallet_links_active_address") ||
    msg.includes("uq_wallet_links_one_primary_per_user")
  )
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
