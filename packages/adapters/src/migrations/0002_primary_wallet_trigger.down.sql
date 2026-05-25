-- ============================================================================
-- Migration 0002_primary_wallet_trigger.down.sql — full reversal of 0002 up.
--
-- Reverse-order drop: trigger first (it depends on the function), then the
-- function. `IF EXISTS` makes the down idempotent — replaying it (or running
-- it from a partial state, e.g. a failed up) is safe.
--
-- After this runs, the underlying spine (0001) is untouched. The
-- `uq_wallet_links_one_primary_per_user` partial unique remains in place;
-- the HARD GUARANTEE for FR-R5 ("exactly one is_primary per user among
-- active rows") survives rollback of the convenience trigger. Callers must
-- then manage the `users.primary_wallet` denormalization themselves until
-- 0002 is re-applied (or accept that the pointer drifts).
-- ============================================================================

BEGIN;

DROP TRIGGER IF EXISTS trg_sync_primary_wallet ON wallet_links;
DROP FUNCTION IF EXISTS sync_primary_wallet();

COMMIT;
