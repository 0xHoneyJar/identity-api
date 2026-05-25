/**
 * credential-bridge-siwe.test.ts — unit tests for the SIWE bridge (T1.7).
 *
 * Mirrors the T1.6 wallet-signature.test.ts pattern: use viem's own
 * primitives to produce ground-truth signatures, no fixed mainnet
 * vectors needed.
 *
 * Coverage:
 *   - happy: signed SIWE message → ok=true with lowercased wallet
 *   - wallet mismatch: wrong expectedAddress → ok=false signature_mismatch
 *   - malformed signature: wrong-length hex → ok=false malformed_signature
 *   - tampered message: ok=false signature_mismatch
 *   - scheme guard: invoked with eip191 payload → ok=false scheme_mismatch
 *   - scheme guard: invoked with dynamic_user_id payload → ok=false scheme_mismatch
 *   - live-path flag: usableInLivePath === true
 *   - no linkedAccount on success (SIWE is wallet-first; nothing else to link)
 *   - no exception on viem-internal failure (recover_error path)
 *   - lowercases recovered address regardless of input checksum case
 */

import { describe, expect, it } from "bun:test"
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"
import { siweCredentialBridge } from "../credential-bridge-siwe"

const SAMPLE_SIWE_MESSAGE = (address: string, nonce: string) =>
  [
    "identity-api.test wants you to sign in with your Ethereum account:",
    address,
    "",
    "Sign in to identity-api test.",
    "",
    "URI: https://identity-api.test",
    "Version: 1",
    "Chain ID: 1",
    `Nonce: ${nonce}`,
    "Issued At: 2026-05-25T00:00:00Z",
  ].join("\n")

describe("siweCredentialBridge — declarative shape", () => {
  it("declares scheme = 'siwe'", () => {
    expect(siweCredentialBridge.scheme).toBe("siwe")
  })

  it("usableInLivePath === true (FR-A4: SIWE is the primary live-path scheme)", () => {
    expect(siweCredentialBridge.usableInLivePath).toBe(true)
  })
})

describe("siweCredentialBridge.verify() — happy path", () => {
  it("signed SIWE message recovers to the signer → ok=true, lowercased wallet, no linkedAccount", async () => {
    const pk = generatePrivateKey()
    const account = privateKeyToAccount(pk)
    const message = SAMPLE_SIWE_MESSAGE(account.address, "abc123-test-nonce")
    const signature = await account.signMessage({ message })

    const result = await siweCredentialBridge.verify({
      scheme: "siwe",
      message,
      signature,
      expectedAddress: account.address,
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.walletAddress).toBe(account.address.toLowerCase())
      // SIWE is wallet-first; no linkedAccount is minted
      expect(result.linkedAccount).toBeUndefined()
    }
  })

  it("expectedAddress passed in lowercase still recovers cleanly (case-insensitive compare in wallet-signature)", async () => {
    const pk = generatePrivateKey()
    const account = privateKeyToAccount(pk)
    const message = SAMPLE_SIWE_MESSAGE(account.address, "case-test-nonce")
    const signature = await account.signMessage({ message })

    const result = await siweCredentialBridge.verify({
      scheme: "siwe",
      message,
      signature,
      expectedAddress: account.address.toLowerCase(),
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      // Result is ALWAYS lowercase (matches spine storage normalization)
      expect(result.walletAddress).toBe(account.address.toLowerCase())
    }
  })
})

describe("siweCredentialBridge.verify() — rejection paths", () => {
  it("wrong expectedAddress → ok=false reason='signature_mismatch'", async () => {
    const pkSigner = generatePrivateKey()
    const acctSigner = privateKeyToAccount(pkSigner)
    const pkOther = generatePrivateKey()
    const acctOther = privateKeyToAccount(pkOther)
    const message = SAMPLE_SIWE_MESSAGE(acctSigner.address, "mismatch-test-nonce")
    const signature = await acctSigner.signMessage({ message })

    const result = await siweCredentialBridge.verify({
      scheme: "siwe",
      message,
      signature,
      expectedAddress: acctOther.address, // wrong wallet
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe("signature_mismatch")
    }
  })

  it("tampered message → ok=false reason='signature_mismatch'", async () => {
    const pk = generatePrivateKey()
    const account = privateKeyToAccount(pk)
    const original = SAMPLE_SIWE_MESSAGE(account.address, "tamper-test-nonce")
    const signature = await account.signMessage({ message: original })

    // Verify against a DIFFERENT (tampered) message
    const tampered = SAMPLE_SIWE_MESSAGE(account.address, "tampered-nonce")
    const result = await siweCredentialBridge.verify({
      scheme: "siwe",
      message: tampered,
      signature,
      expectedAddress: account.address,
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe("signature_mismatch")
    }
  })

  it("malformed signature (wrong length) → ok=false reason='malformed_signature'", async () => {
    const pk = generatePrivateKey()
    const account = privateKeyToAccount(pk)
    const message = SAMPLE_SIWE_MESSAGE(account.address, "malformed-test-nonce")

    const result = await siweCredentialBridge.verify({
      scheme: "siwe",
      message,
      signature: "0x" + "a".repeat(64), // too short (should be 130 hex chars)
      expectedAddress: account.address,
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe("malformed_signature")
    }
  })

  it("garbage signature (passes length+hex, fails recovery) → ok=false reason='recover_error' or 'signature_mismatch'", async () => {
    const pk = generatePrivateKey()
    const account = privateKeyToAccount(pk)
    const message = SAMPLE_SIWE_MESSAGE(account.address, "garbage-test-nonce")

    const result = await siweCredentialBridge.verify({
      scheme: "siwe",
      message,
      // 132 char 0x-prefixed hex — passes format but is not a valid sig
      signature: "0x" + "f".repeat(130),
      expectedAddress: account.address,
    })

    // Either recover throws (recover_error) OR recovers to garbage (signature_mismatch).
    // Both are acceptable rejection paths — the route returns 401 either way.
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(["recover_error", "signature_mismatch"]).toContain(result.reason)
    }
  })

  it("never throws on caller-controlled input (auth surface MUST NOT 500)", async () => {
    // Throw a battery of nasty inputs at the bridge; assert nothing throws.
    const nasties: ReadonlyArray<{ message: string; signature: string; expectedAddress: string }> = [
      { message: "", signature: "0x" + "0".repeat(130), expectedAddress: "0x" + "0".repeat(40) },
      { message: "\x00\x01\x02", signature: "not-even-hex", expectedAddress: "0x" + "f".repeat(40) },
      { message: "anything", signature: "0x", expectedAddress: "0xnothex" },
    ]
    for (const n of nasties) {
      const result = await siweCredentialBridge.verify({
        scheme: "siwe",
        ...n,
      })
      expect(result.ok).toBe(false) // EVERY nasty input MUST resolve to ok=false (no throw)
    }
  })
})

describe("siweCredentialBridge.verify() — scheme guard", () => {
  it("invoked with eip191 payload → ok=false reason='scheme_mismatch' (no throw)", async () => {
    const pk = generatePrivateKey()
    const account = privateKeyToAccount(pk)
    const message = "identity-api login challenge: not-siwe"
    const signature = await account.signMessage({ message })

    // Cast through the union: type system normally prevents this, but the
    // runtime guard is defense-in-depth against caller-routing bugs.
    const result = await siweCredentialBridge.verify({
      scheme: "eip191",
      message,
      signature,
      expectedAddress: account.address,
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe("scheme_mismatch")
    }
  })

  it("invoked with dynamic_user_id payload → ok=false reason='scheme_mismatch' (no throw)", async () => {
    // The Dynamic backfill payload shape is totally different — no signature, no message.
    // The bridge must refuse cleanly.
    const result = await siweCredentialBridge.verify({
      scheme: "dynamic_user_id",
      dynamicUserId: "dyn-fake-id",
      walletAddress: "0x" + "a".repeat(40),
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe("scheme_mismatch")
    }
  })
})
