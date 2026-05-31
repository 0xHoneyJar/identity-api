-- ============================================================================
-- Migration 0007_world_managers.up.sql — the CM→world authorization relation
-- (C-2, bead arrakis-491i).
--
-- This is the SoR for "who manages which world." A "community manager" (CM)
-- is a `users` row that has been granted edit authority over one or more
-- `worlds`. freeside-config (C-1) reads this relation to authorize a CM's
-- theme-write path: management is an IDENTITY fact, so it lives in the spine
-- (this building), NOT in the config layer.
--
-- Distinct from `operator_grants` (migration 0004): that table is the
-- high-trust Privy-DID → svc-JWT issuance ACL (2-of-3-operator approval for
-- production cell-issuance). `world_managers` is a low-ceremony per-(user,
-- world) edit-authority relation — a different bounded concern. Do NOT
-- conflate the two.
--
-- FK-safe ordering: both parents (`users`, `worlds`) ship in migration 0001,
-- so this child table can reference them directly. Both FKs ON DELETE
-- CASCADE: deleting a user or retiring a world removes the dangling
-- management edge automatically (a manager grant has no meaning once either
-- endpoint is gone).
--
-- Keying rationale (`world_slug` → `worlds(world_slug)`): mirrors
-- `world_identity` (migration 0001) exactly — that table also keys per-world
-- state on `world_slug REFERENCES worlds(world_slug)`. `worlds.world_slug` is
-- the PRIMARY KEY of `worlds` and the canonical per-world anchor the rest of
-- the spine references; `world_identity` is the established precedent.
--
-- GRANT-ISSUANCE (who may ADD a manager) is intentionally OUT OF SCOPE here.
-- This migration ships the relation + its read path only. `granted_by` is a
-- free-text audit column (a Privy DID, operator handle, or "bootstrap"); the
-- authorization gate on *issuing* a grant is a follow-up (it can reuse the
-- `operator_grants` 2-of-3 machinery or a dedicated admin endpoint — see the
-- C-2 handoff). v1 seeds manager rows out-of-band (deploy / backfill).
-- ============================================================================

BEGIN;

-- ── world_managers: (user, world) edit-authority edge ────────────────────────
CREATE TABLE world_managers (
    user_id     UUID NOT NULL REFERENCES users(user_id)      ON DELETE CASCADE,
    world_slug  TEXT NOT NULL REFERENCES worlds(world_slug)  ON DELETE CASCADE,
    granted_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- Free-text provenance of the grant (Privy DID / operator handle /
    -- "bootstrap" / "backfill"). NOT an FK — the granter may be an operator
    -- identity that has no `users` row, and the audit value must survive any
    -- later deletion of the granter. Nullable for backfilled rows whose
    -- provenance is unknown.
    granted_by  TEXT,
    PRIMARY KEY (user_id, world_slug)   -- one management edge per (user, world)
);

COMMENT ON TABLE world_managers IS
    'CM→world authorization relation (C-2). The SoR for "who manages which '
    'world" — freeside-config reads this to gate a community-manager theme '
    'write. Distinct from operator_grants (the svc-JWT issuance ACL). '
    'Grant-issuance (who may add a manager) is a follow-up, not encoded here.';

COMMENT ON COLUMN world_managers.granted_by IS
    'Free-text provenance of the grant (Privy DID / operator handle / '
    '"bootstrap" / "backfill"). NOT an FK; nullable for backfilled rows.';

-- Hot path: "what worlds does user X manage?" (GET /v1/users/:id/managed-worlds).
-- The PK already provides a (user_id, world_slug) prefix index that covers
-- the user_id-leading lookup, so no extra index on user_id is needed.

-- Reverse hot path: "who manages world Y?" — not covered by the PK prefix
-- (world_slug is the trailing PK column). A future admin "list managers of a
-- world" surface will want this; we ship it now so that read is index-served.
CREATE INDEX idx_world_managers_world ON world_managers(world_slug);

COMMIT;
