-- ============================================================================
-- Migration 0001_init_spine.down.sql — full rollback of the spine.
--
-- Reverse FK order: leaves child tables before parents are dropped, so a
-- mid-down failure can be inspected without orphan rows. Indexes drop with
-- their tables (CASCADE-on-drop is implicit for table-owned indexes); we
-- also DROP INDEX IF EXISTS the partial-unique indexes explicitly so that
-- a hand-edited DB without a table for them (post-restore artifacts) still
-- cleans up.
--
-- NOTE: pgcrypto is left installed. It's a Postgres-cluster-level extension
-- shared with other tools (e.g. score-api on the same Railway project), so
-- dropping it here would be destructive beyond identity-api's scope.
-- ============================================================================

BEGIN;

-- ── child indexes (defensive — table-owned, but explicit for clarity) ────────
DROP INDEX IF EXISTS idx_auth_nonces_expires;
DROP INDEX IF EXISTS idx_audit_events_type_time;
DROP INDEX IF EXISTS idx_audit_events_user;
DROP INDEX IF EXISTS idx_world_identity_user;
DROP INDEX IF EXISTS idx_linked_accounts_user;
DROP INDEX IF EXISTS idx_wallet_links_user;
DROP INDEX IF EXISTS uq_wallet_links_one_primary_per_user;
DROP INDEX IF EXISTS uq_wallet_links_active_address;

-- ── tables in reverse FK order ───────────────────────────────────────────────
DROP TABLE IF EXISTS auth_nonces;
DROP TABLE IF EXISTS audit_events;
DROP TABLE IF EXISTS world_identity;     -- child of worlds + users
DROP TABLE IF EXISTS worlds;             -- parent (after world_identity)
DROP TABLE IF EXISTS linked_accounts;    -- child of users
DROP TABLE IF EXISTS wallet_links;       -- child of users
DROP TABLE IF EXISTS users;              -- root parent

COMMIT;
