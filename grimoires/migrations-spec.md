---
title: identity-api Schema Migrations Spec
materializes: SDD §4 + D2.5-7 + D2.5-11 + D2.5-12
status: ratified-phase-0
cycle: w2.5-cluster-auth-custody-substrate
date: 2026-05-26
note: SQL DDL spec — actual migration files authored in Sprint 2 Phase A, this doc is the spec they implement against
---

# identity-api Schema Migrations Spec

> **Materializes**: `@grimoires/loa/cycles/cycle-w2.5-cluster-auth-custody-substrate/sdd.md` §4 (post-pair-mode ER shape) + `@grimoires/loa/cycles/cycle-w2.5-cluster-auth-custody-substrate/prd.md` §8 D2.5-11 (denylist) + D2.5-12 (per-request svc-JWT use model) + D2.5-7 (operator-ACL governance).

## What this is

This doc is the **SQL DDL specification** that Sprint 2 Phase A migration files (e.g., `0003_svc_jwt.up.sql`, `0004_operator_grants.up.sql`) implement against. It is **not** the migrations themselves — the migrations are written in Sprint 2 against this spec.

The spec defines four new Postgres tables plus pg_cron sweep job declarations. Convention matches the existing `0001_init_spine.up.sql` pattern: BEGIN/COMMIT-wrapped DDL, `gen_random_uuid()` for surrogate keys, `TIMESTAMPTZ NOT NULL DEFAULT NOW()` for audit timestamps, `TEXT` for free-form identifiers, `JSONB` for structured metadata, partial indexes for the active-row hot paths.

## What's NEW vs REMOVED vs prior iter design

**NEW in post-pair-mode (per D2.5-8 / -11 / -12):**

- `service_jwt_denylist` — operator-managed any-match deny rules (D2.5-11).
- `cell_api_keys` — long-lived per-cell API keys that authenticate cells to the per-request issuance endpoint (replaces the iter-2 `replay_api_keys` table; D2.5-12).
- `operator_grants` — Privy DID/wallet → (sub, aud, role) allow rules; 2-of-3-operator approval required in production (D2.5-7).
- `service_jwt_issuance.jti` is recorded **at issuance time** (not at verify time); this remains UNIQUE.

**REMOVED from prior iter design (per D2.5-12 / -13):**

- `service_jwt_replay` table — removed; replay protection is implicit via the per-request use model. Cells mint a fresh svc-JWT before every cross-cell call. The verifier does **not** query any replay structure at verify time. Replay attacks against the verify path are mechanically impossible by design — a stolen JWT is only useful within its short TTL window, and cells never retain svc-JWTs across requests.
- `replay_api_keys` table — removed; with `service_jwt_replay` gone there is no replay-write endpoint to authenticate against. The closest analogue (per-cell API-key auth) is now expressed by `cell_api_keys`, which authenticates cells to the **issuance** endpoint (`POST /v1/auth/service-jwt`), not to a replay-write endpoint.

**NOT removed but renamed-clarified:** `service_jwt_issuance` is the only persistence-affecting table from the issued-jti side. It serves both audit (90-day retention) and denylist-eligibility lookup (operators can append `{jti}` denylist rules against historical issuances).

---

## 1. `service_jwt_issuance` (audit table; 90-day retention)

Records every svc-JWT minted by `POST /v1/auth/service-jwt`. Per D2.5-12, jti is recorded **at issuance time** — the verifier does not write to this table. Supports denylist eligibility (operators query historical issuances when authoring `{jti}`-keyed deny rules).

```sql
CREATE TABLE service_jwt_issuance (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    kid                   TEXT NOT NULL,                          -- signing kid (e.g. "svc-2026Q2"); supports kid-scoped denylist rules
    jti                   TEXT NOT NULL UNIQUE,                   -- jwt id; UNIQUE prevents accidental double-issuance with same jti
    sub                   TEXT NOT NULL,                          -- calling cell name (e.g. "activities-api")
    aud                   TEXT NOT NULL,                          -- target cell name (e.g. "mint-api")
    iss                   TEXT NOT NULL,                          -- issuer (identity-api canonical URL)
    role                  TEXT NOT NULL,                          -- capability claim (e.g. "mint.invoke")
    exp_at                TIMESTAMPTZ NOT NULL,                   -- token expiry (issued_at + ttl_sec; ttl_sec ≤ 3600 per F-S1.5)
    issued_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    issuing_cell_name     TEXT NOT NULL,                          -- the cell that authenticated to issuance endpoint (= sub for self-issuance; may differ if operator-issued)
    cell_api_key_id       UUID NOT NULL REFERENCES cell_api_keys(id),  -- FK back to the cell_api_keys row used at issuance time
    metadata              JSONB NOT NULL DEFAULT '{}',            -- ip, user_agent, request_id, etc.
    CONSTRAINT chk_ttl_positive CHECK (exp_at > issued_at)
);

-- Hot path: operator queries "all jtis issued in last N hours for cell X" (denylist authoring).
CREATE INDEX idx_svc_jwt_issuance_sub_issued
    ON service_jwt_issuance (sub, issued_at DESC);

-- Hot path: kid-scoped denylist append (e.g. compromised kid rotation).
CREATE INDEX idx_svc_jwt_issuance_kid_issued
    ON service_jwt_issuance (kid, issued_at DESC);

-- Retention sweep: rows older than 90 days are eligible for deletion.
CREATE INDEX idx_svc_jwt_issuance_issued_at
    ON service_jwt_issuance (issued_at);

-- Retention policy: 90 days. After sweep, archive to immutable audit log
-- (cluster-existing pattern; see §5 pg_cron job below).
```

---

## 2. `service_jwt_denylist` (operator-managed deny rules)

Per D2.5-11, this is an **any-match** deny mechanism: a verifier match on any one of `{kid, jti, sub}` in any active rule → `DENIED_BY_RULE` 403. A rule MUST specify at least one of the three discriminators (enforced via CHECK constraint).

```sql
CREATE TABLE service_jwt_denylist (
    rule_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    kid          TEXT,                                   -- nullable; matches all jtis signed by this kid
    jti          TEXT,                                   -- nullable; matches exactly one jti
    sub          TEXT,                                   -- nullable; matches all jtis issued to this sub
    reason       TEXT NOT NULL,                          -- audit string (e.g. "kid rotation 2026-Q3 — key suspected compromised")
    denied_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    denied_by    TEXT NOT NULL,                          -- operator Privy DID (audit trail)
    CONSTRAINT chk_at_least_one_discriminator
        CHECK (kid IS NOT NULL OR jti IS NOT NULL OR sub IS NOT NULL)
);

-- Verifier hot paths: each verify() may run up to three index probes (kid, jti, sub).
-- Partial indexes (WHERE col IS NOT NULL) keep them cheap.
CREATE INDEX idx_svc_jwt_denylist_kid
    ON service_jwt_denylist (kid) WHERE kid IS NOT NULL;
CREATE INDEX idx_svc_jwt_denylist_jti
    ON service_jwt_denylist (jti) WHERE jti IS NOT NULL;
CREATE INDEX idx_svc_jwt_denylist_sub
    ON service_jwt_denylist (sub) WHERE sub IS NOT NULL;

-- Retention: **forever**. Deny rules outlive the tokens they target —
-- a compromised-kid rule must remain active for the lifetime of any
-- JWT that kid could have signed, which exceeds the 90-day audit retention.
-- Operator manually retires rules when the underlying threat is closed
-- (e.g., kid rotated, all in-flight jtis expired). No pg_cron sweep.
```

> **Cross-ref**: SDD §4.1 ER diagram replaces `SERVICE_JWT_REPLAY` + `REPLAY_API_KEYS` with this table per §0a.

---

## 3. `cell_api_keys` (per-cell issuance auth)

Per F-S1.5, cells authenticate to `POST /v1/auth/service-jwt` via a long-lived per-cell API key. The key is operator-issued at cell deploy time (raw key shown once); only the argon2id hash is stored. Rotation procedure documented in `@freeside-auth/grimoires/svc-jwt-spec.md` §7.

```sql
CREATE TABLE cell_api_keys (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    cell_name    TEXT NOT NULL UNIQUE,                    -- e.g. "mint-api", "activities-api"
    key_hash     TEXT NOT NULL,                           -- argon2id-format hash; raw key NEVER stored
    issued_by    TEXT NOT NULL,                           -- operator Privy DID
    issued_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    revoked_at   TIMESTAMPTZ                              -- NULL until revoked
);

-- One ACTIVE key per cell_name (rotation: issue new active key, then revoke old).
CREATE UNIQUE INDEX uq_cell_api_keys_active_name
    ON cell_api_keys (cell_name) WHERE revoked_at IS NULL;

-- Audit hot path: who issued which keys.
CREATE INDEX idx_cell_api_keys_issued_by
    ON cell_api_keys (issued_by, issued_at DESC);

-- Retention: forever (audit + FK target for service_jwt_issuance.cell_api_key_id).
-- Revocation is via revoked_at; rows are never physically deleted.
```

> **Note**: `key_hash` stores an argon2id-format string (e.g. `$argon2id$v=19$m=65536,t=3,p=4$...`); raw key bytes are NEVER persisted. Cells receive the raw key once at issuance time via a side-channel (operator CLI output) per F-S1.5.

---

## 4. `operator_grants` (ACL: which Privy DID may request which (sub, aud, role) tuple)

Per D2.5-7, ACL grants in production require **2-of-3 operator approval**. The `granted_by_array` column records the approver DIDs as a jsonb array; application logic enforces the 2-of-3 threshold before inserting a grant row.

```sql
CREATE TABLE operator_grants (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    grantee_did         TEXT NOT NULL,                    -- Privy DID OR wallet address of the granted operator
    sub                 TEXT NOT NULL,                    -- which "sub" claim the grantee may request (e.g. "activities-api")
    aud                 TEXT NOT NULL,                    -- which "aud" claim the grantee may request (e.g. "mint-api")
    role                TEXT NOT NULL,                    -- which capability the grantee may request (e.g. "mint.invoke")
    granted_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    granted_by_array    JSONB NOT NULL,                   -- jsonb array of ≥ 2 operator Privy DIDs (2-of-3 approval per D2.5-7)
    revoked_at          TIMESTAMPTZ,                      -- NULL until revoked
    CONSTRAINT chk_granted_by_array_min_two
        CHECK (jsonb_typeof(granted_by_array) = 'array'
               AND jsonb_array_length(granted_by_array) >= 2)
);

-- One ACTIVE grant per (grantee_did, sub, aud, role) tuple.
CREATE UNIQUE INDEX uq_operator_grants_active_tuple
    ON operator_grants (grantee_did, sub, aud, role)
    WHERE revoked_at IS NULL;

-- ACL lookup hot path: "does grantee X have grant for (sub, aud, role)?"
CREATE INDEX idx_operator_grants_grantee_lookup
    ON operator_grants (grantee_did, sub, aud, role)
    WHERE revoked_at IS NULL;

-- Audit hot path: who approved which grants.
CREATE INDEX idx_operator_grants_granted_at
    ON operator_grants (granted_at DESC);

-- Retention: forever (audit). Revocation is via revoked_at; rows are never
-- physically deleted.
```

> **2-of-3 enforcement**: the CHECK constraint enforces a minimum-size invariant on the array; the **identity of the approvers** (must be distinct, must be active operators) is enforced by application logic at insert time, not by SQL. Cross-ref `@grimoires/loa/runbooks/threat-model.md` §6 for the governance ritual.

---

## 5. pg_cron sweep jobs

Only **one** table needs a scheduled sweep: `service_jwt_issuance` (90-day audit retention). The other three tables are operator-managed (rules retire on operator action, never on a timer).

```sql
-- service_jwt_issuance: 90-day retention sweep.
-- Runs daily at 03:00 UTC; archives rows older than 90 days, then deletes.
-- The archive_audit_log() helper is a cluster-existing function (writes
-- to the immutable audit log per NF-Audit-2); its implementation is out
-- of scope for this spec. The sweep is idempotent on partial failure.
SELECT cron.schedule(
    'svc-jwt-issuance-90d-sweep',
    '0 3 * * *',
    $$
    WITH archived AS (
        SELECT archive_audit_log('service_jwt_issuance', id)
        FROM service_jwt_issuance
        WHERE issued_at < NOW() - INTERVAL '90 days'
    )
    DELETE FROM service_jwt_issuance
    WHERE issued_at < NOW() - INTERVAL '90 days';
    $$
);
```

**No sweep on `service_jwt_denylist`** — deny rules outlive the JWTs they target and remain effective indefinitely. Operator manually retires rules when the underlying threat is closed; the audit trail (rule_id + denied_at + denied_by + reason) is the load-bearing record. Retention is **forever** by design.

**No sweep on `cell_api_keys`** — operator-managed via revoked_at (soft delete). The row remains for FK integrity (`service_jwt_issuance.cell_api_key_id` references it indefinitely; historical issuances must remain auditable).

**No sweep on `operator_grants`** — operator-managed via revoked_at (soft delete). The 2-of-3-approval audit trail must remain intact for the lifetime of the cluster.

---

## REMOVED from prior iter design

The post-pair-mode architecture (§0a of the SDD) **removes** two tables that earlier iterations carried:

| Removed table | Why removed |
|---|---|
| `service_jwt_replay` | Per D2.5-12, svc-JWTs are minted **per-request** — cells issue a fresh JWT before each cross-cell call and never retain JWTs across requests. Replay attacks against the verify path are mechanically impossible: a stolen JWT is useful only within its short TTL window, and the legitimate cell will not present that same jti again (it will mint a new one). The verifier therefore does not need to query a replay store, and the table has no purpose. |
| `replay_api_keys` | This table existed solely to authenticate cells writing to the `/v1/auth/verify-jti` endpoint (the iter-2 replay-write path). With `service_jwt_replay` removed, that endpoint is also removed (per D2.5-13 collapse). The closest analogue — per-cell API-key auth for the **issuance** endpoint — is now expressed by `cell_api_keys` (§3 above). |

These removals are a structural simplification, not a backwards-compatibility break: no migrations have been authored against either table; they existed only in earlier SDD drafts. Sprint 2 Phase A authors the migrations directly against the post-pair-mode shape documented here.

---

## NOT removed but renamed-clarified

`service_jwt_issuance` is the only persistence-affecting table from the issued-jti side. Its role was clarified by D2.5-12: it records **issuance-time** facts (90-day audit retention, denylist-eligibility lookup), not **verify-time** facts. The verifier touches only `service_jwt_denylist` (read-only hot-path lookup), not `service_jwt_issuance`.

---

## Cross-references

- `@grimoires/loa/cycles/cycle-w2.5-cluster-auth-custody-substrate/sdd.md` §4 — current ER diagram (note: §0a says drop `service_jwt_replay` + `replay_api_keys`; this spec is the post-pair-mode shape).
- `@grimoires/loa/cycles/cycle-w2.5-cluster-auth-custody-substrate/sdd.md` §0a — canonical pair-mode anchor.
- `@grimoires/loa/cycles/cycle-w2.5-cluster-auth-custody-substrate/prd.md` §4 — F-S1.4 (issuance audit), F-S1.5 (issuance endpoint + cell API-key auth), F-S1.10 (jti denylist).
- `@grimoires/loa/cycles/cycle-w2.5-cluster-auth-custody-substrate/prd.md` §8 — D2.5-7, D2.5-11, D2.5-12, D2.5-13.
- `@freeside-auth/packages/adapters/src/migrations/0001_init_spine.up.sql` — existing migration pattern (timestamp, naming, comment style — match these conventions in Sprint 2).
- `@freeside-auth/grimoires/svc-jwt-spec.md` — sibling spec (D-1.1) documenting the verifier interface that reads from `service_jwt_denylist` and the issuance endpoint that writes to `service_jwt_issuance` + `cell_api_keys`.
