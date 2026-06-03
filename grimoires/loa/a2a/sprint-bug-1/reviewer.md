# Implementation Report — sprint-bug-1 (bd-u1j): world_identity row-population gap

**Type**: bugfix (real prod regression) · **Branch**: `fix/wallet-only-world-identity` · **Repo**: freeside-auth (identity-api)
**Spec**: `grimoires/loa/specs/fix-world-identity-upsert.md` · **Sprint**: `grimoires/loa/a2a/bug-20260602-878a0f/sprint.md`

## Executive Summary

Trigger-only fix for the wallet-only `world_identity` row-population gap. Migration `0009` changes the `recompute_world_nym()` trigger body from a bare `UPDATE world_identity` (a 0-row no-op when no row exists) to an `INSERT … ON CONFLICT … DO UPDATE … WHERE nym IS DISTINCT` upsert, so the first `world_identity_names` write self-heals the missing `world_identity` row — an all-callers fix at the trigger. The backfill catch site gains a `claimed_nym`-collision retry (generated-only) so duplicate honey-road `display_name`s no longer drop users. **Engine source unchanged** (`link-wallet-only.ts`, `postgres-spine-adapter.ts` untouched). Test-first; regression shield green.

Files (all committed locally; NOT pushed, NO PR — per dispatch discipline):
- NEW `packages/adapters/src/migrations/0009_world_identity_upsert_trigger.up.sql`
- NEW `packages/adapters/src/migrations/0009_world_identity_upsert_trigger.down.sql`
- EDIT `scripts/backfill-wallet-only-from-midi.ts` (catch-site retry + `claimedNymDropped` stat; `SpineConflictError` import)
- NEW tests: `world_identity_upsert_trigger.test.ts` (T1), `link-wallet-only-trigger.test.ts` (T2), `backfill-wallet-only-from-midi-collision.test.ts` (T3)
- EDIT `packages/adapters/src/__tests__/world_name_model.test.ts` (regression-shield corrections for the new top migration)

## Safety Check (gate before 0009 — RESOLVED)

The spec's open question: could the upsert create a conflicting `world_identity` row via a caller that writes a name row AND calls `claimNym`? Grounded answer — **no; `linkVerifiedWallet` is NOT broken by `0009`**:
- `linkVerifiedWallet` (`packages/engine/src/link-verified-wallet.ts:152-307`) writes ZERO `world_identity_names` rows — only `mintUser`/`linkWalletWithAudit`/`linkAccountWithAudit`/audit. The trigger fires only on `world_identity_names` writes, so it never fires for this path.
- `claimNym` (`packages/adapters/src/postgres-spine-adapter.ts:592-617`) does a DIRECT `world_identity` INSERT and writes NO name row → never fires the trigger.
- `claimNymWithAudit` (`packages/engine/src/resolve-spine.ts:247`) is the only `claimNym` wrapper and has ZERO non-test production call sites.
- No reachable caller writes a name row AND calls `claimNym`. The upsert's `ON CONFLICT (user_id, world_slug) DO UPDATE … WHERE nym IS DISTINCT` re-points an existing row rather than erroring, so even a hypothetical mixed path is safe (proven by T1 "Safety: direct world_identity INSERT then name-write recompute" — no spurious PK conflict).

## AC Verification

> "Wallet-only ingress produces a `world_identity` row with the correct nym (gap no longer reproducible)"

**✓ Met** — `0009` up.sql:65-71 upsert; proven by T2 B1/B2 (`link-wallet-only-trigger.test.ts:138,168`) — `linkWalletOnly` against a real `PostgresSpineAdapter` now yields `world_identity.nym == honeybear` (imported claimed_nym) and `^MIBERA-[A-F0-9]{6}$` (generated). Pre-`0009` the same tests failed (nym null).

> "Backfill survives the duplicate "rug" `claimed_nym` collision, creating generated-only users (exit 0, `claimedNymDropped` surfaced)"

**✓ Met** — `scripts/backfill-wallet-only-from-midi.ts:189-220` retry; proven by T3 (`backfill-wallet-only-from-midi-collision.test.ts:137`) — `stats.created==1, errors==0, claimedNymDropped==1`, colliding user created generated-only with `nym==MIBERA-222222`, no active `claimed_nym` row.

> "0009 up+down both present and reversible (A4)"

**✓ Met** — both files present; `down.sql` body byte-identical to `0008:139-172` (verified via `diff`). Proven by T1 A4 (`world_identity_upsert_trigger.test.ts:287`) and the CLI round-trip: up→down→up with `pg_get_functiondef` confirming `UPSERT → UPDATE-only → UPSERT`.

> "Safety question test-locked: no spurious `world_identity` conflict via `claimNym`/`link-verified-wallet` paths"

**✓ Met** — T1 "Safety: a direct world_identity INSERT then a name-write recompute does NOT raise a spurious PK conflict" (`world_identity_upsert_trigger.test.ts:222`) + the grounded analysis above (`linkVerifiedWallet` writes no name rows).

> "No regressions — `world_name_model.test.ts` + backfill MockSpine suite green; engine source unchanged"

**✓ Met** — `world_name_model.test.ts` 10/10, `backfill-wallet-only-from-midi.test.ts` 13/13 (fresh isolated DB). `git diff` confirms no change to `link-wallet-only.ts` or `postgres-spine-adapter.ts`. (See "Regression-shield finding" below for the 3 test-fixture corrections in `world_name_model.test.ts` — fixture/assertion updates for the new top migration, NOT behavior changes.)

> "Fix addresses root cause (trigger upsert), not a symptom (no per-caller hand-inserts)"

**✓ Met** — single trigger-body change fixes all callers; no engine edits, no per-caller INSERTs.

## Per-Task Results (DB-gated tests against scratch `ci_final`)

| Task | Files | Test result |
|------|-------|-------------|
| T1 adapter trigger | `world_identity_upsert_trigger.test.ts` | 6 pass / 0 fail |
| T2 engine real-spine | `link-wallet-only-trigger.test.ts` | 3 pass / 0 fail |
| T3 backfill collision | `backfill-wallet-only-from-midi-collision.test.ts` | 2 pass / 0 fail |
| T4 migration 0009 | `0009_…up.sql` + `…down.sql` | T1+T2 green; CLI up→down→up verified |
| T5 backfill retry | `backfill-wallet-only-from-midi.ts` | T3 green |
| T6 regression shield | `world_name_model.test.ts` + `backfill-…-from-midi.test.ts` | 10/10 + 13/13 |

## Regression-shield finding (the shield caught a real edge)

Re-running `world_name_model.test.ts` with `0009` applied surfaced 3 failures. Investigated each:
- **Tests #9/#10 (down/up):** stale latest-migration assertions (`0009` now sits above `0008`). Corrected to revert/re-apply both versions.
- **Test #7 (partial-unique retire→reclaim):** its synthetic fixture gave a user a `claimed_nym` with NO `generated` floor — a state the real wallet-only path never produces (`linkWalletOnly` always writes a generated floor; `0008` up.sql:158-161 documents the privacy-floor invariant). Without the floor, retiring the claimed_nym strands the denorm `nym` and the upsert collides on `UNIQUE(world_slug,nym)` when another user reclaims. Verified with a throwaway production-representative repro: WITH the floor, retire recomputes the user to its generated handle (releasing the nym), and the reclaim succeeds cleanly. Corrected the fixture to seed the floor and now asserts both nyms. **`0009` is correct for all reachable states; no migration change was needed.**

Sibling failures in a *combined* `bun test packages/adapters/` run (`migrate.test.ts`, `postgres-spine-adapter-nonces.test.ts`, `primary_wallet_trigger.test.ts`) are **pre-existing and unrelated to 0009**: (a) cross-file scratch-DB interference (all 22 files share one DB; `migrate.test.ts` + nonces pass in isolation), and (b) `primary_wallet_trigger.test.ts` down/up assertions hardcode `0002` as the latest migration — stale since `0003`, documented in `world_name_model.test.ts:25-27`, last touched in commit `92348ed` (untouched here). Karpathy "don't clean up pre-existing issues" — left as-is, flagged.

## Technical Highlights

- **All-callers fix at the trigger**: the upsert inside the existing `IF winning_value IS NOT NULL` guard honors `nym NOT NULL` (`0001:90`); `ON CONFLICT` target is the PK `(user_id, world_slug)` (`0001:96`); `IS DISTINCT` preserves the no-op skip (idempotent on the 187 hand-patched prod rows — they were INSERTed with the resolver's exact winning value, so `EXCLUDED.nym == nym` → skip).
- **Backfill retry is transaction-safe**: `linkWalletOnly` wraps writes in `withTransaction`; the failed first attempt rolls back the user/wallet, and the generated-only retry re-creates cleanly (proven by T3 — `created==1`, exactly one user/world row).
- **No silent swallow**: only `kind==='world_identity' && context.name_type==='claimed_nym'` triggers the retry; any other conflict still increments `stats.errors` (T3 negative case).

## Testing Summary — how to run

```bash
# scratch DB (CI-shaped): docker exec idapi-pg createdb -U postgres identity_ci
DB=postgres://postgres:postgres@localhost:5432/identity_ci
TEST_DATABASE_URL=$DB DATABASE_URL=$DB bun test packages/adapters/src/__tests__/world_identity_upsert_trigger.test.ts
TEST_DATABASE_URL=$DB DATABASE_URL=$DB bun test packages/engine/src/__tests__/link-wallet-only-trigger.test.ts
TEST_DATABASE_URL=$DB DATABASE_URL=$DB bun test scripts/__tests__/backfill-wallet-only-from-midi-collision.test.ts
TEST_DATABASE_URL=$DB DATABASE_URL=$DB bun test packages/adapters/src/__tests__/world_name_model.test.ts   # shield
bun test scripts/__tests__/backfill-wallet-only-from-midi.test.ts                                          # shield (MockSpine, no DB)
```

Each DB-gated suite is self-contained (drops all state + migrates 0001..0009 in `beforeAll`). Run on a fresh scratch DB to avoid cross-file interference.

## Known Limitations

- The backfill retry strips `claimed_nym` permanently for the losing dup-name user (they display `MIBERA-XXXX` forever) — intended degradation, surfaced via `claimedNymDropped` + a log line so the operator can re-assign.
- `0009` applies forward-only (prod is at `0008`); deploy path is `migrate up` on prod then Railway deploy (operator-gated, NOT done here).
- Pre-existing typecheck errors (6) all under `src/hyper/**` (excluded subtree) — unchanged by this work; zero in touched files.

## Verification Steps (for reviewer)

1. `git log --oneline -5` — 5 commits (failing tests → 0009 → backfill retry → shield update).
2. `git diff main..HEAD -- packages/engine/src/link-wallet-only.ts packages/adapters/src/postgres-spine-adapter.ts` — EMPTY (engine unchanged).
3. `diff <(sed -n '139,172p' packages/adapters/src/migrations/0008_world_name_model.up.sql) <(sed -n '22,55p' packages/adapters/src/migrations/0009_world_identity_upsert_trigger.down.sql)` — identical (down restores 0008 body).
4. Run the 5 suites above on a fresh scratch DB — 6+3+2+10+13 all pass.
5. CLI round-trip: `migrate up; migrate down; migrate up` with `pg_get_functiondef('recompute_world_nym')` → `UPSERT → UPDATE-only → UPSERT`.
