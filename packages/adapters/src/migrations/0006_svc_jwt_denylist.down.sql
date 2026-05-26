-- ============================================================================
-- Migration 0006_svc_jwt_denylist.down.sql — full rollback of the denylist
-- table + its partial indexes.
--
-- Defensive ordering: explicit DROP INDEX IF EXISTS before DROP TABLE
-- (matches 0001_init_spine.down.sql convention). Table-owned indexes drop
-- with their parent table; the explicit drops also clean up any hand-edited
-- DB where a partial index outlived its table.
--
-- Caveat: dropping this table is operationally destructive once the
-- denylist is populated — every active deny rule (compromised-kid,
-- leaked-jti, etc.) becomes inactive on drop. Caller MUST confirm no
-- in-force rules before running this down migration in a non-disposable
-- environment.
-- ============================================================================

BEGIN;

DROP INDEX IF EXISTS idx_svc_jwt_denylist_compound;
DROP INDEX IF EXISTS idx_svc_jwt_denylist_sub;
DROP INDEX IF EXISTS idx_svc_jwt_denylist_jti;
DROP INDEX IF EXISTS idx_svc_jwt_denylist_kid;

DROP TABLE IF EXISTS service_jwt_denylist;

COMMIT;
