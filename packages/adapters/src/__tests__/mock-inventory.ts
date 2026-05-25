/**
 * MockInventoryPort — in-process fixture-backed InventoryPort for tests (T2.1).
 *
 * Follows the T1.5 + T1.6 pattern: a configurable mock that test files use
 * to control adapter behavior without standing up a real HTTP server. The
 * mock supports BOTH happy-path fixtures (one stored per wallet) and
 * structured failure injection (one stored per wallet).
 *
 * Test seam: `__setHoldingsForWallet(wallet, fixture)` installs a happy-path
 * return; `__setFailureForWallet(wallet, failure)` installs a failure-path
 * return. Both are reset by `__reset()`. Calling a wallet without either
 * configured returns a sensible default (empty holdings + 'true' completeness)
 * so most tests can ignore the unused walkthrough.
 *
 * Shared by:
 *   - packages/adapters/src/__tests__/http-inventory-adapter.test.ts (T2.1 unit)
 *   - eventually packages/engine/src/__tests__/profile-compose.test.ts (T2.2)
 *   - eventually src/api/__tests__/routes-profile.test.ts (T2.3)
 *
 * Located under `__tests__/` (test seam, not a production export) per the
 * cycle-B convention; not re-exported from the adapters package barrel.
 */

import type {
  InventoryPort,
  InventoryGetHoldingsInput,
  FederationResult,
  FederationFailure,
  PortCallOpts,
} from "@freeside-auth/ports"
import type { InventoryGetHoldingsResp } from "@freeside-auth/protocol/api/federation/inventory"

export interface MockInventoryHistoryEntry {
  readonly wallet: string
  readonly opts?: PortCallOpts
  readonly ts: number
}

export class MockInventoryPort implements InventoryPort {
  private readonly holdingsByWallet = new Map<string, InventoryGetHoldingsResp>()
  private readonly failureByWallet = new Map<string, FederationFailure>()
  /** Calls observed in this mock instance — useful for asserting fan-out. */
  readonly history: MockInventoryHistoryEntry[] = []

  __setHoldingsForWallet(wallet: string, fixture: InventoryGetHoldingsResp): void {
    this.holdingsByWallet.set(wallet.toLowerCase(), fixture)
  }

  __setFailureForWallet(wallet: string, failure: FederationFailure): void {
    this.failureByWallet.set(wallet.toLowerCase(), failure)
  }

  __reset(): void {
    this.holdingsByWallet.clear()
    this.failureByWallet.clear()
    this.history.length = 0
  }

  async getHoldings(
    input: InventoryGetHoldingsInput,
    opts?: PortCallOpts,
  ): Promise<FederationResult<InventoryGetHoldingsResp>> {
    this.history.push({ wallet: input.walletAddress, opts, ts: Date.now() })
    const key = input.walletAddress.toLowerCase()
    const failure = this.failureByWallet.get(key)
    if (failure) return { ok: false, reason: failure }
    const fixture = this.holdingsByWallet.get(key)
    if (fixture) return { ok: true, data: fixture }
    // Default: empty holdings + complete=true. Most tests ignore the
    // wallet-not-configured case (they only verify the wallet they care
    // about), so the default-empty shape keeps test ergonomics simple.
    return {
      ok: true,
      data: {
        holdings: [],
        completeness: {
          as_of_block: 1,
          holder_count: 0,
          source: "sonar",
          complete: true,
        },
      },
    }
  }
}
