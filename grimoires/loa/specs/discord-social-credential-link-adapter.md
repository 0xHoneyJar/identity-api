# Spec — Discord-social OAuth-verification front-end (Better Auth)

**bead:** `bd-2wo.14` · **date:** 2026-06-01 (rev 2) · **decision basis:** `grimoires/loa/2026-06-01-auth-decision-reconciled.md` · **run via:** `code-implement-and-review`

## ⚠ Scope correction (post iter-1 revert — READ FIRST)

A first build attempt added a `credential-bridge-discord.ts` and a `discord` `CredentialScheme`. The reviewer **correctly killed it (CRITICAL)**: the Discord *linking write* (collision detection, idempotency, `linked_accounts` minting) **already exists and is safer** — `engine/link-verified-wallet.ts` (`linkVerifiedWallet` → `linkAccountWithAudit` + `resolveByAccount` + `LinkCrossUserCollisionError`), exposed at `src/api/routes/link.ts` (`/v1/link/verified-wallet`, service-token-gated). A new bridge duplicated it with less safety. **Do not rebuild any of that.**

**The ONLY real gap = the OAuth verification front-end.** The existing link path assumes the `discordId` is *already verified* (an external service POSTs it under a service token). What does not exist: a **user-session-gated, in-repo flow that runs the Discord OAuth itself** to *produce* a verified `discordId`. That — and only that — is this build.

## DO NOT (hard)

- ❌ NO `credential-bridge-discord.ts`. ❌ NO new `CredentialScheme` value. ❌ Do not touch `packages/adapters/src/credential-bridge*.ts` or the `/v1/auth/verify` dispatch — Discord is **not** a verify-path login credential.
- ❌ NO new minting / collision / idempotency logic — that is 100% existing primitives; **call them**.
- ❌ Do not touch `local-es256-signer.ts`, JWKS routes, `svc-jwt-*`, `src/auth.ts` runtime mount, or the account/character/TBA model (kaironic).

## Build (the ONLY new code)

1. **Minimal Better Auth instance** (isolated file, e.g. `src/auth-betterauth-discord.ts`): `better-auth` configured with **only** the Discord social provider + Drizzle/Postgres. Used as a **library** for the OAuth dance — **NOT** mounted as the app auth runtime. Env config: `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `DISCORD_LINK_CALLBACK_URL` → missing any → `503 service_unconfigured` (fail-closed, mirror `link.ts`'s `LINK_SERVICE_TOKEN` posture).
2. **Two session-gated (`.auth()`) endpoints** (pattern: `src/api/routes/me.ts`, where `c.ctx.jwt.sub` is the authed `user_id`):
   - `GET /v1/link/discord/initiate` → build the Discord OAuth URL via Better Auth; bind the OAuth `state` to the session `user_id` (signed/opaque, single-use, TTL) → redirect.
   - `GET /v1/link/discord/callback` → validate `state` ↔ live session, exchange `code` via Better Auth → extract the verified `discordId`. Then call the linking step (below) with the **session** `user_id`.
3. **Linking step = thin reuse, not new logic.** Add ONE thin engine helper `linkVerifiedCredential(spine, { userId, provider: "discord", externalId: discordId, actor })` that, inside `spine.withTransaction`, REUSES the existing primitives:
   - `resolveByAccount("discord", discordId)` → if bound to a **different** `userId` → throw the existing `LinkCrossUserCollisionError` (→ 409); if bound to the **same** `userId` → idempotent no-op; else
   - `linkAccountWithAudit({ userId, provider: "discord", externalId: discordId, actor })`.
   This is a new **session-keyed entry shape** over the *same* safety primitives (the existing `linkVerifiedWallet` is wallet-keyed + service-token; this is user-id-keyed + session). It must NOT reimplement collision/idempotency — it composes the existing functions. If the reviewer judges this still duplicative, fall back to calling `linkAccountWithAudit` + an inline `resolveByAccount` pre-check directly from the route.
4. **Register** the two routes in `src/api/index.ts`.

## Acceptance (test-first — write first, then pass)

- **Happy path:** authed user A → initiate → callback with verified Discord D → `linked_accounts (user_id=A, provider='discord', external_id=D)` + audit.
- **Idempotent:** A re-links D → 200 no-op, no duplicate row.
- **Cross-user collision:** D bound to user B, A links D → `409 cross_user_collision`, no write (reuses `LinkCrossUserCollisionError`).
- **Unauthenticated:** initiate/callback without a valid session → `401`.
- **IDOR-negative:** the linked `user_id` is ALWAYS the session `sub`; no request input (body/query/state) can specify a different `user_id`. Explicit negative test.
- **OAuth-state/CSRF-negative:** a callback whose `state` doesn't match a live session-bound state is rejected (account-linking CSRF guard).
- **Unconfigured:** missing Discord env → `503 service_unconfigured`.
- **No regressions:** `auth-bridge-quarantine.test.ts` still asserts 3 schemes (untouched); `local-es256-signer`/JWKS/`svc-jwt-*`/`credential-bridge*` byte-unchanged. Run typecheck + the suite (repo runner is **bun**, not vitest) before emitting the diff.

## Out of scope / kaironic

- Account/character/TBA model — held kaironic. This writes `linked_accounts` only.
- ES256 issuer / JWKS / svc-JWT verify contract — untouched.
- Per-world login UX — each world owns it. This is the backend OAuth + linking seam only.
- Live end-to-end needs a real Discord app (creds above) — build lands code + config seam + tests with the OAuth boundary mocked; live verification waits on creds.
- Passkey (`bd-2wo.12`) / other providers — same Better Auth substrate, follow-on (this is the first provider on it).
