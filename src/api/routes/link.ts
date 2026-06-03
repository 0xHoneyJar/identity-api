/**
 * Linkage ingress — service-to-service write from Sietch verify (SDD §5.5 / T4.1).
 *
 * Auth: `X-Service-Token` header. The configured token comes from
 * `LINK_SERVICE_TOKEN` env (production); tests set the env before importing
 * the module. Missing/wrong token → 401 unauthorized.
 *
 * Conflict policy is applied server-side per SDD §8.2 / D8 / cycle-c FR-L3
 * via the injectable `ConflictResolver` strategy (OQ-2 seam). The default
 * `latestWinsResolver` is used by this route; swapping to first-claim-wins
 * is a single function-pointer change.
 *
 * Per FR-C3: hard-fail on `cross_user_collision` returns 409; every other
 * conflict case (rebind, idempotent no-op, create) returns 200.
 */

import { createHash, timingSafeEqual } from "node:crypto"
import { jsonResponse } from "@hyper/core"
import { route } from "../../auth"
import { getSpine } from "../spine"
import {
  linkVerifiedWallet as linkVerifiedWalletOrchestrator,
  linkWalletOnly as linkWalletOnlyOrchestrator,
  LinkCrossUserCollisionError,
} from "@freeside-auth/engine"
import {
  LinkVerifiedWalletReqSchema as LinkVerifiedWalletReq,
  type LinkVerifiedWalletReq as LinkVerifiedWalletReqShape,
  LinkWalletOnlyReqSchema as LinkWalletOnlyReq,
  type LinkWalletOnlyReq as LinkWalletOnlyReqShape,
} from "@freeside-auth/protocol/api"

/**
 * Resolve the service token at request time so tests that set the env
 * variable after module load still work. Production sets it once at boot.
 */
function getServiceToken(): string | null {
  const v = process.env.LINK_SERVICE_TOKEN
  return v && v.length > 0 ? v : null
}

/**
 * Constant-time service-token comparison. Plain `!==` short-circuits on
 * the first differing byte, leaking the configured prefix via timing on a
 * shared-secret auth boundary. Hashing both values to fixed-size SHA-256
 * digests + comparing via `timingSafeEqual` neutralizes the leak (FAGAN
 * iter-1 finding).
 */
function serviceTokenMatches(provided: string | null, configured: string): boolean {
  if (provided === null) return false
  const a = createHash("sha256").update(provided, "utf8").digest()
  const b = createHash("sha256").update(configured, "utf8").digest()
  return timingSafeEqual(a, b)
}

export const linkVerifiedWallet = route
  .post("/v1/link/verified-wallet")
  .body(LinkVerifiedWalletReq)
  .meta({
    summary: "Ingest a verified wallet→discord linkage from Sietch (cycle-c redirect)",
    mcp: {
      title: "Link verified wallet",
      description:
        "Accepts the cycle-c redirected linkage write. Applies D8 / FR-L3 conflict policy server-side: latest-wins single-axis updates; hard-fail on cross_user_collision. Per FR-C1.",
    },
  })
  .handle(async (c) => {
    // Service-to-service auth gate — fail closed if no token is configured.
    // Failing closed in prod is the safer posture (a missing token shouldn't
    // leak as "anyone can write"); fail-closed in dev catches forgetfulness.
    const configured = getServiceToken()
    if (configured === null) {
      return jsonResponse(503, {
        code: "service_unconfigured",
        message: "LINK_SERVICE_TOKEN is not set; refusing service-to-service writes",
      })
    }
    const provided = (
      c as unknown as { req: Request }
    ).req.headers.get("x-service-token")
    if (!serviceTokenMatches(provided, configured)) {
      return jsonResponse(401, {
        code: "unauthorized",
        message: "missing or invalid X-Service-Token",
      })
    }

    const body = (c as unknown as { body: LinkVerifiedWalletReqShape }).body
    try {
      const result = await linkVerifiedWalletOrchestrator(getSpine(), body, {
        actor: "sietch-redirect",
      })
      return jsonResponse(200, {
        ok: true,
        user_id: result.userId,
        wallet_address: result.walletAddress,
        idempotent: result.idempotent,
        conflict_resolved: result.conflictResolved,
      })
    } catch (err) {
      if (err instanceof LinkCrossUserCollisionError) {
        return jsonResponse(409, {
          ok: false,
          conflict: "cross_user_collision",
          message: err.message,
        })
      }
      throw err // unknown failure → 5xx via global error handler
    }
  })

/**
 * POST /v1/link/wallet-only — wallet-only spine ingress (Sprint B part 1).
 *
 * The sibling of `linkVerifiedWallet` for users with NO discord. Same
 * service-to-service auth (`X-Service-Token`), same fail-closed posture.
 *
 * Unlike verified-wallet there is NO 409 path: the engine resolver
 * (`firstClaimResolver`, link-wallet-only.ts:82-97) only produces
 * `create_user | idempotent_noop` — no discord axis means no cross-user
 * collision class — so the handler is a straight call with no try-catch.
 */
export const linkWalletOnly = route
  .post("/v1/link/wallet-only")
  .body(LinkWalletOnlyReq)
  .meta({
    summary: "Ingest a wallet-only linkage (no discord) — mints the world name",
    mcp: {
      title: "Link wallet-only user",
      description:
        "Admits a wallet-only user to the spine and assigns their world name. Mirrors link/verified-wallet MINUS the discord axis. New wallet → create + claim a generated name; known wallet → idempotent no-op. No cross_user_collision on this path.",
    },
  })
  .handle(async (c) => {
    // Service-to-service auth gate — fail closed if no token is configured
    // (mirrors verified-wallet; same shared helpers).
    const configured = getServiceToken()
    if (configured === null) {
      return jsonResponse(503, {
        code: "service_unconfigured",
        message: "LINK_SERVICE_TOKEN is not set; refusing service-to-service writes",
      })
    }
    const provided = (
      c as unknown as { req: Request }
    ).req.headers.get("x-service-token")
    if (!serviceTokenMatches(provided, configured)) {
      return jsonResponse(401, {
        code: "unauthorized",
        message: "missing or invalid X-Service-Token",
      })
    }

    const body = (c as unknown as { body: LinkWalletOnlyReqShape }).body
    const result = await linkWalletOnlyOrchestrator(getSpine(), body, {
      actor: "wallet-only-ingress",
    })
    return jsonResponse(200, {
      ok: true,
      user_id: result.userId,
      wallet_address: result.walletAddress,
      idempotent: result.idempotent,
      generated_name: result.generatedName,
    })
  })

