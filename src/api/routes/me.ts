/**
 * /v1/me — JWT-bearer authenticated identity (SDD §5.2 / FR-A3).
 *
 * STUB: T1.1 stands this up gated by .auth() so the L4 fix (installAuthMethod
 * pre-installed via src/auth.ts) is exercised end-to-end. Real impl lands in
 * T1.5 (bead arrakis-232n, resolve core).
 *
 * .auth() comes from RouteBuilder.prototype.auth — runtime-patched at module
 * load when src/auth.ts is imported. The type system doesn't see it; we
 * cast through the chain point per the verdict's L4 workaround pattern
 * (until upstream Hyper fixes the .d.ts).
 */

import { jsonResponse } from "@hyper/core"
import { route } from "../../auth"

const NOT_IMPL_T1_5 = { error: "not_implemented", task: "T1.5", bead: "arrakis-232n" } as const

const meBuilder = route
  .get("/v1/me")
  .meta({
    summary: "Return the JWT-bearing caller's user_id + primary wallet",
    mcp: {
      title: "Get authenticated identity",
      description: "Returns the user_id and primary wallet for the bearer-JWT holder. Per FR-A3.",
    },
  }) as unknown as { auth: () => typeof routeBuilderShim }

declare const routeBuilderShim: {
  handle: (h: () => unknown) => unknown
}

export const me = meBuilder.auth().handle(() => jsonResponse(501, NOT_IMPL_T1_5))
