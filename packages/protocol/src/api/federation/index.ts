/**
 * Federation contract barrel — re-exports the cross-building wire shapes
 * consumed by identity-api's `/v1/profile` (T2.3) read-time compose.
 *
 * Per T2.1 (bead arrakis-ok93): three buildings, three shapes:
 *   - inventory-api (wallet holdings) — Mibera-first, Alchemy replacement
 *   - score-api     (numeric scoring + factor breakdowns)
 *   - mibera-codex  (per-tokenId 7-dim profile + grail bindings)
 *
 * Each shape lives in its own file with full provenance docstring (the
 * source-of-truth path inside each upstream building's local checkout,
 * the discovery-decision tree, the integration-gap notes). This barrel
 * is the single import surface T2.2's compose-fan-out reaches for.
 *
 * Naming: federation/* keeps the cross-building shapes separate from the
 * first-party shapes (auth.ts, resolve.ts, profile.ts, link.ts) which are
 * owned BY identity-api. Federation = consumed FROM other buildings.
 */

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
} from "./inventory"

export {
  ScoreCrowdTierSchema,
  ScoreEliteTierSchema,
  ScoreTrustClassificationSchema,
  ScoreGetWalletPathSchema,
  ScoreGetWalletRespSchema,
  ScoreResolveIdentityReqSchema,
  ResolvedIdentitySchema,
  ScoreResolveIdentityRespSchema,
  type ScoreCrowdTier,
  type ScoreEliteTier,
  type ScoreTrustClassification,
  type ScoreGetWalletPath,
  type ScoreGetWalletResp,
  type ScoreResolveIdentityReq,
  type ResolvedIdentity,
  type ScoreResolveIdentityResp,
} from "./score"

export {
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
} from "./codex"
