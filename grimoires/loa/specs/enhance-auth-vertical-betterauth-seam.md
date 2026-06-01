# Session — Auth Vertical: Better Auth seam (sovereign-auth cutover)

> The identity keystone. We're not hand-building auth anymore — we adopt Better Auth for the *person*, and build sovereign only where the cluster is actually novel: the *account*.

## Context
The auth vertical (`bd-2wo`) is the cluster's biggest-fan-out keystone — the Dynamic→sovereign identity cutover. The Coordinate gate (`bd-3n1`) is **CLOSED at GO**: a running spike (2026-06-01) proved Better Auth fits the **person layer** — its `user` + multi-`account`-per-user *is* the wallet-group, with SIWE / organization=world / per-world JWT, on Drizzle/Postgres, self-hosted (sovereign). So the May-1 plan's hand-built canonical-user engine is **dropped**; the build focuses on the sovereign pieces. Full design: `grimoires/loa/2026-06-01-auth-vertical-rescope.md`.

**The seam (the spine):**
```
PERSON  → Better Auth (adopt)      user · account×N = wallet-group · SIWE · organization=world · JWT(definePayload) · sessions
ACCOUNT → sovereign engine (build) per-world character · inventory · badges · TBA-graduation · CROSS-WALLET LINKING
```

## Run via — `code-implement-and-review` (REQUIRED)
This is a security-critical backend build; run it through the implement→review loop, operator at the gate:
@~/bonfire/construct-compositions/compositions/delivery/code-implement-and-review.yaml
  → rails: implement each build-step → adversarial review (verification-integrity + IDOR/idempotency lens) → operator curates at the loop → next step. The migration + the cutover (steps 3, 5) get the heaviest review.

## Load Order (read first)
1. @~/bonfire/construct-compositions/compositions/delivery/code-implement-and-review.yaml — the loop
2. `grimoires/loa/2026-06-01-auth-vertical-rescope.md` — the design (drop/build split, sprints, gotchas, kaironic boundary)
3. `grimoires/loa/2026-06-01-better-auth-fit-poc.md` — the POC evidence (the seam, verified)
4. The running spike: `git show origin/spike/better-auth-poc:poc/better-auth-spike/auth.ts` (+ `db.ts`, `demo.ts`, `README.md`) — the reference implementation, gotchas baked in
5. memory `project_identity-account-capability-model` + `project_acvp-capability-authorization` — the person→account→TBA stack + the signature-is-the-capability doctrine

## Persona
ARCH (the-arcade/OSTROM) for the structural cutover + craft for the migration rigor. This is the sovereign-aggregator-substitution pattern applied to auth ([[sovereign-aggregator-substitution]]).

## What to Build (dependency-ordered)

### 0. Naming reconciliation (FIRST — the vocab everything inherits)
Better Auth `account` = a credential link. Our `account` = a per-world character. **Rename our game-account → `character` (or `playthrough`); reserve `account` for Better Auth's credential.** Settle this in the protocol/schema vocab before any code, or the seam blurs.

### 1. Stand up Better Auth in-repo (the foundation)
Port the spike's `auth.ts` into the real freeside-auth runtime: plugins `siwe` + `jwt` + `organization`; **Drizzle/Postgres** adapter (the spike used bun:sqlite — swap the connection per `db.ts`'s documented PG path); `jwt.definePayload` stamping `world`/`tenant` from a `user.activeWorld` additionalField; `additionalFields` for `dynamic_env_id` + migration fields. Generate schema via **internal `getSchema()`** (the `@better-auth/cli@1.4.21` lags the 1.6.13 runtime). All server-side calls use **`asResponse: true`**.

### 2. The cross-wallet LINKING CEREMONY (the sovereign piece no library gives)
Verify a 2nd wallet's SIWE signature → attach an `account` + `walletAddress` row to the *already-authenticated* user. (Better Auth auto-groups the same address across chainIds — proven 1+80094→1 user — but NOT distinct wallets from a session.) This is THE sovereign addition to the person layer.

### 3. Dynamic CSV migration → Better Auth `user` + `account`(siwe)  [heaviest review]
`dynamic-csv-translator`: ~98k Dynamic users ([[dynamic-export-reality]]: ~90k unique, 99% blockchain auth) → `user` rows, their wallets → `account` rows. **Idempotent + HARD count assertion.** Read-replica/snapshot source, PII-redacted logs.

### 4. mcp-tools (gateway-mediated; tool DOES NOT sign)
`resolve_wallet`, `link_credential` (= the ceremony, MCP-surfaced), `issue_jwt_for_world`.

### 5. Mirror → Verify → Flip the `AUTH_BACKEND` cutover  [heaviest review]
current (siwe-turso) → Better Auth/freeside-jwt: smoke canary (5+ routes) → parity 30/30 (hard threshold) → operator gate (human GO/NO-GO) → flag flip (30-min watch) → 7-day soak.

### 6. Distill
ADR-039 (Better Auth adoption + the seam, supersedes ADR-003/refines ADR-038) · threat model · migration runbook.

## Design Rules (spike-proven gotchas — bake these in)
- Server-side Better Auth calls: **`asResponse: true`** (the plain wrapper returns `{}`).
- Schema-gen: **internal `getSchema(options)`**, not the lagging external CLI.
- `/siwe/verify` is `requireRequest: true` — pass a `request: new Request(...)`.
- Per-world JWT: `jwt.definePayload((session) => ({world, tenant, ...}))` reading a user additionalField. EdDSA + `/jwks`.
- Berachain (80094): per-request `chainId` flows to `verifyMessage`; EOA `personal_sign` is chain-agnostic (no RPC); only EIP-1271 contract wallets need a Berachain RPC.
- viem's `verifyMessage` drops straight into the SIWE plugin's `verifyMessage` config.

## What NOT to Build (scope cuts)
- ✗ The May-1 hand-built `user`/`credential`/`jwt-claims` schemas, `canonical-user` engine, `jwks-validator`, `credential-bridge-{siwe,passkey,dynamic}` — **Better Auth provides these.** (Dynamic becomes a one-time CSV import, not a live bridge.)
- ⊙ The **ACCOUNT-layer depth** — per-world characters, inventory, TBA-graduation, the `.28` canonical-`identity_id` shape — is **kaironic, held open**. Build a MINIMAL account-stub (enough for per-world JWT scoping) only. Do NOT decide the account/TBA model in this cycle — firm the substrate *under* it.

## Verify
- Re-run the spike to confirm the baseline still holds: `git checkout origin/spike/better-auth-poc -- poc/` then `cd poc/better-auth-spike && bun install && bun run gen-schema.ts && bun run migrate.ts && bun run demo.ts` → SIWE 200, 3 account/1 user, decoded per-world JWT.
- Migration: the hard count assertion (≈98k → matching `user`+`account` row counts).
- Cutover: parity 30/30 + the smoke canary (csp_violations=0, jwt_present=true) before the flag flip.

## Key References
| Topic | Path |
|---|---|
| The design (drop/build, sprints, kaironic) | `grimoires/loa/2026-06-01-auth-vertical-rescope.md` |
| POC evidence (the seam, verified) | `grimoires/loa/2026-06-01-better-auth-fit-poc.md` |
| Running spike (reference impl) | `origin/spike/better-auth-poc` → `poc/better-auth-spike/` |
| Identity model + capability doctrine | memory `project_identity-account-capability-model`, `project_acvp-capability-authorization` |
| The vertical (re-scoped) / the gate (GO) | beads `bd-2wo` / `bd-3n1` |
