/**
 * Resolve routes — the SoR spine readers (SDD §5.3 / FR-R1..R4).
 *
 * T1.5 (bead arrakis-232n) — wires the four GET endpoints to the engine
 * `resolve-spine.ts` orchestrators backed by the singleton SpinePort.
 *
 * Path params: extracted via `c.params` (Hyper's matched-path map). The
 * Zod validators below double as documentation + future `.params(Schema)`
 * surface; we ALSO validate the runtime values inside each handler since
 * the matcher hands strings through without enforcing the Zod regex.
 *
 * Provider enum: PRD v3.0 §4.2 + the linked_accounts CHECK constraint
 * narrow this to discord|telegram|dynamic_user_id. The previous T1.1 stub
 * permitted `twitter|dynamic` — corrected here to match the storage layer
 * truth (the spine will reject any other value at write time anyway).
 *
 * 404 contract: each resolve endpoint returns 200 `{ user_id }` on hit and
 * 404 `{ error: "not_found" }` on miss. We use 404 rather than 200 + null
 * for consistency with REST idioms and SDK ergonomics (the typed client
 * can throw on 404 cleanly).
 *
 * 400 contract: a malformed path param (e.g., `wallet/notanaddress`) hits
 * the in-handler Zod validate and returns 400 with the structured error
 * envelope.
 */

import { jsonResponse, notFound, badRequest } from "@hyper/core"
import { z } from "zod"
import { route } from "../../auth"
import { getSpine } from "../spine"
import {
  resolveByWallet,
  resolveByAccount,
  resolveByNym,
  getIdentity,
} from "@freeside-auth/engine"
import type { SpineLinkedAccountProvider } from "@freeside-auth/ports"
// T1.10 — path-param schemas hoisted to @freeside-auth/protocol/api so the
// SDK can validate inputs client-side using the same regex/format rules
// the server enforces. Aliased to underscore-prefixed names below for
// minimal diff vs the T1.5 names.
import {
  WalletAddressParamSchema as _WalletAddressParam,
  ProviderParamSchema as _ProviderParam,
  ExternalIdParamSchema as _ExternalIdParam,
  WorldSlugParamSchema as _WorldSlugParam,
  NymParamSchema as _NymParam,
  UserIdParamSchema as _UserIdParam,
} from "@freeside-auth/protocol/api"

// Re-export the schemas under their original names so any downstream
// imports (test files, future docs gen) continue to work unchanged.
export {
  _WalletAddressParam,
  _ProviderParam,
  _ExternalIdParam,
  _WorldSlugParam,
  _NymParam,
  _UserIdParam,
}

// Generic param-handle: validate via Zod, return a Response on failure.
function parseParam<T>(
  schema: z.ZodType<T>,
  raw: unknown,
  paramName: string,
): { ok: true; value: T } | { ok: false; res: Response } {
  const parsed = schema.safeParse(raw)
  if (parsed.success) return { ok: true, value: parsed.data }
  return {
    ok: false,
    res: badRequest({
      code: "invalid_param",
      message: `${paramName} is malformed`,
      param: paramName,
      issues: parsed.error.issues.map((i) => i.message),
    } as never),
  }
}

// ---------------------------------------------------------------------------
// GET /v1/resolve/wallet/:address (FR-R1)
// ---------------------------------------------------------------------------
const ResolveByWalletBody = z.object({}) // GET — no body; shape doc only
export const resolveWallet = route
  .get("/v1/resolve/wallet/:address")
  .body(ResolveByWalletBody)
  .meta({
    summary: "Resolve a wallet address to a user_id",
    mcp: {
      title: "Resolve wallet → user",
      description:
        "Returns the canonical user_id for a wallet address, or 404. Spine-local read (never touches downstream). Per FR-R1.",
    },
  })
  .handle(async (c) => {
    const params = c.params as { address?: string }
    const v = parseParam(_WalletAddressParam, params.address, "address")
    if (!v.ok) return v.res
    const userId = await resolveByWallet(getSpine(), v.value)
    if (!userId) {
      return notFound({ code: "not_found", message: "no user is linked to this wallet" } as never)
    }
    return jsonResponse(200, { user_id: userId })
  })

// ---------------------------------------------------------------------------
// GET /v1/resolve/account/:provider/:externalId (FR-R2)
// ---------------------------------------------------------------------------
const ResolveByAccountBody = z.object({})
export const resolveAccount = route
  .get("/v1/resolve/account/:provider/:externalId")
  .body(ResolveByAccountBody)
  .meta({
    summary: "Resolve a linked-account (discord/telegram/dynamic_user_id) to a user_id",
    mcp: {
      title: "Resolve account → user",
      description:
        "Returns the canonical user_id for a (provider, externalId) tuple, or 404. Per FR-R2.",
    },
  })
  .handle(async (c) => {
    const params = c.params as { provider?: string; externalId?: string }
    const pv = parseParam(_ProviderParam, params.provider, "provider")
    if (!pv.ok) return pv.res
    const ev = parseParam(_ExternalIdParam, params.externalId, "externalId")
    if (!ev.ok) return ev.res
    const userId = await resolveByAccount(
      getSpine(),
      pv.value as SpineLinkedAccountProvider,
      ev.value,
    )
    if (!userId) {
      return notFound({
        code: "not_found",
        message: "no user is linked to this account",
      } as never)
    }
    return jsonResponse(200, { user_id: userId })
  })

// ---------------------------------------------------------------------------
// GET /v1/resolve/nym/:worldSlug/:nym (FR-R3)
// ---------------------------------------------------------------------------
const ResolveByNymBody = z.object({})
export const resolveNym = route
  .get("/v1/resolve/nym/:worldSlug/:nym")
  .body(ResolveByNymBody)
  .meta({
    summary: "Resolve a per-world nym to a user_id",
    mcp: {
      title: "Resolve nym → user",
      description:
        "Returns the canonical user_id for a per-world nym (e.g. mibera display_name), or 404. Per FR-R3.",
    },
  })
  .handle(async (c) => {
    const params = c.params as { worldSlug?: string; nym?: string }
    const sv = parseParam(_WorldSlugParam, params.worldSlug, "worldSlug")
    if (!sv.ok) return sv.res
    const nv = parseParam(_NymParam, params.nym, "nym")
    if (!nv.ok) return nv.res
    const userId = await resolveByNym(getSpine(), sv.value, nv.value)
    if (!userId) {
      return notFound({
        code: "not_found",
        message: "no user claims this nym in this world",
      } as never)
    }
    return jsonResponse(200, { user_id: userId })
  })

// ---------------------------------------------------------------------------
// GET /v1/identity/:userId (FR-R4)
//
// Returns the composite Identity shape per SDD §5.3:
//   { user_id, primary_wallet, wallets[], linked_accounts[], world_identities[] }
//
// Naming: SpineIdentityShape is the port type; the on-wire shape mirrors
// it 1:1 (no transformation). When the sealed
// `packages/protocol/identity-resolution.schema.json` is authored (T2.x or
// the doctor pass), this shape becomes the JSON Schema source of truth and
// the route response asserts against it.
// ---------------------------------------------------------------------------
const GetIdentityBody = z.object({})
export const getIdentityRoute = route
  .get("/v1/identity/:userId")
  .body(GetIdentityBody)
  .meta({
    summary: "Return the full Identity (wallets[], primary, accounts[], worldIdentities[])",
    mcp: {
      title: "Get identity by user_id",
      description:
        "Returns the full Identity for a user_id: wallets, primary flag, accounts, per-world identities. Per FR-R4.",
    },
  })
  .handle(async (c) => {
    const params = c.params as { userId?: string }
    const v = parseParam(_UserIdParam, params.userId, "userId")
    if (!v.ok) return v.res
    const identity = await getIdentity(getSpine(), v.value)
    if (!identity) {
      return notFound({ code: "not_found", message: "no user with that user_id" } as never)
    }
    return jsonResponse(200, identity)
  })

// Backwards-compat export name: T1.1's `getIdentity` was a route stub; the
// engine function of the same name now lives at @freeside-auth/engine. We
// rename the route export to `getIdentityRoute` to avoid the shadow, then
// re-export under the original name so `src/api/index.ts` keeps working.
export { getIdentityRoute as getIdentity }
