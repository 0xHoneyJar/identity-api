/**
 * @freeside-auth/protocol — sealed identity schemas
 *
 * Wire-format contracts for the identity overlay. Bridges every freeside-auth
 * consumer (worlds, ruggy, future persona-bots, dashboards, the loa-freeside
 * gateway) to a single coherent vocabulary.
 *
 * Per freeside-auth/CLAUDE.md:
 * - Schemas live here, profile DATA stays in midi (single-writer)
 * - JWKS issuance stays at loa-freeside/apps/gateway (Rust signer)
 * - This module ships VALIDATOR + claims schema, NOT a signer
 *
 * Per Lock-9 (SDD §12.7): JSON Schema (.schema.json) is the canonical
 * cross-language contract; Zod (.ts) is the TS binding. Conflicts → JSON
 * Schema wins.
 *
 * Slice-B (cycle-B convergence-spine) ships 7 of 11 README-planned schemas.
 * Deferred for V2: credential-siwe, credential-passkey, credential-seedvault,
 * event.
 */

// Branded primitives
export {
  UserId,
  WalletAddress,
  CredentialId,
  TenantSlug,
  MiberaId,
  DiscordId,
  type ChainId,
  type Tier as TierType,
} from './types';

// Wallet entity
export {
  WalletSchema,
  ChainSchema,
  VerifiedViaSchema,
  type Wallet,
  type Chain,
  type VerifiedVia,
} from './wallet';

// User entity
export {
  UserSchema,
  TenantSlugSchema,
  type User,
} from './user';

// IdentityComponent
export {
  IdentityComponentSchema,
  CredentialTypeSchema,
  BoundCredentialSchema,
  type IdentityComponent,
  type CredentialType,
  type BoundCredential,
} from './identity-component';

// JWT claims (THE central one · mirrors loa-freeside/apps/gateway shape)
export {
  JWTClaimSchema,
  JWTWalletSchema,
  TierSchema,
  assertTenantBoundary,
  TenantAssertionError,
  type JWTClaim,
  type JWTWallet,
  type Tier,
} from './jwt-claims';

// svc-JWT claims (W2.5 cluster-auth · cell-to-cell service tokens)
// First Effect.Schema artifact; sits beside the W2 zod JWTClaimSchema above
// per operator-memory freeside-effect-transition (2026-05-26).
//
// W2.5 T-2.6 (bead arrakis-ha0l): thin sync-wrapper validation helpers
// (`decodeSvcJwtClaims`, `decodeSvcJwtHeader`) provide a non-Effect-aware
// API for consumers (e.g., the route handler at src/api/) that live outside
// the workspace tree where @effect/schema resolves.
export {
  SvcJwtClaims,
  SvcJwtHeader,
  decodeSvcJwtClaims,
  decodeSvcJwtHeader,
  type SchemaValidationResult,
} from './svc-jwt-claims';

// Credential proofs (slice-B: Dynamic only · siwe/passkey/seedvault V2)
export {
  DynamicCredentialProofSchema,
  DynamicVerifiedCredentialSchema,
  type DynamicCredentialProof,
  type DynamicVerifiedCredential,
} from './credential-dynamic';

// Resolve result
export {
  ResolveResultSchema,
  ResolvedViaSchema,
  type ResolveResult,
  type ResolvedVia,
} from './resolve-result';
