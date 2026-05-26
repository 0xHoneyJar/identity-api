-- ============================================================================
-- Migration 0003_operator_grants.down.sql — rollback of the operator_grants
-- ACL table and its helper functions.
--
-- Drop order: child indexes → table → helper functions. Indexes are table-
-- owned and would cascade with the table, but they are dropped explicitly
-- for parity with 0001_init_spine.down.sql (post-restore-artifact cleanup).
--
-- The two helper functions (jsonb_string_array_unique, jsonb_array_all_strings)
-- were created in 0003 .up; they are dropped here because nothing else in the
-- spine references them. If a future migration depends on either function,
-- it should re-CREATE OR REPLACE the function in its own .up so the down
-- migration here remains safe to run.
--
-- NOTE: pgcrypto is left installed (same rationale as 0001_init_spine.down).
-- ============================================================================

BEGIN;

-- ── indexes (defensive; table-owned but explicit for clarity) ───────────────
DROP INDEX IF EXISTS idx_operator_grants_grantee;
DROP INDEX IF EXISTS idx_operator_grants_lookup;

-- ── table ───────────────────────────────────────────────────────────────────
DROP TABLE IF EXISTS operator_grants;

-- ── helper functions (created by 0003 .up; safe to drop once table is gone) ─
DROP FUNCTION IF EXISTS jsonb_string_array_unique(jsonb);
DROP FUNCTION IF EXISTS jsonb_array_all_strings(jsonb);

COMMIT;
