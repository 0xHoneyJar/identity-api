-- ============================================================================
-- Migration 0008_world_name_model.down.sql — full reversal of 0008 up.
--
-- Reverse-order teardown:
--   1. trigger (depends on the function) → function
--   2. world_identity_names (FK child) → world_name_types (FK parent)
--
-- The old `UNIQUE (world_slug, nym)` on world_identity was KEPT by 0008.up
-- (see the up migration's divergence-with-rationale), so there is nothing to
-- restore — it was never dropped. `nym` data on world_identity is UNTOUCHED
-- throughout (the registry was a pure additive layer).
--
-- The seeded `worlds('mibera')` row is LEFT in place — 0001 left
-- worlds-seeding to deploy, and removing a world a live consumer may reference
-- would be more destructive than leaving the idempotent seed. `IF EXISTS`
-- makes every drop idempotent (safe to replay from a partial state).
-- ============================================================================

BEGIN;

DROP TRIGGER IF EXISTS trg_recompute_world_nym ON world_identity_names;
DROP FUNCTION IF EXISTS recompute_world_nym();

DROP TABLE IF EXISTS world_identity_names;
DROP TABLE IF EXISTS world_name_types;

COMMIT;
