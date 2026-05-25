/**
 * MockCodexPort — in-process fixture-backed CodexPort for tests (T2.1).
 *
 * Follows the MockInventoryPort pattern. See its docstring for the full
 * shared rationale.
 *
 * Per-tokenId fixtures keyed numerically (codex's wire schema is numeric);
 * `getMiberaTraits` aggregates the per-tokenId fixtures for the requested
 * batch and silently omits unknown IDs (matching codex's wire contract).
 */

import type {
  CodexPort,
  CodexGetMiberaTraitsInput,
  CodexMiberaEntry,
  FederationResult,
  FederationFailure,
  PortCallOpts,
} from "@freeside-auth/ports"
import type { CodexGetMiberaBatchResp } from "@freeside-auth/protocol/api/federation/codex"

export interface MockCodexHistoryEntry {
  readonly tokenIds: readonly string[]
  readonly opts?: PortCallOpts
  readonly ts: number
}

export class MockCodexPort implements CodexPort {
  private readonly miberaByTokenId = new Map<number, CodexMiberaEntry>()
  private failureForNextCall: FederationFailure | null = null
  readonly history: MockCodexHistoryEntry[] = []

  __setMiberaEntry(entry: CodexMiberaEntry): void {
    this.miberaByTokenId.set(entry.id, entry)
  }

  /**
   * Inject a failure for the NEXT `getMiberaTraits` call. Cleared after firing
   * once (rather than persisting per-tokenId) because the failure semantics
   * are call-scoped, not token-scoped (a `network_error` affects the whole
   * batch, not one tokenId in the batch).
   */
  __setFailureForNextCall(failure: FederationFailure): void {
    this.failureForNextCall = failure
  }

  __reset(): void {
    this.miberaByTokenId.clear()
    this.failureForNextCall = null
    this.history.length = 0
  }

  async getMiberaTraits(
    input: CodexGetMiberaTraitsInput,
    opts?: PortCallOpts,
  ): Promise<FederationResult<CodexGetMiberaBatchResp>> {
    this.history.push({ tokenIds: input.tokenIds, opts, ts: Date.now() })
    if (this.failureForNextCall) {
      const failure = this.failureForNextCall
      this.failureForNextCall = null
      return { ok: false, reason: failure }
    }
    // Coerce + silently omit unknowns (matches the real wire contract).
    const miberas: CodexMiberaEntry[] = []
    for (const raw of input.tokenIds) {
      const n = Number(raw)
      if (!Number.isInteger(n)) continue
      const entry = this.miberaByTokenId.get(n)
      if (entry) miberas.push(entry)
    }
    return { ok: true, data: { miberas } }
  }
}
