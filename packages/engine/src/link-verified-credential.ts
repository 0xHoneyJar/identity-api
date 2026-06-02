/**
 * link-verified-credential.ts — session-keyed credential-link entry shape
 * (bead bd-2wo.14 · Discord-social OAuth-verification front-end).
 *
 * This is the linking step for the user-session-gated Discord OAuth flow.
 * It is the SESSION-keyed sibling of `linkVerifiedWallet` (which is
 * wallet-keyed + service-token-gated for the Sietch cycle-c redirect).
 *
 * Design contract — REUSE, do not reimplement:
 *
 *   - **No new minting / collision / idempotency logic.** This composes the
 *     EXISTING spine primitives: `resolveByAccount` (the pre-check) +
 *     `linkAccountWithAudit` (the audited write). Cross-user collision
 *     reuses the EXISTING `LinkCrossUserCollisionError` so the route layer's
 *     409 mapping is identical to `/v1/link/verified-wallet`.
 *
 *   - **Atomicity via spine.withTransaction**: the resolveByAccount pre-check
 *     and the linkAccount write commit or roll back as one unit. Matches the
 *     strict-atomicity contract `linkVerifiedWallet` uses.
 *
 *   - **`userId` is the caller-supplied SESSION subject.** The route ALWAYS
 *     passes `c.ctx.jwt.sub` — never a request-controlled value. This helper
 *     does not read any request input; it only knows the userId it is given.
 *     (IDOR defense lives at the route; this function is the safe sink.)
 *
 * Three outcomes (single-axis, since the account is the only key):
 *   - account unbound                      → link it to `userId`
 *   - account already bound to `userId`    → idempotent no-op (no write)
 *   - account bound to a DIFFERENT user    → throw LinkCrossUserCollisionError
 *
 * Source: grimoires/loa/specs/discord-social-credential-link-adapter.md step 3.
 */

import type { AuditActor } from "./resolve-spine"
import type { SpinePort, SpineLinkedAccountProvider } from "@freeside-auth/ports"
import { linkAccountWithAudit, resolveByAccount } from "./resolve-spine"
import { LinkCrossUserCollisionError } from "./link-verified-wallet"

export interface LinkVerifiedCredentialInput {
  /** The SESSION subject — the authenticated user_id. Never request-controlled. */
  readonly userId: string
  readonly provider: SpineLinkedAccountProvider
  /** The externally-verified account id (e.g. the Discord user id). */
  readonly externalId: string
  readonly actor?: AuditActor
}

export interface LinkVerifiedCredentialResult {
  readonly ok: true
  readonly userId: string
  readonly provider: SpineLinkedAccountProvider
  readonly externalId: string
  readonly idempotent: boolean
}

/**
 * Link an externally-verified credential (e.g. a verified Discord id) to the
 * session user, reusing the spine's existing collision/idempotency/audit
 * primitives. Throws `LinkCrossUserCollisionError` (→ 409 at the route) when
 * the credential is already bound to a different user.
 */
export async function linkVerifiedCredential(
  spine: SpinePort,
  input: LinkVerifiedCredentialInput,
): Promise<LinkVerifiedCredentialResult> {
  const actor: AuditActor = input.actor ?? "self"
  const { userId, provider, externalId } = input

  try {
    return await spine.withTransaction(async (txnSpine) => {
      const boundUser = await resolveByAccount(txnSpine, provider, externalId)

      if (boundUser !== null) {
        if (boundUser === userId) {
          // Idempotent re-link → no new write. No audit row (matches the
          // verified-wallet idempotent path: the umbrella row is the
          // verified-wallet flow's affordance; here the caller route emits
          // its own no-op-aware response).
          return {
            ok: true as const,
            userId,
            provider,
            externalId,
            idempotent: true,
          }
        }
        // Bound to a different user → reuse the existing typed collision.
        // walletUser/discordUser fields are repurposed as (attempting, owner)
        // so the route's existing 409 envelope shape is unchanged.
        throw new LinkCrossUserCollisionError(userId, boundUser)
      }

      // Unbound → link it. linkAccountWithAudit emits the account_linked audit
      // row (and conflict_rejected + re-raise on a racing unique violation).
      await linkAccountWithAudit(txnSpine, { userId, provider, externalId, actor })
      return {
        ok: true as const,
        userId,
        provider,
        externalId,
        idempotent: false,
      }
    })
  } catch (err) {
    if (err instanceof LinkCrossUserCollisionError) throw err
    // TOCTOU: the pre-check saw the account unbound, but a concurrent writer
    // linked it in the window before our write — so linkAccountWithAudit
    // re-raised the raw unique-violation. The transaction is rolled back, so
    // re-resolve on the OUTER (fresh) connection to recover the owner and map
    // to the SAME outcome the non-racing path would have produced:
    //   - now owned by us        → idempotent success (concurrent same-user link)
    //   - now owned by another   → cross-user collision → 409
    //   - still unbound          → the error was NOT a collision → re-raise (genuine failure, → 5xx)
    const owner = await resolveByAccount(spine, provider, externalId)
    if (owner === userId) {
      return { ok: true as const, userId, provider, externalId, idempotent: true }
    }
    if (owner !== null) {
      throw new LinkCrossUserCollisionError(userId, owner)
    }
    throw err
  }
}
