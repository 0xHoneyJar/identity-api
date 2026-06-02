# Implementation Report — Sprint 1: `POST /v1/identity/resolve` Merge Facade

**Bead:** `bd-2wo.38` (children 38.1–38.4) · **Goal:** PRD v3.0 **G-5** · **Date:** 2026-06-02
**Design SoT:** `grimoires/loa/sdd.md` (v1.1) · **Sprint:** `grimoires/loa/sprint.md`
**Status:** Implementation complete — 548 pass / 0 fail / 98 skip (full Bun suite, 48 files).

---

## Executive Summary

Shipped the v1 server-side merge facade `POST /v1/identity/resolve`: a consumer POSTs ≤100
wallets and receives **one pre-merged identity per (unique) wallet** — spine join (SoR) +
score-api group-aware onchain enrichment, the `world_nym > discord > score > address` priority
applied **once**, server-side. Additive only: a new `ScorePort` method + `HttpScoreAdapter`
POST binding, two protocol schema files, one pure `mergeIdentity` resolver, one route, and the
SDK type surface. **Zero changes** to the ES256 signer, JWKS, svc-JWT verify, `/v1/auth/verify`,
`CredentialBridge`, the spine, or any migration (AC-13 / AC-14 verified by `git diff`).

One deviation from the SDD's literal §5.4 (documented below): the route validates its body
**in-handler** rather than via Hyper's `.body(Schema)` builder, because the vendored
`openapi-zod` converter crashes walking a `z.array(...)` body schema (Zod-4 `ZodArray`
discriminator bug — logged as discovered issue **bd-9qj**). In-handler validation is the
`/v1/profile` pattern and yields the documented `{code:"invalid_param", …}` 400 envelope.

---

## AC Verification

> Every acceptance criterion from `grimoires/loa/sprint.md` §"Acceptance Criteria", verbatim,
> with status + file:line evidence.

- **AC-1** — *"Priority — each tier wins in order, §7.2#1: `world_nym` present → `display_source="world_nym"`; no nym + discord linked → `"discord"`; neither + real score name → `"score"`; nothing → `"address"`."*
  **✓ Met.** Algorithm: `packages/engine/src/merge-identity.ts:55-83`. Unit proof: `packages/engine/src/__tests__/merge-identity.test.ts` describe "priority precedence (§7.2 case 1)" (4 tier tests). E2E proof: `src/api/__tests__/identity-resolve-goal-validation.test.ts` "all four tiers correct".

- **AC-2** — *"No re-derivation, §7.2#2: when score returns beraname AND ens AND twitter, `display_name` still follows the 4-tier rule; `beraname`/`ens_name`/`twitter_handle` are echoed RAW and do NOT influence `display_source`."*
  **✓ Met.** `merge-identity.ts:69-83` reads name fields for PRESENCE only; passthrough at `:96-98`. Test: `merge-identity.test.ts` "no beraname/ENS/twitter re-derivation (§7.2 case 2)"; boundary E2E in goal-validation "score-vs-identity boundary".

- **AC-3** — *"Discord shape, §7.2#3: resolves to `{ id: external_id, linked: true }`; soft-unlinked (`unlinked_at` set) → `linked:false` (OQ-4 default policy). NEVER a `username`/`handle` field."*
  **✓ Met.** `merge-identity.ts:60-66` (active/soft-unlinked/none). Test: `merge-identity.test.ts` "discord shape (§7.2 case 3)" (3 cases). Schema has only `{id, linked}`: `packages/protocol/src/api/identity-resolve.ts:60-63`.

- **AC-4** — *"Spine miss for one wallet, §7.2#4: batch of 3 where wallet #2 has no spine link (batched score call succeeds) → 200, entry #2 `user_id=null`, `display_source="address"`, `degraded=false`; entries #1/#3 unaffected."*
  **✓ Met.** Route: `src/api/routes/identity-resolve.ts:78-92` (null user → null identity). Test: `identity-resolve-route.test.ts` "spine miss (case 4)".

- **AC-5** — *"Score outage — whole-source degrade, §7.2#5: score-api times out → ALL entries `degraded=true`, spine-derived tiers (world_nym/discord/address) still resolve, 200 OK."*
  **✓ Met.** `identity-resolve.ts:73-76` (`degraded = !scoreResult.ok`, per-batch). Tests: `identity-resolve-route.test.ts` "score outage (case 5)" + goal-validation "graceful degradation (FR-P2/NFR-2)".

- **AC-6** — *"Batch bound, §7.2#6: 101 wallets → 400; 0 wallets → 400; 100 wallets → ok."*
  **✓ Met.** `identity-resolve.ts:50-58` (in-handler `safeParse` of `IdentityResolveReqSchema` `.min(1).max(100)`). Test: `identity-resolve-route.test.ts` "batch bound (case 6)" (101→400, 0→400, bad-hex→400, 100→200).

- **AC-7** — *"`reachable` tri-state, §7.2#7: v1 → `"unknown"` for the wallet-only majority."*
  **✓ Met.** `merge-identity.ts:90` (`reachable: "unknown"`). Schema enum: `identity-resolve.ts:38`. Tests: `merge-identity.test.ts` "reachable is 'unknown' in v1"; goal-validation boundary test.

- **AC-8** — *"`is_primary_wallet`, §7.2#8: sourced from spine `wallet_links.is_primary`, NEVER from score."*
  **✓ Met.** `merge-identity.ts:85-86` (`spine?.wallets.find(...).is_primary`). Tests: `merge-identity.test.ts` "is_primary_wallet …" (true + false); goal-validation boundary.

- **AC-9** — *"world_slug scoping, §7.2#9: omitted world_slug → world_nym tier never selected; present world_slug with no matching nym → also skips."*
  **✓ Met.** `merge-identity.ts:50-53` (`worldSlug !== undefined ? find(...) : undefined`). Test: `merge-identity.test.ts` "world_slug scoping (§7.2 case 9)" (omitted + non-matching).

- **AC-10** — *"Score tier requires a REAL onchain name, §7.2#10: score reached, `display_name` present but `beraname`/`ens_name`/`twitter_handle` ALL null → `display_source="address"`, NOT `"score"`, `degraded=false`. ANY one of the three non-null → `"score"` with score's `display_name`."*
  **✓ Met.** `merge-identity.ts:69-78` (gate on `beraname||ens_name||twitter_handle` non-null). Test: `merge-identity.test.ts` "score tier requires a REAL onchain name (§7.2 case 10, OQ-6)" (both directions).

- **AC-11** — *"score-api response is a keyed map, §7.2#11: the adapter resolves `resp.identities[wallet.toLowerCase()]`; a mixed-case input wallet still finds its score entry; `results[].wallet` is the normalized (lowercased) form."*
  **✓ Met.** Schema: `packages/protocol/src/api/federation/score.ts` `ScoreResolveIdentityRespSchema` = `{ identities: z.record(z.string(), ResolvedIdentitySchema) }`. Route normalizes + looks up `identities[wallet]` (lowercased): `identity-resolve.ts:60-92`. Test: `identity-resolve-route.test.ts` "keyed-map lowercased lookup (case 11)".

- **AC-12** — *"Adapter classification matrix, §7.1 adapter row: `resolveIdentity` maps 200/401/404/429/5xx/parse/timeout → the correct `FederationResult` (…); never throws."*
  **✓ Met.** `packages/adapters/src/http-score-adapter.ts` `resolveIdentity` via `federationHttpCall`. Test: `http-score-adapter.test.ts` describe "HttpScoreAdapter.resolveIdentity (bd-2wo.38.1)" — 10 tests incl. POST/body/header, keyed-map, loose(), 401/404/429/503/parse/timeout.

- **AC-13** — *"HARD constraint — auth untouched: `git diff` shows ZERO changes to `LocalEs256Signer`, `/.well-known/jwks.json`, the svc-JWT verify path, `/v1/auth/verify`, and `CredentialBridge`."*
  **✓ Met.** `git diff --stat <base> -- packages/adapters/src/local-es256-signer.ts src/jwt-mint.ts packages/adapters/src/jwks-validator.ts src/api/routes/auth.ts 'packages/adapters/src/credential-bridge*.ts'` → **empty** (zero changes). Re-verifiable at audit.

- **AC-14** — *"No-embed invariant, FR-P3: no migrations, no new persistence; the facade stores nothing. `git diff` shows no `*.up.sql` / schema changes."*
  **✓ Met.** `git diff --name-only <base> | grep -E '\.up\.sql|migrations/'` → **empty**. The route is pure read/compose (`identity-resolve.ts` — only `resolveByWallet`/`getIdentity` reads + one score read).

---

## Tasks Completed

### Component 1 — `ScorePort.resolveIdentity` + binding (bd-2wo.38.1) — CLOSED
- `packages/protocol/src/api/federation/score.ts` (+69): `ScoreResolveIdentityReqSchema`, `ResolvedIdentitySchema`, `ScoreResolveIdentityRespSchema` (keyed map, `.loose()`). Re-exported via `federation/index.ts` + `api/index.ts`.
- `packages/ports/src/score.port.ts` (+38): `ScoreResolveIdentityInput` + `resolveIdentity` method (never-throws docstring). `packages/ports/src/index.ts` (+1): input type export.
- `packages/adapters/src/http-score-adapter.ts` (+39): `resolveIdentity` POST binding (`{ wallets }` body only — no `world_slug`).
- `packages/adapters/src/__tests__/mock-score.ts` (+65): `MockScorePort.resolveIdentity` with empty-name fallback mirroring score-api.
- Tests: `http-score-adapter.test.ts` (+127, 10 tests).

### Component 2 — protocol schemas + `mergeIdentity` + route (bd-2wo.38.2) — CLOSED
- `packages/protocol/src/api/identity-resolve.ts` (NEW): `IdentityResolveReqSchema`, `IdentityResolveEntrySchema` (pinned #32 contract), `IdentityResolveRespSchema`, `DisplaySourceSchema`, `ReachableSchema`, `IdentityResolveDiscordSchema`. Re-exported via `api/index.ts`.
- `packages/engine/src/merge-identity.ts` (NEW): pure `mergeIdentity(...)` — priority applied once, score-real-name gate. `engine/src/index.ts` (+9): exports `mergeIdentity` + `normalizeAddress`.
- `src/api/routes/identity-resolve.ts` (NEW): `route.post("/v1/identity/resolve")` — in-handler validate → normalize+dedupe → one batched score call (AbortController + `IDENTITY_RESOLVE_SCORE_TIMEOUT_MS`) → per-wallet spine reads + merge → `{ results }`. Registered in `src/api/index.ts:51,87`.
- Tests: `merge-identity.test.ts` (NEW, 16 tests), `identity-resolve-route.test.ts` (NEW, 10 tests).

### Contract bridge (bd-2wo.38.3) — CLOSED
- `packages/sdk/src/types.ts` (+19): identity-resolve types + runtime schemas re-exported on the source-distributed SDK surface for the dashboard `IDENTITY_RESOLVE_URL` mock-fallback. (A typed client method is deferred to cutover, which is GATED on #11 — out of this sprint.)

### E2E goal validation (bd-2wo.38.4) — CLOSED
- `src/api/__tests__/identity-resolve-goal-validation.test.ts` (NEW, 3 tests): consolidated G-5 acceptance — 4-wallet mixed batch (nym/discord/address/score), boundary, degradation. No-embed (AC-14) + auth-untouched (AC-13) verified by `git diff`.

### OQ-3 (Task 1.2 / T-A2) — auth posture
Defaulted to the **sibling-read open posture** (`/v1/profile`, `/v1/resolve/*` use `route` without `.auth()`). The route has no `.auth()`. If the dashboard caller must present a svc-JWT, add `.auth()` to the route ONLY (never the verify impl) — a one-line, reversible follow-up. Flagged for review.

---

## Testing Summary

| Suite | File | Tests |
|-------|------|-------|
| Adapter classification | `packages/adapters/src/__tests__/http-score-adapter.test.ts` | 10 (resolveIdentity) |
| Merge algorithm (unit) | `packages/engine/src/__tests__/merge-identity.test.ts` | 16 |
| Route (integration) | `src/api/__tests__/identity-resolve-route.test.ts` | 10 |
| G-5 acceptance (E2E) | `src/api/__tests__/identity-resolve-goal-validation.test.ts` | 3 |

Run: `bun test` → **548 pass, 0 fail, 98 skip** (48 files). Typecheck (`bun run typecheck`): clean on all touched files (only pre-existing `src/hyper/*` errors remain — not in scope).

11/11 mandatory SDD §7.2 cases covered (AC-1…AC-11) + adapter matrix (AC-12).

---

## Known Limitations & Deviations

1. **In-handler body validation (deviation from SDD §5.4 `.body()`):** the vendored `openapi-zod`
   converter crashes on a `z.array(...)` body schema (Zod-4 `ZodArray._def.type` is the `"array"`
   discriminator string; converter does `v.type ?? v.element` and recurses into the string —
   `src/hyper/openapi-zod/index.ts:66`, crash at `:38`). The route is the first `.body()` with an
   array, so it's the first to trip it. **Workaround:** validate in-handler (the `/v1/profile`
   pattern), yielding the documented `{code:"invalid_param", …}` 400 envelope. **Discovered issue:
   bd-9qj** (`discovered-during:bd-2wo.38.2`). Side effect: the request body shape is not in the
   OpenAPI spec for this route (the response/SDK contract is unaffected — consumers import the Zod
   schema directly). *SDD §5.4's 400 example (`invalid_param`) is therefore correct as written.*
2. **`reachable` is `"unknown"` for everyone in v1** — intentional; #11 (P1) populates true/false. The
   tri-state shape ships now so the contract is stable (SDD §3.3, OQ-5 pinned).
3. **N×2 spine point-reads per batch** (≤200 at 100 wallets), sequential — fine at current prod scale
   (5 users / 3 nyms), all reads index-covered. A batch-resolve engine helper is deferred (R-2).
4. **No circuit breaker** for the score call in v1 (Simplicity First) — the per-source `AbortSignal`
   timeout is the only guard. Reusable `CircuitBreaker` exists in engine if load justifies it later.
5. **Dedup semantics:** duplicate input wallets are normalized + deduped to one entry (first-seen
   order). Documented in `identity-resolve.ts` + tested.

---

## Verification Steps (for reviewer)

```bash
bun test                          # 548 pass / 0 fail
bun run typecheck 2>&1 | grep "error TS" | grep -v "src/hyper/"   # empty
# AC-13 (auth byte-unchanged):
git diff --stat w2.5-sprint-3-auth-sdk-source-distributed -- \
  packages/adapters/src/local-es256-signer.ts src/jwt-mint.ts \
  packages/adapters/src/jwks-validator.ts src/api/routes/auth.ts \
  'packages/adapters/src/credential-bridge*.ts'   # empty
# AC-14 (no-embed):
git diff --name-only w2.5-sprint-3-auth-sdk-source-distributed | grep -E '\.up\.sql|migrations/'   # empty
```

**Reviewer focus (R-1 boundary):** confirm `mergeIdentity` reads `beraname`/`ens_name`/
`twitter_handle` for PRESENCE only and never re-ranks them (AC-2/AC-10) — the score-vs-identity
boundary is the load-bearing constraint.
