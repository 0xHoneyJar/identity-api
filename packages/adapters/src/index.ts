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
