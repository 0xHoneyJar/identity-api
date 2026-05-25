/**
 * Error class hierarchy for @freeside-auth/identity-client.
 *
 * The SDK turns HTTP failures into typed exceptions so callers can do
 * narrow catches against well-defined classes. Mirrors the server's error
 * envelope (per T1.6 SDD §5.6 + the wire shape jsonResponse(...) emits):
 *
 *   { error: <kind>, code: <machine-readable>, message?: <human>, request_id? }
 *
 * Hierarchy:
 *
 *   IdentityApiError                  (base; HTTP 4xx/5xx with an envelope)
 *     ├── UnauthorizedError           (401  → caller can prompt re-auth)
 *     ├── ConflictError               (409  → cross_user_collision etc.)
 *     ├── ValidationError             (400  → malformed request)
 *     ├── NotImplementedError         (501  → stub endpoint awaiting T2.3/T3.2/T4.1)
 *     └── (other 4xx/5xx fall through as bare IdentityApiError)
 *
 *   NetworkError                      (no response — DNS/socket/abort)
 *
 * The catch-block discipline for SDK consumers:
 *
 *   try {
 *     const { user_id } = await client.auth.verify({...});
 *   } catch (e) {
 *     if (e instanceof UnauthorizedError) return prompt_resign();
 *     if (e instanceof ConflictError)     return show_conflict_help(e.code);
 *     if (e instanceof NetworkError)      return retry_with_backoff();
 *     throw e;  // genuine 5xx; let it bubble
 *   }
 *
 * Why classes vs discriminated-union returns: classes survive `await`
 * thenables, integrate with logger filters (`logger.filter(e => e instanceof
 * UnauthorizedError ? "warn" : "error")`), and are the JavaScript-native
 * pattern for distinguishing failure modes. Discriminated unions would
 * force every caller to write a wrapper that throws — anti-ergonomic.
 *
 * Why `message` AND `code` are both surfaced: `code` is the stable wire
 * vocabulary (`invalid_nonce`, `nonce_replayed`, `wallet_mismatch` etc.)
 * that conditional logic should switch on. `message` is the human-readable
 * sentence the server included for logging/debugging — never branch on it
 * (the server is free to rephrase). The pair maps onto the `event_type` +
 * `payload.reason` audit shape at the server, by design.
 */

/**
 * Raw server error envelope shape — matches T1.6 SDD §5.6's
 * jsonResponse(401, {error, code, message}) plus the validation_failed
 * variant from /v1/auth/challenge that includes details.issues[].
 */
export interface ServerErrorEnvelope {
  readonly error: string
  readonly code?: string
  readonly message?: string
  readonly request_id?: string
  readonly details?: { readonly issues?: ReadonlyArray<{ readonly path: ReadonlyArray<string>; readonly message: string }> }
  readonly param?: string
}

/**
 * Base class. Every non-2xx response that included a JSON body inflates
 * to (a subclass of) this. Carries the status code, the parsed envelope,
 * and the raw body for forensic debugging.
 */
export class IdentityApiError extends Error {
  /** HTTP status code (e.g. 401, 409, 500). */
  public readonly status: number
  /** Machine-readable code from the server envelope (e.g. "invalid_nonce"). May be absent. */
  public readonly code: string | undefined
  /** Server-side request id, when emitted by the Hyper logging middleware. */
  public readonly requestId: string | undefined
  /** The full parsed envelope, for callers that need every field. */
  public readonly envelope: ServerErrorEnvelope | undefined
  /** Optional raw response body string, when JSON parse failed. */
  public readonly rawBody: string | undefined

  constructor(opts: {
    status: number
    message: string
    code?: string | undefined
    requestId?: string | undefined
    envelope?: ServerErrorEnvelope | undefined
    rawBody?: string | undefined
  }) {
    super(opts.message)
    this.name = "IdentityApiError"
    this.status = opts.status
    this.code = opts.code
    this.requestId = opts.requestId
    this.envelope = opts.envelope
    this.rawBody = opts.rawBody
  }
}

/**
 * 401. Maps to every auth-flow rejection class:
 *   - invalid_nonce / nonce_replayed / nonce_expired / scheme_mismatch
 *   - wallet_mismatch / signature_invalid / scheme_not_allowed_in_live_path
 *   - missing_token / invalid_token / malformed_token (the L7-hardened
 *     middleware emits this for the malformed-bearer-token case)
 *
 * Callers should switch on `e.code` to route the UX (re-prompt vs error vs
 * show "your session expired").
 */
export class UnauthorizedError extends IdentityApiError {
  constructor(opts: ConstructorParameters<typeof IdentityApiError>[0]) {
    super(opts)
    this.name = "UnauthorizedError"
  }
}

/**
 * 409. The server emits this for conflict-policy violations:
 *   - cross_user_collision (FR-L3: a third-party-claimed (wallet, account)
 *     pair where the wallet and account already belong to DIFFERENT users)
 *   - world_identity_unique (a nym is already claimed in this world by
 *     someone else)
 *
 * Distinct from 401 because the request was authenticated; the data is the
 * problem. Callers typically surface a "this identity is already linked"
 * UX without re-prompting auth.
 */
export class ConflictError extends IdentityApiError {
  constructor(opts: ConstructorParameters<typeof IdentityApiError>[0]) {
    super(opts)
    this.name = "ConflictError"
  }
}

/**
 * 400. Malformed request — usually a Zod validation failure on the server
 * side. `envelope.details.issues[]` lists per-field problems if the server
 * emitted them (which it does for /v1/auth/challenge).
 *
 * Since the SDK validates inputs CLIENT-side before sending (the typed
 * surface requires the right shape at compile time, and the route schemas
 * are imported from `@freeside-auth/protocol/api`), a 400 in production
 * usually means the SDK is out of sync with the server — vendor a newer
 * snapshot or pin the matching commit.
 */
export class ValidationError extends IdentityApiError {
  constructor(opts: ConstructorParameters<typeof IdentityApiError>[0]) {
    super(opts)
    this.name = "ValidationError"
  }
}

/**
 * 501. Stub endpoint awaiting a later task (T2.3 profile / T3.2 mibera /
 * T4.1 link). The typed surface exposes these methods today so consumers
 * can write the catch block; the runtime returns this until the task
 * lands.
 *
 * `e.envelope.error` is "not_implemented"; `e.code` carries the task id
 * ("T2.3" etc.) so consumers can log which extension they're waiting on.
 */
export class NotImplementedError extends IdentityApiError {
  constructor(opts: ConstructorParameters<typeof IdentityApiError>[0]) {
    super(opts)
    this.name = "NotImplementedError"
  }
}

/**
 * No HTTP response was received — DNS failure, socket reset, fetch abort,
 * or the server returned a response without a Content-Length and the
 * client-side `fetch` rejected mid-stream. Distinct from a 5xx (which IS
 * a response, just an error one).
 *
 * Retry strategies typically wrap THIS in a backoff loop; IdentityApiError
 * (4xx) should NOT be retried (request was malformed and won't succeed on
 * resend).
 *
 * Subclasses IdentityApiError to keep the catch-block hierarchy uniform:
 * callers can `if (e instanceof IdentityApiError)` to handle any SDK
 * failure with one branch.
 */
export class NetworkError extends IdentityApiError {
  /** The underlying fetch / abort / DNS error, if available. */
  public readonly cause: unknown

  constructor(opts: { message: string; cause: unknown }) {
    super({
      status: 0, // sentinel — no HTTP status was observed
      message: opts.message,
    })
    this.name = "NetworkError"
    this.cause = opts.cause
  }
}

/**
 * Map a status code + parsed envelope to the most specific class.
 *
 * Used by the transport layer after a non-2xx response. The mapping is
 * deliberately conservative: anything we don't recognize collapses to
 * the base `IdentityApiError` (so consumers get a typed error, just not
 * the more-specific variant).
 */
export function classifyHttpError(opts: {
  status: number
  envelope: ServerErrorEnvelope | undefined
  rawBody: string | undefined
  requestId: string | undefined
}): IdentityApiError {
  const message = opts.envelope?.message ?? opts.envelope?.error ?? opts.rawBody ?? `HTTP ${opts.status}`
  const ctorOpts = {
    status: opts.status,
    message,
    code: opts.envelope?.code,
    envelope: opts.envelope,
    rawBody: opts.rawBody,
    requestId: opts.requestId,
  } satisfies ConstructorParameters<typeof IdentityApiError>[0]

  if (opts.status === 401) return new UnauthorizedError(ctorOpts)
  if (opts.status === 409) return new ConflictError(ctorOpts)
  if (opts.status === 400) return new ValidationError(ctorOpts)
  if (opts.status === 501) return new NotImplementedError(ctorOpts)
  return new IdentityApiError(ctorOpts)
}
