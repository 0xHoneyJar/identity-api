# ACCEPT-IDENTITY — Owner acceptance

| Field | Value |
|---|---|
| Task | `ACCEPT-IDENTITY` (collection-report-coordinator-f09.58) |
| Repository | `0xHoneyJar/identity-api` |
| Branch | `coord/collection-report-coordinator-f09.58` |
| Audited baseline | `origin/main` @ `ab74bf16b4fac8c57f14e6d7d89e237d588255bd` (`Merge pull request #46 from 0xHoneyJar/feat/qmd-coverage-extension`, 2026-06-30) |
| Masters | coordinator `prd.md` / `sdd.md` / `sprint.md` (2026-07-15 candidates; PRD v0.3 / SDD v0.5 / Sprint v0.6) |
| Date | 2026-07-16 |
| Author role | identity-api maintainer (boundary owner; KRANZ dispatch) |
| **Verdict** | **conditional** |

This document is owner acceptance under sprint §13. It does **not** authorize
CR implementation, issue creation, push, PR, or merge. It is **not** human
privacy/security approval, Discord-policy Go (CR-000), or production readiness.

---

## 1. Verdict

**conditional** — Identity accepts ownership of the collection-report boundary
assigned in the task-manifest (`ACCEPT-IDENTITY`, `CR-008`, `CR-011B`,
`CR-017`) and acknowledges the SDD contracts it must eventually satisfy. On
`origin/main` today the building is a **wallet / linked-account / world-nym
resolution spine with soft-unlink columns and append-only `audit_events`**, not
the restricted `identity_link_snapshot.v1` + purpose-consent + trust-stream
system required for Gate Leak.

| Lane | Status | Meaning |
|---|---|---|
| Canonical spine (users, wallets, Discord/Telegram/dynamic links, world names, JWT) | acknowledged | May continue under normal Loa gates; not Gate Leak restricted release |
| Soft-unlink + audit trail (schema / resolve filters) | acknowledged seed | Useful invalidation *seed*; not CR-008 tombstone stream or consumer watermarks |
| CR-008 `identity_link_snapshot.v1` | **blocked for issue-ready** | No community-scoped snapshot, MVCC token, subject-set digest, or 500-page cohort contract on main |
| CR-017 `community_gate_audit` purpose consent / re-consent / withdrawal | **blocked for issue-ready** | No purpose-grant table, policy version, or Dashboard consent contract; ordinary wallet/Discord link must not be reused |
| CR-011B restricted trust-stream producer | **blocked upstream / conditional locally** | Accept producer ownership once CR-009 envelope + CR-000 Go exist; main has no transactional outbox / epoch-sequence stream |
| Privacy / anti-enumeration for Gate Leak | **blocked** | Display-name privacy floor and svc-JWT auth non-discrimination exist; Gate Leak disclosure bands, opaque erasure handles, and mapping anti-enumeration do **not** |
| Human privacy / Discord-policy approval | **unresolved — not invented** | CR-000 signed Go and CR-015 privacy owner work remain external; this artifact does not fabricate them |

Unestimated restricted snapshot / trust-stream / consent capacity remains
**not issue-ready** per sprint §6 (“unestimated is blocked”).

---

## 2. Exact interfaces (produce / consume)

### 2.1 Present on `origin/main` (acknowledged)

| Interface | Location | Version / notes |
|---|---|---|
| Spine DDL | `packages/adapters/src/migrations/0001_init_spine.up.sql` (+ 0002–0009) | `users`, `wallet_links` (`unlinked_at`), `linked_accounts` (`unlinked_at`, providers `discord`/`telegram`/`dynamic_user_id`), `world_identity` / names, `audit_events`, `auth_nonces`, cell keys, svc-JWT denylist, world managers |
| Resolve / identity read APIs | `src/api/routes/resolve.ts`, `me.ts`, `profile.ts` | Wallet / account / nym → `user_id`; full spine identity with `unlinked_at` on wallets and linked accounts |
| Batch merge facade | `POST /v1/identity/resolve` · `packages/protocol/src/api/identity-resolve.ts` | ≤100 wallets; JWT-gated; Discord surface `{ id, linked }` only; **wallet-keyed**, not Discord-subject cohort snapshot |
| Link / auth write paths | `link.ts`, `auth.ts`, `discord-link.ts`, engine `link-*` / `resolve-spine.ts` | Mint user, link wallet/account, primary change; audits `wallet_linked`, `account_linked`, `primary_changed`, `conflict_rejected`, … |
| Soft-unlink **columns** | `wallet_links.unlinked_at`, `linked_accounts.unlinked_at` | Active resolve filters exclude unlinked wallets; `resolveByAccount` intentionally does **not** filter unlinked (callers must check) |
| Soft-unlink **writes** | backfill revert scripts + tests only | Adapter comment: *“v1: soft-unlink is wired in the table but not yet exposed by any write path”* — no user-facing unlink/revocation API on main |
| Append-only audit | `audit_events` via `SpinePort.appendAudit` | Local Postgres trail; **not** a signed monotonic outbox stream |
| svc-JWT + denylist | `src/api/routes/v1/auth/service-jwt.ts`, `denylist/check.ts` | Cell-key auth; uniform 401 to avoid key-enumeration; denylist check for consumers |
| Display privacy floor | world name model / `resolveDisplayName` | Generated MIBERA handle default; raw address never default (`is_opt_in`) |
| BeaconV3 | `packages/protocol/beacon.yaml` | SoR resolve + compose; `is_not` refuses chain indexing, third-party Dynamic auth path, storing bios/holdings |
| CODEOWNERS | `.github/CODEOWNERS` | `* @zkSoju` |

These surfaces are **precedent and substrate**, not aliases for
`identity_link_snapshot.v1`, purpose consent, or CR-009 trust streams.

### 2.2 Required by collection-report masters — **absent on main**

| Interface | Owner expectation (SDD / CR-008 / CR-011B / CR-017) | Main evidence |
|---|---|---|
| `identity_link_snapshot.v1` | Community-scoped, authorized Discord→wallet projection; consent/source/capture/policy/digest provenance; cohort = pinned mapped-role subjects; cap 50,000; pages ≤500; subject-set + page digests; shared Identity MVCC token + tombstone watermark | **None** (no matches for `identity_link_snapshot`, MVCC watermark, subject_set_digest) |
| Purpose grant `community_gate_audit` | Versioned purpose, community scope, source, time, policy version, withdrawal, audit evidence; explicit re-consent; never inferred from wallet link | **None** (no purpose / consent grant schema or routes) |
| Tombstone trust stream | Monotonic versioned outbox for unlink, consent withdrawal, subject deletion; gap-free consumer watermark ≤60s; signed epoch baseline | **None** (no transactional outbox / stream_epoch / sequence allocation) |
| Restricted trust envelopes (CR-011B) | CR-009 Ed25519 envelopes; atomic sequence + outbox; clock skew ≤30s; retention/repair SLO; failover | **None** as producer (svc-JWT ≠ trust-stream) |
| Opaque erasure handles | Identity-issued handles for deletion saga / Key Index participants | **None** |
| Consent-coverage bands (operator-facing) | Non-identifying bands only; no enumerate/target of non-consenting members | **None** in this repo (Dashboard consumes; Identity must emit metrics without subject IDs) |
| Gate Leak anti-enumeration ledger participation | Mapping churn / low-overlap probe limits bind privacy review | **Not owned here**; Identity must fail closed on unauthorized snapshot acquisition |

Identity will **consume** ratified shared-protocol schemas from `loa-freeside`
(CR-007B, CR-009) and will not hand-mirror Ordering or Shadow Audit types.

Wire Identity commits to produce once CRs land (acknowledged, not implemented):

- Restricted snapshot acquisition/response for Shadow Audit / Ordering under
  service auth + community authorization lease watermarks.
- Per-subject results: linked / unlinked / revoked / deleted /
  `consent_unavailable` → eligibility stays `indeterminate` at the producer;
  omission is a protocol error.
- Purpose grant / withdrawal / current-authority projection for Dashboard
  CR-017 journeys.
- Signed authorization + tombstone streams with `(stream_id, stream_epoch,
  sequence)` per CR-011B.

---

## 3. Authority boundaries and forbidden inference

### 3.1 Identity owns

- Canonical user spine: wallet links, linked accounts, world identities/names,
  audit events for link/auth outcomes.
- Future: `identity_link_snapshot.v1` projection, MVCC + tombstone watermark
  authority for that projection (CR-008).
- Future: versioned `community_gate_audit` grant, re-consent, and withdrawal
  contract (CR-017); never bundled into generic wallet linking or report submit.
- Future: restricted trust-stream producer for authorization / tombstones
  (CR-011B), after CR-009 ratification.
- Opaque erasure-handle issuance for deletion participants (with Storage /
  Ordering saga) when CR-014/CR-015 matrix names Identity fields.
- Consent-funnel and definitive-coverage **metrics by community-size band
  without subject identifiers** (joint with Dashboard).

### 3.2 Identity does **not** own / must not infer

| Forbidden | Authority |
|---|---|
| Discord role membership, Gateway capture, `discord_role_snapshot.v1` | Shadow Audit |
| Gate mapping ratify/revoke, `gate-config:ratify`, mapping anti-enumeration limits | Shadow Audit + privacy owner |
| Report order lifecycle, disclosure ledger, artifact CAS, work keys | Ordering |
| Collection recognition, ownership index, Kitchen ingest | Sonar / Inventory |
| Key Index custody, restore quarantine, manifest receipts | Storage + platform KMS (CR-013/014) |
| Inferring `community_gate_audit` from Discord OAuth, wallet link, session, community membership, or prior Gate Leak use | Forbidden — explicit purpose grant only |
| Guessing wallets for unlinked / non-consenting / deleted role members | Forbidden — explicit `indeterminate` / `consent_unavailable` only |
| Treating missing authority as `proven_ineligible` | Forbidden — coverage gap, not a leak |
| Inferring eligible holders missing Discord roles (inverse Gate Leak) | Out of V1 claim |
| Cross-community snapshot reuse or copying the identity spine into Ordering / Shadow Audit | Forbidden — community-scoped restricted evidence only |
| Discord Developer Terms / privileged-intent policy determination | Discord application owner + privacy/security (CR-000) — **not asserted here** |
| Human privacy approval of Gate Leak data use | Freeside privacy/security owner — **not invented by this document** |

Beacon `is_not` on main (no chain indexing, no Dynamic live auth path, no
bios/holdings in spine) is retained and does not substitute for Gate Leak
privacy gates.

---

## 4. Bottom-up estimate (capacity / headcount)

Assumptions: one primary maintainer familiar with this repo; CR-000 Go; shared
CR-007B / CR-009 fixtures land from loa-freeside; Shadow Audit supplies
subject-set digests; Dashboard owns consent UX against Identity’s authority
API; no concurrent full-spine migration fire drill.

| Work | Size | Headcount · calendar | Uncertainty |
|---|---|---|---|
| ACCEPT-IDENTITY (this artifact) | S | 0.5 eng-day | Low |
| CR-008 snapshot capability + MVCC + cohort paging + fixtures | L / Critical | 1 eng · **3–5 weeks** after CR-000 + CR-007B | **High** — no snapshot/outbox code today; soft-unlink API gap |
| CR-017 purpose grant / withdrawal / re-consent API + metrics | M–L / Critical | 1 eng · **2–3 weeks** (API); Dashboard journey parallel | Medium — product copy + a11y owned elsewhere |
| CR-011B restricted trust-stream adoption | L / Critical | 1 eng · **2–4 weeks** after CR-009 + CR-008/016/017 deps | **High** — new outbox/epoch/clock health surface |
| User-facing unlink / consent-withdrawal write paths (prerequisite hygiene) | M | 0.5–1 eng · **1–2 weeks** | Medium — schema exists; product semantics not shipped |
| Load proof: 50k subjects / 500-page / watermark SLO | M | 0.5 eng · ~1 week fixtures + soak | High until representative guild data (CR-018) |
| Ongoing ops (stream gaps, consent incidents, safe disable) | steady | 0.15–0.3 FTE after G1B-3 | High until first game day |

**Capacity statement for current main:** hermetic `bun test` / typecheck
substrate; batch resolve capped at 100 wallets. **No** 50,000-subject snapshot
SLO, 60s tombstone propagation proof, or trust-stream repair SLO exists.

**Issue-ready rule:** CR-008 / CR-011B / CR-017 remain blocked until this
estimate is re-bound to named CR-000 Go, CR-009 fixture IDs, and privacy-owner
field matrix (CR-015) participation rows for Identity-held columns.

---

## 5. Mixed-version / flags / deploy / rollback

### 5.1 Acknowledged from SDD §16.6 / §17

Identity is a named cell in the mixed-version matrix:

- New Ordering with an **old** Identity API that cannot issue MVCC /
  Gateway-bound snapshots, authorization watermarks, opaque erasure handles, or
  signed epochs **refuses restricted admission** before order creation.
- Expand → deploy → constrain; rollback allowed until all readers support the
  constrained schema.
- Restricted flags (`collection_report_restricted_enabled`,
  `collection_report_restricted_rows_enabled`) are **server-evaluated** in
  Ordering/Dashboard — Identity must fail closed when purpose policy /
  trust-stream contracts are missing, not invent client-side enablement.

### 5.2 What main actually provides today

| Mechanism | Behavior | Fits restricted Gate Leak? |
|---|---|---|
| SQL migrations `up`/`down` | Schema rollback for spine / JWT tables | Spine only |
| Soft-unlink columns | Data invalidation seed | Not a signed tombstone stream |
| svc-JWT denylist / cell key revoke | Auth revocation for cells | Not subject-link tombstones |
| `AUTH_BACKEND` / collection-report flags | **Not present** for Gate Leak in this repo | N/A |
| JWKS / cycle rollback runbooks | Operator key/substrate rollback | Unrelated to link-snapshot invalidation |

### 5.3 Rollback limits (accepted)

- **Spine / public identity APIs:** migrate-down or deploy prior revision; do
  not delete `audit_events` to “undo” links; soft-unlink (once shipped) is the
  forward invalidation path.
- **Restricted snapshot / trust-stream (future):** disable restricted producers
  and refuse snapshot acquisition; never resume an old stream epoch or reuse
  sequences after disaster recovery; gap or stale watermark fails closed with
  `identity_invalidation_stale` (SDD), not skip-ahead.
- **Purpose consent:** withdrawal invalidates snapshots and enters disposal;
  code rollback must not silently re-grant `community_gate_audit`.
- **In-flight Gate Leak orders:** Identity rollback must preserve tombstone
  history already emitted; Ordering/Shadow Audit reconcile gaps rather than
  Identity rewriting history.

Deploy position: Identity restricted writers deploy **after** CR-000 Go,
CR-007B retention/deletion policy, and CR-009 envelope fixtures; **with**
Shadow Audit subject-set producer contracts; never ahead of Ordering tombstone
inbox consumers for CR-011B.

---

## 6. Operational ownership

| Concern | Owner | Current state on main |
|---|---|---|
| Spine availability, migrations, JWKS rotation | identity-api maintainer (`@zkSoju` CODEOWNERS) | Runbooks exist for JWKS / audit-keys; no Gate Leak runbook |
| Link / unlink / consent-withdrawal incidents | identity-api (future) + Dashboard UX | Unlink API **missing**; consent **missing** |
| Trust-stream gap repair, epoch baseline reset, clock skew | identity-api producer + Ordering consumer | **Missing** |
| Snapshot acquisition authz / least-privilege service access | identity-api + Ordering leases | Cell/svc-JWT precedent only |
| Safe disablement of restricted snapshot + purpose APIs | Platform flag + Identity fail-closed | **Missing** Identity switch |
| Deletion / erasure-handle incidents | Identity + Storage + Ordering saga + privacy owner | **Missing** |
| Consent-coverage / funnel metrics (non-identifying) | Identity + Dashboard | **Missing** |
| Discord policy renewal / CR-000 standing check | Discord application owner + privacy/security | **External — not claimed** |
| Alerts for spine 5xx / DB | Existing Railway/world ops (not codified for collection-report) | No collection-report on-call doc |

Identity accepts future ownership of snapshot / consent / tombstone-stream ops
**only after** CR-008/011B/017 land with a written runbook (detect → disable
restricted acquisition → reconcile watermarks → resume). Until then, ops
ownership for Gate Leak identity evidence is **unassigned in this repository**.

---

## 7. Current evidence (audit of `origin/main` @ `ab74bf1`)

Commands and observations used for this acceptance (worktree branch
`coord/collection-report-coordinator-f09.58`, aligned with `origin/main`):

1. **Baseline:** `git rev-parse origin/main` →
   `ab74bf16b4fac8c57f14e6d7d89e237d588255bd` (matches sprint §2 identity-api
   baseline).
2. **Absent Gate Leak surfaces:** ripgrep over packages/src/docs/grimoires
   (excluding vendored `.claude` trees) for `identity_link_snapshot`,
   `community_gate_audit`, `purpose_consent`, `trust_envelope`,
   `transactional_outbox`, `tombstone_stream`, `anti_enumeration`,
   `restore_quarantine` → **no substantive hits**.
3. **Spine present:** migrations 0001–0009; soft-unlink columns; `audit_events`;
   resolve + identity-resolve + Discord link + SIWE auth; beacon SoR charter.
4. **Unlink/revocation gap:** `unlinked_at = NOW()` only in backfill-revert
   scripts and adapter tests; `postgres-spine-adapter.resolveByAccount` documents
   no account-unlink write path; no `wallet_unlinked` / `account_unlinked`
   emission on a product API path found.
5. **Privacy seeds vs Gate Leak:** display-name privacy floor and denylist
   uniform 401 exist; SDD row allowlist / disclosure bands / opaque erasure
   handles are **not** implemented here.
6. **Trust-stream:** svc-JWT issuance/denylist ≠ CR-009 ordered evidence
   stream; no outbox sequence allocation.
7. **Coordinator mapping:** task-manifest assigns Identity `ACCEPT-IDENTITY`,
   `CR-008`, `CR-011B`, `CR-017`; sprint §12 names identity-api maintainer for
   those CRs with Dashboard, Ordering, Shadow Audit, and privacy owner as
   counterparts.
8. **Masters cross-check:** SDD §14.5 (Identity must expose snapshot, preserve
   invalidation, refuse cross-community copy, own purpose grant); SDD §16.6
   mixed-version refusal when Identity cannot issue MVCC/watermarks/handles;
   sprint G4B / G1B-3 depend on CR-008/016/017 — Identity alone cannot close
   them.

---

## 8. Unresolved closure conditions

ACCEPT-IDENTITY stays **conditional** (and CR-008 / CR-011B / CR-017 stay
non-issue-ready) until each item below is closed or explicitly waived by the
coordinator with the named external owners:

1. **CR-000 Discord / privacy Go** — signed by Discord application owner and
   privacy/security owner; this acceptance does **not** invent that approval.
   No-go drops restricted Identity CRs from the critical path without failing
   public T0/T1.
2. **CR-007B** retention/deletion policy names Identity as deletion participant
   and purpose-policy contract owner.
3. **CR-009** trust-envelope fixtures published; Identity producer shape frozen.
4. **CR-008 design spike** in-repo (or linked ADR): snapshot schema, MVCC
   token, subject-set/page digests, unlink API + tombstone outbox, 50k/500
   fixtures — then **re-estimate** headcount.
5. **CR-017** purpose-grant schema + Dashboard-focused consent/re-consent/
   withdrawal journeys; no silent migration grant for existing linked users.
6. **CR-016** Shadow Audit subject-set digest / mapped-role cohort producer
   contract Identity consumes (Identity does not invent the cohort).
7. **CR-011B** clock-skew monitoring, epoch baseline authority, retention and
   repair SLO commitments co-signed with Ordering.
8. **CR-015** disclosure/deletion matrix lists every Identity-held Gate Leak
   field; opaque erasure-handle semantics agreed with Storage.
9. **CR-018** (feasibility) — if capture/link-churn envelope fails, revise
   architecture before raising Identity thresholds by configuration alone.
10. **Mixed-version fixtures** (old Identity + new Ordering restricted
    admission refusal) attached to G1B-3 / G1B-5.
11. **Ops runbook** for consent withdrawal during compute, tombstone gap,
    safe disablement of restricted snapshot APIs — merged before restricted
    writers deploy.
12. **Human privacy approval** for production identity rows / purpose — still
    **absent**; must come from the privacy/security owner, not from this file.

Public spine work (resolve, link, JWT, world names) is **not** blocked by these
conditions, but must not be marketed as satisfying G1B-3 / G4B / CR-008.

---

## 9. Lightweight validation (this dispatch)

Performed on branch `coord/collection-report-coordinator-f09.58` after
`bun install --frozen-lockfile`:

- `bun run typecheck` (`tsc --noEmit` via package script) — pass.
- Structural check: this file exists at
  `grimoires/loa/coordination/collection-report/owner-acceptance.md` with
  verdict ∈ {accepted, conditional, blocked} and required sections
  (interfaces, authority/forbidden inference, bottom-up estimate, mixed-version /
  flags / rollback, ops ownership, evidence, closure conditions).
- Absence audit commands recorded in §7 (no CR implementation).

No CR code was implemented. No commit, push, PR, or merge.

---

## 10. Strongest caveat

**`origin/main` has no `identity_link_snapshot.v1`, no `community_gate_audit`
purpose consent, and no signed tombstone trust-stream** — soft-unlink columns
and `audit_events` are not a substitute; Gate Leak restricted identity work
cannot be honestly scheduled as issue-ready until CR-000 privacy/Discord Go
exists (not invented here) and the snapshot/consent/outbox surfaces are designed
and estimated.
