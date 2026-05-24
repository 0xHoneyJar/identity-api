---
title: freeside-auth — Sprint Plan
date: 2026-04-30
phase: Phase 3 (Sprint Plan) — planning-sprints skill output
status: SUPERSEDED 2026-05-24 by grimoires/loa/prd.md (PRD v3.0) + beads reconciliation — retained for provenance
operator: zksoju
authoring_agent: Claude Opus 4.7 (1M)
authoring_persona: KRANZ (construct-freeside flight director)
parent_prd: grimoires/prd.md
parent_sdd: grimoires/sdd.md
parent_ledger: grimoires/ledger.json
methodology: 5-act KRANZ — Coordinate · Mirror · Verify · Flip · Distill
vertical_slice: Sprawl Dashboard (SIWE-Turso → Better Auth + Freeside JWT)
beads_db: .beads/
---

# freeside-auth — Sprint Plan

> The runbook is the load-bearing artifact. The runbook is the artifact the next cutover reads.
> Sprint plan = procedure. Sprint = act. Task = step. Gate = threshold. Telemetry = truth.
> KRANZ persona: terse, telemetry-driven, threshold-based. The threshold predates the call.

## §0 · Executive summary

| Field | Value |
|---|---|
| **MVP scope** | freeside-auth Sprint-1 vertical slice — Sprawl Dashboard cutover (SIWE-Turso → Better Auth + Freeside JWT validator) |
| **Total sprints** | 2 (Sprint-0.5 Coordinate close + POC; Sprint-1 Mirror + Verify + Flip + Distill) |
| **Total elapsed** | ~32 days (Sprint-0.5: 5d; Sprint-1: 27d per PRD §7.4) |
| **Total tasks** | 28 (Sprint-0.5: 5; Sprint-1: 23 across 6 sub-phases) |
| **Goal IDs** | G-1 through G-7 (mirror PRD §3.2 M1–M7) |
| **Persona** | KRANZ — flight director; runbook is artifact-of-record |
| **Coordinate gate state** | YELLOW — 3 items open (DEP-1 janitooor, DEP-8 soju Railway, DEC-OPEN-1 Better Auth POC) |
| **Reversibility policy** | Every action one revert from previous state (KRANZ P4) |
| **Verify discipline** | Three-layer gate (smoke + parity + operator); 100% parity threshold (KRANZ P3) |
| **Distillation hooks** | D-1 through D-7 + AP8 candidate (SDD §9 + §0.5) |

### Sprint roadmap at a glance

```
Sprint-0.5 (5d)  Coordinate close + POC
                 ├─ Task 0.1: janitooor sign-off ask (DEP-1 close)             [P0]
                 ├─ Task 0.2: soju Railway access ask (DEP-8 close)            [P0]
                 ├─ Task 0.3: Better Auth POC scaffold (3-day timebox)         [P0, gates Phase 5]
                 ├─ Task 0.4: POC done-bar evidence file                       [P0]
                 └─ Task 0.5: Coordinate gate close — GO/NO-GO to Mirror       [P0]

Sprint-1 (27d)   Mirror + Verify + Flip + Distill
  Phase 1 (5d)   Schema (M1)
                 ├─ Task 1.1: User schema (TypeBox)                            [P0, blocks 1.2-1.5]
                 ├─ Task 1.2: Credential schema                                [P0]
                 ├─ Task 1.3: JwtClaims schema (FULL substrate, not subset)    [P0, blocks issuer ratify]
                 ├─ Task 1.4: WorldManifestAuth schema                         [P0]
                 └─ Task 1.5: VERSIONING.md governance + protocol publish      [P0]

  Phase 2 (5d)   Engine + Ports (M1 cont.)
                 ├─ Task 2.1: Postgres DDL migration 001_init                  [P0, blocks 2.4]
                 ├─ Task 2.2: Port interfaces (IUserRepo, etc.)                [P0]
                 ├─ Task 2.3: canonical-user.ts engine (mint, link, revoke)    [P0]
                 └─ Task 2.4: resolve-tier.ts extraction from midi             [P0]

  Phase 3 (7d)   Adapters
                 ├─ Task 3.1: jwks-validator.ts (extraction; FR-3.5)           [P0, blocks Phase 5]
                 ├─ Task 3.2: credential-bridge-siwe.ts                        [P0]
                 ├─ Task 3.3: credential-bridge-passkey.ts                     [P1]
                 ├─ Task 3.4: credential-bridge-discord-bot.ts (NFR-1.3)       [P1]
                 ├─ Task 3.5: credential-bridge-better-auth.ts (POC-gated)     [P0, requires 0.3]
                 ├─ Task 3.6: credential-bridge-dynamic.ts (legacy + lint)     [P0]
                 ├─ Task 3.7: pg-mibera-profiles.ts (Railway read; FR-5.3)     [P0, requires 0.2]
                 ├─ Task 3.8: dynamic-csv-translator.ts (98,320 rows)          [P0]
                 └─ Task 3.9: pg-canonical-user/credentials/auth-events repos  [P0]

  Phase 4 (3d)   MCP-tools
                 ├─ Task 4.1: resolve_wallet tool                              [P0]
                 ├─ Task 4.2: link_credential tool                             [P0]
                 └─ Task 4.3: issue_jwt_for_world tool (gateway-mediated)      [P0]

  Phase 5 (5d)   Sprawl Dashboard cutover (Mirror + Verify + Flip)
                 ├─ Task 5.1: Mirror — provision substrate (M1-M6)             [P0]
                 ├─ Task 5.2: Mirror M7 — feature flag wiring                  [P0]
                 ├─ Task 5.3: Verify Layer 1 — smoke canary                    [P0, blocks 5.5]
                 ├─ Task 5.4: Verify Layer 2 — parity 30/30                    [P0, blocks 5.5]
                 ├─ Task 5.5: Verify Layer 3 — operator gate (HUMAN)           [P0, blocks Flip]
                 ├─ Task 5.6: Flip F1-F2 — feature flag default                [P0]
                 ├─ Task 5.7: Flip F3 — 7-day soak window                      [P0]
                 └─ Task 5.E2E: End-to-end goal validation (G-1 through G-7)   [P0]

  Phase 6 (2d)   Distill (post-soak)
                 ├─ Task 6.1: ADR-039 finalize                                 [P0]
                 ├─ Task 6.2: Threat model doc                                 [P0]
                 ├─ Task 6.3: Migration runbook + retro                        [P0]
                 └─ Task 6.4: Distillation PR to construct-freeside (D-1..D-7) [P0]
```

---

## §1 · Coordinate gate state (load-bearing for sequencing)

Per SDD §0.4. The gate is YELLOW. Three items remain open at sprint-plan author time.

| Gate item | State | Owner | Sprint-0.5 task |
|---|---|---|---|
| PRD ratified | 🟢 GREEN | @zksoju | done 2026-04-30 |
| Substrate-of-record audit | 🟢 GREEN | KRANZ | done 2026-04-30 (SDD §0.1) |
| Sprawl Dashboard auth dir confirmed | 🟢 GREEN | KRANZ + @zksoju | done 2026-04-30 (SDD §0.5 Amendment 1; new path: `world-sprawl/apps/freeside-dashboard/`) |
| @janitooor jwt-claims schema mirror sign-off (DEP-1) | 🟡 OPEN | @janitooor | **Task 0.1** |
| @soju Railway DB read access (DEP-8) | 🟡 OPEN | @soju (operator self) | **Task 0.2** |
| Better Auth POC commit (DEC-OPEN-1, RSK-7) | 🟡 OPEN | @zksoju | **Tasks 0.3, 0.4** |

**The gate predates the procedure.** Mirror does not begin until the gate is GREEN.

---

## §2 · Goal Index (PRD M1–M7 → Sprint Plan G-1 through G-7)

PRD §3.2 lists Sprint-1 DoD metrics M1–M7. SDD §0–§9 elaborates. Sprint plan inherits as G-1 through G-7 with task-level traceability.

| ID | Goal | PRD ref | Validation method |
|---|---|---|---|
| **G-1** | Canonical user mint flow (first credential resolution → ULID user_id → Postgres → JWT) | PRD M1 | Integration test in Phase 2; smoke canary in Phase 5 |
| **G-2** | JWKS verification round-trip (Sprawl Dashboard verifies Freeside JWT; fresh+stale paths exercised) | PRD M2 | smoke canary Layer 1 (Phase 5 Task 5.3) |
| **G-3** | Dynamic CSV translation fidelity (98,320 rows → users + credentials, zero data loss, idempotent) | PRD M3 | count assertion at end of Task 3.8; `output_credentials_count == 98320` |
| **G-4** | Three credential adapters live (SIWE + Passkey + Discord-bot attestation) | PRD M4 | unit + integration tests Tasks 3.2, 3.3, 3.4 |
| **G-5** | Per-world auth manifest consumed (world declares accepted credentials; freeside-auth honors) | PRD M5 | Task 1.4 schema + Phase 5 vertical slice consumes manifest |
| **G-6** | ADR-039 drafted (supersedes ADR-003 + ADR-038; ready for hivemind merge) | PRD M6 | Task 6.1 |
| **G-7** | Zero `Co-Authored-By: Dynamic` paths in net-new code (lint rule blocks `@dynamic-labs/*`) | PRD M7 | Task 3.6 ESLint rule + Task 5.E2E lint check |

E2E validation: Task 5.E2E in Phase 5 covers all seven goals end-to-end with cited evidence files.

---

## §3 · Sprint-0.5 — Coordinate close + Better Auth POC

### Sprint scope: SMALL (5 tasks)
### Sprint goal
**Close the three open Coordinate-gate items so Sprint-1 Mirror can begin without yellow lights.**

### Sprint methodology act
**Act 1 (Coordinate) — read the room before committing.** No code on disk yet. This sprint is asks-and-evidence.

### Deliverables (checkbox list)

- [ ] Schema-mirror sign-off ask filed with @janitooor (with mechanical-mirror evidence: jwt-service.ts:142-170 cited; PRD subset documented)
- [ ] Railway DB read access ask filed with @soju (mibera-db, apdao-db, cubquest-db; read-only credentials)
- [ ] Better Auth POC committed at `world-sprawl/apps/freeside-dashboard/__poc__/` (or sibling spike location); 3-day timebox honored
- [ ] POC done-bar evidence file at `grimoires/freeside/cultivations/poc-better-auth-{date}.md`
- [ ] Coordinate gate evidence appended to `grimoires/freeside/cultivations/extract-freeside-auth-2026-04-30.runbook.md`
- [ ] Sprint-0.5 retro entry in NOTES.md

### Acceptance criteria (testable)

- [ ] **AC-0.1**: janitooor sign-off recorded in writing (Discord, Linear, or PR comment) — schema mirror approved or amendment requested
- [ ] **AC-0.2**: Railway env vars documented at `~/.config/freeside-auth/.env.railway-readonly` (gitignored); `psql $RAILWAY_MIBERA_DATABASE_URL -c '\d midi_profiles'` returns schema
- [ ] **AC-0.3 POC pass-bar**: Better Auth instance scaffolds against world-sprawl/apps/freeside-dashboard; SIWE proof exchanged; Better Auth session token produced; bridge-to-Freeside-JWT path validated through stub gateway endpoint
- [ ] **AC-0.4 POC fail-fallback**: if Better Auth fails Solana adapter or session-token bridge feasibility, fallback documented (Sprint-1 ships SIWE+Passkey only on Dashboard cutover; Better Auth deferred to Sprint-2)
- [ ] **AC-0.5**: Coordinate gate (SDD §0.4) shows ALL items GREEN before Sprint-1 starts

### Technical tasks

#### Task 0.1: ~~File janitooor sign-off ask~~ → **DEFERRED via RSK-9 fallback (2026-05-01 operator decision)** → **[G-3]** **[G-7]**
**Source**: PRD DEP-1; SDD §0.4; RSK-9 mitigation.
**Status (2026-05-01)**: RSK-9 fallback ACTIVE. Operator chose to proceed without blocking on @janitooor — schema mirror is mechanical (substrate-cited verbatim from `loa-freeside/packages/adapters/agent/jwt-service.ts:142-170`). Phase 1 schema work proceeds; delta flagged in PR for retroactive ratification when @janitooor available.

- [x] ~~Author sign-off ask message~~ — superseded; proceeding via mechanical mirror
- [ ] **Acting under RSK-9**: extract schemas verbatim from substrate; cite line numbers in code comments (D-3 distillation pattern)
- [ ] **Phase 1 PR description requirement**: include section "Janitooor ratify (RSK-9 retroactive)" listing each claim field + substrate line; on PR review, ping @janitooor for sign-off; merge does not block
- [ ] Open question for retroactive ratification (DEC-SDD-2 / OQ-5): who authenticates a world calling `POST /identity/resolve-and-issue`? Surfaced in PR for jani when available
- [ ] Beads: `freeside-auth-sprint-0.5-task-0.1` priority=DEFERRED; updated 2026-05-01

#### Task 0.2: File soju Railway access ask → **[G-1]**
**Source**: PRD DEP-8; SDD §0.4.
- [ ] Document required Railway projects: `mibera-db`, `apdao-db`, `cubquest-db`
- [ ] Request: read-only credentials; preference for `railway run` pattern (no DB creds in repo)
- [ ] Validate: `\d midi_profiles` schema dump for `IProfileLookup` port impl
- [ ] Beads: `freeside-auth-sprint-0.5-task-0.2` priority=P0
- [ ] Self-actionable (operator is @soju): time-boxed to 1 day

#### Task 0.3: Better Auth POC scaffold → **[G-4]** **[G-5]**
**Source**: PRD DEC-OPEN-1, RSK-7; SDD §4.4; ANTI-13.
- [ ] Scaffold Better Auth instance at `world-sprawl/apps/freeside-dashboard/__poc__/` (NOT in production code paths)
- [ ] Configure Better Auth with SIWE provider (Base 8453, Sprawl Dashboard's chain)
- [ ] Optional: configure Better Auth with passkey provider (validates AAL2 path)
- [ ] Wire Better Auth session validation → stub `engine.resolveOrMintUser(proof, tenant_id, request_id)` call
- [ ] Wire stub call → mock gateway returning ES256-signed JWT (uses static dev key from `s2s-jwt-validator.ts` test fixtures)
- [ ] Dashboard validator round-trips JWKS → claims extracted
- [ ] Timebox: **3 days hard cap** (per DEC-OPEN-1)
- [ ] Beads: `freeside-auth-sprint-0.5-task-0.3` priority=P0

#### Task 0.4: POC done-bar evidence → **[G-4]**
**Source**: SDD §6.3 Layer-1 evidence pattern (smoke canary).
- [ ] Author `grimoires/freeside/cultivations/poc-better-auth-2026-{MM-DD}.md`
- [ ] Required fields: timebox elapsed, scaffolded paths, Solana adapter availability (PASS/FAIL), session-token bridge feasibility (PASS/FAIL), JWKS round-trip evidence (curl/jq output snippet), POC verdict (GO/NO-GO for Sprint-1 Phase 5 inclusion)
- [ ] If NO-GO: document fallback (drop credential-bridge-better-auth.ts from Phase 3; Sprawl Dashboard cutover ships with SIWE adapter only)
- [ ] Beads: `freeside-auth-sprint-0.5-task-0.4` priority=P0; depends_on=0.3

#### Task 0.5: Coordinate gate close → **[G-1]** **[G-2]** **[G-3]**
**Source**: SDD §0.4; KRANZ Coordinate act (Act 1) close.
- [ ] Append entry to `grimoires/freeside/cultivations/extract-freeside-auth-2026-04-30.runbook.md`:
  ```
  Coordinate gate close — GO/NO-GO to Mirror
  Timestamp: <ISO 8601 UTC>
  Operator: @zksoju
  Gate items:
    [✓] PRD ratified (2026-04-30)
    [✓] Substrate-of-record audit (2026-04-30)
    [✓] Sprawl Dashboard path confirmed (2026-04-30, Amendment 1)
    [✓ or ✗] @janitooor sign-off (cite Task 0.1 evidence)
    [✓ or ✗] Railway DB access (cite Task 0.2 evidence)
    [✓ or ✗] Better Auth POC (cite Task 0.4 verdict)
  Decision: GO to Sprint-1 Mirror / HALT (with reason)
  ```
- [ ] Beads: `freeside-auth-sprint-0.5-task-0.5` priority=P0; depends_on=0.1, 0.2, 0.4

### Dependencies
- @janitooor availability (RSK-9 mitigation in place)
- @soju time-boxed self-actionable
- Better Auth library state (currently published; check Solana adapter status at scaffold time)

### Risks & mitigation

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| RSK-7 (Better Auth POC fails on Solana) | Med | High | DEC-OPEN-1 fallback: ship Phase 5 with SIWE+Passkey only; Better Auth deferred to Sprint-2 |
| RSK-9 (janitooor unavailable) | Med | Med | Schema mirror is mechanical (substrate-extracted); proceed with Phase 1 extraction; flag in PR for retroactive ratification |
| Coordinate-gate-creep (operator wants to add scope) | Med | Med | KRANZ AP3: do not Mirror without Coordinate close; sprint-0.5 is the gate, not the prequel |

### Success metrics
- **Days elapsed**: ≤ 5
- **Coordinate gate**: ALL items GREEN at Sprint-0.5 close
- **POC verdict recorded**: PASS or FAIL-with-fallback (not unrecorded)
- **Sprint-1 unblocked**: Mirror M1 (Phase 1) eligible to begin

---

## §4 · Sprint-1 — Mirror + Verify + Flip + Distill

### Sprint scope: LARGE (23 tasks across 6 sub-phases)
### Sprint goal
**Ship the freeside-auth substrate end-to-end and prove Sprawl Dashboard cutover (SIWE-Turso → Better Auth + Freeside JWT) without admin-gate regression.**

### Sprint methodology acts
- **Act 2 (Mirror)** = Phase 1 Schema, Phase 2 Engine+Ports, Phase 3 Adapters, Phase 4 MCP-tools, Phase 5.1-5.2 Mirror substrate
- **Act 3 (Verify)** = Phase 5.3-5.5 (three-layer gate: smoke + parity + operator)
- **Act 4 (Flip)** = Phase 5.6-5.7 (feature flag default + 7-day soak)
- **Act 5 (Distill)** = Phase 6 (ADR-039, threat model, distillation PR)

### Deliverables (checkbox list)

#### Mirror artifacts
- [ ] `@freeside-auth/protocol@0.1.0` published with User · Credential · JwtClaims · WorldManifestAuth schemas + VERSIONING.md
- [ ] `@freeside-auth/runtime@0.1.0` published with engine + ports + 8 adapters (SIWE · Passkey · Discord-bot · Better Auth · Dynamic-legacy · jwks-validator · pg-mibera-profiles · dynamic-csv-translator + pg-canonical-user/credentials/auth-events)
- [ ] `@freeside-auth/mcp-tools@0.1.0` published with `resolve_wallet`, `link_credential`, `issue_jwt_for_world`
- [ ] Postgres canonical schema applied to loa-freeside RDS (staging first, then production)
- [ ] Dynamic CSV translated: `count(credentials WHERE linked_via LIKE 'dynamic-csv:%') == 98320` ASSERTED

#### Verify artifacts
- [ ] `grimoires/freeside/cultivations/smoke-sprawl-dashboard-{date}.md` (Layer 1; ≥5 routes; jwt_present=true; csp_violations=0)
- [ ] `grimoires/freeside/cultivations/parity-sprawl-{date}.yaml` (Layer 2; sample_size=30; parity_rate=1.00)
- [ ] Operator gate entry in runbook (Layer 3; threshold-cited; signed timestamp)

#### Flip artifacts
- [ ] PR on world-sprawl: `AUTH_BACKEND=freeside-jwt` set as default; merged
- [ ] 7-day soak observation log (no admin-gate false-negatives)

#### Distill artifacts
- [ ] ADR-039 filed at `0xHoneyJar/loa-hivemind/wiki/decisions/ADR-039-sovereign-identity-spine.md`
- [ ] Threat model at `grimoires/freeside/threat-model-freeside-auth-2026-04.md`
- [ ] Cycle retro at `grimoires/freeside/cultivations/extract-freeside-auth-2026-04-30.retro.md`
- [ ] DRAFT distillation PR opened at `0xHoneyJar/construct-freeside` (D-1 through D-7 + AP8 candidate)

### Acceptance criteria (testable)

#### Phase 1 (Schema)
- [ ] **AC-1.1**: All 4 schemas validate against TypeBox; JSON Schema export round-trips
- [ ] **AC-1.2**: `protocol/jwt-claims.schema.ts` mirrors `loa-freeside/packages/adapters/agent/jwt-service.ts:142-170` FULL substrate (per DEC-SDD-1; PRD subset documented as identity-relevant projection)
- [ ] **AC-1.3**: `protocol/VERSIONING.md` enforces enum-locked schema_version, additive-only minor bumps (NFR-5.1, 5.2, 5.3)

#### Phase 2 (Engine + Ports)
- [ ] **AC-2.1**: `engine/canonical-user.ts` `resolveOrMintUser` is idempotent under concurrent first-mint of same `(kind, external_id_lowercase, chain)` (NFR-3.2; tested with 10 concurrent inserts → 1 user_id)
- [ ] **AC-2.2**: `engine/resolve-tier.ts` preserves all 4 tiers + `hold` + `new_user` semantics from `mibera-dimensions/lib/server/resolve-wallet.ts:56-331` (Tier 3 trust-validation security check preserved)
- [ ] **AC-2.3**: Postgres DDL applied; `idx_credentials_lookup` index exists; `credentials_unique_active` constraint active

#### Phase 3 (Adapters)
- [ ] **AC-3.1**: SIWE adapter — nonce store rejects duplicate nonce within 5-min TTL (NFR-1.2)
- [ ] **AC-3.2**: Passkey adapter — counter increments post-verify; replay rejected
- [ ] **AC-3.3**: Discord-bot adapter — bot signs attestation with ES256 key; gateway verifies bot key; bot does NOT mint JWTs (NFR-1.3)
- [ ] **AC-3.4**: Better Auth adapter — Sprint-0.5 POC PASS gates inclusion; FAIL = task 3.5 deferred to Sprint-2 (per DEC-OPEN-1 fallback)
- [ ] **AC-3.5**: Dynamic adapter — read-only; ESLint `no-restricted-imports` blocks `@dynamic-labs/*` from net-new files (allowlist exception only for `runtime/adapters/credential-bridge-dynamic.ts`)
- [ ] **AC-3.6**: jwks-validator — direct extraction; preserves 1h fresh / 72h stale-if-error / 60s cooldown / single-flight dedup / unknown-kid force-refresh
- [ ] **AC-3.7**: pg-mibera-profiles — preserves all 4 query patterns from `resolve-wallet.ts:56-331`; read-only; throws on outage (preserves `hold` semantics)
- [ ] **AC-3.8**: dynamic-csv-translator — count assertion `output_credentials_count == 98320` HALTS on mismatch; idempotent re-run via `INSERT...ON CONFLICT DO NOTHING`; completes in < 5 minutes (NFR-2.3)

#### Phase 4 (MCP-tools)
- [ ] **AC-4.1**: `resolve_wallet` returns `ResolveResult` with all 6 tier values supported
- [ ] **AC-4.2**: `link_credential` is append-only (no user_id mutation; FR-1.6)
- [ ] **AC-4.3**: `issue_jwt_for_world` does NOT sign locally; HTTP-POSTs to gateway issuer endpoint (NFR-1.3)

#### Phase 5 (Sprawl Dashboard cutover)
- [ ] **AC-5.1 Mirror**: feature flag `AUTH_BACKEND` exists with values `siwe-turso` (default) and `freeside-jwt`; default unchanged at Mirror end
- [ ] **AC-5.2 Layer 1 smoke**: ≥5 representative auth-gated routes return 200 OK with `Authorization: Bearer <freeside-jwt>` and `tenant_id == 'sprawl-dashboard'` claim
- [ ] **AC-5.3 Layer 2 parity**: 30/30 ADMIN_ADDRESSES sample shows identical authorization decisions between siwe-turso and freeside-jwt backends; parity_rate = 1.00
- [ ] **AC-5.4 Layer 3 operator gate**: @zksoju records GO at threshold-cited timestamp; ADMIN_ADDRESSES allowlist preserved (FR-6.4); tenant_id binding correct (FR-3.4); no SatanElRudo-class cross-app session contamination observed (RSK-5)
- [ ] **AC-5.5 Flip**: PR merged setting `AUTH_BACKEND=freeside-jwt` as default; 30-min watch window shows 5xx ratio unchanged from baseline
- [ ] **AC-5.6 Soak**: 7-day window with zero admin-gate false-negatives in metrics dashboard
- [ ] **AC-5.E2E**: All 7 PRD goals (G-1 through G-7) validated end-to-end with cited evidence

#### Phase 6 (Distill)
- [ ] **AC-6.1**: ADR-039 supersedes ADR-003, refines ADR-038 (per SDD §10 outline); merged to `loa-hivemind`
- [ ] **AC-6.2**: Threat model covers all 11 threats from SDD §8.3
- [ ] **AC-6.3**: Cycle retro names what worked, what dragged, what to distill
- [ ] **AC-6.4**: Distillation PR draft opened at `0xHoneyJar/construct-freeside` with all 7 D-N candidates + AP8 (audit-named-paths-stale-after-rename)

### Technical tasks

---

#### Phase 1 — Schema (5 days; M1 mirror substrate)

##### Task 1.1: `protocol/user.schema.ts` (TypeBox) → **[G-1]** **[G-3]**
**Source**: SDD §2.1; PRD FR-1.1, FR-1.5; DEC-AUTO-1 (ULID).
- [ ] Author TypeBox schema per SDD §2.1 verbatim
- [ ] Export type `UserT = Static<typeof User>`
- [ ] Pin `$id: 'https://freeside.sh/schemas/user/1.0.0'`
- [ ] Add `dynamic_env_id`, `dynamic_user_id` optional fields (FR-1.5; ANTI-12 — never delete)
- [ ] Unit test: round-trip user object through schema validate
- [ ] Beads: `freeside-auth-sprint-1-task-1.1` priority=P0; epic=sprint-1-phase-1
- [ ] Files: `packages/protocol/src/user.schema.ts`

##### Task 1.2: `protocol/credential.schema.ts` → **[G-1]** **[G-3]** **[G-4]**
**Source**: SDD §2.2; PRD FR-1.4, FR-1.6, NFR-1.2, NFR-1.5.
- [ ] Define `CredentialKind` union (siwe, passkey, discord-bot, telegram-bot, better-auth, dynamic-legacy, seed-vault)
- [ ] Author `Credential` schema with append-only fields per SDD §2.2
- [ ] Include `proof_hash` for replay defense (NFR-1.2)
- [ ] Include `revoked_at`/`revoked_reason` for event-recorded revocation (NFR-1.5)
- [ ] Include legacy preservation: `dynamic_env_id`, `dynamic_credential_id`
- [ ] Beads: `freeside-auth-sprint-1-task-1.2` priority=P0
- [ ] Files: `packages/protocol/src/credential.schema.ts`

##### Task 1.3: `protocol/jwt-claims.schema.ts` (FULL substrate mirror) → **[G-2]** **[G-7]**
**Source**: SDD §2.3 + §0.1 audit finding (PRD subset of substrate); DEC-SDD-1; jwt-service.ts:142-170 substrate-of-record.
- [ ] Mirror FULL claim set from `loa-freeside/packages/adapters/agent/jwt-service.ts:142-170` (NOT PRD FR-3.1 subset)
- [ ] Required RFC 7519: `iss='arrakis'`, `aud`, `sub`, `exp`, `iat`, `jti`
- [ ] Identity-spine: `tenant_id`, `tier`, `tier_name`, `pool_id`
- [ ] Multi-wallet projection: `wallets[]` (address, chain, credential_id) — derived per-issuance from Credential[]
- [ ] Credentials summary: `credentials[]` (credential_id, kind, linked_at; NO proof artifacts)
- [ ] Substrate preservation: `nft_id`, `access_level`, `allowed_model_aliases`, `allowed_pools`, `platform`, `channel_id`, `idempotency_key`, `req_hash`, `pool_mapping_version`, `contract_version`, `delegated_by`
- [ ] Schema version: `v: number` (per Bridgebuilder F-10, mirrored from jwt-service.ts:159)
- [ ] **Substrate provenance comment** at top of file (D-1 distillation pattern)
- [ ] Test: validate against fixture JWT generated from staging gateway
- [ ] Beads: `freeside-auth-sprint-1-task-1.3` priority=P0; blocks=ratify-with-janitooor
- [ ] Files: `packages/protocol/src/jwt-claims.schema.ts`

##### Task 1.4: `protocol/world-manifest-auth.schema.ts` → **[G-5]**
**Source**: SDD §2.4; PRD FR-4.1–4.4; NFR-2.1, NFR-3.3.
- [ ] Define `JwtValidatorConfig`: issuer, audience, jwks_url, cache TTLs (1h fresh / 72h stale / 60s cooldown — mirror s2s-jwt-validator.ts), clock_tolerance_sec
- [ ] Define `SovereignIssuerConfig` (FR-4.3 — opt-in, default false)
- [ ] Define `WorldManifestAuth` with `required[]`, `accepted[]`, `jwt_validator`, optional `sovereign_issuer`, optional `break_glass_revocation_role`
- [ ] Beads: `freeside-auth-sprint-1-task-1.4` priority=P0
- [ ] Files: `packages/protocol/src/world-manifest-auth.schema.ts`

##### Task 1.5: VERSIONING.md governance + protocol publish → **[G-5]**
**Source**: SDD §2.0; PRD NFR-5.1–5.4; CLAUDE.md schema governance (imported from loa-constructs).
- [ ] Author `packages/protocol/VERSIONING.md`: enum-locked schema_version, additive-only minor bumps, major bump = new file + migration plan + stable `$id`
- [ ] Cross-reference DEC-OPEN-6 resolution (schema location stays in `freeside-auth/protocol/`)
- [ ] Build: `pnpm -F @freeside-auth/protocol build`; assert TypeScript types export cleanly
- [ ] Publish: `@freeside-auth/protocol@0.1.0` to internal npm
- [ ] Beads: `freeside-auth-sprint-1-task-1.5` priority=P0; depends_on=1.1, 1.2, 1.3, 1.4

---

#### Phase 2 — Engine + Ports (5 days; M1 cont.)

##### Task 2.1: Postgres DDL migration `001_init.sql` → **[G-1]** **[G-3]**
**Source**: SDD §2.6; DEC-AUTO-5 (loa-freeside RDS); NFR-3.2.
- [ ] Author `runtime/migrations/001_init.sql` per SDD §2.6 verbatim
- [ ] `users` table: ULID PK, `dynamic_env_id`, `dynamic_user_id` indexed
- [ ] `credentials` table: `credentials_unique_active UNIQUE NULLS NOT DISTINCT (kind, external_id_lowercase, chain, revoked_at)` constraint (NFR-3.2 idempotency)
- [ ] Indexes: `idx_credentials_lookup`, `idx_credentials_chain_lookup`
- [ ] `auth_events` audit log table (NFR-4.1; partitioned monthly per DEC-SDD-4)
- [ ] Apply to **staging** RDS first; production after Layer 3 operator gate
- [ ] Beads: `freeside-auth-sprint-1-task-2.1` priority=P0; depends_on=Task 0.1 (janitooor sign-off)
- [ ] Files: `packages/runtime/migrations/001_init.sql`

##### Task 2.2: Port interfaces → **[G-1]** **[G-3]** **[G-4]**
**Source**: SDD §3.2.
- [ ] Author `runtime/ports/index.ts` with all 7 interfaces: `IUserRepo`, `ICredentialRepo`, `IProfileLookup`, `IWalletGroupLookup`, `IJwksProvider`, `ICredentialBridge`, `IAuthEventLog`, `IIssueJwtForWorld`
- [ ] Type-only file; zero runtime deps
- [ ] Beads: `freeside-auth-sprint-1-task-2.2` priority=P0
- [ ] Files: `packages/runtime/src/ports/index.ts`

##### Task 2.3: `engine/canonical-user.ts` → **[G-1]** **[G-3]**
**Source**: SDD §3.1; PRD FR-1.1, FR-1.6, NFR-3.2, NFR-1.5.
- [ ] Implement `resolveOrMintUser` with idempotent lookup → mint → unique-violation retry semantics
- [ ] Implement `linkCredential` (append-only)
- [ ] Implement `revokeCredential` (event-recorded; row gets `revoked_at`, NOT deleted)
- [ ] Concurrency test: 10 parallel `resolveOrMintUser` calls for same `(kind, external_id, chain)` → assert 1 user_id, 1 credential row, 9 retries observed (NFR-3.2)
- [ ] Beads: `freeside-auth-sprint-1-task-2.3` priority=P0; depends_on=2.1, 2.2
- [ ] Files: `packages/runtime/src/engine/canonical-user.ts`

##### Task 2.4: `engine/resolve-tier.ts` → **[G-1]**
**Source**: SDD §3.1; extract from `mibera-dimensions/lib/server/resolve-wallet.ts:56-331`.
- [ ] Extract 4-tier algorithm: Tier 1 (dynamic_user_id), Tier 2 (additional_wallets), Tier 3 (wallet_groups with trust-validation), Tier 4 (direct), terminal `hold`/`new_user`
- [ ] **Preserve security check (resolve-wallet.ts:151-220)**: Tier 3 trust-validation — never accept group whose `dynamicUserId` mismatches caller's claim
- [ ] **Preserve outage semantics**: walletGroups raw-client throws on outage → resolvedVia='hold'
- [ ] Replace I/O with port calls (`IProfileLookup`, `IWalletGroupLookup`)
- [ ] Substrate provenance comment at top of file (D-3 distillation pattern)
- [ ] Unit tests against fixtures (1k-row CSV slice per DEC-AUTO-7)
- [ ] Beads: `freeside-auth-sprint-1-task-2.4` priority=P0; depends_on=2.2
- [ ] Files: `packages/runtime/src/engine/resolve-tier.ts`

---

#### Phase 3 — Adapters (7 days)

##### Task 3.1: `jwks-validator.ts` (direct extraction) → **[G-2]**
**Source**: SDD §4.6; FR-3.5, NFR-2.1; extract from `loa-freeside/packages/adapters/agent/s2s-jwt-validator.ts` (288 lines).
- [ ] DIRECT EXTRACTION — preserve, do not invent
- [ ] ES256-only algorithm enforcement
- [ ] `typ: 'JWT'` cross-protocol guard
- [ ] Cache discipline: 1h fresh / 72h stale-if-error / 60s refresh cooldown
- [ ] Single-flight dedup (`inflight: Promise<JwksResponse>`)
- [ ] Unknown-kid → force refresh (single attempt, respects cooldown)
- [ ] Logger interface (pino-compatible)
- [ ] Substrate provenance comment at top (D-3 distillation pattern)
- [ ] Unit tests: fresh hit, stale hit, stale-if-error path, unknown-kid force-refresh, cooldown gate, single-flight dedup
- [ ] Beads: `freeside-auth-sprint-1-task-3.1` priority=P0; blocks=Phase 5 cutover
- [ ] Files: `packages/runtime/src/adapters/jwks-validator.ts`

##### Task 3.2: `credential-bridge-siwe.ts` → **[G-4]**
**Source**: SDD §4.1; PRD FR-2.1; NFR-1.2.
- [ ] Implement `ICredentialBridge` with `kind: 'siwe'`
- [ ] Library: `siwe@3.0.0` (matches Sprawl Dashboard)
- [ ] `verifyProof`: validate EIP-191 signature, nonce, expirationTime, chainId, domain (against world manifest)
- [ ] Returns `{ external_id: address.toLowerCase(), chain: 'eip155:' + chainId, proof_hash: sha256(message+sig) }`
- [ ] Replay defense: nonce store with 5-min TTL; reject duplicate nonce
- [ ] Unit tests: valid proof, expired, wrong chain, replay rejection, malformed signature
- [ ] Beads: `freeside-auth-sprint-1-task-3.2` priority=P0
- [ ] Files: `packages/runtime/src/adapters/credential-bridge-siwe.ts`

##### Task 3.3: `credential-bridge-passkey.ts` → **[G-4]**
**Source**: SDD §4.2; PRD FR-2.2.
- [ ] Library: `@simplewebauthn/server@10.x`
- [ ] `verifyProof`: validate assertion against stored publicKey + counter; increment counter post-verify
- [ ] `external_id`: passkey credential_id (base64url); `chain`: undefined
- [ ] Beads: `freeside-auth-sprint-1-task-3.3` priority=P1
- [ ] Files: `packages/runtime/src/adapters/credential-bridge-passkey.ts`

##### Task 3.4: `credential-bridge-discord-bot.ts` → **[G-4]**
**Source**: SDD §4.3; PRD FR-2.3, NFR-1.3.
- [ ] **CRITICAL INVARIANT (NFR-1.3)**: bot signs attestation envelope; bot does NOT mint JWTs
- [ ] Bot listens to `/link-wallet` slash command; user provides SIWE proof via DM
- [ ] Bot signs attestation envelope with ES256 key
- [ ] Bot POSTs to `loa-freeside/apps/gateway` issuer endpoint
- [ ] Issuer verifies bot attestation (bot's pubkey in JWKS), verifies enclosed SIWE proof, calls `engine.resolveOrMintUser` with `linked_via: 'discord-bot:<bot_id>'`
- [ ] **Bot key rotation policy** (threat model §8.1): monthly rotation; 24h overlap window; rotation event logged to auth_events
- [ ] Beads: `freeside-auth-sprint-1-task-3.4` priority=P1; depends_on=3.2 (siwe verifier reused inside attestation)
- [ ] Files: `packages/runtime/src/adapters/credential-bridge-discord-bot.ts`

##### Task 3.5: `credential-bridge-better-auth.ts` (POC-gated) → **[G-4]**
**Source**: SDD §4.4; PRD FR-2.5, DEC-OPEN-1, RSK-7.
- [ ] **GATE**: Sprint-0.5 Task 0.4 must report POC PASS; if FAIL, this task is DEFERRED to Sprint-2 (per DEC-OPEN-1 fallback)
- [ ] Wrap Better Auth's session validation
- [ ] Extract verified credential, hand to `engine.resolveOrMintUser`
- [ ] Sprawl Dashboard is first consumer (vertical slice)
- [ ] Beads: `freeside-auth-sprint-1-task-3.5` priority=P0; depends_on=Sprint-0.5 Task 0.4 (POC verdict)

##### Task 3.6: `credential-bridge-dynamic.ts` (legacy + lint rule) → **[G-7]**
**Source**: SDD §4.5; PRD FR-2.6, ANTI-13.
- [ ] Implement `ICredentialBridge` with `kind: 'dynamic-legacy'`
- [ ] **READ-ONLY** — no live Dynamic API calls; reads canonical user table by `dynamic_user_id`
- [ ] Author ESLint rule: `no-restricted-imports` blocks `@dynamic-labs/*` from net-new code
- [ ] Allowlist exception: only `runtime/adapters/credential-bridge-dynamic.ts` may import (with comment justifying legacy bridge)
- [ ] Add to repo `eslint.config.js`; CI fails on violation
- [ ] Beads: `freeside-auth-sprint-1-task-3.6` priority=P0
- [ ] Files: `packages/runtime/src/adapters/credential-bridge-dynamic.ts`, `eslint.config.js`

##### Task 3.7: `pg-mibera-profiles.ts` (Railway read adapter) → **[G-1]**
**Source**: SDD §4.8; PRD FR-5.3.
- [ ] Implement `IProfileLookup` against `midi_profiles` Railway PG (read-only)
- [ ] Connection: `RAILWAY_MIBERA_DATABASE_URL` env var (Sprint-0.5 Task 0.2 deliverable)
- [ ] Preserve all 4 query patterns from `resolve-wallet.ts:56-331`
- [ ] Throws on connection failure (preserves `hold` semantics)
- [ ] Sprint-1 ships this adapter ONLY; pg-apdao + pg-cubquest are port stubs (Sprint-2+)
- [ ] Beads: `freeside-auth-sprint-1-task-3.7` priority=P0; depends_on=Sprint-0.5 Task 0.2 (Railway access)
- [ ] Files: `packages/runtime/src/adapters/pg-mibera-profiles.ts`

##### Task 3.8: `dynamic-csv-translator.ts` → **[G-3]**
**Source**: SDD §4.7; PRD FR-5.1, NFR-2.3.
- [ ] One-time idempotent batch
- [ ] Read `~/Downloads/export-d5e7f445-c537-4d7a-9fb0-a35afc42dc30.csv` (38 cols, 98,320 rows)
- [ ] Group rows by `user_id` (Dynamic UUID); each group → 1 canonical user + N credentials
- [ ] Branch on `verified_credential_format`: blockchain → kind=`dynamic-legacy`+chain; email → sub-tag=email; oauth → sub-tag=oauth+provider
- [ ] Idempotency: `INSERT...ON CONFLICT DO NOTHING` keyed on `(dynamic_user_id, dynamic_credential_id)`
- [ ] **HARD ASSERTION before commit**: `output_credentials_count == 98320` — mismatch → halt, log diff, no partial commit (NFR-2.3)
- [ ] Performance target: < 5 minutes (no live Dynamic API calls — substrate-of-record CSV only)
- [ ] Backup: copy CSV to encrypted S3 archive post-import (threat model §8.1)
- [ ] Beads: `freeside-auth-sprint-1-task-3.8` priority=P0; depends_on=2.1, 2.3
- [ ] Files: `packages/runtime/src/adapters/dynamic-csv-translator.ts`

##### Task 3.9: `pg-canonical-user.ts` + `pg-credentials.ts` + `pg-auth-events.ts` → **[G-1]**
**Source**: SDD §4.9.
- [ ] Implement `IUserRepo`, `ICredentialRepo`, `IAuthEventLog` against loa-freeside RDS
- [ ] Use `pg` driver + connection pool
- [ ] Concurrency test (per Task 2.3 AC-2.1): unique-violation retry path exercised
- [ ] Beads: `freeside-auth-sprint-1-task-3.9` priority=P0; depends_on=2.1, 2.2
- [ ] Files: `packages/runtime/src/adapters/pg-canonical-user.ts`, `pg-credentials.ts`, `pg-auth-events.ts`

---

#### Phase 4 — MCP-tools (3 days)

##### Task 4.1: `resolve_wallet` tool → **[G-1]**
**Source**: SDD §5.1; PRD FR-7.1.
- [ ] MCP tool wrapping `engine/resolve-tier.ts`
- [ ] Input schema: `wallet_address`, `dynamic_user_id?`, `tenant_id`
- [ ] Returns `ResolveResult` (§3.1 SDD)
- [ ] Beads: `freeside-auth-sprint-1-task-4.1` priority=P0; depends_on=2.4
- [ ] Files: `packages/mcp-tools/src/tool-resolve-wallet.ts`

##### Task 4.2: `link_credential` tool → **[G-4]**
**Source**: SDD §5.2; PRD FR-7.2.
- [ ] MCP tool wrapping `engine.linkCredential`
- [ ] Append-only; emits `credential_linked` event
- [ ] Beads: `freeside-auth-sprint-1-task-4.2` priority=P0; depends_on=2.3
- [ ] Files: `packages/mcp-tools/src/tool-link-credential.ts`

##### Task 4.3: `issue_jwt_for_world` tool → **[G-2]**
**Source**: SDD §5.3; PRD FR-7.3, NFR-1.3.
- [ ] **CRITICAL (NFR-1.3)**: this tool DOES NOT SIGN; HTTP-POSTs to gateway issuer endpoint
- [ ] Input schema: `user_id`, `tenant_id`, `request_id`
- [ ] Returns `{ jwt, expires_at, jti }`
- [ ] Implementation: HTTP POST to `loa-freeside/apps/gateway` `/identity/resolve-and-issue` (DEC-SDD-2 — gateway-side world auth deferred to @janitooor)
- [ ] Beads: `freeside-auth-sprint-1-task-4.3` priority=P0
- [ ] Files: `packages/mcp-tools/src/tool-issue-jwt-for-world.ts`

---

#### Phase 5 — Sprawl Dashboard cutover (5 days; Mirror M7 + Verify + Flip)

##### Task 5.1: Mirror M1-M6 — provision substrate → **[G-1]** **[G-3]** **[G-5]**
**Source**: SDD §6.2.
- [ ] M1: `terraform plan` for canonical schema; review; `apply` (staging first)
- [ ] M2: Publish `@freeside-auth/protocol@0.1.0` (Phase 1 close)
- [ ] M3: Publish `@freeside-auth/runtime@0.1.0` (Phase 3 close)
- [ ] M4: Publish `@freeside-auth/mcp-tools@0.1.0` (Phase 4 close)
- [ ] M5: Run `dynamic-csv-translator` against staging RDS; assert `count(credentials WHERE linked_via LIKE 'dynamic-csv:%') == 98320`
- [ ] M6: Stand up Better Auth instance (post-POC; conditional on Sprint-0.5 outcome); wire to staging issuer endpoint
- [ ] **Reversibility**: each step revertable (drop tables, bump version, tear down container)
- [ ] Beads: `freeside-auth-sprint-1-task-5.1` priority=P0; depends_on=1.5, 2.3, 3.1-3.9, 4.1-4.3

##### Task 5.2: Mirror M7 — feature flag wiring → **[G-2]** **[G-5]**
**Source**: SDD §6.2 M7; SDD §0.5 Amendment 1 (path resolved).
- [ ] In `world-sprawl/apps/freeside-dashboard/src/lib/server/auth/`: install `@freeside-auth/runtime` validator client
- [ ] Add config from `world-manifest.yaml` (per Phase 1 Task 1.4 schema)
- [ ] Implement feature flag `AUTH_BACKEND` env var with values `siwe-turso` (default) and `freeside-jwt`
- [ ] Default unchanged at Mirror end (KRANZ P4 reversibility)
- [ ] Branch in `siwe.ts`/`session.ts`/`middleware.ts` per flag value
- [ ] Beads: `freeside-auth-sprint-1-task-5.2` priority=P0; depends_on=5.1
- [ ] Files: `world-sprawl/apps/freeside-dashboard/src/lib/server/auth/{siwe,session,middleware,csrf}.ts`

##### Task 5.3: Verify Layer 1 — smoke canary → **[G-1]** **[G-2]** **[G-7]**
**Source**: SDD §6.3 Layer 1, §7.1.
- [ ] Deploy preview branch with `AUTH_BACKEND=freeside-jwt`
- [ ] Hit ≥5 representative auth-gated routes: admin dashboard, world list, env editor, secret rotation, deploy log
- [ ] Per-route assert: `200 OK`, `csp_violations: 0`, `jwt_present: true`, `Authorization: Bearer <freeside-jwt>` header, validator returns claims with `tenant_id == 'sprawl-dashboard'`
- [ ] Validator cache state observed and logged (hit / miss / stale / unknown_kid_force_refresh)
- [ ] **Author evidence file**: `grimoires/freeside/cultivations/smoke-sprawl-dashboard-{date}.md` per SDD §7.1 schema
- [ ] **Exit code**: 0 (green) or 1 (red — abort gate)
- [ ] Beads: `freeside-auth-sprint-1-task-5.3` priority=P0; depends_on=5.2; blocks=5.5

##### Task 5.4: Verify Layer 2 — parity 30/30 → **[G-1]**
**Source**: SDD §6.3 Layer 2, §7.2.
- [ ] Sample: 30 random ADMIN_ADDRESSES from current Sprawl Dashboard allowlist
- [ ] For each: mint user + issue JWT via Freeside; ALSO authorize via SIWE-Turso flow (parallel both backends respond)
- [ ] Assert: same `user_id` resolution semantically; same admin-gating decision
- [ ] **Author evidence file**: `grimoires/freeside/cultivations/parity-sprawl-{date}.yaml` per SDD §7.2 schema
- [ ] **Pass threshold: parity_rate == 1.00**. Any drift halts the gate.
- [ ] Beads: `freeside-auth-sprint-1-task-5.4` priority=P0; depends_on=5.2; blocks=5.5

##### Task 5.5: Verify Layer 3 — operator gate (HUMAN) → **[G-1]** **[G-2]**
**Source**: SDD §6.3 Layer 3, §7.3.
- [ ] Operator (@zksoju) reads §6.3 evidence: smoke green (Task 5.3) + parity 100% (Task 5.4)
- [ ] Operator confirms: ADMIN_ADDRESSES allowlist preserved (FR-6.4); tenant_id binding correct (FR-3.4); no SatanElRudo-class cross-app session contamination (RSK-5)
- [ ] **Append-only entry** in runbook with: operator handle, ISO 8601 UTC timestamp, threshold-cited (smoke + parity evidence file paths), decision GO or HALT
- [ ] **KRANZ Anti-pattern AP3**: never accept "looks fine" as Layer 3. The threshold predates the call.
- [ ] If HALT: name failed threshold; propose fix; return to Verify after fix
- [ ] Beads: `freeside-auth-sprint-1-task-5.5` priority=P0; depends_on=5.3, 5.4; blocks=5.6

##### Task 5.6: Flip F1-F2 — feature flag default → **[G-1]** **[G-2]**
**Source**: SDD §6.4 F1-F2.
- [ ] Open PR on `world-sprawl/apps/freeside-dashboard`: `AUTH_BACKEND=freeside-jwt` set as DEFAULT (flag flipped)
- [ ] Watch window: 30 min post-merge — 5xx ratio, JWT verify failures, ADMIN gate failures
- [ ] **Revert path**: flag flip back (one revert from previous state — KRANZ P4)
- [ ] Merge if metrics within baseline; revert PR if 5xx spike > 1% or any admin-gate false-negative
- [ ] Beads: `freeside-auth-sprint-1-task-5.6` priority=P0; depends_on=5.5

##### Task 5.7: Flip F3 — 7-day soak window → **[G-1]** **[G-2]**
**Source**: SDD §6.4 F3.
- [ ] 7-day soak (Sprawl Dashboard is operator-surface, low traffic but high-trust)
- [ ] Error budget: 0 admin-gate false-negatives
- [ ] Daily check-in entries in runbook (telemetry over claims)
- [ ] **Revert path retained** through F4 (decommission); F4 is the "delete the lifeboat" step — only after operator confirms soak passed
- [ ] Defer F4 (decommission SIWE-Turso path) to post-soak operator decision
- [ ] Beads: `freeside-auth-sprint-1-task-5.7` priority=P0; depends_on=5.6

##### Task 5.E2E: End-to-end goal validation → **[G-1] [G-2] [G-3] [G-4] [G-5] [G-6] [G-7]**
**Source**: 5-act methodology + PRD §3.2 DoD.
This task validates ALL 7 PRD goals end-to-end with cited evidence.
- [ ] **G-1 validation**: Issue JWT via mint flow; cite mint integration test + smoke evidence
- [ ] **G-2 validation**: JWKS verification round-trip; cite jwks-validator unit tests + smoke Layer 1 evidence
- [ ] **G-3 validation**: CSV translator count assertion; cite Mirror M5 evidence (`output_credentials_count == 98320`)
- [ ] **G-4 validation**: Three credential adapters integration tests green; cite SIWE + Passkey + Discord-bot test runs
- [ ] **G-5 validation**: World-manifest.yaml parsed by validator; tenant_id binding correct; cite Phase 5 manifest config
- [ ] **G-6 validation**: ADR-039 draft exists with supersedes/refines fields; cite Task 6.1 deliverable
- [ ] **G-7 validation**: ESLint rule blocks `@dynamic-labs/*` in net-new code; cite CI run with rule active
- [ ] Author summary at `grimoires/freeside/cultivations/e2e-validation-sprint-1-{date}.md`
- [ ] Beads: `freeside-auth-sprint-1-task-5.E2E` priority=P0; depends_on=5.5, 6.1

---

#### Phase 6 — Distill (2 days; post-soak)

##### Task 6.1: ADR-039 finalize → **[G-6]**
**Source**: SDD §10; DEC-DEL-1.
- [ ] Author full ADR-039 from outline at SDD §10
- [ ] Title: "Sovereign Identity Spine — Three-Layer Split + Per-World Heterogeneity"
- [ ] Status: Proposed → Accepted post-soak
- [ ] Supersedes: ADR-003 (Authentication Provider: Dynamic over alternatives)
- [ ] Refines: ADR-038 (Shared Auth + Siloed Profiles)
- [ ] Three decisions, four consequences (2 pro / 2 con), migration path, rejected alternatives, related (DEC-LOCKs)
- [ ] File location: `0xHoneyJar/loa-hivemind/wiki/decisions/ADR-039-sovereign-identity-spine.md`
- [ ] Beads: `freeside-auth-sprint-1-task-6.1` priority=P0

##### Task 6.2: Threat model doc → **[G-7]**
**Source**: SDD §8; PRD NFR-1.1.
- [ ] Author `grimoires/freeside/threat-model-freeside-auth-2026-04.md`
- [ ] Asset inventory (§8.1): canonical user_id, credential proof_hash, bot keys, gateway signing key, JWKS public, CSV snapshot, midi profile data
- [ ] Threat actors (§8.2): external attacker, compromised world, compromised bot key, insider with DB access, malicious external sovereign issuer
- [ ] Threat → mitigation matrix (§8.3): all 11 threats with likelihood/impact/mitigation
- [ ] Privacy posture (§8.4): cookieless + selective disclosure (DEC-OPEN-8)
- [ ] Beads: `freeside-auth-sprint-1-task-6.2` priority=P0

##### Task 6.3: Migration runbook + cycle retro → **[G-1]** **[G-6]**
**Source**: SDD §6.5; KRANZ Act 5.
- [ ] Author `grimoires/freeside/cultivations/extract-freeside-auth-2026-04-30.retro.md`:
  - What worked (substrate extractions, feature-flag reversibility, parity 100% threshold)
  - What dragged (yellow-gate items, POC outcome impact)
  - What to distill (D-1 through D-7 + AP8 candidate)
  - sha256 hash of SDD pinned (D-7 idempotency hook per SDD §9)
- [ ] Migration runbook: full Sprint-1 trail merged into operator-readable narrative for next cycle
- [ ] Beads: `freeside-auth-sprint-1-task-6.3` priority=P0

##### Task 6.4: Distillation PR to construct-freeside → **[G-6]**
**Source**: SDD §9; KRANZ Act 5.
- [ ] Open DRAFT PR on `0xHoneyJar/construct-freeside` titled "Sprint-1 freeside-auth distillation: D-1..D-7 + AP8"
- [ ] PR body checklist:
  - [ ] D-1 skill stub: `mirroring-substrate-claims` (mirror, don't invent — pattern from §2.3 jwt-claims schema)
  - [ ] D-2 skill stub: `creating-mcp-toolsurface` (thin wrappers over engine + repo)
  - [ ] D-3 skill stub: `extracting-from-substrate` (live module → sealed module; algorithm + port-replacement)
  - [ ] D-4 concept enrichment: `freeside-as-subway` per-world-heterogeneity-via-manifest
  - [ ] D-5 ADR-039 + concept page: `three-layer-auth-split` canonical pattern
  - [ ] D-6 KRANZ persona enrichment: `running-an-extraction-cutover` (sub-shape of Mirror)
  - [ ] D-7 integration-context state file at `grimoires/freeside-auth/a2a/integration-context.md`
  - [ ] **NEW: AP8 candidate** anti-pattern: `audit-named-paths-stale-after-rename` (per SDD §0.5 Amendment 1) — append to construct-freeside `anti_patterns_v0_4`
  - [ ] sha256 hash of cycle retro pinned (idempotency)
  - [ ] Cycle retro link
- [ ] Beads: `freeside-auth-sprint-1-task-6.4` priority=P0; depends_on=6.1, 6.2, 6.3

### Dependencies (cross-task graph)

| Task | Depends on |
|---|---|
| 1.5 | 1.1, 1.2, 1.3, 1.4 |
| 2.1 | 0.1 (janitooor sign-off; can proceed mechanically per RSK-9 mitigation if delayed) |
| 2.3 | 2.1, 2.2 |
| 2.4 | 2.2 |
| 3.1 | (Phase 1-2 schemas) |
| 3.4 | 3.2 (siwe verifier reused in attestation) |
| 3.5 | Sprint-0.5 Task 0.4 (POC verdict) |
| 3.7 | Sprint-0.5 Task 0.2 (Railway access) |
| 3.8 | 2.1, 2.3 |
| 3.9 | 2.1, 2.2 |
| 4.1 | 2.4 |
| 4.2 | 2.3 |
| 5.1 | 1.5, 2.3, 3.1-3.9, 4.1-4.3 |
| 5.2 | 5.1 |
| 5.3, 5.4 | 5.2 |
| 5.5 | 5.3, 5.4 |
| 5.6 | 5.5 |
| 5.7 | 5.6 |
| 5.E2E | 5.5, 6.1 |
| 6.1 | 5.7 (ADR accepted post-soak) |
| 6.4 | 6.1, 6.2, 6.3 |

### Risks & mitigation

| Risk | Likelihood | Impact | Mitigation | Trigger / threshold |
|---|---|---|---|---|
| **RSK-1** Better Auth no Solana adapter | High | Med | Defer Solana to Sprint-2+; pluggable arch (DEC-OPEN-4) | POC verdict; Sprint-0.5 Task 0.4 |
| **RSK-2** Bot attestation key management | Med | High | NFR-1.3 invariant; monthly rotation + 24h overlap; threat model §8 | Task 3.4 + Task 6.2 |
| **RSK-3** Railway DB schema heterogeneity | Med | Med | One adapter per world DB (Sprint-1 ships pg-mibera only); common port | Task 3.7 + port stubs |
| **RSK-4** CSV translation fidelity | Low | High | Hard count assertion `== 98320`; halt on mismatch | Task 3.8 AC; M5 gate |
| **RSK-5** SatanElRudo-class cross-app contamination | Low | High | aud=tenant_id binding (FR-3.4); validator enforces audience | Task 5.5 operator gate Layer 3 |
| **RSK-6** Schema location indecision | Med | Low | DEC-OPEN-6 resolved (`freeside-auth/protocol/`); revisit if hounfour materializes | Task 1.5 |
| **RSK-7** Better Auth POC fails | Med | High | Sprint-0.5 fallback; SIWE+Passkey only; defer Better Auth to Sprint-2 | Sprint-0.5 Task 0.4 |
| **RSK-8** Codex 6 structural issues residual | Low | Med | Audit-pass via /review-sprint + /audit-sprint; explicit AC-3.x acceptance | Phase 3 sprint review |
| **RSK-9** janitooor unavailable | Med | Med | Schema mirror is mechanical; proceed; ratify retroactively | Sprint-0.5 Task 0.1 + Task 1.3 PR |
| **RSK-10** Big-bang migration trap | Low | High | Path C-then-B hybrid; ONE consumer (Sprawl Dashboard); other apps stay on Dynamic | Phase 5 scope discipline |
| **RSK-NEW-1** Three-layer-gate theater (skipping a layer) | Med | High | KRANZ P3: smoke + parity + operator are ALL required; any skip = gate is theater | Tasks 5.3, 5.4, 5.5 enforced as blockers |
| **RSK-NEW-2** Substrate drift during sprint (jwt-service.ts changes upstream) | Low | Med | Substrate provenance comment in jwt-claims.schema.ts; CI nightly diff against substrate | Task 1.3 |

### Success metrics

| Metric | Target | Validation |
|---|---|---|
| Days elapsed | ≤ 27 | Sprint close timestamp |
| Coordinate gate | All GREEN before Mirror M1 | Sprint-0.5 Task 0.5 |
| Tasks completed | 23 / 23 (or 22 if Better Auth POC FAIL → Task 3.5 deferred) | beads `closed` count |
| Schema substrate fidelity | 100% (jwt-claims mirrors jwt-service.ts:142-170) | Task 1.3 AC-1.2 |
| CSV translation fidelity | `output_credentials_count == 98320` (NFR-2.3) | Task 3.8 hard assertion |
| Smoke canary green | ≥5 routes; csp_violations=0; jwt_present=true | Task 5.3 evidence file |
| Parity rate | 1.00 (30/30) | Task 5.4 evidence file |
| Operator gate | GO at threshold-cited timestamp | Task 5.5 runbook entry |
| Soak window | 7d zero admin-gate false-negatives | Task 5.7 daily check-ins |
| ADR-039 | Filed + merged | Task 6.1 |
| Distillation PR | DRAFT opened with D-1..D-7 + AP8 | Task 6.4 |
| All 7 PRD goals (G-1..G-7) E2E validated | All ✓ | Task 5.E2E |

---

## §5 · Risk register (cycle-level)

Cycle-level risks roll up from PRD §9 + SDD-surfaced. Sprint-level risks above are the per-sprint mitigation surface.

| Cycle risk | Source | Sprint mitigation surface |
|---|---|---|
| Path C-then-B hybrid migration coherence | DEC-LOCK-1 | Sprint-1 ships ONE consumer; consumer apps stay on Dynamic |
| Per-world heterogeneity primitive extension | DEC-LOCK-7, FR-4 | Sprint-1 ships world-manifest.yaml schema + Sprawl Dashboard consumer |
| Substrate-not-yet-real audit gap (resolved §0.5 Amendment 1) | SDD §0.5 | Distill into AP8 (cycle lesson) — Task 6.4 |
| Three-layer split as load-bearing invariant | DEC-LOCK-9 | Codified in ADR-039 — Task 6.1 |
| Issuer stays at loa-freeside Rust gateway | DEC-LOCK-10, NFR-1.3 | Tasks 4.3, 5.1 enforced (validator client only, no signing locally) |

---

## §6 · Validation approach (success cascade)

```
G-1..G-7 PRD goals
  ↓ each goal validated by 1+ task
Phase task ACs (AC-X.Y)
  ↓ each AC has citable evidence
Three-layer Verify gates (5.3 smoke + 5.4 parity + 5.5 operator)
  ↓ all three required (KRANZ P3)
Flip with reversibility (5.6-5.7)
  ↓ feature flag default + 7-day soak
Distill (Phase 6)
  ↓ ADR-039 + threat model + retro + distillation PR
Cycle close
```

The threshold predates the call. Telemetry is the truth-bearing surface. The runbook is the load-bearing artifact.

---

## §7 · Beads task index (to be created in initialization)

Beads epic structure (to be created via helper scripts):

```
freeside-auth-sprint-0.5-epic   — Coordinate close + POC (5 tasks)
freeside-auth-sprint-1-epic     — Mirror+Verify+Flip+Distill (23 tasks)
  ├── freeside-auth-sprint-1-phase-1-epic — Schema (5 tasks)
  ├── freeside-auth-sprint-1-phase-2-epic — Engine+Ports (4 tasks)
  ├── freeside-auth-sprint-1-phase-3-epic — Adapters (9 tasks)
  ├── freeside-auth-sprint-1-phase-4-epic — MCP-tools (3 tasks)
  ├── freeside-auth-sprint-1-phase-5-epic — Sprawl Dashboard cutover (8 tasks; includes E2E)
  └── freeside-auth-sprint-1-phase-6-epic — Distill (4 tasks)
```

Labels per task: `sprint:0.5` or `sprint:1`, `phase:1` through `phase:6`, `priority:P0`/`P1`, `goal:G-1`..`G-7`.

---

## §8 · Appendices

### Appendix A — Goal-to-task mapping (PRD M1–M7 / Sprint G-1..G-7)

| Goal | Tasks contributing |
|---|---|
| **G-1** Canonical user mint flow | 1.1, 1.2, 2.1, 2.2, 2.3, 2.4, 3.7, 3.9, 4.1, 4.2, 5.1, 5.3, 5.4, 5.5, 5.6, 5.7, 5.E2E |
| **G-2** JWKS verification round-trip | 1.3, 1.4, 3.1, 4.3, 5.2, 5.3, 5.5, 5.6, 5.7, 5.E2E |
| **G-3** Dynamic CSV translation fidelity | 0.1, 1.1, 1.2, 2.1, 3.8, 5.1, 5.E2E |
| **G-4** Three credential adapters live | 0.3, 0.4, 1.2, 3.2, 3.3, 3.4, 3.5, 4.2, 5.E2E |
| **G-5** Per-world auth manifest consumed | 0.3, 1.4, 1.5, 5.1, 5.2, 5.E2E |
| **G-6** ADR-039 drafted | 6.1, 6.3, 6.4, 5.E2E |
| **G-7** Zero `@dynamic-labs/*` paths in net-new code | 0.1, 1.3, 3.6, 5.3, 6.2, 5.E2E |

**Coverage check**: All 7 goals have ≥4 contributing tasks. No goal is orphan. Final phase has E2E task (5.E2E) covering all 7.

### Appendix B — Substrate file extraction map

| Source | Lines | Target |
|---|---|---|
| `loa-freeside/packages/adapters/agent/s2s-jwt-validator.ts` | 288 | `runtime/adapters/jwks-validator.ts` (Task 3.1) |
| `loa-freeside/packages/adapters/agent/jwt-service.ts` | 215 (claims at :142-170) | `protocol/jwt-claims.schema.ts` mirror (Task 1.3; NOT extracted — substrate-of-record stays put) |
| `mibera-dimensions/lib/server/resolve-wallet.ts` | 332 | `runtime/engine/resolve-tier.ts` (Task 2.4) |
| `~/Downloads/export-d5e7f445-c537-4d7a-9fb0-a35afc42dc30.csv` | 98,320 rows | translated to `users` + `credentials` tables (Task 3.8) |
| `freeside-ruggy/apps/bot/src/agent/freeside_auth/server.ts` | (shape only) | `mcp-tools/server.ts` (Phase 4 composition) |
| `world-sprawl/apps/freeside-dashboard/src/lib/server/auth/{siwe,session,middleware,csrf}.ts` | (extension) | feature-flag gated branches (Task 5.2) |

### Appendix C — Per-task quick reference (priorities + sprint placement)

| Task | Sprint | Phase | Priority | Goals |
|---|---|---|---|---|
| 0.1 | 0.5 | Coordinate | P0 | G-3, G-7 |
| 0.2 | 0.5 | Coordinate | P0 | G-1 |
| 0.3 | 0.5 | Coordinate | P0 | G-4, G-5 |
| 0.4 | 0.5 | Coordinate | P0 | G-4 |
| 0.5 | 0.5 | Coordinate | P0 | G-1, G-2, G-3 |
| 1.1 | 1 | 1 Schema | P0 | G-1, G-3 |
| 1.2 | 1 | 1 Schema | P0 | G-1, G-3, G-4 |
| 1.3 | 1 | 1 Schema | P0 | G-2, G-7 |
| 1.4 | 1 | 1 Schema | P0 | G-5 |
| 1.5 | 1 | 1 Schema | P0 | G-5 |
| 2.1 | 1 | 2 Engine | P0 | G-1, G-3 |
| 2.2 | 1 | 2 Engine | P0 | G-1, G-3, G-4 |
| 2.3 | 1 | 2 Engine | P0 | G-1, G-3 |
| 2.4 | 1 | 2 Engine | P0 | G-1 |
| 3.1 | 1 | 3 Adapters | P0 | G-2 |
| 3.2 | 1 | 3 Adapters | P0 | G-4 |
| 3.3 | 1 | 3 Adapters | P1 | G-4 |
| 3.4 | 1 | 3 Adapters | P1 | G-4 |
| 3.5 | 1 | 3 Adapters | P0* | G-4 |
| 3.6 | 1 | 3 Adapters | P0 | G-7 |
| 3.7 | 1 | 3 Adapters | P0 | G-1 |
| 3.8 | 1 | 3 Adapters | P0 | G-3 |
| 3.9 | 1 | 3 Adapters | P0 | G-1 |
| 4.1 | 1 | 4 MCP | P0 | G-1 |
| 4.2 | 1 | 4 MCP | P0 | G-4 |
| 4.3 | 1 | 4 MCP | P0 | G-2 |
| 5.1 | 1 | 5 Cutover | P0 | G-1, G-3, G-5 |
| 5.2 | 1 | 5 Cutover | P0 | G-2, G-5 |
| 5.3 | 1 | 5 Cutover | P0 | G-1, G-2, G-7 |
| 5.4 | 1 | 5 Cutover | P0 | G-1 |
| 5.5 | 1 | 5 Cutover | P0 | G-1, G-2 |
| 5.6 | 1 | 5 Cutover | P0 | G-1, G-2 |
| 5.7 | 1 | 5 Cutover | P0 | G-1, G-2 |
| 5.E2E | 1 | 5 Cutover | P0 | G-1..G-7 |
| 6.1 | 1 | 6 Distill | P0 | G-6 |
| 6.2 | 1 | 6 Distill | P0 | G-7 |
| 6.3 | 1 | 6 Distill | P0 | G-1, G-6 |
| 6.4 | 1 | 6 Distill | P0 | G-6 |

*Task 3.5 priority conditional on POC verdict — P0 if PASS; deferred to Sprint-2 if FAIL (per RSK-7 mitigation).

### Appendix D — Distillation candidates (D-N + AP8; for Task 6.4)

| ID | Pattern | Surface | Source act |
|---|---|---|---|
| D-1 | `mirroring-substrate-claims` | Skill stub | §2.3 jwt-claims (audit finding) |
| D-2 | `creating-mcp-toolsurface` | Skill stub | §5 MCP composition |
| D-3 | `extracting-from-substrate` | Skill stub | §3.1 resolve-tier + §4.6 jwks-validator |
| D-4 | per-world-heterogeneity-via-manifest | Concept enrichment | §1.3 + FR-4 |
| D-5 | three-layer-auth-split | ADR-039 + concept | §1.1 |
| D-6 | running-an-extraction-cutover | KRANZ persona enrichment | §6 vertical slice |
| D-7 | integration-context.md state file | State file | §0 (gap noted) |
| **AP8** | audit-named-paths-stale-after-rename | construct-freeside `anti_patterns_v0_4` append | SDD §0.5 Amendment 1 |

---

## Status

✅ **Sprint plan ready for /implement (Sprint-0.5 first; Sprint-1 after gate close).**

Carried-forward context for Phase 4 (/implement):
- Coordinate gate state (3 yellow items; Sprint-0.5 closes them)
- 28 beads tasks across 2 sprints + 6 phases
- 7 PRD goals fully mapped to tasks; E2E validation in 5.E2E
- 6 phases of Sprint-1 with explicit ACs per task
- Reversibility policy (KRANZ P4) embedded in feature flag pattern
- Three-layer Verify gate (KRANZ P3) embedded as Tasks 5.3 + 5.4 + 5.5
- Distillation hooks (D-1..D-7 + AP8) reserved for Phase 6 Task 6.4

**Pre-flight before /implement Sprint-0.5**:
1. Run `br init` if not done (DONE 2026-04-30)
2. Create beads epics + tasks via `.claude/scripts/beads/create-sprint-epic.sh` (project owner: this repo)
3. Verify ledger.json `active_cycle: freeside-auth-sprint-1`
4. Verify SDD §0.4 Coordinate gate state matches §1 in this sprint plan

**The runbook is the load-bearing artifact. The runbook is the artifact the next cutover reads.** GO/NO-GO follows the threshold; the threshold predates the call. Sprint-0.5 closes the gate; Sprint-1 runs the procedure.

---

*Authored 2026-04-30 by Claude Opus 4.7 (1M, /sprint-plan) under KRANZ persona. Phase 3 of Loa workflow. Phase 4 (/implement) next.*
*Output target: ~/Documents/GitHub/freeside-auth/grimoires/sprint.md (NOT ~/bonfire/grimoires/loa/sprint.md — that's mature-freeside-operator cycle T1-T26).*
