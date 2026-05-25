/**
 * types.type-test.ts — COMPILE-TIME proofs that the SDK's typed surface
 * is doing what it claims (T1.10 verdict L6 closure).
 *
 * This file is intentionally NOT run as a runtime test — it exists to be
 * typechecked by `tsc --noEmit`. Each `@ts-expect-error` line below is a
 * load-bearing assertion: if the line ABOVE the directive typechecks
 * cleanly (i.e., does NOT produce an error), tsc itself fails with "Unused
 * '@ts-expect-error' directive". So:
 *
 *   - Pass = the deliberate mistake produced a compile error (good).
 *   - Fail = the deliberate mistake didn't produce a compile error
 *            (the typed surface is too loose — SDK regression).
 *
 * Run: `bun run typecheck` (from any package containing this file in its
 * `include`). The test file is colocated with the runtime tests so
 * `packages/sdk/tsconfig.json`'s include glob 'src slash star star' covers it.
 *
 * Conventions:
 *   - One @ts-expect-error per intended-failure line.
 *   - The line ABOVE the directive is the failure-target.
 *   - Comments name the LOAD-BEARING property being proved.
 */

import { createIdentityClient } from "../client"

const client = createIdentityClient({ baseUrl: "https://example.test" })

// ─── auth.challenge — input shape enforcement ──────────────────────────────

async function _challengeShapeProofs(): Promise<void> {
  // OK — correct shape.
  await client.auth.challenge({
    walletAddress: "0xabc",
    scheme: "siwe",
  })

  // FAIL: typo in field name (`address` vs `walletAddress`).
  // @ts-expect-error
  await client.auth.challenge({ address: "0xabc", scheme: "siwe" })

  // FAIL: wrong type for `walletAddress` (number vs string).
  // @ts-expect-error
  await client.auth.challenge({ walletAddress: 0x42, scheme: "siwe" })

  // FAIL: `scheme` enum admits only "siwe" | "eip191" — dynamic_user_id
  // is structurally inaccessible from the live-path auth surface (FR-A4
  // enforcement at the typed boundary).
  // @ts-expect-error
  await client.auth.challenge({ walletAddress: "0xabc", scheme: "dynamic_user_id" })

  // FAIL: unknown extra field (collapsed to one line so the @ts-expect-error
  // points at the offending call expression — multi-line literals push the
  // error to the field line, leaving the suppressor "unused").
  // @ts-expect-error
  await client.auth.challenge({ walletAddress: "0xabc", scheme: "siwe", unknownField: true })

  // OK — `scheme` is optional (defaults to siwe server-side; Zod schema
  // declares .default("siwe") so the input type marks it optional).
  await client.auth.challenge({ walletAddress: "0xabc" })
}

// ─── auth.verify — input shape enforcement ─────────────────────────────────

async function _verifyShapeProofs(): Promise<void> {
  await client.auth.verify({
    nonce: "abc",
    signature: "0x" + "a".repeat(130),
    walletAddress: "0xabc",
    scheme: "siwe",
  })

  // FAIL: missing required field (signature). Collapsed so the @ts-expect-error
  // points at the call expression itself, not at a missing-field line that
  // doesn't exist (the error is "Property 'signature' missing in argument").
  // @ts-expect-error
  await client.auth.verify({ nonce: "abc", walletAddress: "0xabc", scheme: "siwe" })

  // FAIL: live-path scheme is enum-narrowed; dynamic_user_id rejected.
  // @ts-expect-error
  await client.auth.verify({ nonce: "abc", signature: "0xdead", walletAddress: "0xabc", scheme: "dynamic_user_id" })
}

// ─── response shape proofs (the "typed RPC client" claim) ──────────────────

async function _responseShapeProofs(): Promise<void> {
  const challengeResp = await client.auth.challenge({ walletAddress: "0xabc", scheme: "siwe" })
  // OK — `nonce`, `message`, `expires_at` are typed strings.
  const _n: string = challengeResp.nonce
  const _m: string = challengeResp.message
  const _e: string = challengeResp.expires_at
  void _n; void _m; void _e

  // FAIL: response does NOT carry `userId` (that's on VerifyResp, not
  // ChallengeResp) — the typed surface enforces the asymmetry.
  // @ts-expect-error
  const _u: string = challengeResp.userId
  void _u

  const verifyResp = await client.auth.verify({
    nonce: "n",
    signature: "0xs",
    walletAddress: "0xa",
    scheme: "siwe",
  })
  // OK — VerifyResp carries user_id + primary_wallet + nested session.
  const _uid: string = verifyResp.user_id
  const _pw: string = verifyResp.primary_wallet
  const _token: string = verifyResp.session.token
  const _exp: number = verifyResp.session.expires_at
  void _uid; void _pw; void _token; void _exp

  // FAIL: session.expires_at is unix-seconds (number), NOT a Date.
  // @ts-expect-error
  const _expWrong: Date = verifyResp.session.expires_at
  void _expWrong
}

// ─── resolve.* return type — Hit | null narrowing ──────────────────────────

async function _resolveNullableProofs(): Promise<void> {
  const hit = await client.resolve.byWallet("0xabc")
  // FAIL: cannot directly access `.user_id` — type is Hit | null and the
  // null branch hasn't been narrowed away. Compiler catches at this site,
  // not at runtime.
  // @ts-expect-error
  const _u: string = hit.user_id
  void _u

  // OK — explicit narrowing.
  if (hit !== null) {
    const _u2: string = hit.user_id
    void _u2
  }

  const resolved = await client.resolve.byAccount("discord", "abc")
  // FAIL: bad provider literal — enum is "discord" | "telegram" | "dynamic_user_id".
  // @ts-expect-error
  await client.resolve.byAccount("twitter", "x")
  void resolved
}

// ─── identity.get — Hit | null narrowing on the spine-row shape ────────────

async function _identityGetProofs(): Promise<void> {
  const maybeIdentity = await client.identity.get("uuid")
  // FAIL: wallet[].wallet_address is `string`, NOT `number`.
  // The optional-chain rules out the null branch but the typed shape
  // still enforces the field types.
  // @ts-expect-error
  const _w: number = maybeIdentity?.wallets[0]?.wallet_address
  void _w

  // OK — correct type.
  const w: string | undefined = maybeIdentity?.wallets[0]?.wallet_address
  void w

  if (maybeIdentity !== null) {
    // FAIL: linked_accounts[].provider enum (no "twitter"). The .provider
    // type is "discord" | "telegram" | "dynamic_user_id"; assigning it to
    // a `"twitter"`-typed slot is a contradiction.
    const provider = maybeIdentity.linked_accounts[0]?.provider
    // @ts-expect-error
    const _twitter: "twitter" = provider
    void _twitter
  }
}

// ─── me() — requires JWT at construction OR throws (typed) ─────────────────

async function _meProofs(): Promise<void> {
  // OK — me() returns IdentityResp; same shape as identity.get's hit.
  const meR = await client.me()
  const _u: string = meR.user_id
  void _u
}

// ─── link.verifiedWallet — input + opts shape ──────────────────────────────

async function _linkProofs(): Promise<void> {
  const linkBody = {
    worldSlug: "mibera",
    discordId: "d",
    walletAddress: "0xabc",
  }
  // FAIL: serviceToken is REQUIRED on the opts arg (the SDK enforces
  // S2S-bearer-token presence at compile time). Collapse the call expression
  // onto one line so the @ts-expect-error pins to the call, not the empty
  // object literal.
  // @ts-expect-error
  await client.link.verifiedWallet(linkBody, {})

  // OK with serviceToken.
  await client.link.verifiedWallet(linkBody, { serviceToken: "tok" })
}

// Anchor each proof function to keep tsc from tree-shaking them out
// of the typecheck (otherwise unused-function diagnostics could mask
// the @ts-expect-error claims).
void _challengeShapeProofs
void _verifyShapeProofs
void _responseShapeProofs
void _resolveNullableProofs
void _identityGetProofs
void _meProofs
void _linkProofs
