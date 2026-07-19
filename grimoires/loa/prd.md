---
title: PRD — identity-api · cycle auth-linking-adapt
cycle: identity-api-auth-linking-adapt-2026-07-19
building_slug: identity-api
status: v3.1 draft (ride-grounded reconciliation + handoff adapt)
date: 2026-07-19
mode: ARCH
authoring: /plan-and-analyze ← /ride --enriched ← handoff zip
supersedes_ride_thin: ride-extracted PRD of same day (merged here)
operator_prd_archive: grimoires/loa/legacy/pre-ride-2026-07-19/prd.md
---

# PRD — identity-api (cycle: auth-linking-adapt)

## §0 Frame

**identity-api is the canonical identity SoR and session issuer for freeside.** Code already owns the spine and Hyper HTTP surface. This cycle reconciles three claim surfaces that disagree:

| Surface | Stance |
|---------|--------|
| Code (truth) | Spine writer + SIWE/EIP191 + Discord OAuth + profile compose + HS256 user JWT + ES256 svc-JWT |
| Operator PRD v3.0 (archived) | SoR writer + SIWE-first + **user** Local ES256 + JWKS |
| Handoff 2026-07-19 | Hexagonal domain + `link_intents` / `CompleteCredentialLink` |

### High-leverage decisions (ratified this session)

| ID | Decision |
|----|----------|
| **D-ADAPT-001** | **Adapt** handoff onto `packages/{ports,engine,adapters}` + spine — do **not** introduce a parallel `src/domain|application` tree or `link_intents`/`credential_links` tables in this cycle. Map handoff use-cases onto `resolve-spine` link helpers + existing routes. |
| **D-JWT-001** | Close the user-session plane gap: **user JWTs must be ES256 via `JWTSigner`**, with JWKS publishing the user verification keys (or clearly dual-plane docs). svc-JWT LocalEs256 remains. Demote HS256 `src/jwt-mint.ts` path. |
| **D-MCP-001** | Live agent surface = Hyper `meta.mcp` on routes. `packages/mcp-tools` stays scaffold until a dedicated package impl sprint — do not block auth work on empty package. |
| **D-MERGE-DONE** | `POST /v1/identity/resolve` merge facade is **shipped** (`merge-identity.ts` + route). Prior sprint.md scope is complete; archived as historical. |

Ride evidence: `grimoires/loa/drift-report.md` (score 48), `gaps.md` GAP-001..010.

---

## §1 Goals (this cycle)

| ID | Goal | Success metric |
|----|------|----------------|
| **G-A1** | User-session ES256 issuance via `JWTSigner` + verify via JWKS/plugin | Honey-road-style session: mint ES256; `GET /.well-known/jwks.json` (or dual-kid plane) verifies; HS256 mint path removed or feature-flagged off |
| **G-A2** | Handoff security invariants on spine link path | No auto-link by email/handle; collision → explicit audited reject; initiate/complete bind same user+session for Discord link |
| **G-A3** | Claim-surface hygiene | CLAUDE.md / INTENT hard-rules match SoR writer + signer reality; handoff marked projection-only in context README |

Out of cycle (explicit): Telegram OIDC, passkey, CAIP-10 rewrite, hexagonal greenfield, mcp-tools src impl, 4-tier `resolve-tier.ts` rebuild.

---

## §2 Users

Primary: wallet holders + Discord-linked users authenticating through identity-api.  
Secondary: cells (svc-JWT — already ES256).  
Agents: Hyper MCP routes (not empty mcp-tools package).

---

## §3 Functional requirements

### G-A1 — User JWT plane

| ID | Requirement |
|----|-------------|
| **FR-J1** | Auth verify / session mint constructs claims then calls `JWTSigner.sign` (no inline HS256 in hot path) |
| **FR-J2** | Production signer for user sessions is ES256 (LocalEs256 user kid **or** HttpJWTSigner when gateway ready) |
| **FR-J3** | `authJwtPlugin` verifies ES256 against published JWKS keys for user kids |
| **FR-J4** | svc-JWT plane remains isolated (`svc-` kid prefix); no privilege confusion |

### G-A2 — Link / collision (handoff-adapted)

| ID | Requirement |
|----|-------------|
| **FR-L1** | Discord link initiate→callback binds initiating session subject; reject completion for mismatched user |
| **FR-L2** | `linked_accounts` collision (same provider+external_id, other user) → audited hard-fail; never silent merge |
| **FR-L3** | No email/username/handle auto-link paths in route or engine link helpers |

### G-A3 — Docs

| ID | Requirement |
|----|-------------|
| **FR-D1** | Root CLAUDE.md hard-rules section rewritten to SoR writer + JWTSigner (PRD wins language removed as contradiction) |
| **FR-D2** | Handoff context README states adapt-not-paste + D-ADAPT-001 |

---

## §4 Non-goals

- Paste handoff `reference-implementation/` into `src/`
- New intent tables without ADR + migration plan (deferred)
- Replacing Discord OAuth with hex Verifier ports this cycle (optional follow-up)

---

## §5 Risks

| Risk | Mitigation |
|------|------------|
| Breaking existing HS256 sessions | Dual-accept verify window or force re-login; document in runbook |
| JWKS mixes user+svc keys | Kid prefix discipline (`svc-` vs user) |
| Bridge on thin sprint | Sprint scoped to G-A1 first, G-A2 tests, G-A3 docs |

## Grounding

| Marker | Notes |
|--------|-------|
| `[GROUNDED]` | Spine, SIWE, Discord routes, merge facade, svc ES256 |
| `[CLAIMED: archived PRD D7]` | User Local ES256 — **target of G-A1** |
| `[CLAIMED: handoff]` | Hex/intents — **rejected for this cycle** via D-ADAPT-001 |
