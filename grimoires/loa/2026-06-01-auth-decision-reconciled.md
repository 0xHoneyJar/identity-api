# Auth Vertical — Decision Reconciled (corrects the 2026-06-01 confabulated brief)

**date:** 2026-06-01 · **status:** operator-ratified · **supersedes the "drop & adopt Better Auth as issuer/SoR" framing in** `grimoires/loa/specs/enhance-auth-vertical-betterauth-seam.md` + `grimoires/loa/2026-06-01-auth-vertical-rescope.md`

## What happened (the confabulation + its mechanism)

The `bd-2wo` child tasks (`.1`–`.32`) were authored 2026-05-01 as a *plan*. The work was then **built off-bead** on branches `feat/t1.x` → `w2.5-sprint-3-auth-sdk-source-distributed` (through `/fagan` iter-3, `dd60990`) **without bead lifecycle** — so the children stayed `open`. A 2026-06-01 `/kickoff` agent read the open beads as an **unbuilt plan** and produced a brief directing us to *drop the "May-1 hand-built" canonical-user / jwks / credential-bridges and adopt Better Auth as the issuer/SoR.* That inverted reality: the artifacts are **shipped, reviewed code**, not an empty plan. The brief is superseded by this record.

Root cause: the SoT (beads) lied. Reconciled below.

## The corrected decision

- **Keep the hand-built ES256 sovereign stack as the issuer / SoR** (LocalEs256Signer, JWKS, Postgres spine, credential bridges, source-distributed verify SDK). This is what **PRD v3.0** already specifies (local ES256 signer behind the `JWTSigner` port; identity-api as SoR).
- **Better Auth = a per-world CREDENTIAL ADAPTER** behind the existing `CredentialBridge` port — translating Better Auth proof (passkey / social / email) → canonical `CredentialProof`. This is the operator's actual goal (**multi-credential login + standardized per-world login UX**) and is **PRD v3.0-sanctioned** ("Better Auth deferred to a per-world adapter", `prd.md:315,323`).
- **NOT** an issuer/SoR replacement. Better Auth is a composed library at the credential **ingress** edge — never an absorbed runtime, never touching the ES256 svc-JWT **egress** contract.
- The **account/character/TBA/inventory model stays KAIRONIC** (held open) — this cycle firms the substrate under it, does not decide it.

## Evidence (cluster probe, confidence 0.93 · 2026-06-01)

- **ZERO external consumers** of the ES256 svc-JWT verify contract cluster-wide. The "1 vendored consumer" (`fa-c2-world-managers`) is our **own git worktree** (byte-identical, same object store). The source-distributed `@0xhoneyjar/auth` SDK is unmerged (sprint-3 branch only). → **contract-change window is fully OPEN** — cheapest moment to make any breaking ES256-contract change, until a real world first vendors the source.
- **Current prod auth is Dynamic SDK end-to-end** (NOT siwe-turso — both the brief and an early read were wrong): midi (`mibera-dimensions`, Vercel) issues+verifies Dynamic JWTs and is the de-facto SoR/writer; service-to-service is static SHA-256 API keys; no svc-JWT in any live path.
- **identity-api is live but build-lagged**: `identity.0xhoneyjar.xyz` serves only the HS256 login/resolve spine; the merged ES256 `service-jwt` + `/.well-known/jwks.json` routes **404** (Railway deploy predates the W2.5 sprint-2 merges). Its one consumer (`freeside-dashboard`) is itself undeployed. → nothing real depends on the new stack yet.
- **Shadow-mode confirmed by design**: the `AUTH_BACKEND` mirror→verify→flip (`bd-2wo.22`–`.29`) keeps Dynamic live; the new substrate flips only on operator GO. No cutover pressure (timeline: soon, no hard date).

## Blast-radius map

| Move | Blast radius |
|---|---|
| ADD Better Auth credential adapter behind `CredentialBridge` | **near-zero** — doesn't touch signer/JWKS/contract or prod |
| Change the ES256 svc-JWT contract | **empty now**; coordinated cross-repo re-vendor once a world vendors the SDK |
| Change identity-api runtime internals | **local** to the producer repo |

## Bead reconciliation (`bd-2wo`)

- **CLOSED — shipped** (evidence in tree): `.1` `protocol/user.ts`(+schema) · `.3` `protocol/jwt-claims.ts` · `.6` `adapters/migrations/0001_init_spine` · `.10` `adapters/jwks-validator.ts` · `.11` `adapters/credential-bridge-siwe.ts` · `.5` `protocol/VERSIONING.md` (source-distributed model superseded npm-publish; pkg `private:true`) · `.7` `ports/*.port.ts` (evolved naming: spine/jwt-signer/jwt-verifier vs old IUserRepo/ICredentialRepo) · `.8` `engine/resolve-spine.ts` + `link-verified-wallet.ts` (mint/link; revoke via credential `revoked_at`) · `.9` `engine/resolve-spine.ts` · `.18` `adapters/postgres-{spine,split}-adapter.ts` + `denylist-postgres.ts`.
- **PARTIAL — kept open**: `.2` (credential schema: `credential-dynamic` shipped; generic append-only `CredentialProof` to finalize with the adapter) · `.15` (`credential-bridge-dynamic.ts` shipped; the ESLint guard blocking `@dynamic-labs/*` not yet in place).
- **FUTURE — kept open**: `.4` world-manifest-auth schema (absent) · `.12` passkey + `.13` discord-bot bridges (now subsumed by the Better Auth adapter scope) · `.16` `pg-mibera-profiles` read · `.17` `dynamic-csv-translator` (the ~98k import) · `.19`/`.20`/`.21` mcp-tools (agent surface, not built) · `.22`–`.29` Mirror/Verify/Flip cutover · `.30`–`.33` distill.
- **ACTIVE BUILD**: `.14` `credential-bridge-better-auth` — unblocked (Sprint-0.5 `bd-3n1` PASSED GO), re-scoped to the credential-adapter decision above.
- **Cutover correction** (`.22`–`.29`): the source backend is **Dynamic** (not siwe-turso); Better Auth is **NOT** stood up as an issuer in Mirror — it is a credential adapter only.

## Sequencing

1. **Hygiene** (this record): reconcile beads · close `bd-3n1` (gate GO) · fix the stale "JWKS issuance lives at loa-freeside/apps/gateway" doctrine in `README.md` + `packages/protocol/src/index.ts` (false — the signer is the in-repo `LocalEs256Signer` per PRD v3.0; that gateway is a Discord/NATS gateway with no `/jwks` or `/issue`).
2. **Build** `bd-2wo.14` — Better Auth credential adapter behind `CredentialBridge` — via `code-implement-and-review`.
3. **Window opportunity** (independent): harden the ES256 svc-JWT contract while the change-window is free.
4. **Deferred / operator's call**: redeploy identity-api so the running build stops lagging `origin/main`; the user-JWT `HS256→ES256` swap (signer already exists).
