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
