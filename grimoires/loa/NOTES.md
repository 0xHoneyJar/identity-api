# Project Notes

## ▶ RESUME HERE (fresh session) — v1 /v1/identity/resolve facade is SHIPPED (PR #33)

**2026-06-02 — `bd-2wo.38` BUILT + audit-APPROVED.** Full Loa cycle ran: `/sprint-plan → /run` (implement→review→audit) → **DRAFT PR [#33](https://github.com/0xHoneyJar/identity-api/pull/33)** (base `w2.5-sprint-3-auth-sdk-source-distributed`, head `w2.5-identity-resolve-facade`). Children `bd-2wo.38.1–.4` closed. Full suite 548 pass / 0 fail. AC-13 (auth byte-unchanged) + AC-14 (no-embed) verified. SDD ground-corrected to v1.1 (score response is a **keyed map** not an array; `{wallets}`-only to score; score tier gated on a real onchain name — OQ-6). Decisions resolved this session: OQ-5 = string-enum (pinned), OQ-6 = score-tier-real-name-only.

**OQ-3 RESOLVED 2026-06-02 (operator):** the route is now `.auth()`-gated (requires a bearer JWT via the building's `authJwtPlugin`; verify impl untouched, AC-13 holds; 401 without token). Dashboard must present a session/svc JWT — coordinate via identity-api#4.

**Next — DEPLOY prep in flight (operator: "deploy 33").** Deploying = the whole **w2.5-sprint-3 chain to main+prod** (facade is 8 of 19 commits ahead of main; the parent branch is 11 commits ahead and unmerged). Deploy mechanism is **Railway dashboard-managed** (no in-repo config; `start: bun src/api/index.ts`). Operator chose: **gate OQ-3 first ✓**, then I **prep merge→main, operator triggers Railway** (option 1) — using the **FREESIDE construct** ops workflow. Dashboard **CUTOVER** still separately gated on #11 backfill (facade ships `reachable:"unknown"` until then). Tracked: `bd-9qj` (openapi-zod z.array body crash → in-handler validate), `bd-eda` (pre-existing 5xx disclosure). Held-open: per-world vs unified nym; twitter-linked-account v2 (`bd-2wo.39`).

## Learnings

- **2026-06-01 — the `/kickoff` brief was confabulated.** The auth-vertical kickoff (`enhance-auth-vertical-betterauth-seam.md` + `2026-06-01-auth-vertical-rescope.md`) directed "drop the hand-built canonical-user/jwks/credential-bridges, adopt Better Auth as issuer." Mechanism: `bd-2wo.1–.32` were authored 2026-05-01 as a plan, the work was then **built off-bead** (T1.x→w2.5-sprint-3, no bead lifecycle), the children stayed `open`, and the kickoff agent read open beads as an *unbuilt plan*. Lesson: **in this repo, verify shipped-vs-planned against the tree before acting on any kickoff/brief** — the beads SoT lied.

## Decisions

- **2026-06-01 (operator-ratified) — Better Auth = per-world CREDENTIAL ADAPTER, not issuer/SoR.** Keep the shipped hand-built ES256 stack (LocalEs256Signer, JWKS, Postgres spine, credential bridges, source-distributed verify SDK) as the issuer/SoR per PRD v3.0. Better Auth slots behind the existing `CredentialBridge` port (passkey/social/email → canonical `CredentialProof`) — the operator's actual goal (multi-credential + standardized world login). Full record: `grimoires/loa/2026-06-01-auth-decision-reconciled.md`. Active build bead: `bd-2wo.14`.

## Blockers

- (none) — adapter build is unblocked (`bd-3n1` Coordinate gate closed GO).

## Observations

- **Prod auth today = Dynamic SDK end-to-end** (NOT siwe-turso): midi (`mibera-dimensions`, Vercel) issues/verifies Dynamic JWTs + is the de-facto SoR/writer; service-to-service = static SHA-256 API keys. No svc-JWT in any live path.
- **identity-api is live but build-lagged**: `identity.0xhoneyjar.xyz` serves only the HS256 spine; merged ES256 `service-jwt` + `/.well-known/jwks.json` routes **404** (Railway deploy predates the W2.5 sprint-2 merges). One consumer (`freeside-dashboard`) is itself undeployed.
- **ES256 svc-JWT contract-change window is OPEN**: cluster probe (0.93) found ZERO external consumers; the "1 vendored consumer" (`fa-c2-world-managers`) is our own git worktree. Cheapest moment to make breaking contract changes — until a real world first vendors the source-distributed `@0xhoneyjar/auth` SDK.
- **Stale doctrine corrected** (banner-only; full rewrite is G-1): README + `protocol/src/index.ts` claimed "JWKS issuance lives at loa-freeside/apps/gateway" — false; the signer is the in-repo `LocalEs256Signer`. The loa-freeside gateway is a Discord/NATS gateway with no `/jwks` or `/issue`.
