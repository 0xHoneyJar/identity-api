# Sprint Plan: `POST /v1/identity/resolve` — Merge Facade (v1)

**Version:** 1.0
**Date:** 2026-06-01
**Author:** Sprint Planner Agent
**PRD Reference:** grimoires/loa/prd.md (§4.5 G-5, §5 NFRs)
**SDD Reference:** grimoires/loa/sdd.md (v1.1 — OQ-2 resolved 2026-06-01)
**Parent bead:** `bd-2wo.38` (P1 · OPEN · ratified `0xHoneyJar/identity-api#32`)

---

## Executive Summary

This is a **feature-scoped, single-sprint** plan delivering ONLY the v1 server-side merge
facade `POST /v1/identity/resolve` (PRD v3.0 **G-5**, bead `bd-2wo.38`). It is NOT a PRD
cycle — the SDD is explicit: *"single-sprint feature… No cycle-ledger scaffolding required
(the repo's cycle ledger is empty by design — work is beads-tracked)"* (sdd.md:L651-652).

The facade lets `freeside-dashboard` POST a batch of wallets and receive **one pre-merged
identity per wallet** — the dashboard re-derives nothing. It is the *resolve-batch sibling* of
the already-shipped `GET /v1/profile` compose. It composes a BATCH of wallets across exactly
two sources — the **local spine** (read-of-record) and **score-api** (onchain-name
enrichment) — and applies the display-name priority server-side ONCE.

> From SDD §1.1: *"The merge is server-side and the priority is applied once. That is the
> entire value proposition"* (sdd.md:L52-53).

**It is additive only:** a new port METHOD on `ScorePort`, a new POST binding on
`HttpScoreAdapter`, two new protocol schema files, one pure merge resolver, and one new route
registered in the existing app composition. **Zero changes to the spine, signer, JWKS, svc-JWT
verify, or `CredentialBridge`** — those are SHIPPED, out of scope, and a HARD no-creative-latitude
constraint (sdd.md:L160-165).

**Total Sprints:** 1
**Scope:** MEDIUM (5 tasks + 1 E2E validation task)
**Read-only v1:** no migrations, no cache, no circuit breaker (sdd.md:L274-275, L584-588).
**Build gate:** Loa `/run sprint-plan` (implement → review → audit). Feature work → Loa gate,
**NOT** `/bug` (per `bd-2wo.38`).

---

## Sprint Overview

| Sprint | Theme | Key Deliverables | Dependencies |
|--------|-------|------------------|--------------|
| 1 | Merge facade (port method → route → contract bridge) | `ScorePort.resolveIdentity` + adapter binding; protocol Req/Resp schemas; pure `mergeIdentity` resolver; `POST /v1/identity/resolve` route; contract-bridge handoff | None (extends shipped building) |

Single sprint. Phases A → B → C are sequential WITHIN the sprint (B depends on A's sealed
score schema; C depends on B's sealed response schema).

---

## Sprint 1: Server-Side Merge Facade

**Scope:** MEDIUM (5 implementation tasks + 1 E2E validation task)
**Duration:** 2.5 days

### Sprint Goal

Ship `POST /v1/identity/resolve` so a consumer hands identity-api a batch of ≤100 wallets and
receives one pre-merged identity per wallet — the merge and the `world_nym > discord > score >
address` priority applied server-side ONCE — with zero changes to auth/signer/spine.

### Deliverables

- [ ] **D1** — `ScorePort.resolveIdentity(input, opts?)` port method + `HttpScoreAdapter.resolveIdentity`
  POST binding to score-api `POST /v1/identity/resolve`, returning `FederationResult<ScoreResolveIdentityResp>`
  (never throws). *(Component 1, SDD §1.4)*
- [ ] **D2** — Sealed Zod schemas: `ScoreResolveIdentityReqSchema` + `ScoreResolveIdentityRespSchema`
  (the keyed-map `{ identities: Record<lowercased-wallet, ResolvedIdentity> }`, `.loose()`) in
  `packages/protocol/src/api/federation/score.ts`. *(SDD §1.4, §1.6)*
- [ ] **D3** — Pure `mergeIdentity(spine, scoreEnrich, world_slug?)` priority resolver applying the
  4-tier rule ONCE, with the score-tier-requires-a-real-onchain-name gate. *(SDD §1.5)*
- [ ] **D4** — `IdentityResolveReqSchema` + `IdentityResolveRespSchema` (the pinned per-wallet
  contract from #32) in `packages/protocol/src/api/identity-resolve.ts`. *(SDD §5.2, §5.3)*
- [ ] **D5** — `POST /v1/identity/resolve` route (Pattern B `post().body().handle()`) in
  `src/api/routes/identity-resolve.ts`, registered in the `.use([...])` array at `src/api/index.ts`. *(SDD §1.4, §5.4)*
- [ ] **D6** — Contract-bridge handoff: sealed response schema importable for the dashboard
  mock-fallback (`IDENTITY_RESOLVE_URL`); contract documented in the source-distributed SDK
  surface. *(SDD §4, §8 Phase C)*
- [ ] **D7** — All 11 mandatory test cases (SDD §7.2) green, test-first, in the existing Bun suite.

### Acceptance Criteria

- [ ] **AC-1 (Priority — each tier wins in order, §7.2#1):** `world_nym` present →
  `display_source="world_nym"`; no nym + discord linked → `"discord"`; neither + real score name
  → `"score"`; nothing → `"address"`.
- [ ] **AC-2 (No re-derivation, §7.2#2):** when score returns beraname AND ens AND twitter,
  `display_name` still follows the 4-tier rule; `beraname`/`ens_name`/`twitter_handle` are echoed
  RAW and do NOT influence `display_source`. (Boundary guard R-1.)
- [ ] **AC-3 (Discord shape, §7.2#3):** resolves to `{ id: external_id, linked: true }`;
  soft-unlinked (`unlinked_at` set) → `linked:false` (OQ-4 default policy). NEVER a
  `username`/`handle` field.
- [ ] **AC-4 (Spine miss for one wallet, §7.2#4):** batch of 3 where wallet #2 has no spine link
  (batched score call succeeds) → 200, entry #2 `user_id=null`, `display_source="address"`,
  `degraded=false`; entries #1/#3 unaffected.
- [ ] **AC-5 (Score outage — whole-source degrade, §7.2#5):** score-api times out → ALL entries
  `degraded=true`, spine-derived tiers (world_nym/discord/address) still resolve, 200 OK.
- [ ] **AC-6 (Batch bound, §7.2#6):** 101 wallets → 400; 0 wallets → 400; 100 wallets → ok.
- [ ] **AC-7 (`reachable` tri-state, §7.2#7):** v1 → `"unknown"` for the wallet-only majority.
- [ ] **AC-8 (`is_primary_wallet`, §7.2#8):** sourced from spine `wallet_links.is_primary`, NEVER
  from score.
- [ ] **AC-9 (world_slug scoping, §7.2#9):** omitted world_slug → world_nym tier never selected;
  present world_slug with no matching nym → also skips.
- [ ] **AC-10 (Score tier requires a REAL onchain name, §7.2#10):** score reached, `display_name`
  present but `beraname`/`ens_name`/`twitter_handle` ALL null → `display_source="address"`, NOT
  `"score"`, `degraded=false`. ANY one of the three non-null → `"score"` with score's `display_name`.
- [ ] **AC-11 (score-api response is a keyed map, §7.2#11):** the adapter resolves
  `resp.identities[wallet.toLowerCase()]`; a mixed-case input wallet still finds its score entry;
  `results[].wallet` is the normalized (lowercased) form.
- [ ] **AC-12 (Adapter classification matrix, §7.1 adapter row):** `resolveIdentity` maps
  200/401/404/429/5xx/parse/timeout → the correct `FederationResult` (`unauthorized`/`not_found`/
  `rate_limited`(breaker-exempt)/`upstream_5xx`/`parse_error`/`timeout`); never throws.
- [ ] **AC-13 (HARD constraint — auth untouched):** `git diff` shows ZERO changes to
  `LocalEs256Signer`, `/.well-known/jwks.json`, the svc-JWT verify path, `/v1/auth/verify`, and
  `CredentialBridge`. Verified at review/audit.
- [ ] **AC-14 (No-embed invariant, FR-P3):** no migrations, no new persistence; the facade stores
  nothing. `git diff` shows no `*.up.sql` / schema changes.

### Technical Tasks

<!-- Phases A → B → C per SDD §8. All test-first (Karpathy Goal-Driven, SDD §7). -->

**Phase A — Component 1: `ScorePort.resolveIdentity` + binding**

- [ ] **Task 1.1 (T-A1): Sealed score-api federation schemas + adapter binding.** → **[G-5]**
  - Author `ScoreResolveIdentityReqSchema` (`{ wallets: string[] }`, `0x+40hex`, `.min(1).max(100)`,
    **no `world_slug`** — score is wallet-only) and `ScoreResolveIdentityRespSchema` (KEYED MAP
    `{ identities: z.record(ResolvedIdentitySchema) }`, `.loose()` for forward-compat) in
    `packages/protocol/src/api/federation/score.ts` (sibling to `ScoreGetWalletRespSchema`, which
    confirms the `.loose()` pattern at federation/score.ts:109-164). `ResolvedIdentity` fields per
    SDD §1.6: `wallet, display_name (non-null), ens_name|null, beraname|null, basename|null,
    twitter_handle|null, pfp_url|null, twitter_source|null`. Re-export from `federation/index.ts`
    + `api/index.ts`.
  - Add `resolveIdentity(input, opts?): Promise<FederationResult<ScoreResolveIdentityResp>>` to
    `ScorePort` (`packages/ports/src/score.port.ts` — today has exactly ONE method `getScore` at
    score.port.ts:84) with the never-throws docstring contract.
  - Implement `HttpScoreAdapter.resolveIdentity` via `federationHttpCall({ method:"POST",
    body:{ wallets }, responseSchema, ... })` (POST + body confirmed supported,
    federation-http.ts:106,116-141). Mirror `getScore`'s `X-API-Key` header + `building:"score-api"`
    + `context:{ walletCount, hasApiKey }`; never log the key.
  - **Test-first:** the §7.1 adapter classification matrix (AC-12) via injected `fetchImpl` /
    `MockScorePort`: 200/401/404/429/5xx/parse/timeout.

- [ ] **Task 1.2 (T-A2): Confirm dashboard-caller auth posture (OQ-3).** → **[G-5]**
  - Determine whether `POST /v1/identity/resolve` follows the sibling-read open posture
    (`/v1/profile`, `/v1/resolve/*` use `route` without `.auth()`) or requires a bearer/svc-JWT.
  - If protected is required: add `.auth()` to the route ONLY. **DO NOT touch the verify
    implementation** (HARD constraint, AC-13). Default to the existing sibling-read posture if
    unconfirmed.

**Phase B — Component 2: the route**

- [ ] **Task 1.3 (T-B1): Protocol schemas + pure `mergeIdentity` resolver (test-first).** → **[G-5]**
  - Author `IdentityResolveReqSchema` (`wallets: array(WalletAddressParamSchema).min(1).max(100)`
    reusing resolve.ts:26-28; `world_slug: WorldSlugParamSchema.optional()` reusing resolve.ts:42-44)
    + `IdentityResolveRespSchema` (`{ results: array(IdentityResolveEntrySchema) }`, per-wallet
    pinned contract §5.3 with `reachable` as string-enum `"true"|"false"|"unknown"`, OQ-5 pinned) in
    `packages/protocol/src/api/identity-resolve.ts`. Re-export from `api/index.ts`.
  - Write the PURE `mergeIdentity(spine, scoreEnrich, world_slug?)` resolver FIRST with its unit
    tests: the 4-tier rule applied ONCE (`world_nym > discord(id-only) > score(real-name-only) >
    address`); the score-tier gate (fires ONLY if `beraname`/`ens_name`/`twitter_handle` non-null —
    SDD §1.5 ▼); `display_source` derivation; discord `{ id, linked }` shape (NO username);
    `reachable` derivation (`"unknown"` default); raw passthrough of beraname/ens/twitter.
  - **Test-first:** §7.2 cases 1-3, 7-10 (AC-1, AC-2, AC-3, AC-7, AC-10) as pure-function unit tests.

- [ ] **Task 1.4 (T-B2): Route `POST /v1/identity/resolve` + registration (test-first).** → **[G-5]**
  - Author `src/api/routes/identity-resolve.ts` (Pattern B `route.post("/v1/identity/resolve")
    .body(IdentityResolveReqSchema).meta({...}).handle(...)` — note `.body()` validation DOES run
    for POST, unlike the GET no-op at profile.ts:53-56):
    1. Validate + lowercase-normalize each wallet (mirror `normalizeAddress`) + dedupe (§5.2 note).
    2. Per wallet: `resolveByWallet(getSpine(), wallet)` → if hit, `getIdentity(getSpine(), user_id)`
       (engine readers used today at resolve.ts:100,201).
    3. ONE batched `getScore().resolveIdentity({ wallets })`; look up `resp.identities[wallet.toLowerCase()]`.
    4. `mergeIdentity` per wallet; set `is_primary_wallet` (from spine), `reachable` tri-state,
       per-wallet `degraded` (computed once per batch — score is one call).
    5. Order-stable `results[]`, echo normalized wallet.
  - Wire the per-source `AbortController` with `IDENTITY_RESOLVE_SCORE_TIMEOUT_MS` (new optional env);
    abort → `{ ok:false, reason:{ kind:"timeout" } }` → `degraded=true`.
  - Error posture (§6.2): validation → 400 envelope (mirror profile.ts:81-86 / resolve.ts:72-78);
    score degrade → 200 + `degraded`; spine MISS (null) → `address` fallback; spine THROW (real DB
    I/O) → propagate to global error handler (5xx). **NO circuit breaker in v1** (Simplicity First).
  - Register in the `.use([...])` array at `src/api/index.ts` (alongside `getProfile`,
    `getMiberaDimensions`).
  - **Test-first:** §7.2 cases 4-6, 8-9, 11 (AC-4, AC-5, AC-6, AC-8, AC-9, AC-11) as integration
    tests against the booted app (ephemeral port test seam at index.ts; `__setScoreForTest` at
    score.ts:49).

**Phase C — Contract bridge handoff**

- [ ] **Task 1.5 (T-C1): Contract-bridge handoff for the dashboard mock-fallback.** → **[G-5]**
  - Confirm `IdentityResolveRespSchema` is importable so the dashboard can build its
    `IDENTITY_RESOLVE_URL` mock-fallback against the sealed shape (§4.1). Document the contract in
    the source-distributed SDK surface (no npm dependency — vendored source per PRD lock-in L333).
  - **Cutover is GATED on #11 P1 + backfill coverage — NOT this sprint** (SDD §4.2). Shipping the
    route does NOT trigger cutover.

- [ ] **Task 1.E2E: End-to-End Goal Validation** → **[G-5]** (see §E2E below).

### Dependencies

- **Within-sprint sequence:** Task 1.3 (B) depends on Task 1.1 (A) sealed score schema; Task 1.4
  (B) depends on Task 1.3 resolver + schemas; Task 1.5 (C) depends on Task 1.4 sealed response schema.
- **External (non-blocking, parallel):** issue #11 (`reachable` population) runs in PARALLEL; this
  sprint ships the tri-state shape with `"unknown"` default. Dashboard CUTOVER is GATED on #11 — out
  of this sprint.
- **Shipped prerequisites (all verified present):** `ScorePort`/`getScore()` singleton,
  `federationHttpCall` POST support, `resolveByWallet`/`getIdentity` engine readers,
  `WalletAddressParamSchema`/`WorldSlugParamSchema`, the `.use([...])` registration array, the 400
  envelope, `__setScoreForTest` seam.

### Security Considerations

- **Trust boundaries:** request body (wallets[], world_slug) is UNTRUSTED → Zod `.body()` validation
  + length cap 100 + lowercase-normalize. score-api response is a federated source → sealed `.loose()`
  schema; classified via `FederationResult`, never thrown. Spine is the local SoR (trusted substrate).
- **External dependencies:** NO new runtime dependencies (SDD §2). One new outbound binding to an
  existing service (score-api), same `X-API-Key` auth, same building.
- **Sensitive data:** `X-API-Key` read from env at singleton build, NEVER logged (adapter logs only
  `hasApiKey: boolean`). Discord `external_id` is an opaque id (no username — column doesn't exist).
  No new PII surface.
- **HARD constraint (no creative latitude):** the ES256 signer, JWKS, svc-JWT verify, and
  `CredentialBridge` stay byte-unchanged. The facade adds NO onchain name resolution to identity-api.

### Risks & Mitigation

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| **R-1** Boundary creep — facade re-derives beraname>ENS>twitter or couples score grouping | Med | High | Hard rule §1.5; AC-2/AC-10 assert no re-derivation (raw passthrough only); review/audit gate checks this explicitly |
| **R-2** N×2 spine point-reads per batch (≤200 at 100 wallets) | Low | Low | Prod scale tiny (5 users / 3 nyms); all reads index-covered (0001:62,80,102); batch capped at 100; batch-resolve helper deferred (not v1) |
| **R-5** Dashboard-caller auth posture unconfirmed (OQ-3) | Med | Med | Task 1.2 (T-A2) confirms; if protected, add `.auth()` ONLY — never touch verify (AC-13) |
| **R-6** `reachable` wire encoding (string-enum vs `boolean\|null`) | Low | Low | OQ-5 RESOLVED → string-enum `"true"\|"false"\|"unknown"` (operator pin); contract window open, no external consumers yet |
| **R-Auth** Accidental edit to signer/JWKS/verify/CredentialBridge | Low | High | AC-13 git-diff check at review + audit; HARD no-creative-latitude rule; tasks touch only port/adapter/protocol/route files |

### Success Metrics

- 11/11 mandatory SDD §7.2 test cases green (AC-1…AC-11) + adapter matrix (AC-12) in the Bun suite.
- `git diff --stat` touches ONLY: `packages/protocol/src/api/federation/score.ts`,
  `packages/protocol/src/api/identity-resolve.ts` (new), `packages/protocol/src/api/index.ts`,
  `packages/ports/src/score.port.ts`, `packages/adapters/src/http-score-adapter.ts`,
  `src/api/routes/identity-resolve.ts` (new), `src/api/index.ts`, and test files. ZERO auth/signer/
  spine/migration files (AC-13, AC-14).
- A booted-app integration test POSTs a mixed batch (resolved + unresolved wallet, score reached +
  degraded) and returns one order-stable, case-normalized entry per wallet at 200 OK.

---

## E2E Goal Validation

### Task 1.E2E: End-to-End Goal Validation

**Priority:** P0 (Must Complete)
**Goal Contribution:** G-5 (the only PRD goal in this feature's scope)

**Description:**
Validate the G-5 read-time-compose, no-embed contract is achieved end-to-end by the facade.

**Validation Steps:**

| Goal ID | Goal (PRD) | Validation Action | Expected Result |
|---------|------------|-------------------|-----------------|
| G-5 | Profile serving — read-time compose, no embed (FR-P1/P2/P3) | Booted-app integration test: POST a batch with (a) a wallet resolving to a spine user with a world_nym, (b) a wallet with discord linked + no nym, (c) a wallet with a real score onchain name only, (d) an unresolved wallet — assert each `display_source` tier and the merged `display_name` | One pre-merged identity per wallet; priority applied ONCE server-side; tiers correct |
| G-5 | No-embed invariant (FR-P3) | `git grep` for new `*.up.sql` / migrations; audit the route stores nothing | No score/onchain data persisted; spine schema unchanged; facade is pure read/compose |
| G-5 | Graceful degradation (FR-P2 / NFR-2) | Force a score-api timeout in the test → assert all entries `degraded=true`, 200 OK, spine tiers still resolve | Downstream outage degrades enrichment only — never the batch, never auth/resolve |
| G-5 | Boundary (score-vs-identity) | Assert `is_primary_wallet` comes from spine, beraname/ens/twitter are raw passthrough not re-ranked | Grouping authority = spine; score enriches only |

**Acceptance Criteria:**
- [ ] G-5 validated with documented evidence (integration test output)
- [ ] No-embed invariant verified (no migrations, no persistence)
- [ ] Degradation path verified (score outage → 200 + degraded, never 5xx)
- [ ] HARD constraint verified: auth/signer/JWKS/verify/CredentialBridge byte-unchanged (AC-13)

---

## Risk Register

| ID | Risk | Sprint | Probability | Impact | Mitigation | Owner |
|----|------|--------|-------------|--------|------------|-------|
| R-1 | Boundary creep (re-derive name chain / couple score grouping) | 1 | Med | High | AC-2/AC-10 tests; review+audit boundary check | implementer |
| R-2 | N×2 spine point-reads per batch | 1 | Low | Low | Tiny prod scale; index-covered; cap 100 | implementer |
| R-5 | Dashboard-caller auth posture unconfirmed | 1 | Med | Med | Task 1.2 confirms; `.auth()`-only if protected | implementer (T-A2) |
| R-6 | `reachable` wire encoding | 1 | Low | Low | RESOLVED — string-enum (OQ-5 operator pin) | operator (pinned) |
| R-Auth | Accidental edit to signer/JWKS/verify/CredentialBridge | 1 | Low | High | AC-13 git-diff gate; HARD rule | review + audit |

> R-3 (score-api wire shape) and OQ-2 are **RESOLVED** (2026-06-01) — grounded against the
> score-api checkout: batched `POST /v1/identity/resolve` exists; response is a keyed map (not
> array); request `{ wallets }` only; group-aware; every wallet guaranteed present. No N-call
> fallback needed.

---

## Success Metrics Summary

| Metric | Target | Measurement Method | Sprint |
|--------|--------|-------------------|--------|
| Mandatory test cases | 11/11 green (+ adapter matrix) | Bun test suite on PR | 1 |
| Blast radius | ONLY port/adapter/protocol/route + tests | `git diff --stat` at review | 1 |
| Auth untouched | 0 changes to signer/JWKS/verify/CredentialBridge | `git diff` AC-13 gate at audit | 1 |
| No-embed | 0 migrations, 0 persistence | `git grep` for `*.up.sql` / store calls | 1 |
| Degradation | score outage → 200 + degraded | integration test | 1 |
| Contract bridge | response schema importable for mock-fallback | Task 1.5 confirmation | 1 |

---

## Dependencies Map

```
Phase A (T-A1, T-A2)  ──▶  Phase B (T-B1, T-B2)  ──▶  Phase C (T-C1)  ──▶  Task 1.E2E
  score port + binding      protocol schemas +          contract bridge      goal validation
  + sealed score schema     pure mergeIdentity +         handoff (mock-
                            route + registration         fallback shape)

  (parallel, non-blocking: issue #11 reachable population — cutover GATED on it, NOT this sprint)
```

---

## Appendix

### A. PRD Feature Mapping

| PRD Feature | Sprint | Status |
|-------------|--------|--------|
| FR-P1 (getProfile/compose via wallet[]) — batch sibling | 1 | Planned |
| FR-P2 (per-source timeout, degrade not 5xx) | 1 | Planned |
| FR-P3 (no-embed invariant) | 1 | Planned |
| FR-P4 (profile shape sealed in protocol) | 1 | Planned |

### B. SDD Component Mapping

| SDD Component | Sprint Tasks | Status |
|---------------|--------------|--------|
| Component 1 — `ScorePort.resolveIdentity` + adapter binding + sealed score schema (§1.4, §1.6, §5.5) | Task 1.1 (T-A1), 1.2 (T-A2) | Planned |
| Component 2 — protocol Req/Resp schemas + pure `mergeIdentity` + route (§1.4, §5.2, §5.3, §5.4) | Task 1.3 (T-B1), 1.4 (T-B2) | Planned |
| Contract bridge handoff (§4, §8 Phase C) | Task 1.5 (T-C1) | Planned |
| Untouched (HARD constraint, §1.4) — signer/JWKS/verify/CredentialBridge | — | OUT OF SCOPE |

### C. PRD Goal Mapping

| Goal ID | Goal Description | Contributing Tasks | Validation Task |
|---------|------------------|-------------------|-----------------|
| G-5 | Profile serving — read-time compose, no embed (the batch merge facade is the resolve-batch sibling of `/v1/profile`) | Sprint 1: Tasks 1.1, 1.2, 1.3, 1.4, 1.5 | Sprint 1: Task 1.E2E |

**Goal Coverage Check:**
- [x] All in-scope PRD goals (G-5) have at least one contributing task
- [x] G-5 has a validation task in the (single) final sprint — Task 1.E2E
- [x] No orphan tasks — every task contributes to G-5

> Scope note: G-1/G-2/G-3/G-4/G-6 are OUT OF SCOPE for this feature-scoped sprint (the spine,
> signer, credential swap, cycle-c redirect, and Mibera survey are separate work). This sprint
> delivers ONLY the G-5 batch merge facade per `bd-2wo.38`.

**Per-Sprint Goal Contribution:**

Sprint 1: G-5 (complete — the `POST /v1/identity/resolve` batch merge facade), validated by Task 1.E2E.

### D. Bead Mapping

| Bead | Maps to | Tasks |
|------|---------|-------|
| `bd-2wo.38` (parent, ratified #32) | The whole feature | all |
| `bd-2wo.38.1` (Component 1) | `ScorePort.resolveIdentity` + binding + sealed schema | Task 1.1, 1.2 |
| `bd-2wo.38.2` (Component 2) | protocol schemas + `mergeIdentity` + route | Task 1.3, 1.4 |
| `bd-2wo.38.3` (Contract bridge) | mock-fallback handoff | Task 1.5 |
| `bd-2wo.38.4` (E2E validation) | G-5 end-to-end | Task 1.E2E |

---

*Generated by Sprint Planner Agent. Next: create task beads under `bd-2wo.38`, then `/run sprint-plan`
(implement → review → audit). Feature work → Loa gate, NOT `/bug`.*
