/**
 * Linkage ingress — service-to-service write from Sietch verify (SDD §5.5).
 *
 * STUB: T1.1 wires the route; real impl (D8 conflict policy server-side
 * + spine upsert + audit) lands in T4.1 (bead arrakis-hyde).
 *
 * Note: this route is service-to-service (NOT a user session). Auth is
 * bearer/api-key (TBD which header — `X-Service-Token` or `Authorization:
 * Bearer`). Sprint-1.x will codify the chosen mechanism.
 */

import { jsonResponse } from "@hyper/core"
import { z } from "zod"
import { route } from "../../auth"

const NOT_IMPL_T4_1 = { error: "not_implemented", task: "T4.1", bead: "arrakis-hyde" } as const

const LinkVerifiedWalletReq = z.object({
  worldSlug: z.string().regex(/^[a-z0-9-]+$/),
  discordId: z.string().min(1),
  walletAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  dynamicUserId: z.string().min(1).optional(),
})

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
  .handle(() => jsonResponse(501, NOT_IMPL_T4_1))
