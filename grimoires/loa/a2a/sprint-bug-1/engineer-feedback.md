# Senior Lead Review — sprint-bug-1 (bd-u1j): world_identity row-population gap

## All good (with noted concerns)

Reviewed the implementation against the spec (`grimoires/loa/specs/fix-world-identity-upsert.md`), the sprint plan (`grimoires/loa/a2a/bug-20260602-878a0f/sprint.md`), and the actual code (not just the report). Approved — concerns below are non-blocking and documented.

## What was verified (code, not report)

- **Engine untouched (the load-bearing guardrail)**: `git diff a4e1ce1^..HEAD -- packages/engine/src/link-wallet-only.ts packages/adapters/src/postgres-spine-adapter.ts` = 0 lines. The fix is entirely the `0009` migration + the backfill catch-site. ✓
- **`0009` up.sql correctness**: upsert sits inside the existing `IF winning_value IS NOT NULL` guard (honors `nym NOT NULL`, 0001:90); `ON CONFLICT (user_id, world_slug)` targets the PK (0001:96); `WHERE … IS DISTINCT` preserves no-op-skip. ✓
- **`0009` down.sql reversibility**: byte-identical to the 0008:139-172 UPDATE-only body (verified `diff`). CLI up→down→up confirmed `UPSERT → UPDATE-only → UPSERT` via `pg_get_functiondef`. ✓
- **Backfill retry guard is precise**: `err instanceof SpineConflictError && err.kind === "world_identity" && err.context?.name_type === "claimed_nym"` (backfill:198-201) — a generated-value collision or any other conflict falls through to `stats.errors`. Verified by T3 negative case. ✓
- **Test-first**: all 3 suites committed failing first (`a4e1ce1`), then made to pass. ✓
- **Regression shield**: `world_name_model.test.ts` 10/10, backfill MockSpine 13/13. ✓

## AC Verification gate (Issue #475)

`## AC Verification` section present in `reviewer.md`, all 6 ACs walked verbatim with `✓ Met` + file:line evidence. No `✗ Not met`, no unbacked deferrals. Gate PASS.

## Documentation verification

This is a bugfix micro-sprint (not a cycle PR) — no CHANGELOG/CLAUDE.md entry required (per post-merge "Full pipeline only for cycle-type PRs"). The `0009` migration is self-documenting (extensive header comments grounding the root cause to file:line). Security-sensitive code (auth-SoR trigger) carries explanatory comments. PASS.

## Complexity analysis

- `backfillWalletOnlyRows()` grew from ~50 to ~70 lines with the retry — within threshold, single added nested try/catch (depth 3, justified by the retry semantics). No duplication (the retry deliberately re-issues `linkWalletOnly` with a narrowed payload rather than abstracting prematurely — Karpathy simplicity-first).
- Migration SQL: pure DDL, no complexity concern.

## Adversarial Analysis

### Concerns Identified (non-blocking)

1. **Stale denorm pointer on retire-without-floor (`0009` up.sql:65-71).** The upsert collides on `UNIQUE(world_slug, nym)` if a user's `claimed_nym` is retired while they have NO `generated` floor (the nym is stranded, then another user reclaims the value). The implementer proved this is unreachable in the real wallet-only path (`linkWalletOnly` always writes a generated floor; 0008:158-161 documents the privacy-floor invariant) and corrected the synthetic test #7 to be production-representative. **Concern:** the trigger raises a raw PG 23505 rather than a typed/handled error in this unreachable state — if a future path ever produces a floor-less user, the failure mode is an opaque DB error inside a trigger. Recommend a follow-up bead to either (a) enforce the generated-floor invariant at the schema/engine boundary, or (b) have the trigger recompute-and-release a stale denorm pointer. Non-blocking: unreachable today.

2. **Double-conflict retry path (backfill:203-227).** If a row's `claimed_nym` collides AND its `generated` `mibera_id` also collides, the retry's inner `linkWalletOnly` throws on the generated value → caught by the inner catch → `stats.errors += 1`. Correct (no infinite loop, no silent swallow), but the log line `(retry after claimed_nym drop)` is the only signal that this is a compound failure. Acceptable — the operator sees a real error with context.

3. **Idempotency of the retry on re-run (backfill:214).** On a second backfill pass, the colliding user already exists generated-only; `linkWalletOnly` resolves `idempotent_noop` and `stats.idempotent += 1` — but `claimedNymDropped` is NOT re-incremented on the idempotent path (the retry block only fires on a fresh conflict). This is correct (the drop already happened), but means `claimedNymDropped` reflects drops-this-run, not cumulative-state. Acceptable for a one-time backfill; noted for the operator reading the stat.

### Assumptions Challenged

- **Assumption**: `linkWalletOnly`'s `withTransaction` rolls back the user/wallet writes when `importName` throws, so the generated-only retry creates cleanly (no orphaned user/wallet from the first attempt).
- **Risk if wrong**: a half-created user (wallet linked, no name) would survive the first attempt, and the retry's `resolveByWallet` would hit `idempotent_noop` — leaving the user with NO name row at all.
- **Verdict**: VALIDATED. T3 asserts exactly one user/world row with `nym==MIBERA-222222` and `stats.created==1` (not idempotent) — proving the rollback works and the retry is a fresh create. Made explicit in `reviewer.md` Technical Highlights.

### Alternatives Not Considered

- **Alternative**: instead of a trigger upsert, have `linkWalletOnly` explicitly INSERT the `world_identity` row after computing the winning name (engine-side fix).
- **Tradeoff**: would require the engine to know the winning nym before the row exists, but `nym` is NOT NULL and the winner is only known after the name rows + resolver query — exactly what the trigger already computes. The engine-side path would duplicate the resolver logic and miss the `claimNymWithAudit` / future callers.
- **Verdict**: current trigger-only approach is justified — it is the all-callers fix and avoids resolver-logic duplication. The implementer's `0009` up.sql header documents this reasoning. Correct call.

## Next Steps

Approved for audit. Recommend (non-blocking, post-merge): a follow-up bead for the generated-floor invariant (Concern 1) — track the unreachable-today raw-23505 failure mode before any future path could produce a floor-less user.
