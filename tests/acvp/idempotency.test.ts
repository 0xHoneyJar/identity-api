/**
 * ACVP proof: idempotency invariant (beacon.yaml acvp_invariants.idempotency).
 *
 * Verifies that re-linking the same verified credential to the same user is a
 * no-op — no duplicate spine write, no duplicate audit row for the link itself.
 */

import { describe, expect, it } from "bun:test"
import type { SpinePort } from "@freeside-auth/ports"
import { linkVerifiedCredential } from "@freeside-auth/engine"
import { buildMockSpineForAcvp } from "./helpers/mock-spine"

describe("ACVP idempotency", () => {
  it("linkVerifiedCredential is idempotent for the same (user, discord) pair", async () => {
    const spine = buildMockSpineForAcvp()
    const userId = "11111111-1111-4111-8111-111111111111"
    const discordId = "discord-999"

    const first = await linkVerifiedCredential(spine as SpinePort, {
      userId,
      provider: "discord",
      externalId: discordId,
      actor: "self",
    })
    expect(first.idempotent).toBe(false)

    spine.resolveByAccountByProvider = { discord: userId }
    const second = await linkVerifiedCredential(spine as SpinePort, {
      userId,
      provider: "discord",
      externalId: discordId,
      actor: "self",
    })
    expect(second.idempotent).toBe(true)
    expect(spine.linkAccountCalls).toHaveLength(1)
  })
})
