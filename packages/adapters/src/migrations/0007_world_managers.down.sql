-- ============================================================================
-- Migration 0007_world_managers.down.sql — full rollback of the world_managers
-- relation + its reverse-lookup index.
--
-- Defensive ordering: explicit DROP INDEX IF EXISTS before DROP TABLE
-- (matches 0001_init_spine.down.sql + 0006_svc_jwt_denylist.down.sql
-- convention). Table-owned indexes drop with their parent table; the explicit
-- drop also cleans up any hand-edited DB where the index outlived its table.
--
-- Caveat: dropping this table is operationally destructive once populated —
-- every CM→world authorization edge is lost on drop, which de-authorizes all
-- community-manager theme writes that depended on it. Caller MUST confirm no
-- live grants are in force before running this down migration in a
-- non-disposable environment.
-- ============================================================================

BEGIN;

DROP INDEX IF EXISTS idx_world_managers_world;

DROP TABLE IF EXISTS world_managers;

COMMIT;
