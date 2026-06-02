/**
 * @freeside-auth/engine — orchestration layer for identity overlay
 *
 * Per SDD §12.4: engine = orchestrators (registry · resolve-tier · mint-jwt).
 * Composes ports + adapters + protocol schemas.
 *
 * Slice-B (cycle-B sprint-1) ships:
 * - TenantRegistry (B-1.2 · this commit)
 * - tenants.yaml (8 tenants · 2 active · 6 declarative)
 * - TenantConfig schema (5-axis declaration)
 *
 * Coming in slice-B sprint-1:
 * - resolve-tier.ts (B-1.3 supporting · 4-tier fallback algorithm)
 * - mint-jwt-orchestrator.ts (B-1.4 · §12.3 delegation pattern)
 *
 * Per CLAUDE.md royal decree: no JWT signing here. Mint orchestrator
 * resolves identity + constructs claims + delegates signing to
 * loa-freeside/apps/gateway (Rust).
 */

// Tenant registry (B-1.2)
export {
  TenantRegistry,
  TenantRegistryConfigError,
  UnknownTenantError,
  type TenantAdapterFactory,
} from './tenant-registry';

// TenantConfig schemas (B-1.2)
export {
  TenantConfigSchema,
  TenantRegistryFileSchema,
  TenantSubstrateSchema,
  TenantTableShapeSchema,
  TenantChainSchema,
  TenantConnectionSchema,
  TenantUserTableSchema,
  type TenantConfig,
  type TenantSubstrate,
  type TenantTableShape,
  type TenantChain,
  type TenantRegistryFile,
} from './tenant-config';

// Mint orchestrator (B-1.4)
export {
  MintJWTOrchestrator,
  MintError,
  type MintRequest,
  type MintResult,
  type MintOrchestratorConfig,
} from './mint-jwt-orchestrator';

// Spine resolvers + write orchestrators (T1.5 · the central SoR engine seam)
// T1.6: + WalletLinkRaceError for the LBR-1 transactional retry signal.
export {
  resolveByWallet,
  resolveByAccount,
  resolveByNym,
  getIdentity,
  mintUser,
  linkWalletWithAudit,
  linkAccountWithAudit,
  claimNymWithAudit,
  setPrimaryWithAudit,
  resolveOrMintByWallet,
  normalizeAddress,
  WalletLinkRaceError,
  type AuditActor,
} from './resolve-spine';

// Per-wallet merge resolver (bd-2wo.38.2 · POST /v1/identity/resolve).
// Pure: joins spine identity + score-api onchain enrichment and applies the
// display-name priority ONCE (world_nym > discord > score > address).
export {
  mergeIdentity,
  type MergeIdentityInput,
} from './merge-identity';

// Auth nonce orchestrators (T1.4 · FR-A1 lifecycle: mint + atomic consume +
// audit pairing). T1.6's /v1/auth/challenge + /v1/auth/verify import from here.
export {
  mintAuthNonce,
  consumeAuthNonce,
  type MintAuthNonceOpts,
  type ConsumeAuthNonceOpts,
} from './auth-nonces';

// Compose primitives (T2.2 · per-source timeout + in-memory circuit-breaker).
// Consumed by `compose-profile.ts` (T2.2 orchestrator) and re-exportable for
// any future fan-out orchestrator that needs the same wire primitives.
export {
  withTimeout,
  type TimeoutHandle,
} from './with-timeout';
export {
  CircuitBreaker,
  type CircuitBreakerOpts,
  type CircuitBreakerState,
} from './circuit-breaker';

// Compose orchestrator (T2.2 · read-time fan-out for /v1/profile).
// The brain of FR-P1/P2/P3/D6/D8. Takes a wallet or user_id, resolves the
// spine identity, fans out to inventory + score + codex with per-source
// AbortController + circuit-breaker, returns a sealed ProfileResp with
// degraded[] populated for any source that missed.
export {
  composeProfile,
  // Shared helpers — also imported by composeMiberaDimensions (T3.1) so the
  // two orchestrators agree on spine resolution + Mibera filter + breaker
  // discipline + degraded[] label format.
  resolveSpineIdentity,
  extractMiberaTokens,
  circuitOpenFailure,
  recordOutcome,
  labelFor,
  type ComposeProfileDeps,
  type ComposeProfileOpts,
  type ComposeProfileInput,
  type SourceLabel,
} from './compose-profile';

// Mibera dimensions orchestrator (T3.1 · read-time spine → inventory → codex
// for /v1/mibera/dimensions). Headline G-6 building block — honey-road
// renders 7-dim Mibera profiles sourced from this orchestrator, NOT Alchemy.
export {
  composeMiberaDimensions,
  type ComposeMiberaDimensionsDeps,
  type ComposeMiberaDimensionsOpts,
  type ComposeMiberaDimensionsInput,
} from './compose-mibera-dimensions';

// Link-verified-wallet orchestrator (T4.1 · POST /v1/link/verified-wallet).
// The cycle-c redirect ingress — receives verified linkage writes from
// Sietch, applies D8/FR-L3 conflict policy server-side (injectable resolver
// per OQ-2), upserts spine atomically, audits every outcome.
export {
  linkVerifiedWallet,
  latestWinsResolver,
  LinkCrossUserCollisionError,
  type LinkVerifiedWalletInput,
  type LinkVerifiedWalletResult,
  type ConflictState,
  type ConflictDecision,
  type ConflictResolver,
} from './link-verified-wallet';

// Link-verified-credential (bd-2wo.14 · Discord-social OAuth-verification
// front-end). The SESSION-keyed sibling of linkVerifiedWallet — composes the
// SAME resolveByAccount + linkAccountWithAudit primitives + reuses
// LinkCrossUserCollisionError. No new minting/collision/idempotency logic.
export {
  linkVerifiedCredential,
  type LinkVerifiedCredentialInput,
  type LinkVerifiedCredentialResult,
} from './link-verified-credential';
