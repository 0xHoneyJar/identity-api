/**
 * @freeside-auth/protocol/api — Zod schemas for every public HTTP route.
 *
 * Pattern B (T1.10): the server routes AND the SDK both import schemas
 * from here. Single source of truth; no codegen step; client-side typing
 * is derived via `z.infer<>` at the consumer's `tsc` pass.
 *
 * Adding a new route?
 *   1. Author its Req/Resp Zod schemas here (FILE per route family).
 *   2. Server: `import { … } from "@freeside-auth/protocol/api"` at the
 *      route file, pass the Req schema to Hyper's `.body(...)`.
 *   3. SDK: extend `packages/sdk/src/types.ts` with `z.infer<typeof …>`
 *      re-exports, then add the typed method to the client factory.
 */

export {
  ChallengeReqSchema,
  ChallengeRespSchema,
  VerifyReqSchema,
  VerifyRespSchema,
  type ChallengeReq,
  type ChallengeResp,
  type VerifyReq,
  type VerifyResp,
} from "./auth"

export {
  WalletAddressParamSchema,
  ProviderParamSchema,
  ExternalIdParamSchema,
  WorldSlugParamSchema,
  NymParamSchema,
  UserIdParamSchema,
  ResolveHitRespSchema,
  IdentityWalletSchema,
  IdentityLinkedAccountSchema,
  IdentityWorldIdentitySchema,
  IdentityRespSchema,
  type ResolveProvider,
  type ResolveHitResp,
  type IdentityWallet,
  type IdentityLinkedAccount,
  type IdentityWorldIdentity,
  type IdentityResp,
} from "./resolve"

export {
  ProfileQuerySchema,
  ProfileRespSchema,
  MiberaDimensionsQuerySchema,
  MiberaDimensionsRespSchema,
  type ProfileQuery,
  type ProfileResp,
  type MiberaDimensionsQuery,
  type MiberaDimensionsResp,
} from "./profile"

export {
  LinkVerifiedWalletReqSchema,
  LinkVerifiedWalletRespSchema,
  type LinkVerifiedWalletReq,
  type LinkVerifiedWalletResp,
} from "./link"
