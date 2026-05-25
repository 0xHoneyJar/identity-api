/**
 * credential-bridge-dynamic.test.ts — Dynamic backfill bridge tests (T1.7).
 *
 * The bridge does NO crypto verification — it processes pre-extracted
 * (dynamic_user_id, wallet) pairs from a trusted backfill source row.
 * Tests focus on: input contract enforcement, output shape, the
 * usableInLivePath: false flag, and the no-throw discipline.
 *
 * Coverage:
 *   - declarative shape: scheme + usableInLivePath: false
 *   - happy: valid pair → ok=true, walletAddress lowercased, linkedAccount populated
 *   - rejection: empty dynamic_user_id → invalid_dynamic_user_id
 *   - rejection: too-long dynamic_user_id → invalid_dynamic_user_id
 *   - rejection: bad wallet (not 0x-40-hex) → invalid_wallet_address
 *   - scheme guard: SIWE payload → scheme_mismatch
 *   - scheme guard: EIP-191 payload → scheme_mismatch
 *   - never throws on attacker input
 *   - linkedAccount.provider IS 'dynamic_user_id' verbatim (PRD §4 string)
 *   - linkedAccount.externalId is the input verbatim (no normalization)
 */

import { describe, expect, it } from "bun:test"
import { dynamicCredentialBridge } from "../credential-bridge-dynamic"

describe("dynamicCredentialBridge — declarative shape", () => {
  it("declares scheme = 'dynamic_user_id'", () => {
    expect(dynamicCredentialBridge.scheme).toBe("dynamic_user_id")
  })

  it("usableInLivePath === FALSE (BACKFILL ONLY per FR-A4 — the load-bearing flag)", () => {
    // This single assertion is the load-bearing live-path quarantine at
    // the type/runtime layer. If this flips to true, the Dynamic SDK
    // becomes reachable from /v1/auth/verify. Test exists specifically
    // to make any flip a code-review-visible blocker.
    expect(dynamicCredentialBridge.usableInLivePath).toBe(false)
  })
})

describe("dynamicCredentialBridge.verify() — happy path", () => {
  it("valid (dynamic_user_id, wallet) pair → ok=true, lowercased wallet, linkedAccount populated", async () => {
    const dynamicUserId = "dyn_user_abc123-fake-uuid-shape"
    const walletAddress = "0xAbCdEf0123456789ABCDEF0123456789ABCDEF01"

    const result = await dynamicCredentialBridge.verify({
      scheme: "dynamic_user_id",
      dynamicUserId,
      walletAddress,
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      // Wallet lowercased (matches spine normalization)
      expect(result.walletAddress).toBe(walletAddress.toLowerCase())
      // LinkedAccount populated with the verbatim externalId
      expect(result.linkedAccount).toEqual({
        provider: "dynamic_user_id",
        externalId: dynamicUserId,
      })
    }
  })

  it("linkedAccount.provider is the verbatim PRD §4 string 'dynamic_user_id'", async () => {
    const result = await dynamicCredentialBridge.verify({
      scheme: "dynamic_user_id",
      dynamicUserId: "some-id",
      walletAddress: "0x" + "1".repeat(40),
    })
    expect(result.ok).toBe(true)
    if (result.ok && result.linkedAccount) {
      // CRITICAL: this string lands in linked_accounts.provider via T4.4.
      // It MUST match the canonical PRD §4 string verbatim — any drift
      // would partition the linked_accounts namespace.
      expect(result.linkedAccount.provider).toBe("dynamic_user_id")
    }
  })

  it("linkedAccount.externalId is the input verbatim (no normalization/case-folding)", async () => {
    // Dynamic IDs may be case-sensitive UUIDs in practice. Round-trip
    // the input through the bridge and assert it comes out unchanged.
    const idWithMixedCase = "DyN_uSeR_iD_WiTh_MiXeD_CaSe_xYz"
    const result = await dynamicCredentialBridge.verify({
      scheme: "dynamic_user_id",
      dynamicUserId: idWithMixedCase,
      walletAddress: "0x" + "a".repeat(40),
    })
    expect(result.ok).toBe(true)
    if (result.ok && result.linkedAccount) {
      expect(result.linkedAccount.externalId).toBe(idWithMixedCase)
    }
  })
})

describe("dynamicCredentialBridge.verify() — input contract rejections", () => {
  it("empty dynamic_user_id → ok=false invalid_dynamic_user_id", async () => {
    const result = await dynamicCredentialBridge.verify({
      scheme: "dynamic_user_id",
      dynamicUserId: "",
      walletAddress: "0x" + "a".repeat(40),
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe("invalid_dynamic_user_id")
    }
  })

  it("dynamic_user_id over 256 chars → ok=false invalid_dynamic_user_id", async () => {
    const result = await dynamicCredentialBridge.verify({
      scheme: "dynamic_user_id",
      dynamicUserId: "x".repeat(257),
      walletAddress: "0x" + "a".repeat(40),
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe("invalid_dynamic_user_id")
    }
  })

  it("wallet address missing 0x prefix → ok=false invalid_wallet_address", async () => {
    const result = await dynamicCredentialBridge.verify({
      scheme: "dynamic_user_id",
      dynamicUserId: "good-id",
      walletAddress: "a".repeat(40),
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe("invalid_wallet_address")
    }
  })

  it("wallet address wrong length → ok=false invalid_wallet_address", async () => {
    const result = await dynamicCredentialBridge.verify({
      scheme: "dynamic_user_id",
      dynamicUserId: "good-id",
      walletAddress: "0x" + "a".repeat(38), // too short
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe("invalid_wallet_address")
    }
  })

  it("wallet address non-hex chars → ok=false invalid_wallet_address", async () => {
    const result = await dynamicCredentialBridge.verify({
      scheme: "dynamic_user_id",
      dynamicUserId: "good-id",
      walletAddress: "0x" + "z".repeat(40),
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe("invalid_wallet_address")
    }
  })

  it("never throws on attacker input (auth surface posture is preserved even off-live-path)", async () => {
    // The bridge isn't reachable from the live auth path, but should
    // still uphold no-throw discipline so callers (T4.4 migration) can
    // surface graceful errors instead of crashing the migration run.
    const nasties: ReadonlyArray<{ dynamicUserId: unknown; walletAddress: unknown }> = [
      { dynamicUserId: null, walletAddress: "0x" + "0".repeat(40) },
      { dynamicUserId: undefined, walletAddress: "0x" + "0".repeat(40) },
      { dynamicUserId: 12345, walletAddress: "0x" + "0".repeat(40) },
      { dynamicUserId: "ok", walletAddress: null },
      { dynamicUserId: "ok", walletAddress: undefined },
      { dynamicUserId: "ok", walletAddress: 42 },
      { dynamicUserId: { malicious: "object" }, walletAddress: { evil: true } },
    ]
    for (const n of nasties) {
      const result = await dynamicCredentialBridge.verify({
        scheme: "dynamic_user_id",
        // Cast through unknown — runtime guards are the test target
        dynamicUserId: n.dynamicUserId as string,
        walletAddress: n.walletAddress as string,
      })
      expect(result.ok).toBe(false)
    }
  })
})

describe("dynamicCredentialBridge.verify() — scheme guard", () => {
  it("invoked with siwe payload → ok=false reason='scheme_mismatch'", async () => {
    const result = await dynamicCredentialBridge.verify({
      scheme: "siwe",
      message: "anything",
      signature: "0x" + "f".repeat(130),
      expectedAddress: "0x" + "a".repeat(40),
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe("scheme_mismatch")
    }
  })

  it("invoked with eip191 payload → ok=false reason='scheme_mismatch'", async () => {
    const result = await dynamicCredentialBridge.verify({
      scheme: "eip191",
      message: "anything",
      signature: "0x" + "f".repeat(130),
      expectedAddress: "0x" + "a".repeat(40),
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe("scheme_mismatch")
    }
  })
})
