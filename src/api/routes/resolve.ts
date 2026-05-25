/**
 * Resolve routes — the SoR spine readers (SDD §5.3 / FR-R1..R4).
 *
 * STUB: T1.1 stands these up; real spine reads land in T1.5 (bead arrakis-232n).
 * Each route declares the wallet/account/nym path-param shape via Zod so OpenAPI
 * + future typed client receive the param documentation.
 *
 * Path params in Hyper are picked up from the path string itself. Body schemas
 * are declared via `.body()`; per-param schemas are declared via meta tags
 * (or come through Zod via the runtime parse — Hyper does not yet have a
 * `.params()` builder method).
 *
 * For the request "shape" guarantee in OpenAPI emit, we also declare the
 * params via Zod here as documentation; future Hyper versions may pick this
 * up natively.
 */

import { jsonResponse } from "@hyper/core"
import { z } from "zod"
import { route } from "../../auth"

const NOT_IMPL_T1_5 = { error: "not_implemented", task: "T1.5", bead: "arrakis-232n" } as const

// Zod schemas — documenting the expected URL-shape; `.body(WalletParamShape)`
// would normally validate request body, but for GET routes we declare these
// as the canonical type contract that the future client/SDK will derive from.
// When Hyper ships `.params(Schema)`, swap these in.
export const _WalletAddressParam = z.string().regex(/^0x[a-fA-F0-9]{40}$/, "0x-prefixed 20-byte hex")
export const _ProviderParam = z.enum(["discord", "telegram", "twitter", "dynamic"])
export const _ExternalIdParam = z.string().min(1)
export const _WorldSlugParam = z
  .string()
  .regex(/^[a-z0-9-]+$/, "lowercase, digits, hyphen only")
export const _NymParam = z.string().regex(/^[a-zA-Z0-9_]+$/, "alphanum + underscore").min(3).max(20)
export const _UserIdParam = z.string().uuid()

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
        "Returns the canonical user_id for a wallet address, or null. Spine-local read (never touches downstream). Per FR-R1.",
    },
  })
  .handle(() => jsonResponse(501, NOT_IMPL_T1_5))

// ---------------------------------------------------------------------------
// GET /v1/resolve/account/:provider/:externalId (FR-R2)
// ---------------------------------------------------------------------------
const ResolveByAccountBody = z.object({})
export const resolveAccount = route
  .get("/v1/resolve/account/:provider/:externalId")
  .body(ResolveByAccountBody)
  .meta({
    summary: "Resolve a linked-account (discord/telegram/twitter/dynamic) to a user_id",
    mcp: {
      title: "Resolve account → user",
      description:
        "Returns the canonical user_id for a (provider, externalId) tuple, or null. Per FR-R2.",
    },
  })
  .handle(() => jsonResponse(501, NOT_IMPL_T1_5))

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
        "Returns the canonical user_id for a per-world nym (e.g. mibera display_name), or null. Per FR-R3.",
    },
  })
  .handle(() => jsonResponse(501, NOT_IMPL_T1_5))

// ---------------------------------------------------------------------------
// GET /v1/identity/:userId (FR-R4)
//
// Renamed leaf to /v1/identity/by-id/:userId would dodge L9 — but T1.1
// scope-locks to "stub the SDD endpoints verbatim". Codegen for this
// single-leaf path is fine; L9 (namespace-overshadow) only bites when a
// bare path AND its child both exist. /v1/identity has no sibling here.
// ---------------------------------------------------------------------------
const GetIdentityBody = z.object({})
export const getIdentity = route
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
  .handle(() => jsonResponse(501, NOT_IMPL_T1_5))
