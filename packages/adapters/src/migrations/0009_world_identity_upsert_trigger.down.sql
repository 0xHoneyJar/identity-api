-- ============================================================================
-- Migration 0009_world_identity_upsert_trigger.down.sql — reversal of 0009 up.
--
-- Restores the recompute_world_nym() function body to the VERBATIM 0008:139-176
-- UPDATE-only form (the pre-0009 behavior). This re-introduces the row-
-- population gap (a name-write on a user with no world_identity row is again a
-- 0-row no-op) — that is the point of the reversal: it proves 0009 is what
-- fixes the gap (T1 case A4).
--
-- The trigger BINDING (trg_recompute_world_nym) is untouched throughout — only
-- the function body is swapped via CREATE OR REPLACE. The world_identity rows
-- that 0009's upsert already created are LEFT in place (the down only restores
-- behavior, it does not delete data — a destructive cleanup would be more
-- harmful than leaving correct rows that the old UPDATE path would have left
-- alone anyway).
--
-- Reversible + idempotent: re-running down (or up) round-trips the body.
-- ============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION recompute_world_nym() RETURNS TRIGGER AS $$
DECLARE
    affected_user  UUID;
    affected_world TEXT;
    winning_value  TEXT;
BEGIN
    -- COALESCE handles INSERT (NEW set), DELETE (OLD set), UPDATE (NEW set).
    affected_user  := COALESCE(NEW.user_id, OLD.user_id);
    affected_world := COALESCE(NEW.world_slug, OLD.world_slug);

    SELECT value INTO winning_value
      FROM world_identity_names
     WHERE user_id = affected_user
       AND world_slug = affected_world
       AND retired_at IS NULL
       AND is_opt_in = FALSE
     ORDER BY priority ASC, assigned_at ASC, value ASC
     LIMIT 1;

    -- Only update when a winning non-opt-in name exists. When the user has no
    -- active non-opt-in name (e.g. all retired), leave nym as-is rather than
    -- NULL it (nym is NOT NULL in 0001; the resolver's privacy floor means a
    -- user always has at least the generated handle in practice).
    IF winning_value IS NOT NULL THEN
        UPDATE world_identity
           SET nym = winning_value
         WHERE user_id = affected_user
           AND world_slug = affected_world
           AND nym IS DISTINCT FROM winning_value;
    END IF;

    RETURN NULL; -- AFTER trigger: return value ignored.
END;
$$ LANGUAGE plpgsql;

COMMIT;
