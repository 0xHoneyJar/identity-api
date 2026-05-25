/**
 * HttpInventoryAdapter — HTTP client implementation of InventoryPort (T2.1).
 *
 * Calls inventory-api's `GET /v1/holdings/:wallet` (per the projected REST
 * shape in @freeside-auth/protocol/api/federation/inventory.ts). Default
 * baseUrl is `https://inventory.0xhoneyjar.xyz` per the freeside-registry;
 * override via env `INVENTORY_API_URL` at the singleton-construction site
 * (`src/api/inventory.ts`).
 *
 * Per the InventoryPort contract:
 *   - READ-ONLY (no-embed invariant, FR-P3).
 *   - Discriminated-union result; never throws (T2.2 fan-out friendly).
 *   - AbortSignal forwarded for per-source timeout (FR-P2).
 *
 * Discovery (see t2.1 build notes): inventory-api is currently a LIBRARY at
 * `~/Documents/GitHub/inventory-api/` — HTTP graduation is pending. This
 * adapter ships the contract ahead of the deployment so T2.2 + T2.3 + T3.1
 * can wire against the port. When the HTTP service ships, the URL config
 * is the only thing that has to move (the path shape + body schema mirror
 * the library's response shape verbatim).
 *
 * Adapter shape mirrors PostgresSpineAdapter (T1.5): constructor takes a
 * config; methods implement the port; private helpers handle the wire detail.
 *
 * Source: PRD v3.0 §4.5, SDD §5.4, packages/freeside-registry/registry.yaml.
 */

import { InventoryGetHoldingsRespSchema } from "@freeside-auth/protocol/api/federation/inventory"
import type {
  InventoryPort,
  InventoryGetHoldingsInput,
  PortCallOpts,
  FederationResult,
} from "@freeside-auth/ports"
import type { InventoryGetHoldingsResp } from "@freeside-auth/protocol/api/federation/inventory"
import {
  federationHttpCall,
  stripTrailingSlash,
  encodePathParam,
  type FederationLogger,
} from "./federation-http"

// ─── default endpoint (per registry.yaml) ───────────────────────────────────

/**
 * Production default. Override at the singleton-construction site via env
 * (`INVENTORY_API_URL`). See `src/api/inventory.ts`.
 *
 * Per `packages/freeside-registry/registry.yaml::modules.inventory-api.beacon_url`.
 */
export const DEFAULT_INVENTORY_BASE_URL = "https://inventory.0xhoneyjar.xyz"

// ─── config ─────────────────────────────────────────────────────────────────

export interface HttpInventoryAdapterConfig {
  /** Override the production default. Trailing slashes are normalized off. */
  readonly baseUrl?: string
  /**
   * Optional static headers (e.g., a `X-Trace-Id`). The adapter doesn't add
   * auth here — inventory-api today declares no auth. When/if it adds auth,
   * a new optional config field will land (mirror score-api's apiKey pattern).
   */
  readonly defaultHeaders?: Record<string, string>
  /** Logger surface for diagnostic events. */
  readonly logger?: FederationLogger
}

// ─── adapter ────────────────────────────────────────────────────────────────

/**
 * The HTTP client adapter for inventory-api federation.
 *
 * Construct once per process (the underlying global fetch is connection-pool-
 * backed); pass into the compose orchestrator at T2.2 / route handlers at T2.3
 * as a shared singleton (see `src/api/inventory.ts`).
 */
export class HttpInventoryAdapter implements InventoryPort {
  readonly baseUrl: string
  readonly defaultHeaders: Record<string, string>
  readonly logger: FederationLogger | undefined

  constructor(config: HttpInventoryAdapterConfig = {}) {
    this.baseUrl = stripTrailingSlash(config.baseUrl ?? DEFAULT_INVENTORY_BASE_URL)
    this.defaultHeaders = { ...(config.defaultHeaders ?? {}) }
    this.logger = config.logger
  }

  async getHoldings(
    input: InventoryGetHoldingsInput,
    opts?: PortCallOpts,
  ): Promise<FederationResult<InventoryGetHoldingsResp>> {
    const wallet = encodePathParam(input.walletAddress)
    const url = `${this.baseUrl}/v1/holdings/${wallet}`
    return federationHttpCall<InventoryGetHoldingsResp>({
      url,
      method: "GET",
      headers: this.defaultHeaders,
      responseSchema: InventoryGetHoldingsRespSchema,
      portOpts: opts,
      logger: this.logger,
      building: "inventory-api",
      context: { wallet: input.walletAddress },
    })
  }
}
