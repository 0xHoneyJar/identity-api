-- ============================================================================
-- Migration 0005_svc_jwt_issuance.down.sql — full rollback of T-2.2.
--
-- Reverse order: (1) unschedule the pg_cron job if installed, (2) drop
-- indexes (defensively — table-owned indexes drop with the table, but
-- the explicit DROP INDEX IF EXISTS handles post-restore artifacts where
-- the table is missing but a stray index remains), (3) drop the table.
--
-- Idempotent: every statement is guarded with IF EXISTS so a partial
-- down (e.g., crashed mid-rollback) can be re-run cleanly.
--
-- NOTE: pgcrypto is left installed — it is shared with the spine (0001)
-- and other cluster tools; dropping it here would be destructive beyond
-- this migration's scope. Same convention as 0001_init_spine.down.sql.
-- ============================================================================

BEGIN;

-- ── unschedule the pg_cron sweep job (conditional, idempotent) ───────────────
-- Mirror the up-side conditional: only attempt cron.unschedule() when the
-- extension is actually loaded. cron.unschedule() raises on a missing job,
-- so we further guard via the cron.job catalog lookup (no exception path).
DO $svcjwtsweepdown$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
        IF EXISTS (
            SELECT 1
              FROM cron.job
             WHERE jobname = 'svc_jwt_issuance_90d_sweep'
        ) THEN
            PERFORM cron.unschedule('svc_jwt_issuance_90d_sweep');
        END IF;
    END IF;
END
$svcjwtsweepdown$;

-- ── child indexes (defensive — table-owned, but explicit for clarity) ────────
DROP INDEX IF EXISTS idx_svc_jwt_issuance_cell_api_key;
DROP INDEX IF EXISTS idx_svc_jwt_issuance_expires;
DROP INDEX IF EXISTS idx_svc_jwt_issuance_kid_issued;
DROP INDEX IF EXISTS idx_svc_jwt_issuance_sub_issued;

-- ── table ────────────────────────────────────────────────────────────────────
DROP TABLE IF EXISTS service_jwt_issuance;

COMMIT;
