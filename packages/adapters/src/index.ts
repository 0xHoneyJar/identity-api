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
export {
  PostgresSpineAdapter,
  SpineConflictError,
  type SpineConflictKind,
  type SpineSqlLike,
  type SpineIdentity,
  type SpineWalletRow,
  type SpineLinkedAccountRow,
  type SpineWorldIdentityRow,
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
