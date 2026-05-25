/**
 * credential-bridge-eip191.test.ts — unit tests for the EIP-191 bridge (T1.7).
 *
 * Parallel coverage to the SIWE bridge test (same primitive backs both).
 *
 * Coverage:
 *   - happy: personal_sign of "identity-api login challenge: <nonce>" → ok=true
 *   - wallet mismatch → ok=false signature_mismatch
 *   - malformed signature → ok=false malformed_signature
 *   - garbage sig (passes format, fails recovery) → ok=false recover_error|signature_mismatch
 *   - scheme guard: SIWE payload → ok=false scheme_mismatch
 *   - scheme guard: dynamic_user_id payload → ok=false scheme_mismatch
 *   - declarative shape: scheme/flag invariants
 *   - never throws on attacker input
 */

import { describe, expect, it } from "bun:test"
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"
import { eip191CredentialBridge } from "../credential-bridge-eip191"

describe("eip191CredentialBridge — declarative shape", () => {
  it("declares scheme = 'eip191'", () => {
    expect(eip191CredentialBridge.scheme).toBe("eip191")
  })

  it("usableInLivePath === true (EIP-191 is live alongside SIWE per FR-A1)", () => {
    expect(eip191CredentialBridge.usableInLivePath).toBe(true)
  })
})

describe("eip191CredentialBridge.verify() — happy path", () => {
  it("signed Sietch-precedent message recovers to the signer → ok=true, lowercased wallet, no linkedAccount", async () => {
    const pk = generatePrivateKey()
    const account = privateKeyToAccount(pk)
    const message = "identity-api login challenge: abc-nonce-xyz"
    const signature = await account.signMessage({ message })

    const result = await eip191CredentialBridge.verify({
      scheme: "eip191",
      message,
      signature,
      expectedAddress: account.address,
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.walletAddress).toBe(account.address.toLowerCase())
      expect(result.linkedAccount).toBeUndefined()
    }
  })

  it("accepts arbitrary opaque payload (EIP-191 is scheme-agnostic on message shape)", async () => {
    const pk = generatePrivateKey()
    const account = privateKeyToAccount(pk)
    // EIP-191 imposes NO requirement on the message content. Test with a
    // non-Sietch-shaped string to assert we don't lock into a format.
    const message = "Welcome to the freeside!\n\nNonce: deadbeef"
    const signature = await account.signMessage({ message })

    const result = await eip191CredentialBridge.verify({
      scheme: "eip191",
      message,
      signature,
      expectedAddress: account.address,
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.walletAddress).toBe(account.address.toLowerCase())
    }
  })
})

describe("eip191CredentialBridge.verify() — rejection paths", () => {
  it("wrong expectedAddress → ok=false reason='signature_mismatch'", async () => {
    const pkSigner = generatePrivateKey()
    const acctSigner = privateKeyToAccount(pkSigner)
    const pkOther = generatePrivateKey()
    const acctOther = privateKeyToAccount(pkOther)
    const message = "identity-api login challenge: mismatch-nonce"
    const signature = await acctSigner.signMessage({ message })

    const result = await eip191CredentialBridge.verify({
      scheme: "eip191",
      message,
      signature,
      expectedAddress: acctOther.address,
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe("signature_mismatch")
    }
  })

  it("malformed signature (wrong length) → ok=false reason='malformed_signature'", async () => {
    const pk = generatePrivateKey()
    const account = privateKeyToAccount(pk)
    const message = "identity-api login challenge: bad-sig-nonce"

    const result = await eip191CredentialBridge.verify({
      scheme: "eip191",
      message,
      signature: "0xdeadbeef", // too short
      expectedAddress: account.address,
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe("malformed_signature")
    }
  })

  it("garbage signature (passes format, fails recovery) → ok=false reason='recover_error' or 'signature_mismatch'", async () => {
    const pk = generatePrivateKey()
    const account = privateKeyToAccount(pk)
    const message = "identity-api login challenge: garbage-nonce"

    const result = await eip191CredentialBridge.verify({
      scheme: "eip191",
      message,
      signature: "0x" + "f".repeat(130),
      expectedAddress: account.address,
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(["recover_error", "signature_mismatch"]).toContain(result.reason)
    }
  })

  it("never throws on caller-controlled input (auth surface MUST NOT 500)", async () => {
    const nasties: ReadonlyArray<{ message: string; signature: string; expectedAddress: string }> = [
      { message: "", signature: "0x" + "0".repeat(130), expectedAddress: "0x" + "0".repeat(40) },
      { message: "\xff\xfe", signature: "0xnothex", expectedAddress: "garbage" },
      { message: "x".repeat(10_000), signature: "0x", expectedAddress: "0x" + "f".repeat(40) },
    ]
    for (const n of nasties) {
      const result = await eip191CredentialBridge.verify({
        scheme: "eip191",
        ...n,
      })
      expect(result.ok).toBe(false)
    }
  })
})

describe("eip191CredentialBridge.verify() — scheme guard", () => {
  it("invoked with siwe payload → ok=false reason='scheme_mismatch'", async () => {
    const pk = generatePrivateKey()
    const account = privateKeyToAccount(pk)
    const message = "identity-api.test wants you to sign in..."
    const signature = await account.signMessage({ message })

    const result = await eip191CredentialBridge.verify({
      scheme: "siwe",
      message,
      signature,
      expectedAddress: account.address,
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe("scheme_mismatch")
    }
  })

  it("invoked with dynamic_user_id payload → ok=false reason='scheme_mismatch'", async () => {
    const result = await eip191CredentialBridge.verify({
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
