/**
 * MockScorePort — in-process fixture-backed ScorePort for tests (T2.1).
 *
 * Follows the MockInventoryPort pattern. See its docstring for the full
 * shared rationale.
 */

import type {
  ScorePort,
  ScoreGetScoreInput,
  FederationResult,
  FederationFailure,
  PortCallOpts,
} from "@freeside-auth/ports"
import type { ScoreGetWalletResp } from "@freeside-auth/protocol/api/federation/score"

export interface MockScoreHistoryEntry {
  readonly wallet: string
  readonly opts?: PortCallOpts
  readonly ts: number
}

export class MockScorePort implements ScorePort {
  private readonly scoresByWallet = new Map<string, ScoreGetWalletResp>()
  private readonly failureByWallet = new Map<string, FederationFailure>()
  readonly history: MockScoreHistoryEntry[] = []

  __setScoreForWallet(wallet: string, fixture: ScoreGetWalletResp): void {
    this.scoresByWallet.set(wallet.toLowerCase(), fixture)
  }

  __setFailureForWallet(wallet: string, failure: FederationFailure): void {
    this.failureByWallet.set(wallet.toLowerCase(), failure)
  }

  __reset(): void {
    this.scoresByWallet.clear()
    this.failureByWallet.clear()
    this.history.length = 0
  }

  async getScore(
    input: ScoreGetScoreInput,
    opts?: PortCallOpts,
  ): Promise<FederationResult<ScoreGetWalletResp>> {
    this.history.push({ wallet: input.walletAddress, opts, ts: Date.now() })
    const key = input.walletAddress.toLowerCase()
    const failure = this.failureByWallet.get(key)
    if (failure) return { ok: false, reason: failure }
    const fixture = this.scoresByWallet.get(key)
    if (fixture) return { ok: true, data: fixture }
    // Default: not_found (score-api returns 404 for unindexed wallets;
    // that's the most-common "I don't have an opinion" case).
    return {
      ok: false,
      reason: {
        kind: "not_found",
        message: "MockScorePort: no fixture configured (default not_found)",
        statusCode: 404,
        context: { wallet: input.walletAddress },
      },
    }
  }
}
