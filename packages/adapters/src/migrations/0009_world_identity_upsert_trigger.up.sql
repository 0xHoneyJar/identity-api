-- ============================================================================
-- Migration 0009_world_identity_upsert_trigger.up.sql
--
-- Fix the world_identity row-population gap (identity-api #11 Phase 1,
-- sprint-bug-1). The 0008 `recompute_world_nym()` trigger body does a bare
-- `UPDATE world_identity` — a 0-row no-op when no world_identity row exists yet
-- for the (user, world). Wallet-only ingress (`linkWalletOnly`) writes ONLY
-- `world_identity_names` rows and NEVER a `world_identity` row (the discord
-- path's `claimNymWithAudit` direct-INSERT is the only thing that created one,
-- and wallet-only never calls it). Result: 187 wallet-only users had name rows
-- but no denorm `world_identity.nym`, so the honey-road navbar rendered raw
-- addresses (the 0008 header comment wrongly assumed the engine creates the
-- row alongside the name rows — it does not).
--
-- The fix is at the TRIGGER (all-callers), not per-caller: change the body
-- from a bare `UPDATE` to an UPSERT so the FIRST `world_identity_names` write
-- self-heals the missing `world_identity` row. The trigger BINDING
-- (0008:174-176, AFTER INSERT OR UPDATE OR DELETE … trg_recompute_world_nym)
-- is UNCHANGED — only the function body is replaced via CREATE OR REPLACE.
--
-- Why trigger-only (not an engine-explicit INSERT): the engine would have to
-- INSERT a placeholder `world_identity` row BEFORE it knows the winning nym,
-- but `nym` is NOT NULL (0001:90). The winning value is only known AFTER the
-- name rows exist and the resolver query runs — which is exactly what this
-- trigger already computes. The upsert inside the existing
-- `IF winning_value IS NOT NULL` guard honors the NOT NULL constraint.
--
-- Idempotent on the 187 hand-patched prod rows: the operator INSERTed those
-- using the resolver's exact winning value, so `EXCLUDED.nym` equals the
-- existing `nym` and the `WHERE world_identity.nym IS DISTINCT FROM EXCLUDED.nym`
-- guard makes the upsert a no-op (no needless tuple rewrite). The ON CONFLICT
-- target is the PK `(user_id, world_slug)` (0001:96), so a coexisting
-- claimNym direct-INSERT on the same (user, world) re-points the nym via
-- DO UPDATE rather than raising a duplicate-key error.
--
-- Reversible: 0009.down restores the verbatim 0008:139-176 UPDATE-only body.
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

    -- Only upsert when a winning non-opt-in name exists. The IF guard honors
    -- nym NOT NULL (0001:90) — we never INSERT a NULL nym. When the user has no
    -- active non-opt-in name (e.g. all retired), leave any existing nym as-is
    -- rather than NULL it.
    IF winning_value IS NOT NULL THEN
        -- UPSERT (was a bare UPDATE in 0008 — the 0-row no-op that left
        -- wallet-only users without a world_identity row). INSERT the row if it
        -- doesn't exist; otherwise re-point nym to the winner. The IS DISTINCT
        -- guard preserves the no-op-skip semantics of the old UPDATE so an
        -- unchanged winner does not churn the tuple.
        INSERT INTO world_identity (user_id, world_slug, nym)
        VALUES (affected_user, affected_world, winning_value)
        ON CONFLICT (user_id, world_slug)
        DO UPDATE SET nym = EXCLUDED.nym
        WHERE world_identity.nym IS DISTINCT FROM EXCLUDED.nym;
    END IF;

    RETURN NULL; -- AFTER trigger: return value ignored.
END;
$$ LANGUAGE plpgsql;

COMMIT;
