/**
 * MockScorePort — in-process fixture-backed ScorePort for tests (T2.1).
 *
 * Follows the MockInventoryPort pattern. See its docstring for the full
 * shared rationale.
 */

import type {
  ScorePort,
  ScoreGetScoreInput,
  ScoreResolveIdentityInput,
  FederationResult,
  FederationFailure,
  PortCallOpts,
} from "@freeside-auth/ports"
import type {
  ScoreGetWalletResp,
  ResolvedIdentity,
  ScoreResolveIdentityResp,
} from "@freeside-auth/protocol/api/federation/score"

export interface MockScoreHistoryEntry {
  readonly wallet: string
  readonly opts?: PortCallOpts
  readonly ts: number
}

export interface MockResolveHistoryEntry {
  readonly wallets: readonly string[]
  readonly opts?: PortCallOpts
  readonly ts: number
}

export class MockScorePort implements ScorePort {
  private readonly scoresByWallet = new Map<string, ScoreGetWalletResp>()
  private readonly failureByWallet = new Map<string, FederationFailure>()
  private readonly resolvedByWallet = new Map<string, ResolvedIdentity>()
  private resolveFailure: FederationFailure | null = null
  readonly history: MockScoreHistoryEntry[] = []
  readonly resolveHistory: MockResolveHistoryEntry[] = []

  __setScoreForWallet(wallet: string, fixture: ScoreGetWalletResp): void {
    this.scoresByWallet.set(wallet.toLowerCase(), fixture)
  }

  __setFailureForWallet(wallet: string, failure: FederationFailure): void {
    this.failureByWallet.set(wallet.toLowerCase(), failure)
  }

  /** Configure the onchain identity score-api returns for `resolveIdentity`. */
  __setResolvedIdentity(wallet: string, fixture: ResolvedIdentity): void {
    this.resolvedByWallet.set(wallet.toLowerCase(), fixture)
  }

  /** Force `resolveIdentity` to fail the whole batch (score-outage degrade). */
  __setResolveIdentityFailure(failure: FederationFailure | null): void {
    this.resolveFailure = failure
  }

  __reset(): void {
    this.scoresByWallet.clear()
    this.failureByWallet.clear()
    this.resolvedByWallet.clear()
    this.resolveFailure = null
    this.history.length = 0
    this.resolveHistory.length = 0
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

  async resolveIdentity(
    input: ScoreResolveIdentityInput,
    opts?: PortCallOpts,
  ): Promise<FederationResult<ScoreResolveIdentityResp>> {
    this.resolveHistory.push({ wallets: [...input.wallets], opts, ts: Date.now() })
    if (this.resolveFailure) return { ok: false, reason: this.resolveFailure }
    // Mirror score-api: every requested wallet is present in the map, keyed by
    // its lowercased address; unconfigured wallets get the empty-name fallback.
    const identities: Record<string, ResolvedIdentity> = {}
    for (const w of input.wallets) {
      const key = w.toLowerCase()
      identities[key] = this.resolvedByWallet.get(key) ?? emptyResolvedIdentity(key)
    }
    return { ok: true, data: { identities } }
  }
}

/**
 * Mirror of score-api's `createEmptyIdentity` fallback
 * (`services/identity.service.ts:253-261`): a wallet with no onchain name is
 * still present in the map with null name fields and a self-truncated
 * `display_name`. Lets the facade merge prove it does NOT promote a nameless
 * score row above the `address` tier.
 */
function emptyResolvedIdentity(wallet: string): ResolvedIdentity {
  return {
    wallet,
    ens_name: null,
    beraname: null,
    basename: null,
    twitter_handle: null,
    display_name: `${wallet.slice(0, 6)}…${wallet.slice(-4)}`,
    pfp_url: null,
    twitter_source: null,
  }
}
