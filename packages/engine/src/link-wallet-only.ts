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
 *                          → claim-or-import the generated name
 *     → (known)   idempotent no-op (no duplicate user/link)
 *   → umbrella `link_wallet_only` audit
 *
 * HARD invariant: NEVER writes provider='discord'. The only linked_account
 * this path may write is 'dynamic_user_id' (optional).
 *
 * Name step (the HOIST):
 *   - `importedNames` present → ABSORB each via `importName` (the backfill's
 *     path: absorb honey-road's existing mibera_id + display_name VERBATIM so
 *     nothing on-screen changes). The orchestrator does NOT regenerate.
 *   - `importedNames` absent → `claimGeneratedName` (the spine mints a fresh
 *     handle — NEW users only).
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
   * The user's generated/default name for the world. On a fresh claim it is
   * the minted MIBERA-XXXX. On an absorb it echoes the imported `generated`
   * value (what honey-road already shows). Null when neither path ran (the
   * idempotent no-op of an existing user — we don't re-read their name here).
   */
  readonly generatedName: string | null
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

    switch (decision.kind) {
      case "idempotent_noop":
        userId = decision.userId
        idempotent = true
        break

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
          generatedName =
            input.importedNames.find((n) => n.nameType === "generated")?.value ?? null
        } else {
          generatedName = await txnSpine.claimGeneratedName({
            userId,
            worldSlug: input.worldSlug,
          })
        }
        break
      }
    }

    // Umbrella audit — the trail row summarizing the full wallet-only ingress.
    // NO discord_id key (this path never touches discord).
    await txnSpine.writeAuditEvent({
      event_type: "link_wallet_only",
      user_id: userId,
      actor,
      payload: {
        world_slug: input.worldSlug,
        wallet_address: walletAddress,
        ...(input.dynamicUserId ? { dynamic_user_id: input.dynamicUserId } : {}),
        idempotent,
        ...(generatedName !== null ? { generated_name: generatedName } : {}),
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
