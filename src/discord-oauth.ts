/**
 * src/discord-oauth.ts — Discord OAuth verification boundary (bd-2wo.14).
 *
 * This is the ONLY new verification surface in the Discord-social link build.
 * It produces a *verified* discordId from the OAuth dance; the LINKING of that
 * verified id into the spine is 100% existing primitives
 * (`linkVerifiedCredential` → `linkAccountWithAudit` + `resolveByAccount`).
 *
 * SCOPE (spec §"Build" + addendum identity-api#44):
 *   - Discord is NOT a verify-path login credential (no credential-bridge-discord).
 *   - Link: session-gated `/v1/link/discord/*`. Login: unauthenticated
 *     `/v1/auth/discord/*` (parallel OAuth path, same exchange client).
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

/** Client credentials only — sufficient for login-path OAuth (redirect_uri from request). */
export function getDiscordOAuthCredentials(): Omit<DiscordOAuthConfig, "callbackUrl"> | null {
  const clientId = process.env.DISCORD_CLIENT_ID
  const clientSecret = process.env.DISCORD_CLIENT_SECRET
  if (!clientId || !clientSecret) return null
  return { clientId, clientSecret }
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
  authorizeUrl(opts: {
    config: DiscordOAuthConfig
    state: string
    /** Login flow passes the consumer callback; link flow uses config.callbackUrl. */
    redirectUri?: string
  }): string
  /** Exchange the callback `code` for the verified Discord user id. */
  exchangeCode(opts: {
    config: DiscordOAuthConfig
    code: string
    redirectUri?: string
  }): Promise<string>
}

/** @deprecated Tests may still assert this class; live client uses fetch exchange. */
export class DiscordOAuthNotProvisioned extends Error {
  readonly code = "oauth_not_provisioned" as const
  constructor() {
    super(
      "Discord OAuth code-exchange client is not provisioned. Wire the " +
        "Better-Auth Discord social client behind DiscordOAuthClient.exchangeCode.",
    )
  }
}

export class DiscordOAuthExchangeError extends Error {
  readonly code = "oauth_exchange_failed" as const
  constructor(message = "Discord OAuth code exchange failed") {
    super(message)
  }
}

/**
 * Comma-separated allowlist of BFF OAuth redirect URIs for the login path.
 * Missing/empty → `/v1/auth/discord/authorize` returns 503.
 */
export function getDiscordLoginRedirectAllowlist(): readonly string[] {
  const raw = process.env.DISCORD_LOGIN_REDIRECT_ALLOWLIST
  if (!raw || raw.trim().length === 0) return []
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
}

export function isAllowedLoginRedirectUri(redirectUri: string): boolean {
  return getDiscordLoginRedirectAllowlist().includes(redirectUri)
}

async function exchangeDiscordCodeViaFetch(opts: {
  config: DiscordOAuthConfig
  code: string
  redirectUri: string
}): Promise<string> {
  const body = new URLSearchParams({
    client_id: opts.config.clientId,
    client_secret: opts.config.clientSecret,
    grant_type: "authorization_code",
    code: opts.code,
    redirect_uri: opts.redirectUri,
  })
  const tokenRes = await fetch("https://discord.com/api/oauth2/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  })
  if (!tokenRes.ok) {
    throw new DiscordOAuthExchangeError()
  }
  const tokenJson = (await tokenRes.json()) as { access_token?: string }
  if (typeof tokenJson.access_token !== "string" || tokenJson.access_token.length === 0) {
    throw new DiscordOAuthExchangeError()
  }

  const meRes = await fetch("https://discord.com/api/users/@me", {
    headers: { authorization: `Bearer ${tokenJson.access_token}` },
  })
  if (!meRes.ok) {
    throw new DiscordOAuthExchangeError()
  }
  const me = (await meRes.json()) as { id?: string }
  if (typeof me.id !== "string" || me.id.length === 0) {
    throw new DiscordOAuthExchangeError()
  }
  return me.id
}

export const defaultDiscordOAuthClient: DiscordOAuthClient = {
  authorizeUrl({ config, state, redirectUri }) {
    const u = new URL("https://discord.com/oauth2/authorize")
    u.searchParams.set("client_id", config.clientId)
    u.searchParams.set("redirect_uri", redirectUri ?? config.callbackUrl)
    u.searchParams.set("response_type", "code")
    u.searchParams.set("scope", "identify")
    u.searchParams.set("state", state)
    return u.toString()
  },
  async exchangeCode({ config, code, redirectUri }) {
    const effectiveRedirect = redirectUri ?? config.callbackUrl
    return exchangeDiscordCodeViaFetch({ config, code, redirectUri: effectiveRedirect })
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

/** Login-path state (no session yet) — bound to consumer redirect + CSRF. */
export interface LoginOAuthStatePayload {
  readonly kind: "login"
  readonly redirect_uri: string
  readonly csrf_state: string
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

/**
 * Mint login-path OAuth state bound to `{ redirect_uri, csrf_state }`.
 * The opaque `state` returned to Discord embeds the consumer CSRF token.
 */
export function mintLoginOAuthState(
  redirectUri: string,
  csrfState: string,
): { state: string; nonce: string } {
  const nonce = b64urlEncode(randomBytes(16))
  const payload: LoginOAuthStatePayload = {
    kind: "login",
    redirect_uri: redirectUri,
    csrf_state: csrfState,
    nonce,
    exp: Date.now() + STATE_TTL_MS,
  }
  const payloadSeg = b64urlEncode(Buffer.from(JSON.stringify(payload), "utf8"))
  const sig = signState(payloadSeg)
  return { state: `${payloadSeg}.${sig}`, nonce }
}

/** Verify login-path OAuth state (signature + TTL + shape). */
export function verifyLoginOAuthState(
  state: string | null | undefined,
): LoginOAuthStatePayload | null {
  if (typeof state !== "string") return null
  const dot = state.indexOf(".")
  if (dot <= 0 || dot === state.length - 1) return null
  const payloadSeg = state.slice(0, dot)
  const sig = state.slice(dot + 1)

  const expected = signState(payloadSeg)
  const a = Buffer.from(sig)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null

  let payload: LoginOAuthStatePayload
  try {
    payload = JSON.parse(b64urlDecode(payloadSeg).toString("utf8")) as LoginOAuthStatePayload
  } catch {
    return null
  }
  if (
    payload?.kind !== "login" ||
    typeof payload.redirect_uri !== "string" ||
    typeof payload.csrf_state !== "string" ||
    typeof payload.nonce !== "string" ||
    typeof payload.exp !== "number"
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
