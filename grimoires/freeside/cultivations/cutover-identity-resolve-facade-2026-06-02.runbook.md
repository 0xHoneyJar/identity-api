# Cutover Runbook — `POST /v1/identity/resolve` facade → prod (identity-api)

```
cycle:        deploy-identity-resolve-facade
cycle_id:     cutover-identity-resolve-facade-2026-06-02
authored_by:  KRANZ (construct-freeside) via opus-4-8-1m + zksoju
target:       identity.0xhoneyjar.xyz (Railway, dashboard-managed)
trigger:      operator "deploy 33"
STATUS:       NO-GO (gate closed at Act 1 — main diverged; #28 CONFLICTING)
```

## Act 1 — Coordinate (read the substrate)

GATE: **NO-GO.** Reality discovery reframed the scope; pause at the seam.

**Telemetry (verified, not claimed):**
- `#33` `w2.5-identity-resolve-facade` → parent `w2.5-sprint-3-auth-sdk-source-distributed`: **MERGED** (`ed2478d`). Facade integrated onto the sprint-3 branch. Reversible (revert the merge commit).
- `#28` `w2.5-sprint-3` → `main`: **CONFLICTING / DIRTY**. The path to prod is blocked.
- **main diverged.** merge-base = `37896b9` (2026-05-26, #26 sprint-2). main HEAD = `17a023f feat(spine): C-2 world_managers (#31)` — adds migration `0007_world_managers` + code. The sprint-3 branch (migrations 0001–0006) never integrated `#31`.
- **Conflict scope = ONE file:** `packages/protocol/src/api/index.ts` (both `#31` and the facade appended re-export blocks to the protocol barrel — `git merge-tree`). `src/api/index.ts`, `packages/engine/src/index.ts`, `packages/ports/src/index.ts` AUTO-MERGE clean.
- **Deploy mechanism:** Railway dashboard-managed; `start: bun src/api/index.ts` does NOT auto-migrate; `migrate up` is separate.
- **Migration correction:** `0007` is **already on main** (via `#31`), NOT introduced by this chain. Earlier claim ("the chain adds 0007") was FALSE — corrected against the substrate (KRANZ: never flip on a claim).

**Why NO-GO:** "deploy 33" is not a clean merge-to-main. The sprint-3 branch is behind main; `#28` carries an unresolved conflict; and prod's migration state vs main's `0007` is unverified. Pushing past this gate would flip on a divergence we have not reconciled.

## Act 2 — Mirror

N/A — single-repo code deploy, no substrate (CDN/bucket) to duplicate. The only "substrate move" is the prod DB migration state, which is **main's** (`0007`), to be verified via `migrate:status` against prod at flip time.

## Act 3 — Verify (three-layer gate)

- **Layer 1 — smoke:** GREEN. Full suite 550 pass / 0 fail; typecheck clean on touched files; AC-13 (auth byte-unchanged) ✓; AC-14 (no-embed) ✓; OQ-3 `.auth()` gate ✓ (401 without token).
- **Layer 2 — parity:** **RED.** `#28` CONFLICTING; sprint-3 branch ≠ main (#31 not integrated); prod migration state unverified.
- **Layer 3 — operator gate:** **NOT REACHED.** Cannot present GO with Layer 2 red.

## Act 4 — Flip (held)

- **Step 1 (done, reversible):** `#33` → parent. ✓
- **Step 2 (BLOCKED):** resolve `#28` conflict → re-verify → `#28` → main → `migrate:status`/`migrate up` on prod (if `0007` not applied) → Railway deploy → 30-min watch → revert on red.

## Required before re-gate (the amendment)

1. **Reconcile the branch with main:** merge `origin/main` (#31 world_managers) into the sprint-3 branch; resolve the ONE barrel conflict in `packages/protocol/src/api/index.ts` (union both export blocks — facade's `IdentityResolve*` + #31's world_managers exports). Trivial.
2. **Re-run the full suite** with #31 integrated (world_managers + facade coexisting).
3. **Verify prod DB migration state:** `migrate:status` against prod `DATABASE_URL` — confirm whether `0007` is applied (main has it; prod is lagged). Run `migrate up` if pending.
4. **Then** re-open Layer 2/3 gates: `#28` mergeable, suite green, prod migration current → operator GO → flip.

## Rollback posture

- Facade is OQ-3 `.auth()`-gated — even if it reached prod, it's not openly exposed.
- `#33`→parent merge: revert `ed2478d`.
- Prod flip (not taken): `git revert` the `#28` merge + `migrate down` if applicable + Railway redeploys prior.

## Act 5 — Distill

Lesson for the construct + the operator: **Coordinate fully (read main + prod state) BEFORE the first flip.** I merged `#33`→parent before reading main's divergence; the merge was correct + reversible, but the divergence should have been read in Act 1. The sprint-3 branch built the facade on a 2026-05-26 base while main advanced (#31); long-lived feature branches drift from main and surface as conflicts at deploy. Amend: reconcile early, deploy from a main-current branch.
