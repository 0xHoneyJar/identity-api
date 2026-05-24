@.claude/loa/CLAUDE.loa.md

> ⚠️ **SUPERSEDED IN PART (2026-05-24) — `grimoires/loa/prd.md` (PRD v3.0) is the authoritative current plan.**
> This repo is renamed **freeside-auth → identity-api** and graduated to the ecosystem's central identity **source-of-truth (SoR)**. PRD v3.0 **reverses three hard-rules stated below** (they reflect the 2026-04-30 Phase-0 stance):
> 1. **Writer (D1):** identity-api **writes** the canonical spine (mint user / wallets[] / credentials / per-world nyms). midi → one-time backfill → then **reads** from identity-api. ⟶ supersedes *"midi is the SINGLE WRITER"* below.
> 2. **Signer (D7):** v1 ships a **local ES256 signer** behind the `JWTSigner` port; the loa-freeside Rust gateway is a **preserved delegation seam, not v1**. ⟶ supersedes *"ships a validator … NOT a signer"* below.
> 3. **Name + distribution:** the building is **identity-api**; external consumption is **source-distributed** (`@0xhoneyjar/identity` vendored source, **NOT** an npm dependency).
>
> The full rewrite of this file + `docs/INTENT.md` + the BeaconV3 `is_not` to the SoR posture is **Phase-1 G-1 build work** (lands through review). **Until then, where this file and PRD v3.0 disagree, PRD v3.0 wins.**

# freeside-auth — agent instructions

This is a freeside-* installable module: **identity overlay** (wallet → canonical user_id + handles + JWT claims). Six packages: `protocol/` (sealed schemas), `ports/` (TS interfaces), `adapters/` (Postgres + JWKS validator + credential bridges), `mcp-tools/` (agent surface), `engine/` (4-tier resolve + credential-link + JWT helpers), `ui/` (shared admin React components — future).

Architectural intent: [`freeside-as-identity-spine`](https://github.com/0xHoneyJar/loa-hivemind/blob/main/wiki/concepts/freeside-as-identity-spine.md). The JWKS issuance runtime lives in [loa-freeside/apps/gateway](https://github.com/0xHoneyJar/loa-freeside) (Rust); profile data of record lives in midi (Railway PG). This module is the schemas + clients + algorithms that bridge them.

## When loaded

Load this CLAUDE.md when:
- Operator extracts identity code from midi (`lib/server/resolve-wallet.ts`) → `engine/`
- Operator extracts identity code from freeside-ruggy (`apps/bot/src/agent/freeside_auth/`) → `adapters/` + `mcp-tools/`
- Operator extracts JWKS validator from loa-freeside (`packages/adapters/agent/s2s-jwt-validator.ts`) → `adapters/jwks-validator.ts`
- Operator authors a new world that wants identity (declares `compose_with: freeside-auth` in world-manifest.yaml)
- Operator extends the protocol with new credential proof shapes (e.g. SeedVault when Solana support lands)

## Hard rules

- **Schemas live here, profile DATA stays in midi.** Identity schemas (wallet → user_id, JWT claims, credential proof shapes) are this module's job. Profile WRITES (display_name, discord_id, mibera_id, additional_wallets) stay in midi's onboarding flow. midi is the SINGLE WRITER. Per [[contracts-as-bridges]] + [[freeside-as-identity-spine]].
- **JWKS issuance stays at loa-freeside/apps/gateway.** This module ships a *validator* + claims schema, NOT a signer. The Rust gateway issues; everyone else verifies. Don't recreate the issuer here.
- **Score data is OFF LIMITS.** Per [[score-vs-identity-boundary]] (2026-04-29 doctrine): factors, ranks, scoring belong to score-mibera. This module joins via `User.wallets[]` with score's `Wallet` entity but never embeds factor data into Identity. Cross-coupling them is the antipattern.
- **Credential providers are external.** Dynamic SDK, Better Auth, SeedVault are libraries we COMPOSE with, not absorb. Adapter pattern: `packages/adapters/credential-bridge-{dynamic,better-auth,seedvault}.ts` translates external proof → canonical CredentialProof schema.
- **Schema governance imported from loa-constructs.** Enum-locked `schema_version`, additive-only minor bumps, major bumps require migration plan + new file + stable `$id` (per `packages/protocol/VERSIONING.md`).
- **Naming follows attachment-prefix doctrine.** `freeside-auth` is plural — mirrors `freeside-worlds`, `freeside-quests` (registry of multiple subjects). Per [[loa-org-naming-conventions]].

## Composition

- `0xHoneyJar/freeside-ruggy` (`apps/bot/src/agent/freeside_auth/`) — current in-bot proxy; replaces with `mcp-tools/resolve_wallet` once published
- `0xHoneyJar/loa-freeside` (`apps/gateway/`) — Rust JWKS issuance runtime; mirror its claims shape in `protocol/jwt-claims.schema.json`
- `mibera-dimensions/lib/server/resolve-wallet.ts` — extracts to `packages/engine/resolve-tier.ts`
- `mibera-dimensions/lib/score-api/client.ts` (getWalletGroup) — shared with score-mibera; coordinate
- `bonfire/grimoires/bonfire/context/auth-unification-seed/` — 8-file seed bundle, especially `02-current-state-audit.md` (per-app divergence), `05-migration-options.md`, `06-open-decisions.md`

## What this repo does NOT own

- The JWKS issuance runtime (`loa-freeside/apps/gateway/` STAYS as canonical signer)
- World-specific login UX (each world owns its Dynamic / passkey / SIWE flow)
- midi profile content (the actual users, their handles, their linked credentials — stays in midi)
- Better Auth deployment (it's a library we compose with via adapters)
- score data (per [[score-vs-identity-boundary]] — that boundary is load-bearing)

## ECS placement (per [[ecs-architecture-freeside]])

| | role |
|---|---|
| **Entity** | `User` (canonical, owned by this module's schemas) + `Wallet` (chain-scoped, owned by score-mibera) |
| **Component** | `IdentityComponent` (credentials[], handle, discord_link, tenant) attaches to User; `FactorEvent` Components attach to Wallet (score's domain) |
| **System** | `AuthSystem` — iterates User entities with IdentityComponents; joins via `User.wallets[]` to surface enriched data; never reads factor events directly |

## References

- [`freeside-as-identity-spine`](https://github.com/0xHoneyJar/loa-hivemind/blob/main/wiki/concepts/freeside-as-identity-spine.md)
- [`score-vs-identity-boundary`](https://github.com/0xHoneyJar/loa-hivemind/blob/main/wiki/concepts/score-vs-identity-boundary.md)
- [`freeside-modules-as-installables`](https://github.com/0xHoneyJar/loa-hivemind/blob/main/wiki/concepts/freeside-modules-as-installables.md)
- [`ecs-architecture-freeside`](https://github.com/0xHoneyJar/loa-hivemind/blob/main/wiki/concepts/ecs-architecture-freeside.md)
- [`contracts-as-bridges`](https://github.com/0xHoneyJar/loa-hivemind/blob/main/wiki/concepts/contracts-as-bridges.md)
- [`loa-org-naming-conventions`](https://github.com/0xHoneyJar/loa-hivemind/blob/main/wiki/concepts/loa-org-naming-conventions.md)
- Auth unification seed: `bonfire/grimoires/bonfire/context/auth-unification-seed/`
