/**
 * auth-bridge-quarantine.test.ts — route-level quarantine assertions (T1.7).
 *
 * Structural tests that the /v1/auth/verify route's credential bridge
 * registry honors the FR-A4 live-path quarantine.
 *
 * Why this lives at the route-test layer:
 *   - The Zod enum on VerifyReq.scheme structurally prevents
 *     `dynamic_user_id` from being a valid request body, so the runtime
 *     `usableInLivePath` check at the route is unreachable via real HTTP
 *     traffic. (That's the GOOD news — two layers of defense.)
 *   - But we still want to assert the registry shape directly: every
 *     bridge for a live-path scheme MUST have `usableInLivePath: true`,
 *     and the dynamic bridge MUST have `usableInLivePath: false`. That
 *     way, a refactor that flips a flag is caught here instead of in
 *     production.
 *
 * The tests don't import the route's private registry (it's not
 * exported); they import the bridges directly from @freeside-auth/adapters
 * and assert per-bridge invariants. The route's registry construction is
 * a 3-line `Record<CredentialScheme, CredentialBridge>` — if every
 * bridge has its flag right, the registry is correct by construction.
 */

import { describe, expect, it } from "bun:test"
import {
  type CredentialScheme,
  dynamicCredentialBridge,
  eip191CredentialBridge,
  siweCredentialBridge,
} from "@freeside-auth/adapters"

describe("credential bridge registry — FR-A4 live-path quarantine", () => {
  it("siwe bridge: scheme='siwe', usableInLivePath=true", () => {
    expect(siweCredentialBridge.scheme).toBe("siwe")
    expect(siweCredentialBridge.usableInLivePath).toBe(true)
  })

  it("eip191 bridge: scheme='eip191', usableInLivePath=true", () => {
    expect(eip191CredentialBridge.scheme).toBe("eip191")
    expect(eip191CredentialBridge.usableInLivePath).toBe(true)
  })

  it("dynamic bridge: scheme='dynamic_user_id', usableInLivePath=FALSE (the load-bearing assertion)", () => {
    // This single line is the structural enforcement of FR-A4. If it
    // ever flips to true, the Dynamic SDK could re-enter the live auth
    // path. The check exists specifically to make the flip a code-review
    // blocker, not a silent regression.
    expect(dynamicCredentialBridge.scheme).toBe("dynamic_user_id")
    expect(dynamicCredentialBridge.usableInLivePath).toBe(false)
  })

  it("every known CredentialScheme has a bridge with a verify() method", () => {
    const allBridges = [siweCredentialBridge, eip191CredentialBridge, dynamicCredentialBridge]
    const seen = new Set<CredentialScheme>()
    for (const bridge of allBridges) {
      expect(typeof bridge.verify).toBe("function")
      seen.add(bridge.scheme)
    }
    // Sanity: the three bridges cover the three known schemes
    expect(seen.has("siwe")).toBe(true)
    expect(seen.has("eip191")).toBe(true)
    expect(seen.has("dynamic_user_id")).toBe(true)
    expect(seen.size).toBe(3)
  })

  it("dynamic bridge defensively refuses to verify a Dynamic payload? — NO, it processes correctly (proves BACKFILL consumer still works)", async () => {
    // The dynamic bridge MUST still work when invoked directly (T4.4 is
    // its consumer). It's only the LIVE-PATH dispatch that's blocked.
    // This test ensures we haven't broken the backfill consumer by
    // over-tightening the quarantine.
    const result = await dynamicCredentialBridge.verify({
      scheme: "dynamic_user_id",
      dynamicUserId: "backfill-test-id",
      walletAddress: "0x" + "9".repeat(40),
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.walletAddress).toBe("0x" + "9".repeat(40))
      expect(result.linkedAccount?.provider).toBe("dynamic_user_id")
      expect(result.linkedAccount?.externalId).toBe("backfill-test-id")
    }
  })
})
