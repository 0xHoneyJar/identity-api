-- ============================================================================
-- Migration 0006_svc_jwt_denylist.up.sql — operator-managed any-match deny
-- rules for service-JWTs (D2.5-11).
--
-- Authoring source (D-1.5 §2 of grimoires/migrations-spec.md) +
-- SDD §4.3a of grimoires/loa/cycles/cycle-w2.5-cluster-auth-custody-substrate/
-- sdd.md (post-flatline SKP-002 semantic clarification: null-as-wildcard
-- CONJUNCTIVE — NOT OR — match).
--
-- This is the only persistence-affecting verify-time check post-D2.5-12: the
-- iter-2 replay_store and the verify-time jti UNIQUE write are both removed
-- under the per-request issuance model (svc-JWTs are minted fresh per
-- cross-cell call; replay is mechanically infeasible within the short TTL).
-- Operators retain emergency revocation via this denylist for compromised
-- kid, leaked jti, or suspected-compromised sub.
--
-- Match semantics — null-as-wildcard CONJUNCTIVE (SDD §4.3a):
--   A JWT (kid_j, jti_j, sub_j) is denied by a rule (kid_r, jti_r, sub_r)
--   iff EVERY non-null field of the rule matches the JWT's corresponding
--   field. A null rule field is a wildcard ("matches anything").
--
--   Verify-time SQL (canonical):
--     SELECT rule_id, reason FROM service_jwt_denylist
--     WHERE (kid IS NULL OR kid = $1)
--       AND (jti IS NULL OR jti = $2)
--       AND (sub IS NULL OR sub = $3)
--     LIMIT 1;
--
--   The CHECK constraint forbids the all-null rule (which would deny every
--   JWT); at-least-one of (kid, jti, sub) MUST be non-null per row.
--
-- Retention: forever. Deny rules outlive the JWTs they target — a
-- compromised-kid rule must remain active for the full lifetime of any JWT
-- that kid could have signed. Operator manually retires rules when the
-- underlying threat is closed (e.g., kid rotated, all in-flight jtis
-- expired). No pg_cron sweep on this table by design (D-1.5 §5).
-- ============================================================================

BEGIN;

CREATE TABLE service_jwt_denylist (
    rule_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    kid         TEXT,                                      -- nullable; null = wildcard
    jti         TEXT,                                      -- nullable; null = wildcard
    sub         TEXT,                                      -- nullable; null = wildcard
    reason      TEXT NOT NULL,                             -- audit string (e.g. "kid rotation 2026-Q3 — key suspected compromised")
    denied_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    denied_by   TEXT NOT NULL,                             -- operator Privy DID (audit trail)
    CONSTRAINT chk_denylist_at_least_one
        CHECK (kid IS NOT NULL OR jti IS NOT NULL OR sub IS NOT NULL)
);

-- Partial indexes for the verify-time CONJUNCTIVE any-match query path.
-- Verify-time SQL (see SDD §4.3a):
--   SELECT rule_id, reason FROM service_jwt_denylist
--   WHERE (kid IS NULL OR kid = $1)
--     AND (jti IS NULL OR jti = $2)
--     AND (sub IS NULL OR sub = $3)
--   LIMIT 1;
-- Each partial index covers the non-null branch of one discriminator; the
-- planner uses whichever the per-rule sparsity favors (typically the most
-- selective non-null field).
CREATE INDEX idx_svc_jwt_denylist_kid
    ON service_jwt_denylist (kid)
    WHERE kid IS NOT NULL;
CREATE INDEX idx_svc_jwt_denylist_jti
    ON service_jwt_denylist (jti)
    WHERE jti IS NOT NULL;
CREATE INDEX idx_svc_jwt_denylist_sub
    ON service_jwt_denylist (sub)
    WHERE sub IS NOT NULL;

COMMENT ON TABLE service_jwt_denylist IS
    'Any-match deny rules per D2.5-11. Null-as-wildcard CONJUNCTIVE semantics: a JWT is denied by a rule when every non-null field of the rule matches the JWTs corresponding field. Operator-managed; no automated sweep — deny rules are forever unless explicitly removed.';

COMMIT;
