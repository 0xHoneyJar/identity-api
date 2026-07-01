/**
 * Shared mock spine for ACVP proof tests.
 */

import type {
  SpineAuditEvent,
  SpineIdentityShape,
  SpineLinkedAccountProvider,
  SpinePort,
} from "@freeside-auth/ports"

export interface AcvpMockSpine extends SpinePort {
  readonly audits: SpineAuditEvent[]
  readonly linkAccountCalls: Array<{
    userId: string
    provider: SpineLinkedAccountProvider
    externalId: string
  }>
  resolveByAccountByProvider?: Partial<Record<SpineLinkedAccountProvider, string | null>>
}

export function buildMockSpineForAcvp(): AcvpMockSpine {
  const audits: SpineAuditEvent[] = []
  const linkAccountCalls: AcvpMockSpine["linkAccountCalls"] = []
  const m: AcvpMockSpine = {
    audits,
    linkAccountCalls,
    async resolveByWallet() {
      return null
    },
    async resolveByAccount(provider) {
      return m.resolveByAccountByProvider?.[provider] ?? null
    },
    async resolveByNym() {
      return null
    },
    async getIdentity(): Promise<SpineIdentityShape | null> {
      return null
    },
    async getManagedWorlds() {
      return []
    },
    async mintUser() {
      return "00000000-0000-4000-8000-000000000000"
    },
    async linkWallet() {},
    async linkAccount(opts) {
      linkAccountCalls.push({
        userId: opts.userId,
        provider: opts.provider,
        externalId: opts.externalId,
      })
    },
    async claimNym() {},
    async claimGeneratedName() {
      return "MIBERA-000001"
    },
    async importName() {},
    async setPrimary() {
      return true
    },
    async writeAuditEvent(event) {
      audits.push(event)
    },
    async mintNonce() {
      return { nonce: "n", expires_at: "2026-06-01T00:05:00.000Z", message: "m" }
    },
    async consumeNonce() {
      return { ok: true as const, message: "m", wallet_address: null }
    },
    async withTransaction<T>(fn: (spine: SpinePort) => Promise<T>): Promise<T> {
      return fn(m)
    },
  }
  return m
}
