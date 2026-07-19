# Sprint Plan: Auth-plane reconciliation (user ES256 + link invariants)

**Version:** 1.0  
**Date:** 2026-07-19  
**PRD:** `grimoires/loa/prd.md` (cycle auth-linking-adapt)  
**SDD:** `grimoires/loa/sdd.md` (ride-grounded)  
**Decisions:** D-ADAPT-001, D-JWT-001, D-MCP-001, D-MERGE-DONE

---

## Executive Summary

Prior merge-facade sprint is **shipped**. This plan closes the highest-leverage drift: **user sessions still mint HS256 while PRD/docs claim ES256/JWKS**, and hardens Discord/link collision invariants from the handoff **without** pasting a hexagonal tree.

**Total Sprints:** 2  
**Build gate:** `/run sprint-plan` inside `/run-bridge --depth 3`

---

## Sprint Overview

| Sprint | Theme | Goals |
|--------|-------|-------|
| 1 | User JWT ES256 via `JWTSigner` | G-A1 / FR-J1–J4 |
| 2 | Link collision + session bind + docs | G-A2 / G-A3 |

---

## Sprint 1: User-session ES256

**Scope:** MEDIUM  
**Goal:** Replace HS256 hot path in `src/jwt-mint.ts` with `JWTSigner` ES256; verify via JWKS-aware plugin; keep svc plane isolated.

### Deliverables

- [x] **D1** — User-session `LocalEs256Signer` (or kid-namespaced variant) wired for session mint; distinct kid from `svc-*`
- [x] **D2** — `src/jwt-mint.ts` (or successor) calls `JWTSigner.sign` only — no `HS256` in production path
- [x] **D3** — `well-known-jwks` publishes user verification JWK(s) alongside svc keys with clear kid separation
- [x] **D4** — `authJwtPlugin` / session verify accepts ES256 user tokens (JWKS or injected keyset)
- [x] **D5** — Tests: mint → verify round-trip; svc token rejected as user session; kid prefix guards
- [x] **D6** — Short runbook note under `grimoires/runbooks/` for session key rotation

### Tasks

1. **T1.1** Inventory current mint/verify (`src/jwt-mint.ts`, `src/api/index.ts`, `well-known-jwks.ts`, `local-es256-signer.ts`) — confirm dual-plane design. → G-A1
2. **T1.2** Implement user ES256 signer config (env PEM + kid) reusing adapter patterns. → FR-J2
3. **T1.3** Refactor session mint to `JWTSigner`. → FR-J1
4. **T1.4** JWKS publish + plugin verify swap. → FR-J3, FR-J4
5. **T1.5** Test suite + migration note for existing HS256 cookies (force re-auth). → G-A1
6. **T1.E2E** Boot app: challenge/verify → ES256 cookie → `/v1/me` 200; forged HS256 rejected.

### E2E Goal Validation

| Goal | Evidence |
|------|----------|
| G-A1 | Integration test mint/verify ES256; HS256 rejected |

---

## Sprint 2: Link invariants + claim hygiene

**Scope:** SMALL–MEDIUM  
**Goal:** Handoff security invariants on existing Discord/link paths; fix CLAUDE.md / handoff README.

### Deliverables

- [x] **D7** — Discord link complete rejects mismatched session subject (already in `discord-link.ts` state.sub === session; covered by existing route tests)
- [ ] **D8** — Cross-user `linked_accounts` collision audited (engine already partial — close gaps + tests)
- [ ] **D9** — Grep gate: no email/handle auto-link in link routes/engine
- [x] **D10** — CLAUDE.md hard-rules aligned to SoR writer + JWTSigner
- [x] **D11** — Handoff context README: adapt-not-paste + D-ADAPT-001 (`ADAPT.md`)

### Tasks

1. **T2.1** Discord link session-bind tests + fix. → FR-L1
2. **T2.2** Collision path tests on `linkAccountWithAudit`. → FR-L2
3. **T2.3** Auto-link grep CI or unit assert. → FR-L3
4. **T2.4** Docs: CLAUDE.md + handoff README. → FR-D1, FR-D2
5. **T2.E2E** Documented evidence for G-A2/G-A3

---

## Risk Register

| ID | Risk | Mitigation |
|----|------|------------|
| R1 | Session break for existing users | Force re-login; note in runbook |
| R2 | Kid collision user/svc | Prefix convention + tests |
| R3 | Scope creep into hex rewrite | D-ADAPT-001 hard stop |

## Success Metrics

| Metric | Target |
|--------|--------|
| User mint alg | ES256 only in prod path |
| Drift GAP-006 | Closable with evidence |
| Handoff paste | Zero new `src/domain` tree |
