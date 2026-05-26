-- ============================================================================
-- Migration 0005_svc_jwt_issuance.up.sql — svc-JWT issuance audit + denylist
-- eligibility table.
--
-- Materializes D-1.5 §1 of grimoires/migrations-spec.md (commit ce0bb8a).
-- Records every svc-JWT minted by `POST /v1/auth/service-jwt` per the
-- D2.5-12 per-request issuance model: jti is recorded at ISSUANCE time
-- (not at verify time); the verifier touches only `service_jwt_denylist`
-- (a separate, sibling-migration table). 90-day audit retention; supports
-- denylist eligibility lookup (operators query historical issuances when
-- authoring {jti}-keyed deny rules).
--
-- FK forward reference: `cell_api_key_id REFERENCES cell_api_keys(id)`. The
-- `cell_api_keys` table is created in a SIBLING migration authored under
-- T-2.4 (bead arrakis-cpmh) which lands separately. The migration runner
-- (packages/adapters/src/migrate.ts) applies files in LEXICAL order, so as
-- long as the sibling migration's version stem sorts BEFORE `0004_…`, the
-- FK target table will already exist at COMMIT time of this migration.
-- The pre-assigned numbering scheme for sibling W2.5 sprint-2 migrations
-- (per the caller's coord ticket on arrakis-cpmj) places `cell_api_keys`
-- at a stem that sorts strictly before this file. If the runner attempts
-- to apply this migration in isolation against a clean DB without first
-- applying the sibling, the REFERENCES clause will fail at COMMIT — this
-- is intentional fail-fast behavior and is the documented runbook (see
-- the W2.5 sprint-2 cross-migration ordering note in this file's commit).
--
-- Convention reference: 0001_init_spine.up.sql.
-- ============================================================================

BEGIN;

-- pgcrypto provides gen_random_uuid(); 0001_init_spine already installed it
-- but we re-assert defensively (CREATE EXTENSION IF NOT EXISTS is idempotent
-- and harmless when the extension is already present).
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ── service_jwt_issuance: 90-day audit retention + denylist-eligibility ──────
-- The verifier does NOT write to this table; the issuance endpoint does.
-- Per D2.5-12, replay protection is implicit in the per-request use model
-- (cells mint a fresh jti before every cross-cell call), so no replay
-- structure is queried at verify time. This table exists solely for audit
-- + operator denylist-rule authoring (e.g., "show me jtis issued in the
-- last N hours for sub=activities-api so I can pick which to deny").
CREATE TABLE service_jwt_issuance (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    kid                   TEXT NOT NULL,                          -- signing kid (e.g. "svc-2026Q2"); supports kid-scoped denylist rules
    jti                   TEXT NOT NULL UNIQUE,                   -- jwt id; UNIQUE prevents accidental double-issuance with same jti
    sub                   TEXT NOT NULL,                          -- calling cell name (e.g. "activities-api")
    aud                   TEXT NOT NULL,                          -- target cell name (e.g. "mint-api")
    iss                   TEXT NOT NULL,                          -- issuer (identity-api canonical URL)
    role                  TEXT NOT NULL,                          -- capability claim (e.g. "mint.invoke"); denormalized from JWT for audit + kid-scoped denylist filtering (per D-1.5 §1)
    exp_at                TIMESTAMPTZ NOT NULL,                   -- token expiry (issued_at + ttl_sec; ttl_sec ≤ 3600 per F-S1.5)
    issued_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    issuing_cell_name     TEXT NOT NULL,                          -- the cell that authenticated to issuance endpoint (= sub for self-issuance; may differ if operator-issued)
    cell_api_key_id       UUID NOT NULL REFERENCES cell_api_keys(id),  -- FK back to sibling-migration table (T-2.4)
    metadata              JSONB NOT NULL DEFAULT '{}',            -- ip, user_agent, request_id, etc.
    CONSTRAINT chk_ttl_positive CHECK (exp_at > issued_at)
);

-- Hot path: operator queries "all jtis issued in last N hours for cell X"
-- (denylist authoring), and 90-day retention sweep scans by sub-then-time.
CREATE INDEX idx_svc_jwt_issuance_sub_issued
    ON service_jwt_issuance (sub, issued_at DESC);

-- Hot path: kid-scoped denylist authoring + key-rotation forensics
-- ("show me everything issued under kid svc-2026-Q2 between dates"). Per D-1.5 §1.
CREATE INDEX idx_svc_jwt_issuance_kid_issued
    ON service_jwt_issuance (kid, issued_at DESC);

-- Hot path: retention sweep scans by exp_at to identify expired tokens
-- (operationally distinct from issued_at-based retention; an expired jti
-- can still appear in a denylist query before retention sweep runs).
CREATE INDEX idx_svc_jwt_issuance_expires
    ON service_jwt_issuance (exp_at);

-- FK-join hot path: "show all issuances against this cell_api_key_id"
-- (key rotation audit, compromised-key forensics).
CREATE INDEX idx_svc_jwt_issuance_cell_api_key
    ON service_jwt_issuance (cell_api_key_id);

-- ── 90-day retention sweep (pg_cron, conditional) ────────────────────────────
-- Per D-1.5 §5: only `service_jwt_issuance` needs a scheduled sweep (the
-- sibling-migration tables — service_jwt_denylist, cell_api_keys,
-- operator_grants — are operator-managed and retain forever).
--
-- Why conditional: pg_cron is a Postgres extension that is not present in
-- every environment (e.g., local dev containers, test DBs). In environments
-- without pg_cron, the sweep is the responsibility of an app-side cron job
-- (tracked on arrakis-1gqz; the choice between pg_cron and app-side is
-- per-deployment). This DO-block creates the job ONLY when the extension
-- is actually loaded; absence is silent, not an error.
--
-- The cluster-existing `archive_audit_log()` helper (D-1.5 §5) is NOT yet
-- materialized; this sweep currently DELETEs without archiving. When the
-- archive helper lands, this job should be updated to wrap the DELETE in
-- a CTE that calls archive_audit_log() first (per the spec example). For
-- this migration, the simpler DELETE keeps the operational behavior
-- predictable and the migration self-contained.
DO $svcjwtsweep$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
        PERFORM cron.schedule(
            'svc_jwt_issuance_90d_sweep',
            '0 3 * * *',
            $sweep$
                DELETE FROM service_jwt_issuance
                 WHERE issued_at < NOW() - INTERVAL '90 days'
            $sweep$
        );
    END IF;
END
$svcjwtsweep$;

COMMIT;
