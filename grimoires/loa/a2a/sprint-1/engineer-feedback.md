# Senior Tech Lead Review — Sprint 1: `POST /v1/identity/resolve` Merge Facade

**Bead:** `bd-2wo.38` (38.1–38.4) · **Reviewer:** Senior Tech Lead (adversarial) · **Date:** 2026-06-02
**Verdict:** **All good (with noted concerns)** — one robustness bug fixed during review; remaining concerns non-blocking + acknowledged.

---

## Overall Assessment

The implementation is production-ready and faithfully matches the grounded SDD v1.1. Blast radius is exactly the planned set (port/adapter/protocol/engine/route/sdk + tests); **zero** changes to the signer/JWKS/verify/`CredentialBridge`/spine/migrations (AC-13/AC-14 re-verified by `git diff` — empty). The score-vs-identity boundary (R-1, the load-bearing constraint) holds: `mergeIdentity` reads `beraname`/`ens_name`/`twitter_handle` for **presence only** and never re-ranks them (`merge-identity.ts:69-78`, asserted by AC-2/AC-10 tests). Priority is applied once. Degrade is per-batch and never 5xxes. 39 focused tests + full suite 548 pass / 0 fail.

I read the actual code (not just the report). The report's `## AC Verification` section is present and complete — all 14 ACs walked verbatim with file:line evidence; spot-checks confirm the evidence.

## AC Status — all met

AC-1…AC-14: **✓ Met** (evidence verified against code + tests; see `reviewer.md` §AC Verification). 11/11 SDD §7.2 cases covered; adapter matrix (AC-12) covers 200/401/404/429/5xx/parse/timeout.

## Critical Issues (must fix)

**None.** No security issue, no auth drift, no AC failure, no blocking bug.

## Issue Fixed During Review

- **[FIXED] Robustness: `NaN` score-timeout env → silent universal degrade.**
  `src/api/routes/identity-resolve.ts` read `Number(process.env.IDENTITY_RESOLVE_SCORE_TIMEOUT_MS ?? 600)`. A malformed env value → `NaN` → `setTimeout(NaN)` fires ~immediately → `ac.abort()` before the fetch resolves → **every** request degrades to spine-only with no error. Fixed: `Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : DEFAULT` (route:65-69). Re-ran tests: 13/13 green, typecheck clean.

## Adversarial Analysis

### Concerns Identified
1. **Sequential per-wallet spine reads** (`identity-resolve.ts:80-92`): up to 200 awaits at 100 wallets. Documented as R-2 (tiny prod scale, index-covered). Non-blocking; see Alternative below.
2. **Multi-active-discord-per-user → arbitrary first pick** (`merge-identity.ts:60-62`): the spine PK `(provider, external_id)` permits >1 active discord row per user; `find` picks the first (deterministic by `getIdentity` order). The contract surfaces ONE discord. By-design but undocumented — note it.
3. **Empty-string nym would be selected** (`merge-identity.ts:55-58`): `worldNym !== undefined` selects even a `""` nym (→ `display_name=""`). Low risk — `NymParamSchema` enforces `.min(3)` at claim time, so the spine shouldn't hold an empty nym. Defense-in-depth would guard `worldNym !== undefined && worldNym !== ""`.

### Assumptions Challenged
- **Assumption:** score-api keys its response map by **lowercased** wallet AND includes every requested wallet. **Risk if wrong:** lookup misses → universal degrade-to-address. **Verdict:** grounded against the score-api checkout (`identity.service.ts` normalizes lowercase + `createEmptyIdentity` guarantees presence) AND the route is defensive — a missing key → `enrich=undefined` → address tier, never a crash. Validated; acceptable.
- **Assumption (boundary nuance):** the `score` tier's `display_name` is group-aware per **score-api's** `resolve_wallet_group`, which may differ from the **spine's** `wallet_links` grouping. **Verdict:** correct by doctrine — score owns onchain names (+ their group resolution); identity owns user grouping (`user_id`/`is_primary_wallet` from spine). Not a violation; worth a one-line note for future readers.

### Alternatives Not Considered
- **Alternative:** `Promise.all` the per-wallet spine reads (parallelize). **Tradeoff:** lower latency at scale vs. one throw rejecting the whole batch (which is the desired 5xx-on-spine-failure posture anyway). **Verdict:** current sequential is justified for v1 (Simplicity First, tiny scale, R-2 documented); parallelize when scale demands — note for the post-cutover optimization pass.

## Karpathy Principles

- **Think Before Coding:** ✓ assumptions surfaced in `reviewer.md` + the OQ-3/OQ-6 decisions are explicit.
- **Simplicity First:** ✓ no speculative features; no client method added (correctly deferred to gated cutover); no circuit breaker (justified).
- **Surgical Changes:** ✓ diff traces to the task; no drive-by edits; the discovered converter bug was logged (bd-9qj), not silently worked around in `src/hyper`.
- **Goal-Driven:** ✓ 11 mandatory cases → AC-1…AC-11; the G-5 goal-validation test is the executable evidence.

## Complexity Analysis

- `mergeIdentity()`: OK (~50 lines incl. comments, 1 options param, nesting ≤2). `route handler`: OK (~45 lines, linear). No duplication >3, no circular deps, no dead code. Clear naming.

## Documentation Verification

- **CHANGELOG:** N/A at review — this repo auto-generates CHANGELOG via post-merge automation (`CLAUDE.loa.md` §Post-Merge). No manual per-task entry required on a feature branch.
- **CLAUDE.md:** N/A — no new Loa command/skill (this is an API endpoint).
- **Contract docs:** ✓ SDD v1.1 + `reviewer.md` + route/merge docstrings document the endpoint, the new `IDENTITY_RESOLVE_SCORE_TIMEOUT_MS` env, and the in-handler-validation deviation.
- One nit: SDD §5.1 still says "this is a real POST, so Hyper's `.body()` validation DOES run" — now inaccurate (route validates in-handler due to bd-9qj). Non-blocking; recommend a one-line SDD touch at audit or a follow-up.

## Cross-Model Review

`flatline_protocol.code_review` is **not enabled** in `.loa.config.yaml` → Phase 2.5 adversarial cross-model review skipped (single-model assessment). No gate block (the adversarial-review gate fires only when enabled).

## Next Steps

Approved. Non-blocking concerns (#1–#3 + the SDD §5.1 nit) are documented for a follow-up/optimization pass — none gate this sprint. Proceed to `/audit-sprint`.
