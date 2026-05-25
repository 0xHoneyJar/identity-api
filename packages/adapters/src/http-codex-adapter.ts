/**
 * HttpCodexAdapter — HTTP client implementation of CodexPort (T2.1).
 *
 * Calls mibera-codex's `POST /v1/mibera/batch` (per the projected REST shape
 * in @freeside-auth/protocol/api/federation/codex.ts — codex's primary
 * transport today is MCP, not HTTP). Default baseUrl is
 * `https://codex.0xhoneyjar.xyz` per the freeside-registry; override via env
 * `CODEX_API_URL` at the singleton-construction site (`src/api/codex.ts`).
 *
 * Auth: codex declares `auth: kind: none` + `pricing: free` in its beacon.
 * No API key required.
 *
 * Per the CodexPort contract:
 *   - READ-ONLY.
 *   - Discriminated-union result.
 *   - AbortSignal forwarded for per-source timeout.
 *   - Token-IDs are STRING inputs (matching inventory-api's wire shape); the
 *     adapter coerces to integers at the wire boundary. Non-integer tokenIds
 *     resolve to `parse_error` with structured cause.
 *
 * Adapter shape mirrors PostgresSpineAdapter (T1.5).
 *
 * Transport caveat: when/if we choose to ride MCP instead of HTTP, an
 * alternate `McpCodexAdapter` satisfies the same CodexPort interface; the
 * port abstracts the transport choice.
 *
 * Source: PRD v3.0 §4.5, SDD §5.4, `~/Documents/GitHub/mibera-codex/beacon.yaml`,
 * `~/Documents/GitHub/mibera-codex/src/types.ts:46-78`.
 */

import { CodexGetMiberaBatchRespSchema } from "@freeside-auth/protocol/api/federation/codex"
import type {
  CodexPort,
  CodexGetMiberaTraitsInput,
  PortCallOpts,
  FederationResult,
} from "@freeside-auth/ports"
import type { CodexGetMiberaBatchResp } from "@freeside-auth/protocol/api/federation/codex"
import {
  federationHttpCall,
  stripTrailingSlash,
  type FederationLogger,
} from "./federation-http"

// ─── default endpoint (per registry.yaml) ───────────────────────────────────

/**
 * Production default. Override at the singleton-construction site via env
 * (`CODEX_API_URL`). See `src/api/codex.ts`.
 *
 * Per `packages/freeside-registry/registry.yaml::modules.codex` (and the
 * codex beacon URL `https://codex.0xhoneyjar.xyz`).
 */
export const DEFAULT_CODEX_BASE_URL = "https://codex.0xhoneyjar.xyz"

// ─── config ─────────────────────────────────────────────────────────────────

export interface HttpCodexAdapterConfig {
  /** Override the production default. Trailing slashes are normalized off. */
  readonly baseUrl?: string
  /** Optional static headers (e.g., a `X-Trace-Id`). No auth header by default. */
  readonly defaultHeaders?: Record<string, string>
  /** Logger surface for diagnostic events. */
  readonly logger?: FederationLogger
}

// ─── adapter ────────────────────────────────────────────────────────────────

/**
 * The HTTP client adapter for mibera-codex federation.
 *
 * Construct once per process; pass into the compose orchestrator + route
 * handlers as a shared singleton (see `src/api/codex.ts`).
 *
 * The batch endpoint accepts up to 100 tokenIds per call (matching the
 * wire-schema cap); callers needing more must split.
 */
export class HttpCodexAdapter implements CodexPort {
  readonly baseUrl: string
  readonly defaultHeaders: Record<string, string>
  readonly logger: FederationLogger | undefined

  constructor(config: HttpCodexAdapterConfig = {}) {
    this.baseUrl = stripTrailingSlash(config.baseUrl ?? DEFAULT_CODEX_BASE_URL)
    this.defaultHeaders = { ...(config.defaultHeaders ?? {}) }
    this.logger = config.logger
  }

  async getMiberaTraits(
    input: CodexGetMiberaTraitsInput,
    opts?: PortCallOpts,
  ): Promise<FederationResult<CodexGetMiberaBatchResp>> {
    // Coerce string tokenIds → integers at the wire boundary. Non-integer
    // entries surface as a structured parse_error BEFORE the HTTP call (the
    // upstream would 400 anyway; bailing locally saves a round-trip and
    // gives the caller a cleaner error).
    const tokenIds: number[] = []
    for (const raw of input.tokenIds) {
      const n = Number(raw)
      if (!Number.isInteger(n) || n <= 0 || n > 10000) {
        return {
          ok: false,
          reason: {
            kind: "parse_error",
            message: `codex: invalid tokenId '${raw}' (must be integer 1..10000)`,
            context: { tokenId: raw, fullInput: input.tokenIds },
          },
        }
      }
      tokenIds.push(n)
    }
    if (tokenIds.length === 0) {
      // The wire schema caps min at 1; pre-empt with a clear local error so
      // callers don't waste a round-trip on an empty request.
      return {
        ok: false,
        reason: {
          kind: "parse_error",
          message: "codex: getMiberaTraits called with empty tokenIds list",
          context: { fullInput: input.tokenIds },
        },
      }
    }
    if (tokenIds.length > 100) {
      return {
        ok: false,
        reason: {
          kind: "parse_error",
          message: `codex: tokenIds list of ${tokenIds.length} exceeds 100-cap; caller must split`,
          context: { count: tokenIds.length },
        },
      }
    }

    const url = `${this.baseUrl}/v1/mibera/batch`
    return federationHttpCall<CodexGetMiberaBatchResp>({
      url,
      method: "POST",
      headers: this.defaultHeaders,
      body: { tokenIds },
      responseSchema: CodexGetMiberaBatchRespSchema,
      portOpts: opts,
      logger: this.logger,
      building: "mibera-codex",
      context: { tokenCount: tokenIds.length },
    })
  }
}
