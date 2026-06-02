# Better Auth fit POC — done-bar evidence (bd-3n1.4)

**date:** 2026-06-01 · **verdict: PASS → GO (with the seam)** · framed by the [person→account(TBA)→inventory identity model] (2026-05-31)

## The question
Does Better Auth fit the cluster's sovereign-auth needs — and **where is the seam** between a generic auth library and the cluster's sovereign engine? Framed by the identity model: *the person↔account boundary is the library↔sovereign boundary.*

## Verdict: **GO** — adopt Better Auth for the PERSON layer; build sovereign for the ACCOUNT layer.

```
┌ PERSON layer ─ human · wallet-group · world-membership · sessions · per-world JWT ─┐  →  BETTER AUTH (its model IS this)
└ ACCOUNT layer ─ per-world character(s) · inventory · badges · TBA-graduation ──────┘  →  SOVEREIGN ENGINE (no library has it)
```

## Evidence — Better Auth fits the PERSON layer (verified against better-auth.com docs)
- **`user`** = the person (one canonical human). ✓
- **`account`** (MANY per `user`, `userId` FK) = the **wallet-group** — each wallet/credential is an `account` row. *The cluster's wallet-group identity is Better Auth's native account-linking.* "primary wallet" = an `additionalField`/flag. **← the single biggest fit: what bd-2wo planned to hand-build as the canonical-user/credential engine IS Better Auth's core.**
- **SIWE plugin** = wallet-first auth (nonce + verify, multi-chain; Berachain 80094 via custom `chainId` + `verifyMessage`/viem). Replaces the hand-built `credential-bridge-siwe`. ✓
- **organization plugin** = per-world membership (teams/roles/invitations/access-control + `additionalFields`). World ~ organization. ✓
- **JWT plugin** + custom claims (`customAccessTokenClaims` via OIDC/OAuth-provider) = the per-world svc-JWT the cluster mints. JWKS in DB or custom adapter. ✓
- **`additionalFields`** on `user` = `dynamic_env_id` + migration fields. ✓
- **Drizzle / Postgres adapter** (also Kysely/Prisma) = the cluster's stack. **Self-hosted** (sovereign — you run it; NOT a vendor SaaS like Dynamic). ✓

## What Better Auth does NOT have → the sovereign engine
"One person → MANY per-world **characters** → each with **inventory** → graduating to a tradeable **TBA**." Better Auth has `user → organizations` (membership), NOT `user → many-characters-per-world`. The **account + inventory + badge + TBA-graduation** layer is the cluster-specific canonical model — the actually-novel sovereign work (the [identity-account-capability-model]).

## ⚠ Naming collision (resolve before build, not a blocker)
Better Auth **`account`** = a credential link. The identity model's **account** = a per-world game-character. **Same word, different layers.** Reconcile the vocabulary — e.g., game-account → `character`/`playthrough`, reserve `account` for Better Auth's credential. A rename, not a redesign.

## Implications for bd-2wo (the plan realignment — the May-1 SDD is stale vs the identity model)
- **Sprints 1–3** (hand-built `user`/`credential` schemas, `canonical-user` engine mint/link/revoke, `credential-bridges`, `jwks-validator`) → **largely Better Auth** (adopt, don't hand-build). **The build shrinks.**
- The **sovereign effort focuses** on the account+inventory+badge+TBA layer — the novel part, where the cluster's value is.
- The **~98k Dynamic CSV migration** → import into Better Auth's `user` + `account`(SIWE) tables (`dynamic-csv-translator` maps Dynamic users → `user` rows, their wallets → `account` rows). Feasible.
- The SDD's "canonical-user engine from scratch" **realigns** to "Better Auth person layer + sovereign account layer." **The seam IS the realignment.**

## The Coordinate gate (bd-3n1.5) — operator GO/NO-GO to Mirror
**Recommendation: GO.** Adopt Better Auth (person layer); the build is smaller, self-hostable-sovereign, and the wallet-group fit is exact. Carry: the naming reconciliation + the SDD realignment to the identity model. **Operator's call** (the Coordinate gate is human-cited).

## Fallback (if NO-GO)
Hand-build canonical-user/credential/session (the original SDD) — full control, but re-implements what Better Auth provides + a larger build. Not recommended given the clean person-layer fit + self-hostability.

---
*POC method: documentation fit-assessment against the verified Better Auth data model (user/account/session, Drizzle/Postgres adapter, SIWE/organization/JWT plugins, additionalFields) + the cluster's identity model. No code stood up — the fit is determinable from the data model + plugin surface; a code spike adds cost without changing the seam. If the operator wants a running spike before GO, that's a bounded fast-follow.*
