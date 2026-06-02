/**
 * src/discord-oauth.ts — Discord OAuth verification boundary (bd-2wo.14).
 *
 * This is the ONLY new verification surface in the Discord-social link build.
 * It produces a *verified* discordId from the OAuth dance; the LINKING of that
 * verified id into the spine is 100% existing primitives
 * (`linkVerifiedCredential` → `linkAccountWithAudit` + `resolveByAccount`).
 *
 * SCOPE (spec §"Build"):
 *   - Discord is NOT a verify-path login credential. There is NO
 *     credential-bridge-discord, NO new CredentialScheme. This file is a
 *     standalone OAuth front-end used ONLY by the two /v1/link/discord routes.
 *   - Better Auth is the intended concrete OAuth client (social Discord
 *     provider), used as a LIBRARY for the dance — never mounted as the app
 *     auth runtime. Because `better-auth` is not yet a repo dependency, the
 *     OAuth dance is expressed behind an injectable `DiscordOAuthClient` port
 *     so the routes + linking are fully testable with the boundary mocked
 *     (spec acceptance: "OAuth boundary mocked; live verification waits on
 *     creds"). The Better-Auth-backed impl drops in behind this port without
 *     touching the routes.
 *
 * CSRF / account-linking guard (spec acceptance "OAuth-state/CSRF-negative"):
 *   The OAuth `state` is a signed, single-use, TTL-bounded opaque token bound
 *   to the SESSION user_id. The callback re-derives the binding from `state`
 *   and rejects any state that wasn't minted for THIS session subject. Signing
 *   key = SESSION_SECRET (already loaded + length-validated by src/auth.ts).
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"
import { SESSION_SECRET } from "./auth"

// ─── config gating ──────────────────────────────────────────────────────────

export interface DiscordOAuthConfig {
  readonly clientId: string
  readonly clientSecret: string
  readonly callbackUrl: string
}

/**
 * Resolve the Discord OAuth config from env at request time (mirrors
 * link.ts's request-time LINK_SERVICE_TOKEN read so tests that set env after
 * module load still work). Returns null if ANY required var is missing →
 * the route maps null to `503 service_unconfigured` (fail-closed, same posture
 * as link.ts).
 */
export function getDiscordOAuthConfig(): DiscordOAuthConfig | null {
  const clientId = process.env.DISCORD_CLIENT_ID
  const clientSecret = process.env.DISCORD_CLIENT_SECRET
  const callbackUrl = process.env.DISCORD_LINK_CALLBACK_URL
  if (!clientId || !clientSecret || !callbackUrl) return null
  return { clientId, clientSecret, callbackUrl }
}

// ─── OAuth client port (the Better-Auth seam) ────────────────────────────────

/**
 * The OAuth boundary. `authorizeUrl` builds the Discord consent URL (state +
 * scope embedded); `exchangeCode` swaps the returned `code` for the verified
 * Discord user id. The Better-Auth-backed implementation slots in here; tests
 * inject a fake.
 */
export interface DiscordOAuthClient {
  /** Build the Discord authorize URL the browser is redirected to. */
  authorizeUrl(opts: { config: DiscordOAuthConfig; state: string }): string
  /** Exchange the callback `code` for the verified Discord user id. */
  exchangeCode(opts: { config: DiscordOAuthConfig; code: string }): Promise<string>
}

/**
 * Default OAuth client — builds the standard Discord authorize URL. The
 * `exchangeCode` step is the live boundary that needs a real Discord app; it
 * is intentionally NOT implemented inline here (no `better-auth` dependency
 * yet). It throws `DiscordOAuthNotProvisioned` so a deploy that forgot to wire
 * the Better-Auth client fails loudly rather than silently returning a fake id.
 * Live wiring is the follow-on once Discord creds + better-auth land.
 */
export class DiscordOAuthNotProvisioned extends Error {
  readonly code = "oauth_not_provisioned" as const
  constructor() {
    super(
      "Discord OAuth code-exchange client is not provisioned. Wire the " +
        "Better-Auth Discord social client behind DiscordOAuthClient.exchangeCode.",
    )
  }
}

export const defaultDiscordOAuthClient: DiscordOAuthClient = {
  authorizeUrl({ config, state }) {
    const u = new URL("https://discord.com/oauth2/authorize")
    u.searchParams.set("client_id", config.clientId)
    u.searchParams.set("redirect_uri", config.callbackUrl)
    u.searchParams.set("response_type", "code")
    u.searchParams.set("scope", "identify")
    u.searchParams.set("state", state)
    return u.toString()
  },
  async exchangeCode() {
    throw new DiscordOAuthNotProvisioned()
  },
}

// ─── signed single-use TTL state (CSRF / account-linking guard) ──────────────

const STATE_TTL_MS = 10 * 60 * 1000 // 10 minutes — short window for the dance.

/**
 * The decoded state payload. `sub` is the session user_id the state was minted
 * for; the callback MUST match it against the LIVE session subject. `nonce`
 * makes each state unique (single-use enforcement is the caller's job: it
 * checks the state matches the session's currently-pending nonce).
 */
export interface OAuthStatePayload {
  readonly sub: string
  readonly nonce: string
  readonly exp: number
}

function b64urlEncode(buf: Buffer): string {
  return buf.toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_")
}

function b64urlDecode(s: string): Buffer {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4))
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64")
}

/** HMAC-SHA256 over the payload segment, keyed by SESSION_SECRET. */
function signState(payloadSeg: string): string {
  return b64urlEncode(createHmac("sha256", SESSION_SECRET).update(payloadSeg).digest())
}

/**
 * Mint a signed, single-use, TTL-bounded state token bound to `sub`. The
 * returned `nonce` is what the caller stashes in the session so the callback
 * can enforce single-use.
 */
export function mintOAuthState(sub: string): { state: string; nonce: string } {
  const nonce = b64urlEncode(randomBytes(16))
  const payload: OAuthStatePayload = { sub, nonce, exp: Date.now() + STATE_TTL_MS }
  const payloadSeg = b64urlEncode(Buffer.from(JSON.stringify(payload), "utf8"))
  const sig = signState(payloadSeg)
  return { state: `${payloadSeg}.${sig}`, nonce }
}

/**
 * Verify a state token: constant-time signature check + TTL check. Returns the
 * payload on success, or null on any failure (bad shape, bad signature,
 * expired). The caller is responsible for the remaining two checks:
 *   - `payload.sub === liveSessionSubject` (IDOR / cross-session guard)
 *   - `payload.nonce === session.pendingNonce` (single-use guard)
 */
export function verifyOAuthState(state: string | null | undefined): OAuthStatePayload | null {
  if (typeof state !== "string") return null
  const dot = state.indexOf(".")
  if (dot <= 0 || dot === state.length - 1) return null
  const payloadSeg = state.slice(0, dot)
  const sig = state.slice(dot + 1)

  // Constant-time signature comparison.
  const expected = signState(payloadSeg)
  const a = Buffer.from(sig)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null

  let payload: OAuthStatePayload
  try {
    payload = JSON.parse(b64urlDecode(payloadSeg).toString("utf8")) as OAuthStatePayload
  } catch {
    return null
  }
  if (
    typeof payload?.sub !== "string" ||
    typeof payload?.nonce !== "string" ||
    typeof payload?.exp !== "number"
  ) {
    return null
  }
  if (Date.now() > payload.exp) return null
  return payload
}

// ─── single-use enforcement (replay defense) ─────────────────────────────────
//
// A signed state is otherwise replayable for its full TTL (the signature +
// sub-binding stop forgery/cross-session, but NOT replay). We record CONSUMED
// nonces in a TTL-pruned in-process set; the callback consumes each nonce
// exactly once, so a second presentation of the same state is rejected.
//
// MULTI-INSTANCE CAVEAT: this set is per-process — identical to the default
// `memorySessions()` store this repo already uses. A multi-instance production
// deploy MUST back single-use with a shared store (spine table / Redis) so a
// replay can't land on a second instance. Single-instance dev/staging is
// covered; the live deploy is creds-gated regardless (exchangeCode is stubbed).
const _consumedStateNonces = new Map<string, number>() // nonce → exp (ms epoch)

function _pruneConsumed(now: number): void {
  for (const [nonce, exp] of _consumedStateNonces) {
    if (now > exp) _consumedStateNonces.delete(nonce)
  }
}

/**
 * Atomically consume a state nonce. Returns true on FIRST use (and records it
 * until `exp`); returns false if the nonce was already consumed — i.e. a
 * replay, which the caller rejects with 401. Call this AFTER signature + TTL +
 * session-binding checks pass, so an invalid state never burns a legit nonce.
 */
export function tryConsumeStateNonce(nonce: string, exp: number): boolean {
  const now = Date.now()
  _pruneConsumed(now)
  if (_consumedStateNonces.has(nonce)) return false
  _consumedStateNonces.set(nonce, exp)
  return true
}

/** Test-only: clear the consumed-nonce set between cases. */
export function __resetConsumedStateNoncesForTest(): void {
  _consumedStateNonces.clear()
}
