-- ============================================================================
-- Migration 0001_init_spine.up.sql — identity-api resolution spine (the SoR).
--
-- Authoring source (SDD §3.2 of loa-freeside/grimoires/loa/sdd.md, the
-- canonical DDL for this building). Schema realizes PRD v3.0 §4.2 (the
-- 5-table spine sketch) plus the SDD's two service tables (audit_events,
-- auth_nonces). The primary-wallet integrity trigger is intentionally split
-- to migration 0002 (T1.3, bead arrakis-ca51); this 0001 ships the partial-
-- unique index `uq_wallet_links_one_primary_per_user` which is the *hard*
-- guarantee for FR-R5 (exactly one primary per user); the trigger added in
-- 0002 is the *convenience* that mirrors onto `users.primary_wallet`.
--
-- Resolution data ONLY (D2/D8 score-vs-identity boundary): the spine stores
-- no bios, no dimensions, no holdings — those federate live on read.
--
-- FK-safe ordering: parents → children. `users` and `worlds` before any
-- table that references them; `wallet_links` / `linked_accounts` /
-- `world_identity` reference `users`; `world_identity` also references
-- `worlds`. `audit_events.user_id` is intentionally a soft pointer (no FK
-- + no ON DELETE) so the audit log survives user deletion (NFR-5).
-- `auth_nonces` is pre-user (wallet-first auth) and stands alone.
-- ============================================================================

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;  -- gen_random_uuid()

-- ── users: the anchor — one human = one user_id ──────────────────────────────
CREATE TABLE users (
    user_id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    -- denormalized convenience pointer; authoritative source is
    -- wallet_links.is_primary (FR-R5). Mirrored by the trigger in 0002.
    primary_wallet  TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── wallet_links: verified wallet → user (multi-chain, primary-aware) ────────
CREATE TABLE wallet_links (
    wallet_address  TEXT NOT NULL,                  -- store canonical lowercase
    user_id         UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    chain_ids       TEXT[] NOT NULL DEFAULT '{}',   -- multi-chain (cycle-c D6)
    is_primary      BOOLEAN NOT NULL DEFAULT FALSE,
    verified_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    unlinked_at     TIMESTAMPTZ                     -- soft-unlink; NULL = active
);

-- One ACTIVE link per wallet address. Models PRD §4.2:
--   unique(wallet_address) where unlinked_at is null
-- The wallet is free to be re-linked to a different user after soft-unlink.
CREATE UNIQUE INDEX uq_wallet_links_active_address
    ON wallet_links(wallet_address)
    WHERE unlinked_at IS NULL;

-- Exactly one PRIMARY per user among ACTIVE links (FR-R5 hard guarantee).
-- The trigger added in 0002 is convenience; this index is the contract.
CREATE UNIQUE INDEX uq_wallet_links_one_primary_per_user
    ON wallet_links(user_id)
    WHERE is_primary = TRUE AND unlinked_at IS NULL;

-- Hot path for FR-R4 (getIdentity by user_id → wallets[]).
CREATE INDEX idx_wallet_links_user
    ON wallet_links(user_id)
    WHERE unlinked_at IS NULL;

-- ── linked_accounts: off-chain providers (discord / telegram / dynamic) ──────
CREATE TABLE linked_accounts (
    user_id         UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    provider        TEXT NOT NULL CHECK (provider IN ('discord','telegram','dynamic_user_id')),
    external_id     TEXT NOT NULL,
    verified_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    unlinked_at     TIMESTAMPTZ,
    PRIMARY KEY (provider, external_id)
);
-- (provider, external_id) as PK gives FR-R2 (resolveByAccount) a covering
-- lookup. dynamic_user_id is just a provider row here (D3) — no Dynamic SDK
-- is ever called in the live credential path; this is backfill / linkage.

-- Hot path for FR-R4 (getIdentity → accounts[]).
CREATE INDEX idx_linked_accounts_user ON linked_accounts(user_id);

-- ── worlds: the per-world registry anchor (SoT seam — see SDD §13 OQ-5) ──────
CREATE TABLE worlds (
    world_slug      TEXT PRIMARY KEY,               -- → freeside-worlds registry
    display_name    TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- v1 wires only THJ + mibera-world (PRD §2.2). Seeded at deploy (OQ-5 default).
-- Migration 0001 is structural only; no seed rows here.

-- ── world_identity: per-world nym (one human, different names per app) ───────
CREATE TABLE world_identity (
    user_id         UUID NOT NULL REFERENCES users(user_id)  ON DELETE CASCADE,
    world_slug      TEXT NOT NULL REFERENCES worlds(world_slug) ON DELETE CASCADE,
    nym             TEXT NOT NULL,
    joined_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, world_slug),              -- one nym per (user, world)
    UNIQUE (world_slug, nym)                        -- nym unique within world (FR-R3)
);

-- Hot path for FR-R4 (getIdentity → world_identities[]).
CREATE INDEX idx_world_identity_user ON world_identity(user_id);

-- ── audit_events: append-only link/unlink/primary/conflict trail (NFR-5) ─────
-- user_id is intentionally NULLABLE and NOT a FK: a pre-resolution conflict
-- (e.g. cross-user collision rejected) has no user yet, and the audit log
-- must survive any later user deletion. Append-only is enforced by code
-- discipline (no UPDATE/DELETE routes); we do NOT add a Postgres RULE here
-- because backfill restoration may legitimately rewrite rows.
CREATE TABLE audit_events (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_type      TEXT NOT NULL,                  -- 'wallet_linked'|'wallet_unlinked'|'primary_changed'|'account_linked'|'conflict_rejected'|...
    user_id         UUID,                           -- nullable; pre-resolution conflicts have none
    actor           TEXT,                           -- 'self' | 'sietch-redirect' | 'backfill' | world_slug
    payload         JSONB NOT NULL,                 -- structured context (tenant/world, addresses, conflict_kind)
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_audit_events_user      ON audit_events(user_id);
CREATE INDEX idx_audit_events_type_time ON audit_events(event_type, created_at);

-- ── auth_nonces: challenge/response lifecycle (FR-A1) ────────────────────────
--   Reuses the *shape* of wallet_link_nonces (cycle-c migration 046, SQLite)
--   re-expressed in Postgres. Pre-user (wallet-first): wallet_address may
--   be NULL until verify in a SIWE flow. Single-use enforced by `used_at`
--   (set on successful verify) + the partial index `idx_auth_nonces_expires`
--   which only scans live nonces.
CREATE TABLE auth_nonces (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    nonce           TEXT NOT NULL UNIQUE,           -- 32-byte hex (NONCE_BYTES=32)
    wallet_address  TEXT,                           -- claimed wallet (nullable until verify for SIWE)
    scheme          TEXT NOT NULL CHECK (scheme IN ('siwe','eip191')),
    message         TEXT NOT NULL,                  -- exact string presented for signing
    expires_at      TIMESTAMPTZ NOT NULL,           -- 5-min default (DEFAULT_CHALLENGE_EXPIRATION_SECONDS=300)
    used_at         TIMESTAMPTZ,                    -- single-use: set on verify
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- Partial: only scan live, unused nonces during expiration sweeps.
CREATE INDEX idx_auth_nonces_expires ON auth_nonces(expires_at) WHERE used_at IS NULL;

COMMIT;
