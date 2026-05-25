/**
 * @freeside-auth/ports — typed interfaces (no impl)
 *
 * Per SDD §12.4: ports = interfaces; adapters = implementations.
 * Consumers depend on these; adapters in `@freeside-auth/adapters` satisfy them.
 *
 * Slice-B (cycle-B convergence-spine) ships the TenantAdapter port. Future
 * cycles add JWTVerifier port (B-1.4 · in V2 actually since slice-B uses
 * direct lib · not interface yet) and JWTIssuer port.
 */

export {
  type TenantAdapter,
  type TenantConfigShape,
  type TenantUserIdentity,
  type CredentialInput,
  type PingResult,
} from './tenant-adapter.port';

export {
  type JWTSigner,
  SignerError,
} from './jwt-signer.port';

export {
  type JWTVerifier,
  type VerifyResult,
  type VerifyError,
  type RevocationLayer,
} from './jwt-verifier.port';

// Spine SoR port (T1.5 · central identity-api spine; the writer of FR-R6)
export {
  type SpinePort,
  type SpineLinkedAccountProvider,
  type SpineWallet,
  type SpineLinkedAccount,
  type SpineWorldIdentity,
  type SpineIdentityShape,
  type SpineAuditEvent,
} from './spine.port';
