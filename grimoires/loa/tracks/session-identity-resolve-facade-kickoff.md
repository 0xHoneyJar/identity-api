---
session: identity-resolve-facade
date: 2026-06-01
type: kickoff
status: planned
---

# Session — v1 `POST /v1/identity/resolve` merge facade (kickoff)

## Scope
- BUILD the server-side merge facade on identity-api (bead `bd-2wo.38`, ratified `#32`).
- 2 tasks: (1) `ScorePort.resolveIdentity` → score-api `POST /v1/identity/resolve` binding; (2) the `POST /v1/identity/resolve` route (spine join + score enrich, priority once, read-only).
- Entry: planning gate done → `/sprint-plan` → `/run sprint-N` (implement→review→audit). Feature work, NOT /bug.
- Ship behind the contract-first bridge (`IDENTITY_RESOLVE_URL`); build PARALLEL to #11.

## Artifacts
- Build doc: `specs/enhance-identity-resolve-facade.md` (session-entry layer)
- Design (source of truth): `sdd.md`
- Ratification: `0xHoneyJar/identity-api#32` comment

## Prior session (this one)
Caught + corrected a confabulated `/kickoff` brief (drop-the-shipped-ES256-stack); ratified Better Auth = credential adapter (not issuer); shipped + reviewed the Discord-social OAuth-link adapter scaffold (`bd-2wo.14`, APPROVED, 20/20); ratified #32 + produced the facade SDD; folded #11's twitter-as-linked-account into the plan (`bd-2wo.39`, v2). Commits: `9c71e0f` `740bade` `02a7fa5` `8341e3d` `65a4158`.

## Decisions made (pinned — do not re-litigate)
- Priority `world_nym > discord(id) > score display_name > address`; don't re-derive the onchain sub-chain.
- `discord: {id, linked}` only (no username column); `reachable` tri-state (OQ-5: confirm shape during build).
- Grouping SoR = identity-api `wallet_links`; score enriches per-wallet.
- T-A1 grounded (score-api batch endpoint verified). `twitter_handle` source-flip forward-designed (v2).
- Auth = no creative latitude: do not touch signer/JWKS/verify/CredentialBridge; no onchain-name resolution here.
- Held-open: per-world nym vs unified cross-world freeside-nym.

## Gate / dependency
Dashboard CUTOVER gated on #11 P1 (multi-method links → spine rows) + world-identity backfill coverage (prod: 5 users / 3 nyms — backfill ran, coverage tiny). Build does NOT wait on it.
