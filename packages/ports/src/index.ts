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
// Extended in T1.4 with auth_nonces lifecycle (mintNonce / consumeNonce).
export {
  type SpinePort,
  type SpineLinkedAccountProvider,
  type SpineWallet,
  type SpineLinkedAccount,
  type SpineWorldIdentity,
  // C-2 (bead arrakis-491i) — CM→world authorization relation read shape
  type SpineManagedWorld,
  type SpineIdentityShape,
  type SpineAuditEvent,
  // T1.4 nonce lifecycle types (FR-A1)
  type SpineNonceScheme,
  type MintNonceInput,
  type MintNonceResult,
  type ConsumeNonceInput,
  type ConsumeNonceResult,
} from './spine.port';

// ─── Federation client ports (T2.1 · bead arrakis-ok93) ─────────────────────
//
// Per PRD v3.0 §4.5 (FR-P1..P4) + SDD §5.4: identity-api federates the
// `/v1/profile` read-time compose (T2.3) over three upstream buildings —
// inventory-api, score-api, mibera-codex. These are READ-ONLY federation
// client surfaces; the data lives upstream (no-embed invariant FR-P3).
//
// Each port specifies the contract; HTTP adapter impls live in
// @freeside-auth/adapters; T2.2 (compose orchestrator) consumes the ports
// via dependency injection.

// Shared infrastructure
export {
  type PortFetchLike,
  type PortCallOpts,
} from './port-opts';
export {
  type FederationFailureKind,
  type FederationFailure,
  type FederationResult,
} from './federation-result';

// inventory-api federation port — wallet holdings (Mibera primary).
export {
  type InventoryPort,
  type InventoryGetHoldingsInput,
} from './inventory.port';

// score-api federation port — V8 numeric scoring + tier surfaces.
export {
  type ScorePort,
  type ScoreGetScoreInput,
} from './score.port';

// mibera-codex federation port — per-tokenId 7-dim Mibera profile.
export {
  type CodexPort,
  type CodexGetMiberaTraitsInput,
  type CodexMiberaEntry,
} from './codex.port';
