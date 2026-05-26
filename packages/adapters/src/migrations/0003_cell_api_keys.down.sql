-- ============================================================================
-- Migration 0003_cell_api_keys.down.sql — full reversal of 0003 up.
--
-- Reverse-order drop: indexes first (defensive — DROP TABLE cascades to its
-- indexes, but explicit drop is idempotent and parallels the up's structure).
-- `IF EXISTS` makes the down idempotent; replaying it (or running it from a
-- partial-up state) is safe.
--
-- IMPORTANT: This rollback will FAIL if any downstream migration has already
-- created a FK pointing at cell_api_keys.id (e.g. T-2.2 service_jwt_issuance
-- at migration 0005). The FK must be dropped first. The expected rollback
-- order in that case:
--   0005_svc_jwt_issuance.down.sql  → drops the FK
--   0004_svc_jwt_denylist.down.sql  → independent
--   0003_cell_api_keys.down.sql     → THIS file
-- Running this file standalone while 0005 is still applied will error with
-- `cannot drop table cell_api_keys because other objects depend on it`.
-- This is correct behavior; the migration runner should refuse partial down-
-- migrations that would leave dangling FKs.
-- ============================================================================

BEGIN;

DROP INDEX IF EXISTS idx_cell_api_keys_revoked;
DROP INDEX IF EXISTS idx_cell_api_keys_active_cell;
DROP TABLE IF EXISTS cell_api_keys;

COMMIT;
