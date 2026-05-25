/**
 * credential-bridge.ts — shared `CredentialBridge` interface (T1.7).
 *
 * The single seam through which the /v1/auth/verify handler dispatches
 * signature/proof verification. Each scheme has its own implementation:
 *
 *   • `credential-bridge-siwe.ts`   — SIWE  (live path)
 *   • `credential-bridge-eip191.ts` — EIP-191 (live path)
 *   • `credential-bridge-dynamic.ts`— dynamic_user_id (BACKFILL ONLY)
 *
 * Doctrine — D3-reframed (PRD §3): "swap the CREDENTIAL layer (Dynamic →
 * SIWE-direct), NOT delete the identity layer." `dynamic_user_id` demotes
 * from resolve-Tier-1 to a backfill credential. The Dynamic SDK MUST NOT
 * be imported anywhere in the live auth path (enforced at quarantine
 * gate `scripts/check-dynamic-quarantine.sh`).
 *
 * FR-A4 (PRD §4.3): `credential-bridge-dynamic` retained for backfill
 * only; `dynamic_user_id` lands in `linked_accounts` (provider =
 * 'dynamic_user_id') via the T4.4 one-time backfill migration. No
 * Dynamic SDK in the live credential path.
 *
 * Design intent — `usableInLivePath` is the load-bearing flag. The route
 * handler checks it BEFORE calling `verify()` and returns 401 instantly
 * (`scheme_not_allowed_in_live_path`) for any bridge whose flag is false.
 * This is a per-bridge invariant declared at the type level so adding a
 * new credential scheme requires an explicit, code-review-visible decision
 * about its live-path eligibility — not a forgotten default.
 *
 * Why a single interface (not per-scheme function shapes)?
 *   - The route handler dispatches by scheme; uniform shape lets the
 *     handler treat each bridge as an opaque black box (no per-scheme
 *     conditional branches at the call site beyond bridge SELECTION).
 *   - The audit-emit layer (in the route handler) consumes `VerifyResult`
 *     uniformly — `reason` strings stay consistent across schemes, so a
 *     single audit_events.payload.reason column carries every rejection.
 *   - Future credentials (passkey, email, ERC-1271) add a new module +
 *     register; no router rewrite.
 *
 * Why NOT just pass `verifySignature` directly (the T1.6 inline shape)?
 *   - The Dynamic bridge has a different input shape — it doesn't consume
 *     a wallet signature at all; it consumes a `(dynamic_user_id, wallet)`
 *     pair from a backfill source row and emits a `linked_account`. A
 *     single function signature can't model both without becoming a tagged
 *     union that's harder to read than the bridge-per-scheme split.
 *   - Live-path quarantine becomes a per-bridge static flag rather than
 *     a runtime check scattered across the route handler.
 *
 * NO audit-emit happens inside a bridge. The route handler emits
 * `auth_signature_rejected` on the route side — bridges are pure
 * verifiers + result shapers. (Double-emit would break the T1.6 audit
 * chain's one-event-per-rejection invariant.)
 */

// ─── scheme enumeration ────────────────────────────────────────────────────

/**
 * Every credential scheme the building knows about.
 *
 *   - `siwe`              — EIP-4361 SIWE message + secp256k1 signature.
 *                           Live path. Primary credential per G-3.
 *   - `eip191`            — Plain personal_sign of an opaque string +
 *                           secp256k1 signature. Live path. Legacy /
 *                           non-SIWE clients.
 *   - `dynamic_user_id`   — A `dynamic_user_id` string extracted from a
 *                           backfill source (e.g., mibera-db's
 *                           `dynamic_users` table) paired with the
 *                           wallet that row already attests. BACKFILL
 *                           ONLY. The bridge does NOT call the Dynamic
 *                           SDK; it processes already-extracted IDs.
 */
export type CredentialScheme = "siwe" | "eip191" | "dynamic_user_id"

// ─── verify input ──────────────────────────────────────────────────────────

/**
 * Wallet-signature input shape. Used by SIWE + EIP-191 bridges.
 *
 *   - `message`        — The exact string the wallet was asked to sign
 *                        (the verbatim `message` returned by /challenge).
 *   - `signature`      — Hex signature, 0x-prefixed, 132 chars (65 bytes).
 *   - `expectedAddress`— The wallet the verifier expects to recover.
 *                        Case-insensitive comparison.
 */
export interface WalletSignatureVerifyInput {
  readonly message: string
  readonly signature: string
  readonly expectedAddress: string
}

/**
 * Dynamic backfill input shape. Used by the Dynamic bridge — NOT consumed
 * by the live auth path.
 *
 *   - `dynamicUserId`  — The opaque dynamic_user_id string already
 *                        extracted from the backfill source row. The
 *                        bridge does NOT validate that this corresponds
 *                        to a live Dynamic session — it accepts the
 *                        attestation of the backfill source.
 *   - `walletAddress`  — The wallet the backfill source row attests is
 *                        bound to that dynamic_user_id. The pair is the
 *                        unit of trust that the T4.4 migration ingests.
 */
export interface DynamicBackfillVerifyInput {
  readonly dynamicUserId: string
  readonly walletAddress: string
}

/**
 * Discriminated verify input — scheme tags the payload shape.
 *
 * Each bridge enforces its own scheme tag at the type level; passing a
 * mismatched payload to a bridge is a static error (and the bridge
 * defensively returns `{ok: false, reason: 'scheme_mismatch'}` at
 * runtime to catch any caller bug that slipped through).
 */
export type VerifyInput =
  | ({ readonly scheme: "siwe" } & WalletSignatureVerifyInput)
  | ({ readonly scheme: "eip191" } & WalletSignatureVerifyInput)
  | ({ readonly scheme: "dynamic_user_id" } & DynamicBackfillVerifyInput)

// ─── verify result ─────────────────────────────────────────────────────────

/**
 * Linked-account row to mint alongside the resolved wallet. Returned ONLY
 * by the backfill bridge — wallet-signature bridges (SIWE/EIP-191)
 * recover an EOA and have nothing else to mint.
 *
 * Maps onto the spine's `linked_accounts` row shape:
 *   { user_id, provider, external_id, verified_at, … }
 *
 * The bridge supplies `provider` + `external_id`; the engine (resolve-
 * spine.ts) attaches `user_id` and `verified_at` at mint time.
 */
export interface BridgedLinkedAccount {
  readonly provider: string
  readonly externalId: string
}

/**
 * Possible reasons a bridge can reject. Strings are stable across bridges
 * so the audit row's `payload.reason` column carries a consistent
 * vocabulary across credential schemes. Adding a new reason is a typed
 * decision (extend this union).
 *
 *   - `malformed_signature`           — Wrong-length / non-hex / missing 0x.
 *   - `signature_mismatch`            — Recovered address ≠ expected.
 *   - `recover_error`                 — viem threw mid-recovery (bad r/s/v).
 *   - `scheme_mismatch`               — Caller passed a different scheme
 *                                       payload than the bridge handles
 *                                       (caller-bug guard; should never
 *                                       fire in normal operation).
 *   - `wallet_mismatch`               — Bridge-internal cross-check (e.g.,
 *                                       SIWE message's `Address:` line vs
 *                                       expectedAddress) failed.
 *   - `siwe_parse_error`              — SIWE message did not lex / parse.
 *   - `invalid_dynamic_user_id`       — Backfill bridge: input string is
 *                                       not a syntactically valid id.
 *   - `invalid_wallet_address`        — Backfill bridge: paired wallet is
 *                                       not a 0x-20-byte hex string.
 */
export type VerifyRejectionReason =
  | "malformed_signature"
  | "signature_mismatch"
  | "recover_error"
  | "scheme_mismatch"
  | "wallet_mismatch"
  | "siwe_parse_error"
  | "invalid_dynamic_user_id"
  | "invalid_wallet_address"

/**
 * Result of a bridge's verify(). Discriminated by `ok`.
 *
 * Successful verifies always carry a `walletAddress` (the canonical
 * subject identity in the wallet-first scheme). Backfill bridges
 * additionally carry a `linkedAccount` to mint into `linked_accounts`.
 */
export type VerifyResult =
  | {
      readonly ok: true
      readonly walletAddress: string
      readonly linkedAccount?: BridgedLinkedAccount
    }
  | {
      readonly ok: false
      readonly reason: VerifyRejectionReason
    }

// ─── the bridge interface ──────────────────────────────────────────────────

/**
 * A credential bridge: a uniform `(verify) → result` shape per scheme.
 *
 * Implementations MUST:
 *   1. Pin `scheme` to a single `CredentialScheme` value.
 *   2. Declare `usableInLivePath` honestly. The route handler checks this
 *      and 401-instant for any false bridge — so a bridge that lies about
 *      its eligibility lets the Dynamic SDK quarantine fail open.
 *   3. Refuse mismatched payloads with `{ok: false, reason:
 *      'scheme_mismatch'}` (defense-in-depth; the type system should
 *      catch this first).
 *   4. NOT emit audit events. Rejection auditing happens in the route
 *      handler (it has the request context the bridge doesn't).
 *   5. NOT throw on caller input. All attacker-controlled-input failures
 *      map to `{ok: false}` so the route returns 401 (NEVER 500).
 *
 * The interface is sync-free at the type level — `verify` returns a
 * Promise to leave room for future bridges that need async work (e.g.,
 * ERC-1271 contract-wallet dispatch in Sprint-1.x).
 */
export interface CredentialBridge {
  /** Which scheme this bridge handles. */
  readonly scheme: CredentialScheme

  /**
   * Whether the route handler at /v1/auth/verify may invoke this bridge.
   *
   * SIWE + EIP-191 = true (live wallet-first auth).
   * Dynamic       = false (backfill migration only).
   *
   * The route handler MUST check this BEFORE calling verify(). A bridge
   * with `usableInLivePath: false` reaching verify() at the route layer
   * is a routing bug — the bridge defensively still refuses to verify in
   * its own scope (test coverage asserts this), but the route should
   * never get there.
   */
  readonly usableInLivePath: boolean

  /**
   * Verify the credential. Discriminated `VerifyInput` tags the payload
   * shape; bridges narrow on `scheme` and validate their own contract.
   */
  verify(input: VerifyInput): Promise<VerifyResult>
}

// ─── helper for route handler ──────────────────────────────────────────────

/**
 * Convenience type for the route handler's bridge registry. Keys are
 * schemes; values are bridges. The handler does:
 *
 *   const bridge = registry[body.scheme]
 *   if (!bridge.usableInLivePath) → 401 scheme_not_allowed_in_live_path
 *   const result = await bridge.verify(buildInput(body, scheme))
 *
 * The registry's exhaustiveness over `CredentialScheme` is enforced by
 * the `Record<CredentialScheme, ...>` index type at the route layer.
 */
export type CredentialBridgeRegistry = Readonly<Record<CredentialScheme, CredentialBridge>>
