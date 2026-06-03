# Implementation Report — `POST /v1/link/wallet-only` (Sprint B part 1)

**Sprint:** `grimoires/loa/sprint-wallet-only-link-route.md`
**Branch:** `feat/wallet-only-link-route`
**Repo:** identity-api (`~/Documents/GitHub/freeside-auth`)
**Date:** 2026-06-02
**Beads:** bd-4hu, bd-msv, bd-zq8, bd-27u, bd-w7k, bd-99e, bd-z80 (all closed)

---

## Executive Summary

Exposed the already-built, already-deployed `linkWalletOnly` engine over HTTP as
a service-token-gated additive route `POST /v1/link/wallet-only`. The route is a
verbatim clone of `linkVerifiedWallet` **minus the discord axis** and **minus the
409/collision path** — the engine resolver only yields `create_user |
idempotent_noop`, so no cross-user collision class exists on this path and the
handler needs no try-catch.

Implemented **test-first**: 5 mock-spine route tests written RED (404, no route),
then protocol schemas → barrel export → route → registration → SDK, turning them
GREEN. Total: **8 tests** in the new file (5 spec cases + a 400-validation case +
1 OpenAPI-converter regression test). Full suite: **618 pass / 0 fail**.

One **in-scope bug fix**: the `importedNames` array is the first `z.array()`
request body in the repo, which surfaced a pre-existing Zod-v4 bug in the
`openapi-zod` converter (crashed at app boot). Fixed surgically (1 line) with a
regression test. Details below.

---

## AC Verification

| AC | Status | Evidence |
|----|--------|----------|
| **AC-1** | ✓ Met | "`LinkWalletOnlyReqSchema` validates `{ worldSlug: /^[a-z0-9-]+$/, walletAddress: /^0x[a-fA-F0-9]{40}$/, dynamicUserId?: string, importedNames?: [{nameType, value}] }` and contains **NO `discordId` field**" — `packages/protocol/src/api/link.ts:81-91`. Field names match `LinkWalletOnlyInput`/`ImportedName` (`link-wallet-only.ts:54-70`). Grep confirms `discordId` appears ONLY in `LinkVerifiedWalletReqSchema` (`link.ts:23`), never in the wallet-only schema. |
| **AC-2** | ✓ Met | "`LinkWalletOnlyRespSchema` validates `{ ok: literal(true), user_id: uuid, wallet_address: string, idempotent: boolean, generated_name: string|null }`" — `packages/protocol/src/api/link.ts:102-108` (`generated_name: z.string().nullable()`). Matches `LinkWalletOnlyResult` (`link-wallet-only.ts:100-112`). |
| **AC-3** | ✓ Met | "returns **503 `service_unconfigured`** when `LINK_SERVICE_TOKEN` is unset" — `src/api/routes/link.ts:138-143` (`getServiceToken() === null` → `jsonResponse(503, {code:"service_unconfigured"})`). Test: `wallet-only-route.test.ts:197` passes. |
| **AC-4** | ✓ Met | "returns **401 `unauthorized`** on missing or wrong `X-Service-Token`, constant-time compare via shared `serviceTokenMatches`" — `src/api/routes/link.ts:147-152`. Reuses the file's existing `serviceTokenMatches` (`link.ts:46-51`); no new crypto added. Tests: `wallet-only-route.test.ts:204` (missing) + `:210` (wrong) pass. |
| **AC-5** | ✓ Met | "returns **200** with non-null `generated_name` on a new wallet (`importedNames` absent), `idempotent: false`" — route maps `result.generatedName` (`link.ts:163`). Test: `wallet-only-route.test.ts:220` asserts `generated_name === "MIBERA-000001"`, `idempotent === false`, and call order `["mintUser","linkWallet","claimGeneratedName"]`. Passes. |
| **AC-6** | ✓ Met | "returns **200** with `idempotent: true` and `generated_name: null` on a known wallet (`idempotent_noop`)" — Test: `wallet-only-route.test.ts:241` sets `resolveByWalletReturns = USER_A`, asserts `idempotent === true`, `generated_name === null`, and `linkCalls === []`. Passes. |
| **AC-7** | ✓ Met | "Audit event `event_type: 'link_wallet_only'` emitted with **NO `discord_id` key**" — Test: `wallet-only-route.test.ts:258` finds the `link_wallet_only` umbrella audit and asserts `"discord_id" in payload === false` for it AND every audit on the path. Passes. (Engine source `link-wallet-only.ts:197-208` never writes `discord_id`.) |
| **AC-8** | ✓ Met | "Route contains **NO 409 branch and NO collision try-catch** — straight `linkWalletOnly(getSpine(), body, { actor: 'wallet-only-ingress' })` call" — `src/api/routes/link.ts:154-164`: a single `await linkWalletOnlyOrchestrator(...)` with no `try`/`catch` and no `409`. Grep of the route body confirms `409` and `LinkCrossUserCollisionError` appear ONLY in the verified-wallet route above it. |
| **AC-9** | ✓ Met | "SDK `client.link.walletOnly(input, opts)` compiles with full typing; mirrors `verifiedWallet`'s S2S `x-service-token` pattern" — interface `packages/sdk/src/client.ts:152-159`, impl `:286-298` (POST `/v1/link/wallet-only`, header `x-service-token`). `LinkWalletOnlyOpts` (`client.ts:104-110`) + type re-exports (`types.ts:56-58`, `:106-107`, index `:40`). 45/45 SDK tests pass; no tsc error in any changed file. |
| **AC-10** | ✓ Met | "`bun test` GREEN (no DB); `tsc` passes across protocol/sdk/src/api" — `bun test`: **618 pass / 149 skip / 0 fail** across 62 files. Protocol `tsc --noEmit`: clean. No `tsc` error in any file I changed (verified by grep). See **Known Limitations** for pre-existing Hyper-runtime tsc errors that are out of scope. |

All 10 ACs **Met**. No deferred or partial ACs.

---

## Tasks Completed

| Bead | Task | Files | Result |
|------|------|-------|--------|
| bd-4hu | 5 route tests FIRST (RED) | `src/api/__tests__/wallet-only-route.test.ts` (new) | RED → 404 (route absent), proving wiring |
| bd-msv | Protocol Req/Resp schemas | `packages/protocol/src/api/link.ts:71-109` | `LinkWalletOnlyReqSchema`/`RespSchema` + `ImportedNameSchema` + types |
| bd-zq8 | Barrel export | `packages/protocol/src/api/index.ts:68-73` | 3 schemas + 2 types exported |
| bd-27u | Route | `src/api/routes/link.ts:111-165` | mirror minus discord, minus 409; reuses helpers |
| bd-w7k | Registration | `src/api/index.ts:51,93` | import + `.use([...])` array |
| bd-99e | SDK | `packages/sdk/src/{client,types,index}.ts` | `link.walletOnly` + opts + type/schema re-exports |
| bd-z80 | E2E goal validation | — | full suite GREEN; scope-guard `git diff --stat` clean |

**Approach:** strict mirror of the verified-wallet route, deleting the discord
axis and the entire `try/catch`/409 block (the resolver type makes a collision
structurally impossible). The service-token helpers (`getServiceToken`,
`serviceTokenMatches` — the latter a constant-time compare from a prior FAGAN
finding) were **reused, not re-implemented**.

---

## Technical Highlights

### In-scope bug fix: openapi-zod converter array handling (Zod v4)

`LinkWalletOnlyReqSchema.importedNames` is the **first `z.array()` request body
in the repo**. Registering the route crashed at app boot:

```
TypeError: undefined is not an object (evaluating 'def.typeName')
  at defName (src/hyper/openapi-zod/index.ts:38)
```

Root cause (pre-existing, last touched in the Hyper vendor commit `86c4cdf`): in
Zod v4 a `ZodArray._def` exposes BOTH `type` (the discriminator **string**
`"array"`) AND `element` (the element schema). The converter read
`v.type ?? v.element` — picking the truthy string `"array"`, then walking it as a
schema and crashing on `"array"._def`. Fixed at `src/hyper/openapi-zod/index.ts:65-72`:
read `v.element ?? v.type` (v4 element wins; v3 — where `element` is absent —
still falls back to `type`). Regression test: `wallet-only-route.test.ts:296-305`.

This fix is in scope: it is the converter, not the engine, and the route cannot
boot without it. It is surgical (1 substantive line), reversible, and covered.

### No 409 is structurally correct, not an omission

`firstClaimResolver` (`link-wallet-only.ts:82-97`) is typed
`{kind:"create_user"} | {kind:"idempotent_noop"}` — there is no collision
variant. A try-catch/409 would be dead code. AC-8 + the test suite pin this.

---

## Testing Summary

**New test file:** `src/api/__tests__/wallet-only-route.test.ts` (mock-spine
harness cloned from `link-route.test.ts` — ephemeral `port:0`,
`__setSpineForTest`, env set in `beforeEach`).

| Scenario | Line | Asserts |
|----------|------|---------|
| 503 unconfigured | `:197` | status 503, `code:"service_unconfigured"` |
| 401 missing token | `:204` | status 401, `code:"unauthorized"` |
| 401 wrong token | `:210` | status 401, `code:"unauthorized"` |
| 200 new wallet | `:220` | `generated_name==="MIBERA-000001"`, `idempotent===false`, calls `[mintUser,linkWallet,claimGeneratedName]`, no `linkAccount` |
| 200 idempotent | `:241` | `idempotent===true`, `generated_name===null`, `linkCalls===[]` |
| audit no discord | `:258` | `link_wallet_only` emitted, no `discord_id` key in any payload |
| 400 validation | `:278` | malformed wallet → 400 |
| converter regression | `:297` | array schema → `{type:'array',items:{type:'object'}}` |

**Run:**
```bash
# route tests (mock-spine, no DB — needs DATABASE_URL only for app boot config):
DATABASE_URL=postgres://postgres:postgres@localhost:5432/identity_api \
  bun test src/api/__tests__/wallet-only-route.test.ts   # 8 pass

# full suite (ci.yml non-DB step shape):
DATABASE_URL=postgres://postgres:postgres@localhost:5432/identity_api bun test  # 618 pass / 149 skip / 0 fail

# SDK:
bun test packages/sdk   # 45 pass
```

**CI:** No `ci.yml` change needed. These are mock-spine tests (no real PG, no
`withTransaction` against a DB), so they run in the default `bun test` step that
already discovers all `*.test.ts`. The spec's "add to the DB proof list" clause
is conditioned on "if DB-gated" — these are not.

---

## Known Limitations

- **Pre-existing tsc errors in vendored Hyper runtime** (`src/hyper/auth-jwt/index.ts`,
  `src/hyper/session/index.ts`, `src/hyper/openapi/generate.ts`). These predate
  this work (Hyper vendor commit `86c4cdf`), are NOT in any file I changed, and
  are out of scope per Karpathy surgical-changes. Flagged for separate triage.
  `generate.ts:119` is a *different* file from my `openapi-zod/index.ts` fix.
- **No DB-level route test.** By design — the route's transactional behavior is
  the engine's responsibility and already covered by
  `link-wallet-only-trigger.test.ts` (DB-gated, in ci.yml). The route layer is
  validated at the mock-spine boundary.

---

## Verification Steps for Reviewer

1. `git log --oneline 24149fb..HEAD` — 5 commits, one per task group.
2. `git diff --stat 24149fb..HEAD -- 'src/**' 'packages/**'` — exactly 9 source
   files; engine/`0009`/`merge-identity`/`compose-profile`/backfill/`ci.yml`
   UNTOUCHED (verified).
3. `DATABASE_URL=…/identity_api bun test src/api/__tests__/wallet-only-route.test.ts` — 8 pass.
4. `DATABASE_URL=…/identity_api bun test` — 618 pass / 0 fail.
5. Confirm `src/api/routes/link.ts:111-165` has NO `409` and NO `try`/`catch`.
6. Confirm `packages/protocol/src/api/link.ts:81-91` has NO `discordId`.

---

## Scope Discipline

- **No push, no PR** — committed locally on `feat/wallet-only-link-route`; the
  coordinator opens the PR.
- **Forbidden files untouched:** engine `link-wallet-only.ts`, migration `0009`,
  `merge-identity.ts`, `compose-profile.ts`, backfill scripts, `ci.yml`.
- **`.env` not committed.**
