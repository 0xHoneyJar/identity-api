-- ============================================================================
-- Migration 0008_world_name_model.up.sql — the world NAME REGISTRY (Sprint A,
-- identity-api #11 Phase 1).
--
-- Authoring source: grimoires/loa/specs/enhance-wallet-only-name-model.md §A1
-- (grounded 2026-06-02). The spine becomes the SOLE generator/owner of world
-- display-names; the MIBERA-XXXX scheme HOISTS out of honey-road into the
-- spine. The flat `world_identity.nym TEXT` (0001) was a single denormalized
-- name with `UNIQUE (world_slug, nym)` — no type, priority, opt-in, or
-- soft-delete. This migration adds a typed, prioritized, soft-retireable
-- REGISTRY (a new world = INSERT rows, zero code change) WITHOUT dropping the
-- denormalized `nym` pointer (SpineWorldIdentity + merge-identity.ts:57 keep
-- working unchanged).
--
-- Design decisions (spec §A1 + operator ratification 2026-06-02):
--   * REGISTRY, not a 3-tier enum. world_name_types is the per-world scheme
--     registry; world_identity_names holds the per-user typed rows.
--   * KEEP world_identity.nym as a denormalized default-display pointer. A
--     BEFORE/AFTER trigger recomputes it from the resolver-equivalent SQL
--     (lowest-priority ACTIVE NON-OPT-IN name), mirroring 0002's
--     sync_primary_wallet. This is what makes nym a pure cache of the
--     registry — the resolver (A4) and this trigger MUST agree.
--   * MOVE uniqueness: the old single-column UNIQUE (world_slug, nym) is
--     REPLACED by a partial unique on (world_slug, name_type, value) WHERE
--     retired_at IS NULL. Multiple name rows per (user, world) make the old
--     constraint incompatible; the PK (user_id, world_slug) on world_identity
--     still guards "one denorm nym row per user/world" so claimNymWithAudit
--     (resolve-spine.ts:247, a direct world_identity INSERT) keeps working
--     (R-3).
--   * NO mibera_id column — the value is a `generated` NAME ROW, not a column.
--
-- Privacy-by-default (the load-bearing invariant): the recompute trigger
-- selects only `is_opt_in = FALSE` rows, so the raw short address
-- (raw_short_addr, is_opt_in = TRUE) is STRUCTURALLY UNREACHABLE as the
-- default `nym`. The generated MIBERA-XXXX handle is the floor.
--
-- Reversible: 0008_world_name_model.down.sql drops the trigger + function +
-- both tables and RESTORES the old UNIQUE (world_slug, nym); `nym` data is
-- untouched.
-- ============================================================================

BEGIN;

-- mibera must exist in `worlds` before we can FK + seed its name types. 0001
-- is structural-only (worlds seeded at deploy); seed idempotently here so the
-- migration is self-sufficient on a fresh DB and a no-op on a seeded one.
INSERT INTO worlds (world_slug, display_name)
VALUES ('mibera', 'Mibera')
ON CONFLICT (world_slug) DO NOTHING;

-- ── world_name_types: per-world scheme registry ─────────────────────────────
-- One row per (world, name_type). generator_kind classifies how a value of
-- this type is produced:
--   * generated_scheme — minted by the spine (claimGeneratedName) to `pattern`
--   * derived          — computed from other data (e.g. shortened address)
--   * authored         — user/operator supplied (e.g. a claimed nym)
-- default_priority: LOWER = preferred (resolver picks the lowest). is_opt_in:
-- a type that must be EXPLICITLY requested to surface (privacy floor).
CREATE TABLE world_name_types (
    world_slug        TEXT NOT NULL REFERENCES worlds(world_slug) ON DELETE CASCADE,
    name_type         TEXT NOT NULL,
    generator_kind    TEXT NOT NULL CHECK (generator_kind IN ('generated_scheme', 'derived', 'authored')),
    pattern           TEXT,                     -- regex the generated value must match (generated_scheme only)
    default_priority  INT  NOT NULL,            -- lower = preferred
    is_opt_in         BOOLEAN NOT NULL DEFAULT FALSE,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (world_slug, name_type)
);

-- ── world_identity_names: per-user typed name rows ──────────────────────────
-- Multiple rows per (user, world) — one per name the user holds in that world.
-- Soft-retire via retired_at (mirrors wallet_links.unlinked_at). priority +
-- is_opt_in are denormalized from world_name_types at assignment time so the
-- resolver reads one table on the hot path; the type's defaults seed them.
CREATE TABLE world_identity_names (
    user_id      UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    world_slug   TEXT NOT NULL,
    name_type    TEXT NOT NULL,
    value        TEXT NOT NULL,
    priority     INT  NOT NULL,
    is_opt_in    BOOLEAN NOT NULL DEFAULT FALSE,
    assigned_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    retired_at   TIMESTAMPTZ,                   -- NULL = active; set = soft-retired
    FOREIGN KEY (world_slug, name_type) REFERENCES world_name_types(world_slug, name_type) ON DELETE CASCADE
);

-- Hot-path read: all active names for a (user, world), priority-ordered.
CREATE INDEX idx_world_identity_names_user_world
    ON world_identity_names (user_id, world_slug);

-- Uniqueness MOVED here from world_identity. A value is unique within a
-- (world, name_type) among ACTIVE rows only — retiring frees it for re-use.
CREATE UNIQUE INDEX uq_world_identity_names_active_value
    ON world_identity_names (world_slug, name_type, value)
    WHERE retired_at IS NULL;

-- ── world_identity.nym uniqueness: KEPT (divergence-with-rationale) ──────────
-- The spec §A1 proposed REPLACING the old `UNIQUE (world_slug, nym)` with the
-- registry partial-unique, calling the old one "incompatible with multi-name."
-- It is NOT incompatible: the multi-name rows live in world_identity_names;
-- world_identity still holds EXACTLY ONE denormalized nym per (user, world)
-- via its PK (user_id, world_slug). The live route
-- `GET /v1/resolve/nym/:worldSlug/:nym` (src/api/routes/resolve.ts:163) does a
-- LIMIT-1 lookup that DEPENDS on world-nym uniqueness — dropping the
-- constraint would let two users share a denorm nym and make resolveByNym
-- return an arbitrary owner (a real correctness regression).
--
-- Keeping `UNIQUE (world_slug, nym)` is non-conflicting AND strictly safer:
--   * The registry partial-unique already guarantees no two users hold the
--     same ACTIVE (world, name_type, value), so two users CANNOT recompute to
--     the same nym for the same type. Cross-type collision (A's claimed_nym
--     vs B's generated handle) is impossible because generated values match
--     `^MIBERA-[A-F0-9]{6}$` and claimed nyms don't.
--   * It preserves claimNymWithAudit's world-nym collision semantics (R-3:
--     "the relaxed UNIQUE must NOT break claimNymWithAudit") unchanged.
--
-- So we DO NOT drop it. The registry partial-unique is ADDITIVE (per-type
-- uniqueness in the new table), not a replacement. This is the spec's intent
-- ("Keep nym + PK") read at the level of preserving the live contract.

-- ── recompute trigger: world_identity.nym = lowest-priority active non-opt-in ─
-- Keeps the denormalized `nym` pointer in sync with the registry. Fires AFTER
-- any change to world_identity_names. The SELECT is the SQL twin of the A4
-- resolveDisplayName({ includeOptIn: false }) resolver: ACTIVE
-- (retired_at IS NULL) AND NON-OPT-IN (is_opt_in = FALSE), lowest priority
-- wins (ties broken by assigned_at then value for determinism). Opt-in rows
-- (raw_short_addr) can NEVER become the default nym — the privacy floor.
--
-- AFTER (not BEFORE): the recompute reads the COMMITTED-within-statement set
-- of world_identity_names rows (including NEW/excluding OLD), so it must run
-- after the row change is visible. It UPDATEs a DIFFERENT table
-- (world_identity), so there is no NEW-row mutation concern that would
-- require BEFORE.
--
-- If no world_identity row exists yet for the (user, world), the UPDATE is a
-- 0-row no-op — the engine (A3 linkWalletOnly) creates the world_identity row
-- alongside the name rows; order within the txn does not matter because the
-- final state is consistent (the last name-row write recomputes correctly).
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

CREATE TRIGGER trg_recompute_world_nym
    AFTER INSERT OR UPDATE OR DELETE ON world_identity_names
    FOR EACH ROW EXECUTE FUNCTION recompute_world_nym();

-- ── seed mibera's name types ────────────────────────────────────────────────
-- claimed_nym  (authored,          priority 10, not opt-in) — user-chosen handle
-- generated    (generated_scheme,  priority 50, not opt-in) — MIBERA-XXXX floor
-- raw_short_addr (derived,         priority 90, OPT-IN)      — never the default
INSERT INTO world_name_types (world_slug, name_type, generator_kind, pattern, default_priority, is_opt_in)
VALUES
    ('mibera', 'claimed_nym',    'authored',         NULL,                  10, FALSE),
    ('mibera', 'generated',      'generated_scheme', '^MIBERA-[A-F0-9]{6}$', 50, FALSE),
    ('mibera', 'raw_short_addr', 'derived',          NULL,                  90, TRUE);

COMMIT;
