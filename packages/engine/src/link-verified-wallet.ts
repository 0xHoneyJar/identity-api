/**
 * link-verified-wallet.ts — cycle-c redirect ingress orchestrator (T4.1 ·
 * bead arrakis-hyde · FR-C1 / FR-C3).
 *
 * Receives a verified linkage write from Sietch (post-/verify) and reconciles
 * it into the spine, applying the D8 / cycle-c FR-L3 conflict policy
 * SERVER-SIDE.
 *
 * Design contract:
 *
 *   - **Conflict policy is an injected strategy** (OQ-2 swappable seam). The
 *     `ConflictResolver` is a pure function `(state) → ConflictDecision`;
 *     swapping latest-wins for first-claim-wins is a single function
 *     pointer change. Default: `latestWinsResolver` (per SDD §8.2).
 *
 *   - **Atomicity via spine.withTransaction**: resolveByWallet +
 *     resolveByAccount + create/link writes commit or roll back as one
 *     unit. Matches the LBR-1 / NFR-7 strict-atomicity contract used by
 *     resolveOrMintByWallet in resolve-spine.ts.
 *
 *   - **Audit on every outcome** (NFR-5): wallet_linked, account_linked,
 *     conflict_rejected, link_verified_wallet (the umbrella audit row
 *     summarizing the full call). All inside the same txn so the audit
 *     trail reflects committed state.
 *
 *   - **Idempotent** (NFR-7): re-running the same (walletAddress, discordId,
 *     worldSlug) is a no-op + returns `{ ok: true, idempotent: true }`.
 *     Caller can safely retry.
 *
 * The Sietch redirect (T4.2 / T4.3) calls this orchestrator's HTTP route.
 * The shape `LinkVerifiedWalletReq` mirrors cycle-c's MidiPgIdentityLink
 * write contract — the redirect is wire-compatible without Sietch changes
 * beyond swapping the port binding.
 *
 * Source: SDD §5.5 + §8.2, PRD §4.6 (FR-C1..C4), cycle-c §0 + FR-L3.
 */

import type { AuditActor } from "./resolve-spine"
import type { SpinePort } from "@freeside-auth/ports"
import {
  linkAccountWithAudit,
  linkWalletWithAudit,
  mintUser,
  normalizeAddress,
  resolveByAccount,
  resolveByWallet,
} from "./resolve-spine"

// ─── public types ──────────────────────────────────────────────────────────

export interface LinkVerifiedWalletInput {
  readonly worldSlug: string
  readonly discordId: string
  readonly walletAddress: string
  readonly dynamicUserId?: string
}

/**
 * The conflict-resolver input state — what the spine knows about the
 * incoming claim at decision time.
 */
export interface ConflictState {
  readonly walletUser: string | null
  readonly discordUser: string | null
  readonly input: LinkVerifiedWalletInput
}

/**
 * The conflict-resolver output decision — what the orchestrator should do
 * based on the state. Five cases, exactly one applies.
 */
export type ConflictDecision =
  | { readonly kind: "idempotent_noop"; readonly userId: string }
  | { readonly kind: "create_user_link_both" }
  | { readonly kind: "link_wallet_to_discord_user"; readonly userId: string }
  | { readonly kind: "link_discord_to_wallet_user"; readonly userId: string }
  | { readonly kind: "collision"; readonly walletUser: string; readonly discordUser: string }

/**
 * Pure function — given the resolved state, decide the action. The default
 * latest-wins resolver implements SDD §8.2 verbatim. Swap this in for
 * first-claim-wins or any other policy (OQ-2 seam).
 */
export type ConflictResolver = (state: ConflictState) => ConflictDecision

/**
 * Default conflict resolver — latest-wins on single-axis change, hard-fail
 * on cross_user_collision. Verbatim SDD §8.2 / cycle-c FR-L3.
 */
export const latestWinsResolver: ConflictResolver = (state) => {
  const { walletUser, discordUser } = state
  if (walletUser === null && discordUser === null) {
    return { kind: "create_user_link_both" }
  }
  if (walletUser !== null && discordUser !== null) {
    if (walletUser === discordUser) {
      return { kind: "idempotent_noop", userId: walletUser }
    }
    return { kind: "collision", walletUser, discordUser }
  }
  if (discordUser !== null) {
    // wallet null, discord set → bind wallet to discord-user (latest-wins on wallet axis)
    return { kind: "link_wallet_to_discord_user", userId: discordUser }
  }
  // wallet set, discord null → bind discord to wallet-user (latest-wins on discord axis)
  return { kind: "link_discord_to_wallet_user", userId: walletUser! }
}

/**
 * The orchestrator's success envelope. Mirrors `LinkVerifiedWalletResp`
 * at the protocol layer (kept separate so the engine doesn't depend on
 * the wire schema package — only the route adapter does the wire->engine
 * shape coercion).
 */
export interface LinkVerifiedWalletResult {
  readonly ok: true
  readonly userId: string
  readonly walletAddress: string
  readonly idempotent: boolean
  readonly conflictResolved: "wallet_rebound" | "discord_rebound" | null
}

/**
 * Typed conflict — the route translates this to 409 + JSON envelope.
 */
export class LinkCrossUserCollisionError extends Error {
  readonly kind = "cross_user_collision" as const
  readonly walletUser: string
  readonly discordUser: string
  constructor(walletUser: string, discordUser: string) {
    super(`cross_user_collision: wallet linked to ${walletUser}, discord linked to ${discordUser}`)
    this.walletUser = walletUser
    this.discordUser = discordUser
  }
}

// ─── the orchestrator ──────────────────────────────────────────────────────

/**
 * Reconcile a verified linkage write into the spine.
 *
 * Wraps the resolve-then-write sequence in a single spine transaction so
 * the writes commit atomically — concurrent linkage attempts cannot leave
 * a partial state (e.g., user created without a wallet link).
 *
 * Throws `LinkCrossUserCollisionError` on hard-fail; the route layer
 * catches this and returns 409 with `{ok:false, conflict:'cross_user_collision'}`.
 *
 * `actor` is forwarded to all audit emits — Sietch passes
 * `'sietch-redirect'` per SDD §8.2 step 4.
 */
export async function linkVerifiedWallet(
  spine: SpinePort,
  input: LinkVerifiedWalletInput,
  opts: {
    readonly resolver?: ConflictResolver
    readonly actor?: AuditActor
  } = {},
): Promise<LinkVerifiedWalletResult> {
  const resolver = opts.resolver ?? latestWinsResolver
  const actor: AuditActor = opts.actor ?? "sietch-redirect"
  const walletAddress = normalizeAddress(input.walletAddress)
  const discordId = input.discordId

  return spine.withTransaction(async (txnSpine) => {
    const [walletUser, discordUser] = await Promise.all([
      resolveByWallet(txnSpine, walletAddress),
      resolveByAccount(txnSpine, "discord", discordId),
    ])

    const decision = resolver({
      walletUser,
      discordUser,
      input: { ...input, walletAddress },
    })

    let userId: string
    let idempotent = false
    let conflictResolved: LinkVerifiedWalletResult["conflictResolved"] = null

    switch (decision.kind) {
      case "idempotent_noop":
        userId = decision.userId
        idempotent = true
        // No new writes; audit the no-op outcome for the trail.
        break

      case "create_user_link_both": {
        userId = await mintUser(txnSpine, { actor })
        await linkWalletWithAudit(txnSpine, {
          userId,
          walletAddress,
          isPrimary: true,
          actor,
        })
        await linkAccountWithAudit(txnSpine, {
          userId,
          provider: "discord",
          externalId: discordId,
          actor,
        })
        break
      }

      case "link_wallet_to_discord_user":
        userId = decision.userId
        await linkWalletWithAudit(txnSpine, {
          userId,
          walletAddress,
          isPrimary: false,
          actor,
        })
        conflictResolved = "wallet_rebound"
        break

      case "link_discord_to_wallet_user":
        userId = decision.userId
        await linkAccountWithAudit(txnSpine, {
          userId,
          provider: "discord",
          externalId: discordId,
          actor,
        })
        conflictResolved = "discord_rebound"
        break

      case "collision":
        // Write the rejected-attempt audit through the OUTER `spine` — not
        // `txnSpine` — because throwing immediately below aborts the
        // transaction and rolls back every txn-scoped write. The audit
        // trail of REJECTED attempts must survive the rollback (NFR-5),
        // so it commits independently. FAGAN iter-1 finding: the mock
        // pass-through txn would hide this rollback in tests; real PG
        // would silently lose the audit.
        await spine.writeAuditEvent({
          event_type: "conflict_rejected",
          user_id: null,
          actor,
          payload: {
            conflict_kind: "cross_user_collision",
            wallet_address: walletAddress,
            discord_id: discordId,
            world_slug: input.worldSlug,
            wallet_user_id: decision.walletUser,
            discord_user_id: decision.discordUser,
          },
        })
        throw new LinkCrossUserCollisionError(decision.walletUser, decision.discordUser)
    }

    // Optional: link the Dynamic-SDK user_id as a linked_account when
    // supplied. Only fired on non-noop outcomes (idempotent re-link of an
    // already-linked dynamic_user_id would just hit the unique constraint).
    if (input.dynamicUserId && !idempotent) {
      await linkAccountWithAudit(txnSpine, {
        userId,
        provider: "dynamic_user_id",
        externalId: input.dynamicUserId,
        actor,
      })
    }

    // Umbrella audit: link_verified_wallet — the trail row that summarizes
    // the full call regardless of which sub-operations fired. Lets ops
    // query "all redirect-ingress events" without scanning the four
    // component event_types.
    await txnSpine.writeAuditEvent({
      event_type: "link_verified_wallet",
      user_id: userId,
      actor,
      payload: {
        world_slug: input.worldSlug,
        wallet_address: walletAddress,
        discord_id: discordId,
        ...(input.dynamicUserId ? { dynamic_user_id: input.dynamicUserId } : {}),
        idempotent,
        conflict_resolved: conflictResolved,
      },
    })

    return {
      ok: true as const,
      userId,
      walletAddress,
      idempotent,
      conflictResolved,
    }
  })
}

