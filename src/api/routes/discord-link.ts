/**
 * /v1/link/discord/{initiate,callback} — session-gated Discord OAuth-verify
 * + link front-end (bd-2wo.14).
 *
 * The ONLY new verification surface for Discord-social linking. The linking
 * write reuses the existing spine primitives via `linkVerifiedCredential`
 * (→ resolveByAccount + linkAccountWithAudit + LinkCrossUserCollisionError).
 * NO new minting/collision/idempotency logic here.
 *
 * Auth: both routes are `.auth()`-gated (JWT bearer), identical to me.ts —
 * `c.ctx.jwt.sub` is the authenticated user_id. The linked user_id is ALWAYS
 * that session subject; NO request input (query/state) can specify a different
 * user_id (IDOR guard).
 *
 * Flow:
 *   GET /v1/link/discord/initiate
 *     → mint a signed, TTL-bounded OAuth `state` bound to the session sub
 *     → 302 redirect to the Discord authorize URL.
 *   GET /v1/link/discord/callback?code=...&state=...
 *     → verify state signature + TTL, AND state.sub === live session sub
 *       (CSRF / account-linking guard — a state minted for another session
 *       is rejected)
 *     → exchange code → verified discordId
 *     → linkVerifiedCredential(spine, { userId: sub, provider:'discord', ... })
 *     → 200 { ok, user_id, idempotent } | 409 cross_user_collision.
 *
 * Config: missing any of DISCORD_CLIENT_ID / DISCORD_CLIENT_SECRET /
 * DISCORD_LINK_CALLBACK_URL → 503 service_unconfigured (fail-closed, mirrors
 * link.ts's LINK_SERVICE_TOKEN posture).
 *
 * Source: grimoires/loa/specs/discord-social-credential-link-adapter.md.
 */

import { jsonResponse } from "@hyper/core"
import { z } from "zod"
import { route } from "../../auth"
import { getSpine } from "../spine"
import {
  linkVerifiedCredential,
  LinkCrossUserCollisionError,
} from "@freeside-auth/engine"
import {
  defaultDiscordOAuthClient,
  DiscordOAuthNotProvisioned,
  getDiscordOAuthConfig,
  mintOAuthState,
  tryConsumeStateNonce,
  verifyOAuthState,
  type DiscordOAuthClient,
} from "../../discord-oauth"

// ─── injectable OAuth client (test seam) ─────────────────────────────────────
//
// Production uses `defaultDiscordOAuthClient` (the Better-Auth-backed client
// drops in here once provisioned). Tests install a fake via
// `__setDiscordOAuthClientForTest` so the OAuth boundary is mocked — the
// routes + linking are exercised end-to-end without a live Discord app.
let _oauthClient: DiscordOAuthClient = defaultDiscordOAuthClient

/** Install a custom OAuth client (test only). */
export function __setDiscordOAuthClientForTest(c: DiscordOAuthClient): void {
  _oauthClient = c
}
/** Restore the default OAuth client (test only). */
export function __resetDiscordOAuthClientForTest(): void {
  _oauthClient = defaultDiscordOAuthClient
}

// Hyper's `.auth()` sugar returns a builder whose only relevant member here is
// `.handle()` (same shim me.ts uses to avoid depending on Hyper internals).
declare const routeBuilderShim: {
  handle: (
    h: (c: {
      ctx: { jwt?: { sub?: string } | undefined; user?: { sub?: string } | undefined }
      req: Request
    }) => unknown,
  ) => unknown
}

// JWT sub must be a UUID (same trust posture as me.ts) — a malformed sub must
// never reach the spine as a durable linked_accounts user_id.
const _SubUuid = z.string().uuid()

function sessionSub(c: {
  ctx: { jwt?: { sub?: string } | undefined; user?: { sub?: string } | undefined }
}): string | null {
  const sub = c.ctx.jwt?.sub ?? c.ctx.user?.sub
  if (typeof sub !== "string" || sub.length === 0) return null
  return _SubUuid.safeParse(sub).success ? sub : null
}

// ─── GET /v1/link/discord/initiate ───────────────────────────────────────────

const initiateBuilder = route
  .get("/v1/link/discord/initiate")
  .meta({
    summary: "Begin the Discord OAuth verification to link a Discord id to the session user",
    mcp: {
      title: "Initiate Discord link",
      description:
        "Session-gated. Mints a signed OAuth state bound to the session user and redirects to Discord's authorize URL. The verified discordId links to the session user on callback.",
    },
  }) as unknown as { auth: () => typeof routeBuilderShim }

export const discordLinkInitiate = initiateBuilder.auth().handle((c) => {
  const config = getDiscordOAuthConfig()
  if (config === null) {
    return jsonResponse(503, {
      code: "service_unconfigured",
      message: "Discord OAuth env (DISCORD_CLIENT_ID/SECRET/CALLBACK_URL) is not set",
    })
  }
  const sub = sessionSub(c)
  if (sub === null) {
    // .auth() should reject before here; defense-in-depth.
    return jsonResponse(401, { code: "missing_sub", message: "JWT sub claim absent" })
  }
  const { state } = mintOAuthState(sub)
  // 302 built manually: the redirect() helper omits security headers. The
  // Location carries the session-bound state, so set no-store + no-referrer to
  // shrink the replay-capture surface (intermediary caches / Referer leak).
  return new Response(null, {
    status: 302,
    headers: {
      location: _oauthClient.authorizeUrl({ config, state }),
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    },
  })
})

// ─── GET /v1/link/discord/callback ───────────────────────────────────────────

const callbackBuilder = route
  .get("/v1/link/discord/callback")
  .meta({
    summary: "Complete the Discord OAuth dance and link the verified Discord id to the session user",
    mcp: {
      title: "Complete Discord link",
      description:
        "Session-gated. Validates the OAuth state against the live session, exchanges the code for a verified discordId, and links it to the session user via the existing spine link primitives (409 on cross-user collision).",
    },
  }) as unknown as { auth: () => typeof routeBuilderShim }

export const discordLinkCallback = callbackBuilder.auth().handle(async (c) => {
  const config = getDiscordOAuthConfig()
  if (config === null) {
    return jsonResponse(503, {
      code: "service_unconfigured",
      message: "Discord OAuth env (DISCORD_CLIENT_ID/SECRET/CALLBACK_URL) is not set",
    })
  }
  const sub = sessionSub(c)
  if (sub === null) {
    return jsonResponse(401, { code: "missing_sub", message: "JWT sub claim absent" })
  }

  const url = new URL(c.req.url)
  const code = url.searchParams.get("code")
  const state = url.searchParams.get("state")
  if (!code) {
    return jsonResponse(400, { code: "missing_code", message: "callback is missing the OAuth code" })
  }

  // CSRF / account-linking guard: the state must be a valid signed token AND
  // bound to THIS session subject. A state minted for a different session
  // (or forged) is rejected with 401 — no code-exchange, no link.
  const payload = verifyOAuthState(state)
  if (payload === null || payload.sub !== sub) {
    return jsonResponse(401, {
      code: "invalid_state",
      message: "OAuth state is missing, malformed, expired, or not bound to this session",
    })
  }

  // Single-use: consume the state's nonce exactly once. A replay of a valid,
  // still-in-TTL state is rejected here (the signature/TTL/sub checks above do
  // NOT stop replay). Consume AFTER those checks so an invalid state never
  // burns the legit nonce.
  if (!tryConsumeStateNonce(payload.nonce, payload.exp)) {
    return jsonResponse(401, {
      code: "invalid_state",
      message: "OAuth state has already been used (replay rejected)",
    })
  }

  // Exchange the code for the verified Discord id (the live boundary). Map any
  // failure to a non-500: the unprovisioned default → 503; any other exchange
  // failure (bad/expired code, Discord/network) → 502 — never an unhandled 500.
  let discordId: string
  try {
    discordId = await _oauthClient.exchangeCode({ config, code })
  } catch (err) {
    if (err instanceof DiscordOAuthNotProvisioned) {
      return jsonResponse(503, {
        code: "service_unconfigured",
        message: "Discord OAuth code-exchange client is not provisioned",
      })
    }
    return jsonResponse(502, {
      code: "oauth_exchange_failed",
      message: "Discord OAuth code exchange failed",
    })
  }

  try {
    const result = await linkVerifiedCredential(getSpine(), {
      userId: sub, // ALWAYS the session subject — never request-controlled.
      provider: "discord",
      externalId: discordId,
      actor: "self",
    })
    return jsonResponse(200, {
      ok: true,
      user_id: result.userId,
      provider: result.provider,
      external_id: result.externalId,
      idempotent: result.idempotent,
    })
  } catch (err) {
    if (err instanceof LinkCrossUserCollisionError) {
      return jsonResponse(409, {
        ok: false,
        conflict: "cross_user_collision",
        message: "this Discord account is already linked to a different user",
      })
    }
    throw err // unknown failure → 5xx via global error handler
  }
})
