/**
 * ACVP proof: audit_replay invariant (beacon.yaml acvp_invariants.audit_replay).
 *
 * Verifies that successful credential links emit durable audit rows suitable
 * for downstream replay / forensics.
 */

import { describe, expect, it } from "bun:test"
import type { SpinePort } from "@freeside-auth/ports"
import { linkVerifiedCredential } from "@freeside-auth/engine"
import { buildMockSpineForAcvp } from "./helpers/mock-spine"

describe("ACVP audit_replay", () => {
  it("linkVerifiedCredential emits account_linked audit on first bind", async () => {
    const spine = buildMockSpineForAcvp()
    const userId = "11111111-1111-4111-8111-111111111111"

    await linkVerifiedCredential(spine as SpinePort, {
      userId,
      provider: "discord",
      externalId: "discord-audit-1",
      actor: "self",
    })

    const linked = spine.audits.filter((row) => row.event_type === "account_linked")
    expect(linked).toHaveLength(1)
    expect(linked[0]?.user_id).toBe(userId)
    expect(linked[0]?.payload).toMatchObject({
      provider: "discord",
      external_id: "discord-audit-1",
    })
  })
})
