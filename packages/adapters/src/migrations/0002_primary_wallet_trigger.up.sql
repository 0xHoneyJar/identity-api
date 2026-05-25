-- ============================================================================
-- Migration 0002_primary_wallet_trigger.up.sql — primary-wallet integrity (FR-R5).
--
-- Authoring source: SDD §3.2 of loa-freeside/grimoires/loa/sdd.md (the canonical
-- shape — function name, trigger name, AFTER vs BEFORE choice, OF-list, and the
-- two-UPDATE body are all from the SDD verbatim). PRD v3.0 §4.2 FR-R5:
--     "Primary-wallet: exactly one is_primary per user; setting a new primary
--      clears the prior."
--
-- Layered guarantee model (SDD §3.2 note):
--   * The partial-unique `uq_wallet_links_one_primary_per_user` in 0001 is the
--     HARD GUARANTEE — two simultaneous primaries are impossible at the storage
--     layer. A naive "INSERT another primary" attempt RAISES a uniqueness
--     violation; the trigger does NOT rescue that path.
--   * This trigger is the CONVENIENCE for the caller-orchestrated workflow:
--     when a caller flips an existing row to `is_primary=TRUE` (via UPDATE) or
--     inserts a new row with `is_primary=TRUE` *after* clearing prior primaries
--     (the FR-R5 atomic-swap idiom), the trigger
--       a) demotes any other ACTIVE primary for the same user to FALSE, and
--       b) mirrors the new primary onto users.primary_wallet (denorm pointer).
--
-- AFTER vs BEFORE: SDD prescribes AFTER. Two implications worth naming:
--   * The new row's own write happens BEFORE the trigger; the partial-unique
--     check therefore fires against a state where only this row would have
--     primary set for this user (the trigger then demotes any prior). For the
--     caller-orchestrated workflow this works as designed.
--   * For the naive single-statement "two primaries" attempt the partial-unique
--     RAISES first — the trigger never runs. That's a feature, not a bug: the
--     hard guarantee is the contract; the trigger only smooths the legitimate
--     swap path.
--
-- OF is_primary clause: scopes the UPDATE side of the trigger to writes that
-- actually touch `is_primary`. Pure verified_at / chain_ids updates do not
-- fire the trigger (avoids a write amplification each time chain_ids changes).
-- INSERT does NOT support an OF list; the trigger always evaluates for new rows
-- and short-circuits via the IF guard when is_primary is false.
--
-- Soft-unlink isolation: the IF guard requires `unlinked_at IS NULL`. An
-- inactive row claiming primary historically (its is_primary may still be TRUE
-- because primary state is preserved on soft-unlink) does NOT compete; the
-- partial-unique already excludes it (`WHERE is_primary = TRUE AND
-- unlinked_at IS NULL`), and this trigger refuses to mirror an inactive row
-- onto users.primary_wallet.
--
-- Reversible: 0002_primary_wallet_trigger.down.sql drops trigger → function.
-- ============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION sync_primary_wallet() RETURNS TRIGGER AS $$
BEGIN
    -- After a wallet_links insert/update that sets is_primary=TRUE, mirror it
    -- onto users.primary_wallet and clear any prior primary for the same user.
    IF (NEW.is_primary = TRUE AND NEW.unlinked_at IS NULL) THEN
        UPDATE wallet_links
           SET is_primary = FALSE
         WHERE user_id = NEW.user_id
           AND wallet_address <> NEW.wallet_address
           AND is_primary = TRUE
           AND unlinked_at IS NULL;
        UPDATE users
           SET primary_wallet = NEW.wallet_address, updated_at = NOW()
         WHERE user_id = NEW.user_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_sync_primary_wallet
    AFTER INSERT OR UPDATE OF is_primary ON wallet_links
    FOR EACH ROW EXECUTE FUNCTION sync_primary_wallet();

COMMIT;
