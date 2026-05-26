-- ============================================================================
-- Migration 0003_cell_api_keys.up.sql — per-cell API key auth for svc-JWT issuance.
--
-- NUMBERING NOTE: The T-2.4 task brief pre-assigned migration number 0002 to
-- this table. The 0002 slot was already occupied by 0002_primary_wallet_trigger
-- (T1.3, bead arrakis-ca51, landed on main pre-W2.5). Renumbered to 0003 to
-- avoid collision; the ordering invariant from the task brief ("cell_api_keys
-- must come BEFORE service_jwt_issuance because service_jwt_issuance.cell_api_key_id
-- FKs cell_api_keys.id") remains satisfied — T-2.2 (service_jwt_issuance) is
-- scheduled at 0005 (was 0004 in the brief; shifts by 1).
--
-- Authoring source: D-1.5 (grimoires/migrations-spec.md §3, ratified 2026-05-26
-- in ce0bb8a) + SDD §4.4 of loa-freeside/grimoires/loa/cycles/cycle-w2.5-cluster-
-- auth-custody-substrate/sdd.md + flatline IMP-008 (argon2id parameter pinning).
--
-- Materializes the per-request issuance model (D2.5-12):
--   Each cell holds a long-lived API key, operator-issued at cell deploy time
--   (raw key shown once via operator-CLI side channel; only the argon2id hash
--   is stored). Cells authenticate every call to POST /v1/auth/service-jwt
--   with X-Cell-Api-Key + X-Cell-Name; identity-api hashes the presented key
--   via argon2id (with PINNED parameters per IMP-008) and compares against
--   `cell_api_keys.key_hash` filtered by `cell_name` AND `revoked_at IS NULL`.
--
-- IMP-008 parameter pinning (flatline blocker — closure here):
--   The argon2id m/t/p parameters MUST be pinned at hash-creation time in the
--   application config (TypeScript constants — single source of truth across
--   issuance + verify paths). They are NOT stored per-row, which would allow
--   silent parameter drift between writes and reads. The schema-side defense
--   is the CHECK constraint `chk_cell_api_keys_argon2id` which enforces the
--   `$argon2id$v=19$` format prefix — any hash that doesn't start with that
--   prefix is rejected at INSERT time. The argon2id v=19 string format
--   embeds the m/t/p values it was produced with, so verifiers can re-parse
--   and CONFIRM the pinned parameters at verify time (defense-in-depth).
--
-- Rotation model:
--   Active-key partial unique index forbids two un-revoked keys for the same
--   cell_name. Rotation procedure (per svc-jwt-spec.md §7 forward-track):
--     1. Operator issues NEW key for cell X → INSERT succeeds only after
--        prior active key is revoked (otherwise UNIQUE violation).
--     2. Practical order: SET revoked_at on old → INSERT new in one txn,
--        OR a brief dual-active window must be avoided. Strict policy:
--        revoke-then-issue (no overlap window).
--     3. Old row stays for FK integrity (service_jwt_issuance.cell_api_key_id
--        references it indefinitely; audit must survive).
--
-- Reversible: 0003_cell_api_keys.down.sql drops indexes → table.
--
-- bead: arrakis-3qbk
-- coord: https://github.com/0xHoneyJar/identity-api/issues/12#arrakis-3qbk
-- sprint: w2.5/s2 (T-2.4)
-- ============================================================================

BEGIN;

CREATE TABLE cell_api_keys (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    cell_name       TEXT NOT NULL,                              -- e.g. "mint-api", "activities-api"
    key_hash        TEXT NOT NULL,                              -- argon2id $argon2id$v=19$m=...$t=...$p=...$salt$hash; raw key NEVER stored
    issued_by       TEXT NOT NULL,                              -- operator Privy DID (audit trail)
    issued_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    revoked_at      TIMESTAMPTZ,                                -- NULL until revoked
    CONSTRAINT chk_cell_api_keys_argon2id
        CHECK (key_hash LIKE '$argon2id$v=19$%'),               -- IMP-008: hash MUST be argon2id v=19 format; m/t/p pinned in app config
    -- BB F-002: cell_name slug shape — lowercase alphanumeric + hyphen, 3–63
    -- chars (matches the rest of the cluster's slug convention; rejects empty
    -- strings, leading/trailing hyphens, uppercase, dots, slashes). Aligns
    -- the audit/ACL identifier space with the existing label-safe-slug pattern
    -- used in the coord manifest + freeside-network registry.
    CONSTRAINT chk_cell_name_slug
        CHECK (cell_name ~ '^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$')
);

-- Active-key partial unique index: one active key per cell_name at any moment.
-- Rotation must explicitly revoke-then-issue (no concurrent dual-active window).
-- Historical rows (revoked_at IS NOT NULL) accumulate without unique conflict;
-- they remain for FK integrity (service_jwt_issuance.cell_api_key_id).
CREATE UNIQUE INDEX idx_cell_api_keys_active_cell
    ON cell_api_keys (cell_name) WHERE revoked_at IS NULL;

-- Lookup hot path: "list revoked keys for forensics / audit / FK joins."
CREATE INDEX idx_cell_api_keys_revoked
    ON cell_api_keys (revoked_at) WHERE revoked_at IS NOT NULL;

COMMENT ON TABLE cell_api_keys IS
    'Per-cell long-lived API keys for /v1/auth/service-jwt issuance. Argon2id-hashed (raw key never stored). Parameter pinning per flatline IMP-008: the CHECK constraint enforces argon2id v=19 hash format prefix; the argon2id m/t/p parameters MUST be pinned in the application config (constants), not stored per-row (allows parameter rotation without schema change but ensures all hashes were produced under the SAME pinned parameter set at hash time).';
COMMENT ON COLUMN cell_api_keys.cell_name IS
    'Subject of the API key (e.g. mint-api, activities-api). Resolves to operator_grants.grantee_did at issuance ACL check (forward-track arrakis-zp0a).';
COMMENT ON COLUMN cell_api_keys.key_hash IS
    'argon2id hash of the random 256-bit key; format $argon2id$v=19$m=...$t=...$p=...$salt$hash. Pin the m/t/p parameters at hash-creation time in the application; verify with the same parameters.';
COMMENT ON COLUMN cell_api_keys.issued_by IS
    'Operator Privy DID who issued the key (audit). Issuance MUST go through the operator-CLI side channel; raw key bytes exit the system exactly once.';
COMMENT ON COLUMN cell_api_keys.revoked_at IS
    'Soft delete. Row persists for FK integrity (service_jwt_issuance.cell_api_key_id references it indefinitely; historical issuances must remain auditable). Rotation procedure: revoke old before issuing new — the partial unique index forbids dual-active.';

COMMIT;
