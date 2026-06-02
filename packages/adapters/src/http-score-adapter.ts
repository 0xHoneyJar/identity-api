/**
 * HttpScoreAdapter — HTTP client implementation of ScorePort (T2.1).
 *
 * Calls score-api's `GET /v1/wallets/:address` (the real endpoint at
 * `~/Documents/GitHub/score-api/src/routes/wallets.ts`, line ~120). Default
 * baseUrl is `https://score.0xhoneyjar.xyz` per the freeside-registry;
 * override via env `SCORE_API_URL` at the singleton-construction site
 * (`src/api/score.ts`).
 *
 * Auth: score-api gates `/v1/*` behind `X-API-Key` per its `authMiddleware`
 * at `~/Documents/GitHub/score-api/src/middleware/auth.ts`. The adapter takes
 * the key via config (defaulted from env `SCORE_API_KEY` at the singleton
 * site) and injects it as the `X-API-Key` header on every request.
 *
 * Per the ScorePort contract:
 *   - READ-ONLY.
 *   - Discriminated-union result.
 *   - AbortSignal forwarded for per-source timeout.
 *   - 404 from score-api → `{ ok: false, reason: { kind: 'not_found' } }`
 *     (the upstream returns 404 for wallets with no scoring data yet).
 *
 * Adapter shape mirrors PostgresSpineAdapter (T1.5).
 *
 * Source: PRD v3.0 §4.5, SDD §5.4, `~/Documents/GitHub/score-api/src/routes/wallets.ts`,
 * `~/Documents/GitHub/score-api/src/middleware/auth.ts`.
 */

import {
  ScoreGetWalletRespSchema,
  ScoreResolveIdentityRespSchema,
} from "@freeside-auth/protocol/api/federation/score"
import type {
  ScorePort,
  ScoreGetScoreInput,
  ScoreResolveIdentityInput,
  PortCallOpts,
  FederationResult,
} from "@freeside-auth/ports"
import type {
  ScoreGetWalletResp,
  ScoreResolveIdentityResp,
} from "@freeside-auth/protocol/api/federation/score"
import {
  federationHttpCall,
  stripTrailingSlash,
  encodePathParam,
  type FederationLogger,
} from "./federation-http"

// ─── default endpoint (per registry.yaml) ───────────────────────────────────

/**
 * Production default. Override at the singleton-construction site via env
 * (`SCORE_API_URL`). See `src/api/score.ts`.
 *
 * Per `packages/freeside-registry/registry.yaml::modules.score-api.beacon_url`.
 */
export const DEFAULT_SCORE_BASE_URL = "https://score.0xhoneyjar.xyz"

/**
 * Header name score-api's authMiddleware checks. Hard-coded because changing
 * it requires coordinated changes on the upstream side; not a per-deploy knob.
 */
export const SCORE_API_KEY_HEADER = "X-API-Key"

// ─── config ─────────────────────────────────────────────────────────────────

export interface HttpScoreAdapterConfig {
  /** Override the production default. Trailing slashes are normalized off. */
  readonly baseUrl?: string
  /**
   * X-API-Key value. score-api's authMiddleware gates /v1/* on this header.
   * Pass `undefined` only in test scenarios; production paths MUST supply it
   * or score-api responds 401 (which the port returns as `unauthorized`).
   */
  readonly apiKey?: string
  /** Optional static headers (e.g., a `X-Trace-Id`). */
  readonly defaultHeaders?: Record<string, string>
  /** Logger surface for diagnostic events. */
  readonly logger?: FederationLogger
}

// ─── adapter ────────────────────────────────────────────────────────────────

/**
 * The HTTP client adapter for score-api federation.
 *
 * Construct once per process; pass into the compose orchestrator + routes as
 * a shared singleton (see `src/api/score.ts`).
 */
export class HttpScoreAdapter implements ScorePort {
  readonly baseUrl: string
  readonly defaultHeaders: Record<string, string>
  readonly logger: FederationLogger | undefined
  private readonly apiKey: string | undefined

  constructor(config: HttpScoreAdapterConfig = {}) {
    this.baseUrl = stripTrailingSlash(config.baseUrl ?? DEFAULT_SCORE_BASE_URL)
    this.apiKey = config.apiKey
    this.defaultHeaders = {
      ...(config.apiKey ? { [SCORE_API_KEY_HEADER]: config.apiKey } : {}),
      ...(config.defaultHeaders ?? {}),
    }
    this.logger = config.logger
  }

  async getScore(
    input: ScoreGetScoreInput,
    opts?: PortCallOpts,
  ): Promise<FederationResult<ScoreGetWalletResp>> {
    const address = encodePathParam(input.walletAddress)
    const url = `${this.baseUrl}/v1/wallets/${address}`
    return federationHttpCall<ScoreGetWalletResp>({
      url,
      method: "GET",
      headers: this.defaultHeaders,
      responseSchema: ScoreGetWalletRespSchema,
      portOpts: opts,
      logger: this.logger,
      building: "score-api",
      context: { wallet: input.walletAddress, hasApiKey: this.apiKey !== undefined },
    })
  }

  /**
   * Batch-resolve wallets to group-aware onchain identities via score-api's
   * `POST /v1/identity/resolve` (bd-2wo.38.1). Body is `{ wallets }` ONLY —
   * score-api takes no `world_slug`. Response is a keyed map looked up
   * lowercased by the caller. Same never-throws / FederationResult contract
   * as `getScore`.
   */
  async resolveIdentity(
    input: ScoreResolveIdentityInput,
    opts?: PortCallOpts,
  ): Promise<FederationResult<ScoreResolveIdentityResp>> {
    const url = `${this.baseUrl}/v1/identity/resolve`
    return federationHttpCall<ScoreResolveIdentityResp>({
      url,
      method: "POST",
      headers: this.defaultHeaders,
      body: { wallets: input.wallets },
      responseSchema: ScoreResolveIdentityRespSchema,
      portOpts: opts,
      logger: this.logger,
      building: "score-api",
      context: {
        walletCount: input.wallets.length,
        hasApiKey: this.apiKey !== undefined,
      },
    })
  }
}
