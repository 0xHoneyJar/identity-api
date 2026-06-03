# Security Audit — sprint-bug-1 (bd-u1j): world_identity row-population gap

## APPROVED - LETS FUCKING GO

Audited as the Paranoid Cypherpunk Auditor. This is an auth-SoR trigger change — zero-latitude surface — and it passes clean. The fix is a tight, non-destructive, fully-reversible, fully-audited trigger-body swap plus a narrowing backfill retry. No security findings at any severity.

## Scope audited

`a4e1ce1^..HEAD` — 8 files: `0009_world_identity_upsert_trigger.{up,down}.sql`, `scripts/backfill-wallet-only-from-midi.ts`, 3 new test files, `world_name_model.test.ts`, `NOTES.md`. Engine source (`link-wallet-only.ts`, `postgres-spine-adapter.ts`): 0 lines changed (verified).

## Security checklist

| Check | Verdict | Evidence |
|-------|---------|----------|
| **SQL injection** | CLEAN | `0009` is pure parameterized plpgsql — bound variables (`affected_user`, `affected_world`, `winning_value`), no `EXECUTE`, no `format()`, no string interpolation, no dynamic SQL. Backfill retry calls `linkWalletOnly` (engine → adapter `sql\`…\`` tagged templates); no raw SQL in the path. |
| **Secrets** | CLEAN | No hardcoded credentials/keys/tokens in production code. Only `postgres:postgres` local-docker scratch-DB creds in test setup. |
| **Destructive ops** | CLEAN | `0009` up = `CREATE OR REPLACE FUNCTION` only (idempotent, non-destructive). down = `CREATE OR REPLACE FUNCTION` restoring the UPDATE-only body; leaves ALL `world_identity` rows intact (no `DROP TABLE`, no `DELETE`). Backfill production path has no destructive ops. |
| **Data integrity (SoR)** | CLEAN | INSERT fires only when `winning_value NOT NULL` (honors `nym NOT NULL`, 0001:90); `ON CONFLICT (user_id, world_slug)` = PK → at most one row per (user,world), cannot duplicate; `DO UPDATE … WHERE IS DISTINCT` is deterministic + no-churn; `AFTER … RETURN NULL` cannot mutate the triggering row. Winner-selection `ORDER BY` unchanged from 0008. |
| **Auth/authz** | CLEAN | Backfill retry NARROWS `importedNames` (drops `claimed_nym`) — strictly less data, never escalates; `actor='backfill-wallet'` preserved; no discord/dynamic linkage added beyond the source row. |
| **Info disclosure** | CLEAN | Log fields are all PUBLIC identity data (wallet_address on-chain, display_name + mibera_id are public navbar handles). `String(err)` could surface a DB error — acceptable in a one-time operator-run script (not a request handler). |
| **Degradation auditability** | CLEAN | `claimed_nym` drop is surfaced (`claimedNymDropped` stat + per-row log), reversible (revert script + `link_wallet_only` audit event), no identity loss (user keeps unique MIBERA-XXXX). No silent data loss — the colliding `claimed_nym` belonged to a prior holder. |
| **Test security** | CLEAN | Only synthetic addresses (`0x1111…`, `0xaaaa…`); no real wallets, secrets, or prod endpoints. |

## OWASP Top-10 quick pass

- A01 (Broken Access Control): n/a — no access-control surface changed; backfill narrows, never escalates.
- A03 (Injection): CLEAN — parameterized throughout (see SQL injection row).
- A04 (Insecure Design): the trigger-only fix is the correct all-callers design; `ON CONFLICT` + `IF NOT NULL` guards enforce invariants at the SoR.
- A09 (Logging/Monitoring Failures): the degradation path is loud (stat + log + audit event), not silent.

## Non-blocking note (carried from senior review, not an audit blocker)

Concern 1 from `engineer-feedback.md` (raw PG 23505 on a floor-less retire/reclaim) is an **unreachable** edge today (the generated-floor invariant holds in the real path). Tracked as follow-up bead `bd-axa` (P3, `domain:shared`). Not a security issue — a future-hardening item. Does not block this gate.

## Verdict

APPROVED. Tests: T1 6/6, T2 3/3, T3 2/2, shield 10/10 + 13/13. Reversible (CLI up→down→up verified). Engine untouched. Auditable. Ship it.
