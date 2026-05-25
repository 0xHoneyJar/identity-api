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
  WalletLinkRaceError,
  type AuditActor,
} from './resolve-spine';

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
