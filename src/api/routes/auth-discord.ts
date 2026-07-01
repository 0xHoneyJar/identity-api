/**
 * /v1/auth/discord/{authorize,exchange} — unauthenticated Discord OAuth login
 * (identity-api#44 · spec addendum in discord-social-credential-link-adapter.md).
 *
 * BFF consumers (freeside-dashboard) redirect the browser here; identity-api
 * owns Discord app credentials and mints session JWTs matching wallet verify.
 *
 * Flow:
 *   GET  /v1/auth/discord/authorize?redirect_uri=&state=
 *     → validate redirect_uri against DISCORD_LOGIN_REDIRECT_ALLOWLIST
 *     → mint signed login-state → 302 Discord OAuth
 *   POST /v1/auth/discord/exchange { code, redirect_uri }
 *     → exchange code → verified discordId
 *     → resolveOrMintByDiscord → mint session JWT
 *     → { user_id, session, discord }
 */

import { jsonResponse } from "@hyper/core"
import { z } from "zod"
import { route } from "../../auth"
import { getSpine } from "../spine"
import {
  AccountLinkRaceError,
  resolveOrMintByDiscord,
} from "@freeside-auth/engine"
import { mintSessionJwt } from "../../jwt-mint"
import {
  defaultDiscordOAuthClient,
  DiscordOAuthExchangeError,
  getDiscordLoginRedirectAllowlist,
  getDiscordOAuthCredentials,
  isAllowedLoginRedirectUri,
  mintLoginOAuthState,
  tryConsumeStateNonce,
  verifyLoginOAuthState,
  type DiscordOAuthClient,
} from "../../discord-oauth"

let _oauthClient: DiscordOAuthClient = defaultDiscordOAuthClient

export function __setDiscordLoginOAuthClientForTest(c: DiscordOAuthClient): void {
  _oauthClient = c
}

export function __resetDiscordLoginOAuthClientForTest(): void {
  _oauthClient = defaultDiscordOAuthClient
}

const DiscordExchangeBody = z.object({
  code: z.string().min(1),
  redirect_uri: z.string().url(),
  state: z.string().min(1).optional(),
})

// ─── GET /v1/auth/discord/authorize ───────────────────────────────────────────

export const authDiscordAuthorize = route
  .get("/v1/auth/discord/authorize")
  .meta({
    summary: "Begin Discord OAuth login (unauthenticated)",
    mcp: {
      title: "Discord login authorize",
      description:
        "Validates redirect_uri against allowlist, mints signed login state, and redirects to Discord OAuth.",
    },
  })
  .handle((c) => {
    const creds = getDiscordOAuthCredentials()
    if (creds === null) {
      return jsonResponse(503, {
        code: "service_unconfigured",
        message: "Discord OAuth env (DISCORD_CLIENT_ID/SECRET) is not set",
      })
    }
    if (getDiscordLoginRedirectAllowlist().length === 0) {
      return jsonResponse(503, {
        code: "service_unconfigured",
        message: "DISCORD_LOGIN_REDIRECT_ALLOWLIST is not set",
      })
    }

    const url = new URL(c.req.url)
    const redirectUri = url.searchParams.get("redirect_uri")
    const csrfState = url.searchParams.get("state")
    if (!redirectUri || !csrfState) {
      return jsonResponse(400, {
        code: "missing_params",
        message: "redirect_uri and state query params are required",
      })
    }
    if (!isAllowedLoginRedirectUri(redirectUri)) {
      return jsonResponse(400, {
        code: "redirect_not_allowed",
        message: "redirect_uri is not in DISCORD_LOGIN_REDIRECT_ALLOWLIST",
      })
    }

    const { state } = mintLoginOAuthState(redirectUri, csrfState)
    const config = { ...creds, callbackUrl: redirectUri }
    return new Response(null, {
      status: 302,
      headers: {
        location: _oauthClient.authorizeUrl({ config, state, redirectUri }),
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
      },
    })
  })

// ─── POST /v1/auth/discord/exchange ───────────────────────────────────────────

export const authDiscordExchange = route
  .post("/v1/auth/discord/exchange")
  .body(DiscordExchangeBody)
  .meta({
    summary: "Complete Discord OAuth login and mint a session JWT",
    mcp: {
      title: "Discord login exchange",
      description:
        "Exchanges the OAuth code for a verified discordId, resolve-or-mints the user, and returns a session JWT.",
    },
  })
  .handle(async (c) => {
    const creds = getDiscordOAuthCredentials()
    if (creds === null) {
      return jsonResponse(503, {
        code: "service_unconfigured",
        message: "Discord OAuth env (DISCORD_CLIENT_ID/SECRET) is not set",
      })
    }
    if (getDiscordLoginRedirectAllowlist().length === 0) {
      return jsonResponse(503, {
        code: "service_unconfigured",
        message: "DISCORD_LOGIN_REDIRECT_ALLOWLIST is not set",
      })
    }

    const body = c.body as z.infer<typeof DiscordExchangeBody>
    if (!isAllowedLoginRedirectUri(body.redirect_uri)) {
      return jsonResponse(400, {
        code: "redirect_not_allowed",
        message: "redirect_uri is not in DISCORD_LOGIN_REDIRECT_ALLOWLIST",
      })
    }

    if (body.state !== undefined) {
      const payload = verifyLoginOAuthState(body.state)
      if (payload === null || payload.redirect_uri !== body.redirect_uri) {
        return jsonResponse(401, {
          code: "invalid_state",
          message: "OAuth state is missing, malformed, expired, or redirect mismatch",
        })
      }
      if (!tryConsumeStateNonce(payload.nonce, payload.exp)) {
        return jsonResponse(401, {
          code: "invalid_state",
          message: "OAuth state has already been used (replay rejected)",
        })
      }
    }

    const config = { ...creds, callbackUrl: body.redirect_uri }
    let discordId: string
    try {
      discordId = await _oauthClient.exchangeCode({
        config,
        code: body.code,
        redirectUri: body.redirect_uri,
      })
    } catch (err) {
      if (err instanceof DiscordOAuthExchangeError) {
        return jsonResponse(502, {
          code: "oauth_exchange_failed",
          message: "Discord OAuth code exchange failed",
        })
      }
      return jsonResponse(502, {
        code: "oauth_exchange_failed",
        message: "Discord OAuth code exchange failed",
      })
    }

    const spine = getSpine()
    let userId: string
    let minted: boolean
    try {
      ;({ userId, minted } = await spine.withTransaction(async (tx) =>
        resolveOrMintByDiscord(tx, {
          discordId,
          actor: "self",
        }),
      ))
    } catch (err) {
      if (err instanceof AccountLinkRaceError) {
        ;({ userId, minted } = await spine.withTransaction(async (tx) =>
          resolveOrMintByDiscord(tx, {
            discordId,
            actor: "self",
          }),
        ))
      } else {
        throw err
      }
    }

    const identity = await spine.getIdentity(userId)
    const primaryWallet =
      identity?.wallets.find((w) => w.is_primary)?.wallet_address ??
      identity?.wallets[0]?.wallet_address ??
      null

    const session = await mintSessionJwt({
      sub: userId,
      primaryWallet,
    })

    await spine.writeAuditEvent({
      event_type: "auth_verified",
      user_id: userId,
      actor: "self",
      payload: {
        scheme: "discord_oauth",
        discord_id: discordId,
        minted_user: minted,
        jti: session.jti,
      },
    })

    return jsonResponse(200, {
      user_id: userId,
      session: {
        token: session.token,
        expires_at: session.expiresAt,
      },
      discord: {
        id: discordId,
        linked: true,
      },
    })
  })
