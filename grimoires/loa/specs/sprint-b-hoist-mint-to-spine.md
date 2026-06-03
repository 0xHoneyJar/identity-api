# Sprint B — hoist `mibera_id` generation into the spine (build-after-deploy)

> Completes the hoist doctrine: the spine becomes the **sole generator** of the MIBERA-XXXX handle; mibera-dimensions stops minting and delegates. Reader code is unaffected (write-through cache). Grounded 2026-06-02; refs cite `file:line`. **This spec is BLOCKED for build until identity-api #34 is merged + deployed + the prod backfill has run** (see Sequencing).

## Context

[[hoist-dont-handroll-shared-substrate]] applied at the WRITE seam. Today mibera-dimensions hand-rolls the handle: `app/actions/complete-onboarding.ts` → `generateUniqueMiberaId()` rolls `MIBERA-${randomHex}` (`Math.random`, uniqueness-checked against `midi_profiles`) and `completeOnboarding()` inserts it. The Phase-1 engine `linkWalletOnly` (`packages/engine/src/link-wallet-only.ts:126-133`, exported `index.ts:166-175`) already mints via the spine's `claimGeneratedName`. Sprint B is **not new engine logic** — it's (1) an HTTP route wrapping the existing orchestrator, (2) rewiring dimensions to call it, (3) confirming readers need no change.

**Verified (was the top risk):** `claimGeneratedName` → `generateFromPattern` (`postgres-spine-adapter.ts:1035-1045`) mints `MIBERA-` + 6 **uppercase-hex from CSPRNG**, matching dimensions' CHECK `mibera_id ~ '^MIBERA-[A-F0-9]{6}$'` (`mibera-dimensions/lib/db/schema/index.ts:480`) **exactly**. The rewire's insert will satisfy the constraint. (Upgrade: CSPRNG replaces `Math.random`.)

## ⛔ Sequencing (load-bearing — do not invert)

```
#34 MERGED → #34 DEPLOYED to prod → PROD BACKFILL run (A6 actor 'backfill-wallet')
   → [spine is LIVE + POPULATED]
   → ROUTE built+deployed (identity-api) + LINK_SERVICE_TOKEN provisioned for dimensions
   → DIMENSIONS rewire (delete local mint, delegate)
   → readers free (no work)
```

A live route with no caller is harmless; **a caller with no live route hard-breaks onboarding.** Enforce route-deployed + backfill-done as a literal checklist before merging the dimensions PR. Until backfill runs the spine is empty; until #34 deploys, `claimGeneratedName` isn't in the prod schema.

## Part 1 — `POST /v1/link/wallet-only` (identity-api / freeside-auth, off main after #34)

A verbatim clone of the `linkVerifiedWallet` route (`src/api/routes/link.ts:53-107`) **minus the discord axis + the 409 path**, wrapping the already-built `linkWalletOnly` orchestrator.

**Protocol** (`packages/protocol/src/api/link.ts` after :62, mirror `LinkVerifiedWalletReqSchema:21-26` minus `discordId`):
```
LinkWalletOnlyReqSchema  = { worldSlug: /^[a-z0-9-]+$/, walletAddress: /^0x[a-fA-F0-9]{40}$/,
                             dynamicUserId?: string, importedNames?: [{nameType, value}] }
LinkWalletOnlyRespSchema = { ok: true, user_id: uuid, wallet_address, idempotent: bool,
                             generated_name: string|null }
```
Field names match `LinkWalletOnlyInput` (`link-wallet-only.ts:59-70`) + `ImportedName` (`:54-57`) exactly. Export both + types from `packages/protocol/src/api/index.ts` beside the verified-wallet export (`:60-67`).

**Auth** — reuse `getServiceToken()` + `serviceTokenMatches()` (constant-time, `link.ts:34-51`). **503 `service_unconfigured`** when `LINK_SERVICE_TOKEN` unset (`:69-74`), **401 `unauthorized`** on wrong/missing token (`:78-83`). (The earlier "401-only" framing was wrong — mirror both.)

**Handler** — `linkWalletOnly(getSpine(), body, { actor: 'wallet-only-ingress' })` (`getSpine()` from `src/api/spine.ts:63-66`). **No 409 / no collision try-catch** — `firstClaimResolver` (`link-wallet-only.ts:94-97`) only returns `create_user` | `idempotent_noop`; there is no cross-user collision class on this path. New signups send no `importedNames` → engine hits `claimGeneratedName` (`:186-189`) and returns the fresh handle in `generated_name`.

**Register** — `src/api/index.ts`: add `linkWalletOnly` to the `./routes/link` import (`:51`) + the `app.use([...])` array (`:91`).

**Tests** (none exist yet): 503-on-unset-token · 401-on-wrong-token · 200 + non-null `generated_name` on new wallet (assert `claimGeneratedName` path) · 200 + `idempotent:true` + `generated_name:null` on known wallet · audit `event_type='link_wallet_only'` with **no** `discord_id` key (`link-wallet-only.ts:197-208`). Follow the verified-wallet route's env-set-before-import test harness. **Merge + DEPLOY before any dimensions work.**

## Part 2 — dimensions rewire (mibera-dimensions, after route deployed + token provisioned)

**Add** `lib/identity-api/client.ts` (net-new — grep `IDENTITY_API`/`X-Service-Token` = 0 today). Mirror the score-api Effect pattern (`lib/effect/score-api.ts`): env `IDENTITY_API_URL` + `LINK_SERVICE_TOKEN` (cf. `SCORE_API_URL`/`SCORE_API_KEY` at `:115-129`), `X-Service-Token` header (vs score's `X-API-Key` at `:188`), typed errors. Expose `linkWalletOnly(walletAddress, dynamicUserId) → Effect<{generatedName}, …>`. Add both env vars to `.env.example` + Vercel.

**Rewire** `app/actions/complete-onboarding.ts`:
- **DELETE** `generateUniqueMiberaId()` (`:33-67`) + its uniqueness pre-check (`:48-59`) — the mint the doctrine kills.
- **REPLACE** the mint call (`:159-169`) with the identity-api client call; `generated_name` from the response becomes `miberaId`.
- **Insert unchanged in shape** — `db.insert(midi_profiles)` (`:200-214`) still writes the `miberaId` column, now from the spine value. Column + `idx_midi_profiles_mibera_id` + CHECK regex (`schema/index.ts:472,480`) **STAY** (write-through cache).
- **Order**: spine mint → insert → Convex `writeProfile` (`:253`) → score-api `linkWallet` (`:275`).
- **Errors**: identity-api unreachable/timeout → `retryable:true`; 4xx → `retryable:false` (existing `CompleteOnboardingResult` contract). **Idempotent `generated_name:null`** (known wallet) must NOT crash — recover the existing handle (see Open Q2).

## Design fork — DECIDED: keep `midi_profiles.mibera_id` as a write-through cache

Spine owns the **mint**; dimensions keeps the `mibera_id`↔wallet **read** mapping local. Evidence (one-directional): dimensions **routes by `mibera_id`** synchronously everywhere — `middleware.ts:14-22` (`/~MIBERA-XXXX` rewrite on every nav), SSR `getUserByMiberaId` (`page.tsx:25`), OG image gen (`api/og/[miberaId]/route.tsx:164`), navbar URL gen (`top-navbar.tsx:100-101`). Full delegation = an async round-trip on every profile view + breaks SSR/OG static-gen, for **zero gain** — the spine exposes no `mibera_id` lookup (it resolves by nym, not mibera_id). Sync is unidirectional, spine→dimensions at creation time. Transitional: if a future spine adds `GET /v1/resolve/{mibera_id}`, the read path *could* migrate — out of scope.

## Readers — no Sprint-B work

dimensions' own `mibera_id` readers keep reading the local column (cache stays populated). Cross-app **name** readers (honey-road `lib/identity/world-nym.ts:44-51`, characters `announce-mint.ts:150-171`) read `world_identities[*].nym` via `/v1/profile` — additive-ready for the Phase-1 `display_name`/`display_source` block (auto-syncs via vendored Zod types), **not gated by Sprint B**. Keep Sprint B strictly to the `mibera_id` mint hoist (do NOT pull in the name/privacy axis).

## Open questions (resolve before the dimensions PR lands)

1. ✅ **RESOLVED** — spine handle format = `^MIBERA-[A-F0-9]{6}$` exactly (CSPRNG), matches dimensions' CHECK.
2. **Idempotent recovery** — `idempotent_noop` returns `generated_name:null` (`link-wallet-only.ts:108-111`, "we don't re-read their name here"). A returning wallet gets no handle from the route. Recover from the local cache row, OR add a spine handle-read. Affects the dimensions error branch. (Operator/build decision.)
3. **Shared physical table?** — is dimensions' `DATABASE_URL` `midi_profiles` the SAME Railway table the spine reads via `MIDI_DATABASE_URL`, or a separate copy? If shared, cache == spine rows (no drift). Needs the actual env values. (Operator-side.)
4. **Service-token model** — does dimensions share the verified-wallet caller's `LINK_SERVICE_TOKEN`, or a per-caller token? Route compares one env var (`link.ts:34-37`). (Operator provisioning.)
5. **wallet_groups ordering** — confirm score-api `linkWallet` (`:275`) has no dependency on the spine user existing first (recommended: spine mint first, it gates the `miberaId` the insert needs).

## Risks

- **Premature dimensions rewire** — lands before route deployed or backfill done → new users get no handle, onboarding hard-fails. The sequencing gate is the mitigation; enforce as a checklist.
- **Cache divergence** — spine mint succeeds but dimensions insert fails mid-onboarding → spine user with no local cache row → `mibera_id` 404s. Make the insert transactional-or-retryable vs the spine mint; handle idempotent recovery (Q2).
- **Token fail-closed** — route 503s when `LINK_SERVICE_TOKEN` unset (good), but if dimensions' Vercel omits it, every onboarding 503s. Provision + smoke-test before flipping off the local mint.
- **Scope-creep into the name/privacy axis** — keep Sprint B to the `mibera_id` mint hoist only.

## Task breakdown (sequenced)

| # | Repo | Task | Depends on |
|---|------|------|-----------|
| 0 | freeside-auth | GATE: confirm #34 merged + deployed + prod backfill run | identity-api #34 |
| 1 | freeside-auth | Protocol: `LinkWalletOnlyReq/RespSchema` + exports | 0 |
| 2 | freeside-auth | Route: `POST /v1/link/wallet-only` (service-token, no-409) | 1 |
| 3 | freeside-auth | Register route in `src/api/index.ts` | 2 |
| 4 | freeside-auth | Tests + SDK re-export → merge + **deploy** | 3 |
| 5 | mibera-dimensions | `lib/identity-api/client.ts` + env (route deployed + token) | 4 |
| 6 | mibera-dimensions | Rewire `completeOnboarding`; delete `generateUniqueMiberaId` | 5 |
| 7 | mibera-dimensions | Readers no-op confirmation (cache held) | 6 |

## References

| Topic | Path |
|---|---|
| Engine (already built) | `freeside-auth/packages/engine/src/link-wallet-only.ts:126-133` (export `index.ts:166-175`) |
| Route to clone | `freeside-auth/src/api/routes/link.ts:34-51,53-107` |
| Generated-name format (verified) | `freeside-auth/packages/adapters/src/postgres-spine-adapter.ts:1035-1045` |
| The mint to kill | `mibera-dimensions/app/actions/complete-onboarding.ts:33-67,159-169` |
| Insert / write-through cache | `mibera-dimensions/app/actions/complete-onboarding.ts:200-214` + `lib/db/schema/index.ts:472,480` |
| Client pattern to mirror | `mibera-dimensions/lib/effect/score-api.ts:115-129,188` |
| Routing-by-mibera_id (cache rationale) | `mibera-dimensions/middleware.ts:14-22`, `app/actions/get-user-by-mibera-id.ts`, `app/api/og/[miberaId]/route.tsx:164` |
| Phase-1 PR (the gate) | identity-api#34 · spec `enhance-wallet-only-name-model.md` |
