---
session: auth-vertical-betterauth-seam
date: 2026-06-01
type: kickoff
status: planned
target_repo: freeside-auth
driving_composition: code-implement-and-review
---

# Auth Vertical — Better Auth seam (kickoff)

## Scope
- Adopt **Better Auth** for the PERSON layer (user · account×N = wallet-group · SIWE · organization=world · JWT via definePayload · sessions; Drizzle/Postgres; self-hosted-sovereign).
- Build **sovereign** for the ACCOUNT layer + the **cross-wallet linking ceremony** (the piece no library gives).
- 6 dependency-ordered steps: (0) naming reconciliation → (1) stand up Better Auth in-repo → (2) linking ceremony → (3) ~98k Dynamic CSV migration → (4) mcp-tools → (5) Mirror→Verify→Flip cutover → (6) Distill.
- ⊙ KAIRONIC: the account/TBA/inventory depth + the `.28` canonical-`identity_id` shape are **held open** — minimal account-stub only; firm the substrate *under* the account model without deciding it.

## Artifacts
- Design / re-scope: `grimoires/loa/2026-06-01-auth-vertical-rescope.md` (supersedes the May-1 SDD)
- POC evidence: `grimoires/loa/2026-06-01-better-auth-fit-poc.md`
- Build doc (source of truth): `specs/enhance-auth-vertical-betterauth-seam.md`
- Running spike (reference impl): `origin/spike/better-auth-poc` → `poc/better-auth-spike/`

## Prior session
Coordinate gate `bd-3n1` **CLOSED at GO** — a running Better Auth spike PASSED (2026-06-01): SIWE login, wallet-group (3 account/1 user, queried live), per-world JWT verified. The May-1 `bd-2wo` SDD is superseded by the re-scope.

## Decisions made
- **Better Auth GO** for the person layer; sovereign engine for the account/TBA layer + the cross-wallet linking ceremony.
- **Drop** the May-1 hand-built `user`/`credential`/`jwt-claims` schemas, `canonical-user` engine, `jwks-validator`, `credential-bridges` — Better Auth provides them; Dynamic → one-time CSV import.
- **Naming**: Better Auth `account` = credential link; ours = `character` (rename game-account; reserve `account`).
- **Driving composition**: `code-implement-and-review` (implement → review → operator-curate).
- Gotchas baked in: `asResponse:true`, internal `getSchema()`, bun:sqlite→PG swap, Berachain EOA no-RPC, per-world `definePayload`.
