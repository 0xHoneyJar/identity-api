# Session — Build the v1 `POST /v1/identity/resolve` merge facade

> identity-api becomes the dashboard's one pre-merged identity object. Planning gate is closed; this session BUILDS. Source of truth for the design = `grimoires/loa/sdd.md`.

## Context
freeside-dashboard needs one pre-merged identity per wallet (display_name + discord + linked) so it re-derives nothing. The merge has no home today: score-api computes the onchain name chain but has no Discord; identity-api has Discord + the link graph + per-world nyms but no onchain name. **Decision (ratified #32):** a server-side merge facade on identity-api — spine join + score-api enrichment, priority applied once, server-side. Requirements RATIFIED at `0xHoneyJar/identity-api#32`; design in `grimoires/loa/sdd.md`; tracked as `bd-2wo.38`. This is feature work under the #4 SoR umbrella (PRD v3.0 G-5).

## Run via — Loa sprint cycle (REQUIRED)
The operator chose the **full Loa gate**. Drive the build through the implement→review→audit loop:
```
/sprint-plan          # consume the SDD's Phase A/B/C task breakdown → sprint plan + beads
   → /run sprint-N    # implement → /review-sprint → /audit-sprint, with circuit breaker
```
Rails: `/sprint-plan` turns the SDD's Phase A/B/C into tasks; `/run` wraps implement+review+audit per task and halts on blocker — the operator curates at each review gate. **Alt (operator's call at kickoff):** `code-implement-and-review` (`~/bonfire/construct-compositions/compositions/delivery/code-implement-and-review.yaml`) — the proven path from the Discord adapter this cycle (implement → adversarial `construct-scar`/FAGAN review → fix → re-review). Either way: auth = no creative latitude, so the review gate is non-negotiable.

## Load Order
1. `grimoires/loa/sdd.md` — **the design source of truth** (blast radius, the 2 components, Phase A/B/C, NFRs, the pinned contract, OQ-5).
2. The ratification: `0xHoneyJar/identity-api#32` comment (the 6 grounded answers + reshapes) — `gh issue view 32 --comments`.
3. `grimoires/loa/NOTES.md` — the RESUME HERE block + session decisions/observations.
4. `src/api/routes/profile.ts` + `packages/engine/src/compose-profile.ts` — the `composeProfile`/`FederationResult` pattern to mirror (never-throws, per-source degrade).
5. `packages/adapters/src/http-score-adapter.ts` + `packages/ports/src/score.port.ts` — the existing score client to extend (Component 1).
6. `src/api/routes/resolve.ts` + `packages/engine/src/resolve-spine.ts` (`resolveByWallet`/`getIdentity`) — the spine reads to reuse (Component 2).
7. Memories: `[[better-auth-is-a-credential-adapter-not-issuer]]`, `[[kickoff-briefs-confabulate-from-stale-beads]]` — **verify shipped-vs-planned against the tree before acting** (this repo's beads have lied before).

## Persona
ARCH (`the-arcade`/OSTROM) + craft lens. Structural cutover discipline; reuse over reinvention.

## What to Build (dependency-ordered — full spec in the SDD)
### 1. `ScorePort.resolveIdentity` + `HttpScoreAdapter` binding
New port method + adapter call to score-api `POST /v1/identity/resolve` (batch ≤100, group-aware onchain `display_name`/beraname/ens/twitter). The existing wired client targets `GET /v1/wallets/:address` (scores-only) — this rides the SAME building/`X-API-Key`/`federationHttpCall` (supports POST+body), returns `FederationResult` (never throws; degraded on upstream miss). **T-A1 already grounded** — `score-api/src/routes/identity.ts:27-71` confirms the batch endpoint + per-wallet onchain names; no fallback-to-N-calls needed.

### 2. `POST /v1/identity/resolve` route (Pattern B)
Protocol Zod Req/Resp in `packages/protocol/src/api/` → `route.post().body().handle()` in `src/api/routes/` → register in `src/api/index.ts:74-93`. Per wallet: spine read (`resolveByWallet`→`getIdentity`: user_id, `world_identities[].nym`, `linked_accounts` discord id + linked) + score enrich; apply priority ONCE; return one pre-merged identity per wallet. Read-only (no migrations/cache/circuit-breaker in v1). **Per-wallet partial failure keeps the batch 200** (two axes: `user_id:null` + per-wallet `degraded`) — mirror `composeProfile`.

## Design Rules
- **Priority (applied once, server-side):** `world_nym > discord(id-only) > score display_name > address`. Do NOT re-derive `beraname>ENS>twitter` — consume score's `display_name` as ONE tier; `beraname`/`ens_name`/`twitter_handle` are raw passthrough tooltips (score-vs-identity boundary).
- **`discord: { id, linked }` only** — the spine has no username column.
- **`reachable: "true"|"false"|"unknown"`** string-enum (a JSON bool can't carry the third state) — `unknown` until #11 P1; **OQ-5: confirm this shape while the contract window is open (no external consumers yet).**
- **Grouping SoR = identity-api `wallet_links`/`primary_wallet`;** score enriches per-wallet, never the grouping authority.
- **Per-wallet `degraded` flag** when score enrichment was unavailable (mirror `/v1/profile`).
- **`twitter_handle` source-flip is forward-designed** (v2 `bd-2wo.39`): score-scraped now; identity-linked later (verified > inferred) — same field, non-breaking. Do not build it; just don't paint into a corner.

## What NOT to Build
- ❌ Onchain name resolution in identity-api (lives in score-api — boundary).
- ❌ Any touch of the ES256 signer / JWKS / svc-JWT verify path / `/v1/auth/verify` CredentialBridge (auth = no latitude).
- ❌ Migrations, cache, circuit-breaker (v1 is read-only + simple).
- ❌ The twitter linked-account flow (`bd-2wo.39`, v2) or the per-world-nym-vs-unified-freeside-nym decision (held-open).
- ❌ The dashboard CUTOVER — that's gated on #11 P1 + world-identity backfill coverage (prod: 5 users / 3 nyms). Ship behind the contract-first bridge (`IDENTITY_RESOLVE_URL`) so the dashboard wires against the shape with mock-fallback; build runs PARALLEL to #11.

## Verify
- `bun test` green incl. new tests: happy merge, `user_id:null` (no spine row), per-wallet `degraded` (score down → batch still 200), priority precedence (nym wins over score name), ≤100 cap, beraname-not-re-derived assertion (SDD §7.2).
- Typecheck clean on touched files (pre-existing `src/hyper/*` errors are not yours).
- The 4 untouched-component assertions (signer/JWKS/verify/CredentialBridge byte-unchanged).

## Key References
| Topic | Path |
|---|---|
| Design (source of truth) | `grimoires/loa/sdd.md` |
| Ratified contract + 6 answers | `0xHoneyJar/identity-api#32` (comment) |
| Bead | `bd-2wo.38` (+ forward `bd-2wo.39` twitter v2) |
| Federation pattern to mirror | `src/api/routes/profile.ts`, `packages/engine/src/compose-profile.ts` |
| Score client to extend | `packages/adapters/src/http-score-adapter.ts`, `packages/ports/src/score.port.ts` |
| Spine reads to reuse | `src/api/routes/resolve.ts`, `packages/engine/src/resolve-spine.ts` |
| Dep / gate | #11 P1 (multi-method links → spine rows) + world-identity backfill coverage |
