-- ============================================================================
-- Migration 0004_operator_grants.up.sql — Privy DID issuance ACL (W2.5 T-2.5).
--
-- Materializes D-1.5 §4 (canonical DDL) + SDD §4.5 (post-sweep, with
-- granted_by_array element-uniqueness CHECK added per flatline post-sweep
-- CRITICAL/940). Implements the Privy DID → (sub, aud, role) allow-list
-- that gates the cell-issuance hot path per svc-jwt-spec.md §"Authorization"
-- and design decision D2.5-7 (2-of-3-operator approval in production).
--
-- INVARIANTS encoded in SQL:
--   1. is_production=true rows REQUIRE jsonb_array_length(granted_by_array) >= 2
--      (chk_production_two_of_three — the "2-of-3" threshold; non-production
--      grants do NOT require multi-operator approval and may carry an empty
--      array, hence the NOT is_production OR ... pattern).
--   2. Elements of granted_by_array MUST be unique (chk_granted_by_array_unique).
--      This closes the post-sweep CRITICAL/940 attack: without uniqueness, a
--      single operator could satisfy length>=2 by inserting their own DID twice.
--   3. Every element of granted_by_array MUST be a JSON string (chk_granted_by_array_strings).
--      Without this, an integer/null/object element could break consumer parsing
--      AND would silently bypass uniqueness (jsonb_array_elements_text on a non-
--      string element returns NULL; COUNT(DISTINCT) treats NULLs as not-distinct
--      from each other — semantically off-spec).
--
-- POSTGRES CHECK-CONSTRAINT NOTE: PostgreSQL forbids subqueries inside CHECK
-- expressions (verified empirically against postgres:16 — "ERROR: cannot use
-- subquery in check constraint"). The element-uniqueness and element-type
-- invariants both require traversal of the JSON array, so they are wrapped
-- in IMMUTABLE SQL functions; the CHECK then calls the function scalar-style,
-- which the planner accepts. The functions are pure over their input and
-- depend on no session state — IMMUTABLE is correct.
--
-- ACL lookup hot path (per svc-jwt-spec.md §"Authorization"):
--   SELECT 1 FROM operator_grants
--   WHERE grantee_did = $1 AND sub = $2 AND aud = $3 AND role = $4
--     AND revoked_at IS NULL;
-- Served by idx_operator_grants_lookup. Retention: forever (audit). Revocation
-- is soft (set revoked_at); rows are never physically deleted (D-1.5 §5).
-- ============================================================================

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;  -- gen_random_uuid()

-- ── helper functions: CHECK-friendly jsonb predicates ────────────────────────
-- IMMUTABLE means the planner trusts the function for use in CHECK constraints
-- and partial indexes. Both functions are pure over their input (no GUCs, no
-- current_timestamp, no session-state reads).

CREATE OR REPLACE FUNCTION jsonb_string_array_unique(arr jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
    -- Returns TRUE when the array has no duplicate string values.
    -- Compares jsonb_array_length(arr) against COUNT(DISTINCT) over its
    -- text-coerced elements. PRECONDITION: caller has separately enforced
    -- that arr is an array of strings (see jsonb_array_all_strings).
    SELECT jsonb_array_length(arr) = (
        SELECT count(DISTINCT v) FROM jsonb_array_elements_text(arr) AS v
    )
$$;

CREATE OR REPLACE FUNCTION jsonb_array_all_strings(arr jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
    -- Returns TRUE when arr is a JSON array AND every element has
    -- jsonb_typeof = 'string'. Used as a CHECK-constraint predicate to
    -- guarantee the precondition of jsonb_string_array_unique.
    SELECT jsonb_typeof(arr) = 'array'
       AND NOT EXISTS (
           SELECT 1 FROM jsonb_array_elements(arr) AS e
           WHERE jsonb_typeof(e) <> 'string'
       )
$$;

COMMENT ON FUNCTION jsonb_string_array_unique(jsonb) IS
    'IMMUTABLE predicate: TRUE when the input jsonb array has no duplicate string '
    'elements. Used by operator_grants.chk_granted_by_array_unique to close the '
    'flatline post-sweep CRITICAL/940 attack (single operator satisfying '
    'length>=2 via DID duplication). Caller MUST separately ensure all elements '
    'are strings (see jsonb_array_all_strings).';

COMMENT ON FUNCTION jsonb_array_all_strings(jsonb) IS
    'IMMUTABLE predicate: TRUE when the input is a JSON array whose every '
    'element has jsonb_typeof = string. Companion to jsonb_string_array_unique.';

-- ── operator_grants: the Privy DID → (sub, aud, role) ACL ────────────────────
CREATE TABLE operator_grants (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    grantee_did         TEXT NOT NULL,                  -- Privy DID or wallet
    sub                 TEXT NOT NULL,                  -- requested svc-JWT 'sub'
    aud                 TEXT NOT NULL,                  -- requested svc-JWT 'aud'
    role                TEXT NOT NULL,                  -- requested capability
    is_production       BOOLEAN NOT NULL DEFAULT false, -- gates 2-of-3 rule
    granted_by_array    JSONB NOT NULL DEFAULT '[]'::jsonb,
    granted_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    revoked_at          TIMESTAMPTZ,                    -- soft delete; NULL = active

    -- 2-of-3 production threshold: is_production=true requires ≥2 approvers.
    -- Non-production grants may carry an empty array (the default).
    CONSTRAINT chk_production_two_of_three CHECK (
        NOT is_production OR jsonb_array_length(granted_by_array) >= 2
    ),

    -- Element type guard: every entry MUST be a JSON string. Runs first
    -- semantically (uniqueness depends on text coercion).
    CONSTRAINT chk_granted_by_array_strings CHECK (
        jsonb_array_all_strings(granted_by_array)
    ),

    -- Element uniqueness: closes flatline post-sweep CRITICAL/940. Without
    -- this, a single operator could satisfy length>=2 by listing their DID
    -- twice. Uses an IMMUTABLE function wrapper because PostgreSQL forbids
    -- raw subqueries inside CHECK expressions.
    CONSTRAINT chk_granted_by_array_unique CHECK (
        jsonb_string_array_unique(granted_by_array)
    ),

    -- Self-approval gap closure (BB F-002): the grantee themselves MUST NOT
    -- appear in granted_by_array — otherwise a single operator could grant
    -- themselves production capability and self-approve, satisfying the
    -- 2-of-3 threshold only when paired with ONE other approver instead of
    -- requiring TWO other approvers. The @> containment operator on jsonb
    -- arrays of strings tests "does the array contain this string". We
    -- negate it to require absence.
    CONSTRAINT chk_no_self_approval CHECK (
        NOT (granted_by_array @> to_jsonb(grantee_did))
    )
);

COMMENT ON TABLE operator_grants IS
    'Privy DID → (sub, aud, role) allow rules for cell-issuance ACL per D2.5-7. '
    'Production grants (is_production=true) require 2-of-3-operator approval '
    '(granted_by_array length >= 2 AND elements unique). The '
    'chk_granted_by_array_unique CHECK was added post-sweep per flatline '
    'CRITICAL/940 (a single operator could otherwise satisfy length>=2 by '
    'adding their DID twice). The 2-of-3 invariant on approver IDENTITY (must '
    'be distinct + active operators) is enforced at application insert-time; '
    'SQL only guarantees the structural shape.';

COMMENT ON COLUMN operator_grants.granted_by_array IS
    'JSONB array of operator DID strings that approved this grant. Elements '
    'MUST be JSON strings; MUST be unique within the array (CHECK-enforced). '
    'The 2-of-3 length-threshold applies only when is_production = true.';

COMMENT ON COLUMN operator_grants.is_production IS
    'When true, this grant authorizes production-traffic svc-JWTs and requires '
    '2-of-3-operator approval (granted_by_array length >= 2). Non-production '
    'grants are operator-self-serve and may carry an empty granted_by_array.';

COMMENT ON COLUMN operator_grants.revoked_at IS
    'Soft-delete timestamp. NULL = active grant. Rows are never physically '
    'deleted; the 2-of-3-approval audit trail must remain intact for the '
    'lifetime of the cluster (D-1.5 §5).';

-- ── Indexes ───────────────────────────────────────────────────────────────────
-- ACL lookup hot path (cell-issuance verify gate):
--   SELECT 1 FROM operator_grants
--   WHERE grantee_did = $1 AND sub = $2 AND aud = $3 AND role = $4
--     AND revoked_at IS NULL;
CREATE INDEX idx_operator_grants_lookup
    ON operator_grants (grantee_did, sub, aud, role)
    WHERE revoked_at IS NULL;

-- "List grants for grantee X" admin/operator hot path.
CREATE INDEX idx_operator_grants_grantee
    ON operator_grants (grantee_did)
    WHERE revoked_at IS NULL;

-- BB F-004: prevent duplicate ACTIVE grants for the same (grantee_did, sub,
-- aud, role) tuple. Without this, an operator could create multiple active
-- rows for the same tuple — only one is needed semantically, and dupes make
-- the soft-delete audit trail ambiguous (which row revoked when?). The
-- partial unique applies ONLY to active rows (revoked_at IS NULL); revoked
-- rows can freely duplicate the tuple since they're historical.
CREATE UNIQUE INDEX uq_operator_grants_active_tuple
    ON operator_grants (grantee_did, sub, aud, role)
    WHERE revoked_at IS NULL;

COMMIT;
