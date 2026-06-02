# Auth Vertical — re-scope to the Better-Auth seam + identity model

> ⛔ **SUPERSEDED (2026-06-01, operator-ratified) — see `grimoires/loa/2026-06-01-auth-decision-reconciled.md`.**
> This doc's *"DROP the hand-built canonical-user/jwks/credential-bridges, adopt Better Auth as the issuer"* framing was a **confabulation**: it read the stale-`open` `bd-2wo` beads as an unbuilt plan, but that stack is **shipped + reviewed** (built off-bead, T1.x→w2.5-sprint-3). Corrected decision: **keep the ES256 stack as issuer/SoR; Better Auth = a per-world credential adapter behind `CredentialBridge`** (PRD v3.0-sanctioned). Do not build from this doc.

**date:** 2026-06-01 · **supersedes** the May-1 `bd-2wo` SDD's hand-built canonical-user plan · **decision:** Better Auth GO (running spike PASS, `bd-3n1` closed) · **for:** a fresh focused build session (`/kickoff`)

## Why re-scope
The May-1 SDD predates (a) the **person→account(TBA)→inventory identity model** (2026-05-31) and (b) the **Better Auth GO** (running spike, 2026-06-01). Building it as-written would hand-build a flat canonical-user engine that Better Auth gives for free. This re-scope realigns the cycle to the verified seam — **the build shrinks.**

## The seam (the spine of the re-scope)
```
PERSON layer  → BETTER AUTH (adopt)        user · account×N = wallet-group · SIWE · organization=world · JWT · sessions
ACCOUNT layer → SOVEREIGN ENGINE (build)   per-world character · inventory · badges · TBA-graduation · CROSS-WALLET LINKING
```

## DROP from the May-1 plan (Better Auth provides — verified by the running spike)
- `bd-2wo.1-.5` hand-built `user`/`credential`/`jwt-claims`/`world-manifest` schemas → Better Auth schema (+ `additionalFields`).
- `bd-2wo.8` `canonical-user` engine (mint/link/revoke) → Better Auth `user` + account-linking.
- `bd-2wo.10` `jwks-validator` → Better Auth JWT plugin (EdDSA + `/jwks`).
- `bd-2wo.11/.12/.15` credential-bridge-siwe/passkey/dynamic → Better Auth SIWE/passkey plugins (Dynamic becomes a one-time CSV import, not a live bridge).

## BUILD (sovereign — the cycle's real focus)
1. **Stand up Better Auth in freeside-auth** (the real instance, not the spike): plugins `siwe` + `jwt` + `organization`, **Drizzle/Postgres** adapter, `jwt.definePayload` stamping `world`/`tenant` from a `user.activeWorld` additionalField, `additionalFields` for `dynamic_env_id` + migration fields. Schema-gen via **internal `getSchema()`** (the `@better-auth/cli@1.4.21` lags the 1.6.13 runtime — drift). Server-side calls use **`asResponse: true`**. (All proven in the spike: `origin/spike/better-auth-poc`.)
2. **The cross-wallet LINKING CEREMONY** (the piece no library gives): verify a 2nd wallet's SIWE signature → attach an `account` + `walletAddress` row to the *already-authenticated* user. (Better Auth auto-groups the same address across chainIds, but NOT distinct wallets from a session — this is sovereign.)
3. **The ~98k Dynamic CSV migration** → Better Auth `user` + `account`(siwe) tables (idempotent; HARD count assertion; the `dynamic-csv-translator` maps Dynamic users→`user`, wallets→`account`). Per `dynamic-export-reality` (~90k users, 99% blockchain auth).
4. **mcp-tools** (gateway-mediated, tool DOES NOT sign): `resolve_wallet`, `link_credential` (= the ceremony, MCP-surfaced), `issue_jwt_for_world`.
5. **Mirror → Verify → Flip** the `AUTH_BACKEND` cutover (current siwe-turso → Better Auth/freeside-jwt): smoke canary → parity 30/30 → operator gate → flag flip → soak. (The existing `bd-2wo.22-.29` Sprint-5 shape holds; the substrate underneath just changed to Better Auth.)
6. **Distill**: ADR-039 (Better Auth adoption + the seam), threat model, migration runbook.

## ⚠ Carry-forward decisions (baked in)
- **Naming reconciliation**: Better Auth `account` = a credential link; our `account` = a per-world character. Rename our game-account (`character`/`playthrough`); reserve `account` for the credential. Do this in the schema/protocol vocab FIRST.
- **Per-world JWT**: `jwt.definePayload` (custom claim) is the mechanism; organization-membership is the alternative. Both work (spike-proven).
- **Berachain (80094)**: per-request `chainId` flows to `verifyMessage`; EOA `personal_sign` is chain-agnostic (no RPC); only EIP-1271 contract wallets need a Berachain RPC.

## ⊙ KAIRONIC boundary (NOT this cycle)
The **ACCOUNT layer's depth** — per-world characters, inventory, TBA-graduation, the `.28` canonical-`identity_id` shape — is the [identity-account-capability-model] frontier, held open kaironically. **This auth cycle delivers the PERSON layer (Better Auth) + the cross-wallet linking + a minimal account-stub** (enough for per-world JWT scoping). The character/inventory/TBA model evolves separately — do NOT force it into this cycle. The auth cycle firms the substrate *under* the account model without deciding the account model.

## Reference
- Running spike: `origin/spike/better-auth-poc` (`poc/better-auth-spike/` — `auth.ts`, `db.ts`, `demo.ts`, README + gotchas).
- POC evidence: `grimoires/loa/2026-06-01-better-auth-fit-poc.md`.
- Identity model + capability doctrine: memory `project_identity-account-capability-model`, `project_acvp-capability-authorization`.
- Beads: `bd-2wo` (the vertical, re-scoped here) · `bd-3n1` (Coordinate gate, CLOSED GO).
