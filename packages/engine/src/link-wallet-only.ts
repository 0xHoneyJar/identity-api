/**
 * link-wallet-only.ts — wallet-only spine ingress orchestrator (A3 ·
 * identity-api #11 Phase 1).
 *
 * The sibling of `linkVerifiedWallet` for users with NO discord. The only
 * spine-creating engine API today, `linkVerifiedWallet`, HARD-REQUIRES
 * discordId (link-verified-wallet.ts:54; protocol enforces z.string().min(1)).
 * Of 192 midi users, 189 are wallet-only → invisible to the SoR. This
 * orchestrator admits them: it mirrors `linkVerifiedWallet` MINUS the discord
 * axis and adds the hoisted name step (claim-or-import).
 *
 * Sequence (inside spine.withTransaction, matching the LBR-1/NFR-7 atomicity
 * posture of resolveOrMintByWallet + linkVerifiedWallet):
 *
 *   resolveByWallet
 *     → (unknown) mintUser → linkWalletWithAudit(isPrimary: true)
 *                          → optional linkAccountWithAudit('dynamic_user_id')
 *                          → claim-or-import the world name
 *     → (known)   getIdentity → has a world name for this world?
 *                                 yes → TRUE no-op (echo the existing handle)
 *                                 no  → claim-or-import it (claims-if-missing)
 *   → umbrella `link_wallet_only` audit
 *
 * CLAIMS-IF-MISSING (identity-api #39): pre-SIWE, the (known) branch was an
 * unreachable rarity — a wallet only became known via THIS path. SIWE login is
 * now live: every /v1/auth/verify resolve-or-mints the spine user at login, so
 * by the time onboarding calls /v1/link/wallet-only the wallet is ALREADY
 * KNOWN and the (known) branch is the DEFAULT for a fresh user. A pure no-op
 * there would leave that user with NO world name forever (the spine never mints
 * a handle; midi's local fallback drifts against "the spine is the sole
 * generator"). So the known branch now reads the user's world names and, IF
 * NONE exist for the world, assigns one exactly as the create path does — claim
 * a fresh generated handle, or absorb the backfill's importedNames. A user who
 * already holds a world name is still a true no-op.
 *
 * HARD invariant: NEVER writes provider='discord'. The only linked_account
 * this path may write is 'dynamic_user_id' (optional).
 *
 * Name step (the HOIST) — runs on the unknown branch AND the known-but-nameless
 * branch (claims-if-missing):
 *   - `importedNames` present → ABSORB each via `importName` (the backfill's
 *     path: absorb honey-road's existing mibera_id + display_name VERBATIM so
 *     nothing on-screen changes). The orchestrator does NOT regenerate.
 *   - `importedNames` absent → `claimGeneratedName` (the spine mints a fresh
 *     handle).
 *
 * Why read-then-claim (not a blind re-claim) on the known branch:
 * `claimGeneratedName` is NOT idempotent — the only active uniqueness is on
 * `(world_slug, name_type, value)`, NOT `(user_id, world_slug, name_type)`, so
 * a blind re-claim on a user who already has a handle would mint a SECOND,
 * different `MIBERA-XXXX` row. We reuse the existing `getIdentity` read
 * (it already returns `world_names`) to gate the assign — no new port method.
 *
 * Concurrency edge (ACCEPTED, #39): read-then-claim is not single-flight under
 * READ COMMITTED — two concurrent calls for the SAME known, nameless wallet
 * could both read zero names and both `claimGeneratedName`, leaving the user
 * with a duplicate active `generated` row (the value-unique index doesn't
 * collide them; the create path, by contrast, is DB-guarded by the wallet
 * link's `uq_wallet_links_active_address`, and an `importedNames` absorb is
 * guarded by the name value-unique). The decision is to ACCEPT this edge
 * rather than introduce a lock: wallet-only onboarding is single-flight per
 * wallet in practice (one S2S call per onboarding), the impact is a benign
 * duplicate row (NOT corruption — the 0009 recompute trigger keeps the
 * displayed handle deterministic), and a `SELECT … FOR UPDATE` /
 * `pg_advisory_xact_lock` would require a raw-SQL lock primitive that the
 * `SpinePort` abstraction does not expose — i.e. new port surface, out of
 * scope for this change. If concurrent re-claims are ever observed, the fix is
 * an advisory xact lock keyed on `(userId, worldSlug)` before the read.
 *
 * Conflict policy is an injectable seam (mirrors linkVerifiedWallet's OQ-2
 * resolver), but the wallet-only case has only TWO outcomes (no discord axis
 * to collide on): create-fresh, or idempotent-noop on an existing wallet.
 * Default: first-claim / idempotent-noop.
 *
 * Source: spec §A3 (grounded 2026-06-02) + link-verified-wallet.ts (the
 * discord-required sibling this clones minus discord).
 */

import type { AuditActor } from "./resolve-spine"
import type { SpinePort } from "@freeside-auth/ports"
import {
  linkAccountWithAudit,
  linkWalletWithAudit,
  mintUser,
  normalizeAddress,
  resolveByWallet,
} from "./resolve-spine"

// ─── public types ──────────────────────────────────────────────────────────

/** One externally-minted name to absorb (the backfill's honey-road values). */
export interface ImportedName {
  readonly nameType: string
  readonly value: string
}

export interface LinkWalletOnlyInput {
  readonly worldSlug: string
  readonly walletAddress: string
  /** Optional Dynamic-SDK user id; linked as provider='dynamic_user_id'. */
  readonly dynamicUserId?: string
  /**
   * Externally-minted names to ABSORB (backfill). When present, the
   * orchestrator imports each VERBATIM and does NOT mint a generated handle.
   * When absent, it mints one via claimGeneratedName.
   */
  readonly importedNames?: readonly ImportedName[]
}

/** Resolver input state — what the spine knows about the wallet at decision time. */
export interface WalletOnlyConflictState {
  readonly walletUser: string | null
  readonly input: LinkWalletOnlyInput
}

/**
 * Resolver output decision. Only two cases — no discord axis means no
 * cross-user collision class on this path.
 */
export type WalletOnlyConflictDecision =
  | { readonly kind: "create_user" }
  | { readonly kind: "idempotent_noop"; readonly userId: string }

export type WalletOnlyConflictResolver = (
  state: WalletOnlyConflictState,
) => WalletOnlyConflictDecision

/**
 * Default resolver — first-claim / idempotent-noop. Unknown wallet → create;
 * known wallet → idempotent no-op (the wallet already maps to a user).
 */
export const firstClaimResolver: WalletOnlyConflictResolver = (state) =>
  state.walletUser === null
    ? { kind: "create_user" }
    : { kind: "idempotent_noop", userId: state.walletUser }

/** Success envelope. */
export interface LinkWalletOnlyResult {
  readonly ok: true
  readonly userId: string
  readonly walletAddress: string
  readonly idempotent: boolean
  /**
   * The user's generated/default name for the world — ALWAYS the user's handle
   * (existing or fresh), per #39. On a fresh claim it is the minted
   * MIBERA-XXXX. On an absorb it echoes the imported `generated` value (what
   * honey-road already shows). On a known wallet that already holds a world
   * name (TRUE no-op), it echoes that existing `generated` handle (re-read via
   * getIdentity). Null only when the user holds world names but none of type
   * `generated` (an absorb whose importedNames carried no `generated` row, or a
   * world-name set without a generated handle), or when the user is a LEGACY
   * pre-name-model identity (world_identity row via claimNym, zero registry
   * rows — a true no-op that must not clobber the legacy nym).
   */
  readonly generatedName: string | null
}

// ─── the name step (shared by both branches) ────────────────────────────────

/**
 * Assign the user's world name: ABSORB the backfill's `importedNames` VERBATIM,
 * or mint a fresh generated handle when none are supplied. Shared by the
 * create-user path and the claims-if-missing known-wallet path (#39) — once a
 * world name is determined to be MISSING, both assign it identically.
 *
 * Returns the user's generated handle: the absorbed `generated` value, or the
 * freshly minted one. Null when `importedNames` carried no `generated` row.
 */
async function assignWorldName(
  txnSpine: SpinePort,
  userId: string,
  input: LinkWalletOnlyInput,
): Promise<string | null> {
  if (input.importedNames && input.importedNames.length > 0) {
    for (const n of input.importedNames) {
      await txnSpine.importName({
        userId,
        worldSlug: input.worldSlug,
        nameType: n.nameType,
        value: n.value,
      })
    }
    // Echo the absorbed `generated` value (what honey-road shows), if any.
    return input.importedNames.find((n) => n.nameType === "generated")?.value ?? null
  }
  return txnSpine.claimGeneratedName({ userId, worldSlug: input.worldSlug })
}

// ─── the orchestrator ──────────────────────────────────────────────────────

/**
 * Admit a wallet-only user to the spine + assign their world name.
 *
 * Wraps the resolve-then-write sequence in one spine transaction so the writes
 * commit atomically — a mid-sequence failure rolls back every write including
 * the orphan mintUser row (no partial state survives).
 *
 * `actor` is forwarded to all audit emits — the A6 backfill passes
 * 'backfill-wallet' so the revert can precisely invert these writes.
 */
export async function linkWalletOnly(
  spine: SpinePort,
  input: LinkWalletOnlyInput,
  opts: {
    readonly resolver?: WalletOnlyConflictResolver
    readonly actor?: AuditActor
  } = {},
): Promise<LinkWalletOnlyResult> {
  const resolver = opts.resolver ?? firstClaimResolver
  const actor: AuditActor = opts.actor ?? "system"
  const walletAddress = normalizeAddress(input.walletAddress)

  return spine.withTransaction(async (txnSpine) => {
    const walletUser = await resolveByWallet(txnSpine, walletAddress)
    const decision = resolver({ walletUser, input: { ...input, walletAddress } })

    let userId: string
    let idempotent = false
    let generatedName: string | null = null
    // Did THIS call assign a name (claim/absorb)? Drives the umbrella audit's
    // `generated_name` field — present only when an assign actually ran, so the
    // trail reflects what HAPPENED (not the echoed handle of a true no-op).
    let nameAssigned = false

    switch (decision.kind) {
      case "idempotent_noop": {
        // The wallet already maps to a user — no duplicate user/link. But with
        // SIWE pre-minting users at login, this is now the DEFAULT path for a
        // fresh user, so we CLAIM-IF-MISSING the world name (#39): read the
        // user's world names; echo an existing handle (true no-op), else assign
        // one as the create path does. `idempotent` stays true regardless — it
        // reflects the USER axis (no new spine user was minted); a name assign
        // here is reflected separately by `generated_name` in the audit + the
        // underlying `name_assigned` row.
        userId = decision.userId
        idempotent = true

        const existing = await txnSpine.getIdentity(userId)
        const worldNames =
          existing?.world_names.filter((n) => n.world_slug === input.worldSlug) ?? []
        // Legacy guard (#40 review): a pre-name-model user can hold a
        // world_identity row (claimNym writes it directly, FR-R6) with ZERO
        // registry name rows. Claiming here would fire the 0009 recompute and
        // silently OVERWRITE their legacy nym with a generated handle — so a
        // legacy row counts as "world identity exists" and stays a TRUE no-op.
        const hasLegacyIdentity =
          existing?.world_identities.some((w) => w.world_slug === input.worldSlug) ??
          false
        if (worldNames.length > 0 || hasLegacyIdentity) {
          // World identity already exists → TRUE no-op. Echo the existing
          // generated handle (re-read), so the caller always gets the user's
          // handle; midi can drop its local MIBERA-XXXX fallback. A LEGACY-ONLY
          // user (world_identity row, no registry rows) has no generated-type
          // name to echo → null; their display stays the legacy nym.
          generatedName =
            worldNames.find((n) => n.name_type === "generated")?.value ?? null
        } else {
          generatedName = await assignWorldName(txnSpine, userId, input)
          nameAssigned = true
        }
        break
      }

      case "create_user": {
        userId = await mintUser(txnSpine, { actor })
        await linkWalletWithAudit(txnSpine, {
          userId,
          walletAddress,
          isPrimary: true,
          actor,
        })

        // Optional Dynamic-SDK linkage. NEVER discord — this is the wallet-only
        // path's hard invariant.
        if (input.dynamicUserId) {
          await linkAccountWithAudit(txnSpine, {
            userId,
            provider: "dynamic_user_id",
            externalId: input.dynamicUserId,
            actor,
          })
        }

        // The HOIST: absorb the app's existing names, or mint a fresh handle.
        generatedName = await assignWorldName(txnSpine, userId, input)
        nameAssigned = true
        break
      }
    }

    // Umbrella audit — the trail row summarizing the full wallet-only ingress.
    // NO discord_id key (this path never touches discord). `generated_name` is
    // present only when an assign RAN this call (nameAssigned) — a true no-op
    // echoes the existing handle into the result but writes nothing here.
    await txnSpine.writeAuditEvent({
      event_type: "link_wallet_only",
      user_id: userId,
      actor,
      payload: {
        world_slug: input.worldSlug,
        wallet_address: walletAddress,
        ...(input.dynamicUserId ? { dynamic_user_id: input.dynamicUserId } : {}),
        idempotent,
        ...(nameAssigned && generatedName !== null ? { generated_name: generatedName } : {}),
      },
    })

    return {
      ok: true as const,
      userId,
      walletAddress,
      idempotent,
      generatedName,
    }
  })
}
