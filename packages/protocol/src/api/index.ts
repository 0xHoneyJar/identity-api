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
  type ChallengeReqValidated,
  type ChallengeResp,
  type VerifyReq,
  type VerifyReqValidated,
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
  LinkVerifiedWalletConflictSchema,
  type LinkVerifiedWalletReq,
  type LinkVerifiedWalletResp,
  type LinkVerifiedWalletConflict,
} from "./link"

// ─── CM→world authorization read (C-2 · bead arrakis-491i) ───────────────────
export {
  ManagedWorldSchema,
  ManagedWorldsRespSchema,
  type ManagedWorld,
  type ManagedWorldsResp,
} from "./users"

// ─── federation contracts (T2.1) ────────────────────────────────────────────
//
// Cross-building wire shapes consumed by identity-api's /v1/profile read-time
// compose at T2.3. These are NOT first-party identity-api endpoints — they
// describe what we expect when we call OUT to the other freeside buildings
// (inventory-api / score-api / mibera-codex). See provenance docstrings in
// each `./federation/<bldg>.ts` file for source-of-truth references.
//
// Re-exported through the federation subdir barrel (./federation/index.ts) so
// consumers can `import { InventoryGetHoldingsRespSchema, ... } from
// "@freeside-auth/protocol/api"` or, more narrowly,
// `import { ... } from "@freeside-auth/protocol/api/federation"`.

export {
  InventoryAttributeSchema,
  InventoryCompletenessSchema,
  InventoryContractHoldingSchema,
  InventoryGetHoldingsPathSchema,
  InventoryGetHoldingsRespSchema,
  type InventoryAttribute,
  type InventoryCompleteness,
  type InventoryContractHolding,
  type InventoryGetHoldingsPath,
  type InventoryGetHoldingsResp,
  ScoreCrowdTierSchema,
  ScoreEliteTierSchema,
  ScoreTrustClassificationSchema,
  ScoreGetWalletPathSchema,
  ScoreGetWalletRespSchema,
  type ScoreCrowdTier,
  type ScoreEliteTier,
  type ScoreTrustClassification,
  type ScoreGetWalletPath,
  type ScoreGetWalletResp,
  CodexArchetypeSchema,
  CodexElementSchema,
  CodexSwagRankSchema,
  CodexGetMiberaPathSchema,
  CodexGetMiberaBatchReqSchema,
  CodexMiberaEntrySchema,
  CodexGetMiberaRespSchema,
  CodexGetMiberaBatchRespSchema,
  type CodexArchetype,
  type CodexElement,
  type CodexSwagRank,
  type CodexGetMiberaPath,
  type CodexGetMiberaBatchReq,
  type CodexMiberaEntry,
  type CodexGetMiberaResp,
  type CodexGetMiberaBatchResp,
} from "./federation/index"
