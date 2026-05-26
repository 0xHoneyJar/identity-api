/**
 * @freeside-auth/adapters — typed clients implementing ports
 *
 * Per SDD §12.4: ports = interfaces; adapters = implementations.
 * This package contains the wire-side code that fulfills the contracts in
 * @freeside-auth/ports.
 *
 * Slice-B (cycle-B sprint-1) ships:
 * - PostgresSplitAdapter (B-1.3 · this commit · mibera shape)
 *
 * Coming in slice-B:
 * - PostgresUnifiedAdapter (B-2.1 · cubquest multi-chain shape)
 * - JwksValidator (B-1.4 · extracts loa-freeside/packages/adapters/agent/s2s-jwt-validator)
 * - CredentialBridgeDynamic (B-1.4 supporting · Dynamic SDK proof translator)
 *
 * Per Lock-2 (I2 Cyberdeck Seam): SQL + HTTP + RPC are SIDE EFFECTS confined
 * to this package. Pure logic stays in @freeside-auth/engine.
 */

export {
  PostgresSplitAdapter,
  type PgPoolLike,
  type MidiProfileRow,
} from './postgres-split-adapter';

// Spine SoR adapter (T1.5 · the central identity-api write surface)
// Implements SpinePort from @freeside-auth/ports; the port types are
// re-exported here too for ergonomic single-import consumption.
// T1.4 extends with auth_nonces mint/consume (FR-A1).
export {
  PostgresSpineAdapter,
  SpineConflictError,
  type SpineConflictKind,
  type SpineSqlLike,
  // Port types (re-exported through the adapter for caller convenience)
  type SpinePort,
  type SpineLinkedAccountProvider,
  type SpineWallet,
  type SpineLinkedAccount,
  type SpineWorldIdentity,
  type SpineIdentityShape,
  type SpineAuditEvent,
  // T1.4 nonce types
  type SpineNonceScheme,
  type MintNonceInput,
  type MintNonceResult,
  type ConsumeNonceInput,
  type ConsumeNonceResult,
  // Legacy aliases retained for ergonomic in-package naming
  type SpineIdentity,
  type SpineAuditEventInput,
  type LinkedAccountProvider,
} from './postgres-spine-adapter';

// JWKS validator (B-1.4 · per CLAUDE.md royal decree: VALIDATOR not signer)
export {
  JwksValidator,
  type JwksValidatorConfig,
} from './jwks-validator';

// Argon2id pinned parameters (W2.5 T-2.6 · flatline IMP-008)
// Single source of truth for cell_api_keys hash + verify.
export {
  ARGON2ID_PARAMS,
  ARGON2ID_HASH_PREFIX,
  BUN_PASSWORD_HASH_OPTIONS,
} from './argon2-params';

// LocalEs256Signer — ES256 svc-JWT signer (W2.5 T-2.6 · D-1.1 §2)
// Consumed by the /v1/auth/service-jwt route handler.
export {
  createLocalEs256Signer,
  createLocalEs256SignerFromEnv,
  __generateTestEs256KeyMaterial,
  type ServiceJwtSigner,
  type LocalEs256SignerConfig,
} from './local-es256-signer';

// HTTP JWT signer (B-1.4 · §12.3 delegation default · points at loa-freeside/apps/gateway)
export {
  HttpJWTSigner,
  type HttpJWTSignerConfig,
} from './http-jwt-signer';

// Wallet signature verifier (T1.6 · FR-A2 EIP-191 + SIWE recovery)
// viem-backed `recoverMessageAddress` wrapped with strict-format guard +
// catch-all to keep 500s off the auth surface (LBR-3 / verdict-L7 posture).
export {
  verifySignature,
  isValidSignatureFormat,
  addressesEqual,
  type SignatureScheme,
} from './wallet-signature';

// Credential bridge interface (T1.7 · FR-A4 · D3-reframed credential swap)
// Per-scheme verify abstraction with live-path quarantine flag for Dynamic.
// Bridges: SIWE (live), EIP-191 (live), Dynamic (BACKFILL ONLY — no SDK).
export type {
  CredentialBridge,
  CredentialBridgeRegistry,
  CredentialScheme,
  VerifyInput,
  VerifyResult,
  VerifyRejectionReason,
  BridgedLinkedAccount,
  WalletSignatureVerifyInput,
  DynamicBackfillVerifyInput,
} from './credential-bridge';

// Live-path bridges (SIWE + EIP-191) — usableInLivePath: true
export { siweCredentialBridge } from './credential-bridge-siwe';
export { eip191CredentialBridge } from './credential-bridge-eip191';

// Backfill bridge (Dynamic) — usableInLivePath: FALSE per FR-A4.
// Consumed by the T4.4 midi_profiles backfill migration ONLY. The live
// auth path can never reach it (route handler 401s on the flag check).
// NO @dynamic-labs/* import anywhere in this file — quarantine enforced
// by scripts/check-dynamic-quarantine.sh.
export { dynamicCredentialBridge } from './credential-bridge-dynamic';

// ─── Federation HTTP adapters (T2.1 · bead arrakis-ok93) ────────────────────
//
// READ-ONLY HTTP clients for the three upstream freeside buildings
// identity-api federates from for its /v1/profile read-time compose. Per
// FR-P3 no-embed: identity-api stores ZERO holdings/scores/dimensions in
// its spine; we federate-read at compose time.
//
// Each adapter implements its corresponding port from @freeside-auth/ports
// and returns a discriminated-union FederationResult; never throws.
//
// Default URLs per packages/freeside-registry/registry.yaml; per-deploy
// override via env at the singleton-construction site (src/api/{inventory,
// score, codex}.ts).

export {
  HttpInventoryAdapter,
  DEFAULT_INVENTORY_BASE_URL,
  type HttpInventoryAdapterConfig,
} from './http-inventory-adapter';

export {
  HttpScoreAdapter,
  DEFAULT_SCORE_BASE_URL,
  SCORE_API_KEY_HEADER,
  type HttpScoreAdapterConfig,
} from './http-score-adapter';

export {
  HttpCodexAdapter,
  DEFAULT_CODEX_BASE_URL,
  type HttpCodexAdapterConfig,
} from './http-codex-adapter';

// federation-http is the shared HTTP plumbing the three adapters use; the
// FederationLogger type is exported so callers can pass a compatible logger
// surface at adapter construction.
export {
  type FederationLogger,
} from './federation-http';
