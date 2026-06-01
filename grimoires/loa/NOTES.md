# Project Notes

## ▶ RESUME HERE (fresh session) — build the v1 /v1/identity/resolve facade

Planning gate is DONE for `bd-2wo.38` (ratified GitHub #32). Artifacts landed + committed:
- requirements: `grimoires/loa/prd.md` (v3.0, G-5) + the ratification comment on `0xHoneyJar/identity-api#32`
- design: `grimoires/loa/sdd.md` (feature-scoped; Phase A/B/C task breakdown; `[ASSUMPTION]` T-A1 is ALREADY grounded — score-api `POST /v1/identity/resolve` verified at `score-api/src/routes/identity.ts:27-71`)
- bead: `bd-2wo.38` (full task spec + pinned contract)

**Next:** `/sprint-plan` (consume the SDD's Phase A/B/C breakdown) → `/run sprint-N` (implement→review→audit). Two tasks: (1) `ScorePort.resolveIdentity` → score-api binding; (2) the `POST /v1/identity/resolve` route. Open design Q for the build: **OQ-5** (`reachable` tri-state as string-enum — contract window is open, cheap to confirm). Build runs PARALLEL to #11; dashboard CUTOVER stays gated on #11 P1 + world-identity backfill coverage (prod: 5 users / 3 nyms — backfill ran, coverage tiny). Held-open: per-world nym vs unified freeside-nym.

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
