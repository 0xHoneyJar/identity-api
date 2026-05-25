/**
 * wallet-signature.test.ts — unit tests for the T1.6 signature primitive.
 *
 * Strategy: use viem's own primitives (`generatePrivateKey`,
 * `privateKeyToAccount`, `signMessage`) to produce ground-truth signatures
 * we can verify against. This gives us reproducible known-vector tests
 * without baking in mainnet addresses or relying on external fixtures.
 *
 * Coverage:
 *   - happy: EIP-191 signMessage → verifySignature returns ok=true
 *   - happy: SIWE-shaped message signed via personal_sign → ok=true (the
 *            scheme=siwe dispatch routes through the same recovery)
 *   - mismatch: wrong expectedAddress → ok=false reason='signature_mismatch'
 *   - mismatch: tampered message → ok=false reason='signature_mismatch'
 *   - malformed: wrong-length / non-hex / no-0x / non-string → ok=false reason='malformed_signature'
 *   - garbage (passes length+hex check but invalid r/s/v) → ok=false reason='recover_error'
 *   - case-insensitivity: lowercase expected vs checksummed-case recovered → ok=true
 *   - helpers: addressesEqual + isValidSignatureFormat unit cases
 */

import { describe, expect, it } from "bun:test"
import {
  generatePrivateKey,
  privateKeyToAccount,
} from "viem/accounts"
import {
  addressesEqual,
  isValidSignatureFormat,
  verifySignature,
} from "../wallet-signature"

describe("verifySignature() — happy paths", () => {
  it("EIP-191 personal_sign: signature recovers to the signer, ok=true", async () => {
    const pk = generatePrivateKey()
    const account = privateKeyToAccount(pk)
    const message = "identity-api login challenge: abc123"
    const signature = await account.signMessage({ message })

    const result = await verifySignature({
      scheme: "eip191",
      message,
      signature,
      expectedAddress: account.address,
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      // Recovered address matches case-insensitively (viem returns EIP-55
      // checksummed; the input expected may be either case).
      expect(result.recoveredAddress.toLowerCase()).toBe(account.address.toLowerCase())
    }
  })

  it("SIWE message signed via personal_sign: scheme='siwe' routes through the same recovery, ok=true", async () => {
    const pk = generatePrivateKey()
    const account = privateKeyToAccount(pk)
    // Synthetic SIWE EIP-4361 message. viem's createSiweMessage would
    // produce the same structure, but for the recovery test the exact
    // string matters more than the EIP-4361 grammar (signing is via
    // personal_sign on the verbatim string either way).
    const message = [
      "identity-api wants you to sign in with your Ethereum account:",
      account.address,
      "",
      "Sign in to identity-api.",
      "",
      "URI: https://identity-api.example.com",
      "Version: 1",
      "Chain ID: 1",
      "Nonce: o4DNeid0mSzlB4IDNYvU_G8aUDULzj91-ZMeDUddZxc",
      "Issued At: 2026-05-24T00:00:00Z",
    ].join("\n")
    const signature = await account.signMessage({ message })

    const result = await verifySignature({
      scheme: "siwe",
      message,
      signature,
      expectedAddress: account.address,
    })

    expect(result.ok).toBe(true)
  })

  it("case-insensitive address comparison: lowercase expected vs checksummed signer ok=true", async () => {
    const pk = generatePrivateKey()
    const account = privateKeyToAccount(pk)
    const message = "test-case-insensitive"
    const signature = await account.signMessage({ message })

    const result = await verifySignature({
      scheme: "eip191",
      message,
      signature,
      // EIP-55-checksummed vs all-lower must both work.
      expectedAddress: account.address.toLowerCase(),
    })
    expect(result.ok).toBe(true)
  })
})

describe("verifySignature() — rejection paths", () => {
  it("wrong expectedAddress: ok=false reason='signature_mismatch'", async () => {
    const pkSigner = generatePrivateKey()
    const accSigner = privateKeyToAccount(pkSigner)
    const pkOther = generatePrivateKey()
    const accOther = privateKeyToAccount(pkOther)

    const message = "test-wrong-address"
    const signature = await accSigner.signMessage({ message })

    const result = await verifySignature({
      scheme: "eip191",
      message,
      signature,
      expectedAddress: accOther.address, // sig is from accSigner, not accOther
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe("signature_mismatch")
    }
  })

  it("tampered message: recovers to a different (random) address → 'signature_mismatch'", async () => {
    const pk = generatePrivateKey()
    const account = privateKeyToAccount(pk)
    const signature = await account.signMessage({ message: "the-real-message" })

    const result = await verifySignature({
      scheme: "eip191",
      message: "a-completely-different-message",
      signature,
      expectedAddress: account.address,
    })
    expect(result.ok).toBe(false)
    // The recovery will succeed (signatures recover SOMEONE — the math
    // works) but to a different address than the real signer. Net: mismatch.
    if (!result.ok) {
      expect(result.reason).toBe("signature_mismatch")
    }
  })

  it("signature with wrong length: ok=false reason='malformed_signature'", async () => {
    const result = await verifySignature({
      scheme: "eip191",
      message: "x",
      signature: "0xdeadbeef", // too short (10 chars vs 132)
      expectedAddress: "0x0000000000000000000000000000000000000001",
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe("malformed_signature")
  })

  it("signature without 0x prefix: ok=false reason='malformed_signature'", async () => {
    const result = await verifySignature({
      scheme: "eip191",
      message: "x",
      signature: "f".repeat(130), // 130 hex chars without 0x = 130 length, no prefix
      expectedAddress: "0x0000000000000000000000000000000000000001",
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe("malformed_signature")
  })

  it("signature with non-hex chars: ok=false reason='malformed_signature'", async () => {
    const result = await verifySignature({
      scheme: "eip191",
      message: "x",
      signature: "0x" + "z".repeat(130), // 132 chars total but z is not hex
      expectedAddress: "0x0000000000000000000000000000000000000001",
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe("malformed_signature")
  })

  it("garbage that passes length + hex check but fails recovery: ok=false (mismatch or recover_error, never throws)", async () => {
    // 132-char hex string with structurally-valid bytes but a recovery
    // id (v) outside 27/28/0/1 → viem may either throw (caught → recover_error)
    // OR recover to a deterministic-random address (compared → signature_mismatch).
    // Either is a CLEAN ok:false; the LOAD-BEARING property is "no 500".
    const result = await verifySignature({
      scheme: "eip191",
      message: "x",
      signature: "0x" + "a".repeat(130),
      expectedAddress: "0x0000000000000000000000000000000000000001",
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(["recover_error", "signature_mismatch"]).toContain(result.reason)
    }
  })
})

describe("isValidSignatureFormat() unit", () => {
  it("accepts a canonical 65-byte hex signature", () => {
    expect(isValidSignatureFormat("0x" + "a".repeat(130))).toBe(true)
    expect(isValidSignatureFormat("0x" + "F".repeat(130))).toBe(true)
  })

  it("rejects: missing 0x", () => {
    expect(isValidSignatureFormat("a".repeat(132))).toBe(false)
  })

  it("rejects: wrong length", () => {
    expect(isValidSignatureFormat("0x")).toBe(false)
    expect(isValidSignatureFormat("0x" + "a".repeat(129))).toBe(false)
    expect(isValidSignatureFormat("0x" + "a".repeat(131))).toBe(false)
  })

  it("rejects: non-hex chars", () => {
    expect(isValidSignatureFormat("0x" + "g".repeat(130))).toBe(false)
  })

  it("rejects: non-string", () => {
    // biome-ignore lint/suspicious/noExplicitAny: testing runtime type guard
    expect(isValidSignatureFormat(null as any)).toBe(false)
    // biome-ignore lint/suspicious/noExplicitAny: testing runtime type guard
    expect(isValidSignatureFormat(undefined as any)).toBe(false)
    // biome-ignore lint/suspicious/noExplicitAny: testing runtime type guard
    expect(isValidSignatureFormat(123 as any)).toBe(false)
  })
})

describe("addressesEqual() unit", () => {
  it("equal case-insensitively", () => {
    expect(
      addressesEqual(
        "0xabcdef0000000000000000000000000000000001",
        "0xABCDEF0000000000000000000000000000000001",
      ),
    ).toBe(true)
  })

  it("inequal addresses", () => {
    expect(
      addressesEqual(
        "0xaaaaaa0000000000000000000000000000000001",
        "0xbbbbbb0000000000000000000000000000000001",
      ),
    ).toBe(false)
  })

  it("rejects malformed inputs (defense-deny posture)", () => {
    expect(addressesEqual("not-an-address", "0x" + "a".repeat(40))).toBe(false)
    expect(addressesEqual("0x" + "a".repeat(40), "")).toBe(false)
    expect(addressesEqual("", "")).toBe(false)
  })

  it("rejects non-string types", () => {
    // biome-ignore lint/suspicious/noExplicitAny: testing runtime type guard
    expect(addressesEqual(null as any, "0x" + "a".repeat(40))).toBe(false)
    // biome-ignore lint/suspicious/noExplicitAny: testing runtime type guard
    expect(addressesEqual(undefined as any, undefined as any)).toBe(false)
  })
})
