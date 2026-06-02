# freeside-auth

> ⚠ **DRAFT — under major revision per codex 2026-04-29.** See
> `bonfire/grimoires/bonfire/context/freeside-auth-requirements-seed-2026-04-29.md`
> for canonical requirements heading into `/plan-and-analyze`. Six structural issues flagged
> (rename done; threat model + Discord/TG verifier flow + issuer sequencing + package
> cardinality + vendor-coupling + Dynamic-as-legacy still pending).

> ⚠ **ISSUER DOCTRINE SUPERSEDED (2026-06-01)** — `grimoires/loa/prd.md` (PRD v3.0) +
> `grimoires/loa/2026-06-01-auth-decision-reconciled.md` are authoritative. Statements below
> that *"the JWKS server runtime lives in `loa-freeside/apps/gateway` (Rust)"* and *"this
> module ships a validator, NOT a signer"* reflect the 2026-04 stance and are **stale**.
> PRD v3.0: identity-api ships an **in-repo local ES256 signer**
> (`packages/adapters/src/local-es256-signer.ts`) serving its own JWKS; the loa-freeside
> gateway is a **preserved delegation seam, not v1** (and is in fact a Discord/NATS gateway
> with no `/jwks` or `/issue` route). The full README/INTENT/BeaconV3 rewrite to the SoR
> posture is Phase-1 G-1 work (lands through review).

> The freeside-* installable module for **auth** across the THJ
> ecosystem — wallet → canonical user, multi-credential linking
> (SIWE / passkey / Discord-bot / Telegram-bot / Dynamic-legacy),
> JWT claims via Freeside JWKS. Sealed schemas + agent surface (MCP)
> + headless engine. Apps port into this; this module doesn't drive
> any one app's UX.

Renamed from `freeside-identities` 2026-04-29 per operator + codex
adversarial review. "Identity" was confusing in the agentic age (LLM
agents have identities too); `auth` is the operator-canonical name and
matches the box already named `FREESIDE-AUTH` in
[`score-vs-identity-boundary`](https://github.com/0xHoneyJar/loa-hivemind/blob/main/wiki/concepts/score-vs-identity-boundary.md).
The internal domain model retains `IdentityComponent`; only the
module + repo name changed.

This repo is the schemas + clients + engine side of the **identity spine** doctrine. The JWKS server runtime lives in [`loa-freeside/apps/gateway`](https://github.com/0xHoneyJar/loa-freeside/tree/main/apps/gateway) (Rust). Profile data of record lives in midi (Railway Postgres `midi_profiles`). This module bridges them with a sealed protocol surface.

Doctrine: [`freeside-modules-as-installables`](https://github.com/0xHoneyJar/loa-hivemind/blob/main/wiki/concepts/freeside-modules-as-installables.md) — instance-5 of the freeside-* attachment-prefix family.

Companion concept: [`freeside-as-identity-spine`](https://github.com/0xHoneyJar/loa-hivemind/blob/main/wiki/concepts/freeside-as-identity-spine.md) (architectural intent, 2026-04-16). Companion seam: [`score-vs-identity-boundary`](https://github.com/0xHoneyJar/loa-hivemind/blob/main/wiki/concepts/score-vs-identity-boundary.md) — names what score MUST NOT carry, and therefore what lives here.

Operator-extraction directive (vault `freeside-as-identity-spine`, auth-unification-seed/02-current-state-audit.md):

> *"Freeside JWKS infrastructure exists in loa-freeside/apps/gateway but is not consumed by any world. ZERO worlds issue Freeside tenant JWTs. Sessions are isolated per-app. Each world authenticates users independently without tenant_id/tier/pool_id claims that Freeside is designed to issue."*

This module ends that. Schemas + clients + MCP for wallet→identity resolution. Worlds opt in.

## The six packages

```
freeside-auth/
├── packages/
│   ├── protocol/    📐 sealed schemas — User, Wallet, IdentityComponent, JWT claims, credential proofs
│   ├── ports/       🔌 IIdentityService + IJwksProvider TS interfaces
│   ├── adapters/    🔁 typed clients — Postgres (midi_profiles), JWKS validator, Dynamic bridge, future Better Auth + SeedVault
│   ├── mcp-tools/   🤖 agent-callable surface — resolve_wallet, resolve_wallets, verify_token (used by ruggy + future persona-bots)
│   ├── engine/      ⚙️ headless tier-resolution + credential-link + JWT issuance helpers (extracts midi `lib/server/resolve-wallet.ts`)
│   └── ui/          🎨 shared admin React components — link-wallet, view-credentials, identity-debug (for freeside-dashboard, later)
└── docs/
    ├── INTENT.md            why this module exists, what it extracts, what stays
    ├── EXTRACTION-MAP.md    per-file source paths in midi + freeside-ruggy + loa-freeside
    └── INTEGRATION-PATH.md  staged cutover plan (in-bot mcp today → freeside-auth consumers)
```

| package | role | analogous to |
|---|---|---|
| `protocol/` | wire-format contracts (Draft 2020-12 JSON Schema + Zod) | `freeside-worlds/packages/protocol/`, `freeside-quests/packages/protocol/` |
| `ports/` | TS interfaces consumers depend on; impls bind to these | hexagonal architecture port pattern, per [[contracts-as-bridges]] |
| `adapters/` | concrete impls of ports over wire (HTTP, pg, JWKS) | `freeside-quests/packages/adapters/`, `freeside-score/packages/adapters/` |
| `mcp-tools/` | MCP tool specs for agent runtimes | `freeside-quests/packages/mcp-tools/` |
| `engine/` | headless identity logic (resolve-tier algo, credential-link semantics, JWT helpers) | what midi's `lib/server/resolve-wallet.ts` becomes when extracted |
| `ui/` | shared admin React components | future — for freeside-dashboard's identity tab |

## What lives here vs what stays elsewhere

| concern | here (`freeside-auth`) | stays elsewhere |
|---|---|---|
| User / Wallet / IdentityComponent JSON schemas + Zod | ✅ `packages/protocol/` | — |
| JWT claims schema (sub, wallets[], handle, tenant, tier, exp) | ✅ `packages/protocol/jwt-claims.schema.json` | — |
| Credential proof schemas (SIWE, passkey, Dynamic, SeedVault) | ✅ `packages/protocol/credential-*.schema.json` | — |
| `resolveProfileWallet` 4-tier algorithm | ✅ `packages/engine/resolve-tier.ts` (extracted) | midi `lib/server/resolve-wallet.ts` (current home) |
| Postgres adapter for `midi_profiles` table | ✅ `packages/adapters/pg-midi-profiles.ts` | midi onboarding remains the WRITER |
| JWKS validator client (with cache + stale-if-error) | ✅ `packages/adapters/jwks-validator.ts` | impl extracted from `loa-freeside/packages/adapters/agent/s2s-jwt-validator.ts` |
| MCP tool specs (`mcp__identities__*`) | ✅ `packages/mcp-tools/` | — |
| **JWKS issuance runtime (the actual JWT signer)** | — | ✅ `loa-freeside/apps/gateway` (Rust). This module wraps it. |
| **Profile DATA of record** | — | ✅ midi onboarding + Railway PG `midi_profiles` |
| **Credential providers (Dynamic SDK, Better Auth, SeedVault)** | — | ✅ external libs. This module composes with them via adapters. |
| **Per-world login UX** | — | ✅ each world owns its login flow |

## Why `freeside-auth` (plural slug)

Per [[loa-org-naming-conventions]] + [[freeside-modules-as-installables]]: plural slugs mark "registry of multiple subjects" (matches `freeside-worlds`, `freeside-quests`). A single canonical user has MANY linked credentials (SIWE wallet + passkey device + Dynamic OAuth + future SeedVault), MANY wallets across chains, MANY tenant memberships. Plural feels right at the module level.

## Family

| sibling | role |
|---|---|
| `freeside-worlds` | meta layer for worlds — sealed schemas + registry → terraform |
| `freeside-score` | keeper of score schemas — factor metadata, IScoreServiceClient port |
| `freeside-filesystem` | file storage layout + metadata serving |
| `freeside-quests` | quest defs + completion + badges + raffles |
| `freeside-ruggy` | persona-layer Discord bot (consumes mcp-tools from here for wallet → handle) |
| **`freeside-auth`** (this) | identity overlay — wallet → user_id + handles + JWT |

## Status: scaffolded; extraction staged

Today's identity logic is split:
- **midi** owns the profile data + the 4-tier resolve algorithm (`lib/server/resolve-wallet.ts`)
- **freeside-ruggy** has an in-bot proxy MCP (`apps/bot/src/agent/freeside_auth/`) that hits midi's Postgres directly
- **loa-freeside/apps/gateway** is the unconsumed JWKS issuance runtime

This repo's job: extract the schemas + algorithms + adapters into a sealed module so the worlds + ruggy + future persona-bots all consume one contract. Sequenced extraction in `docs/INTEGRATION-PATH.md`.

## Composition

- `freeside-ruggy` consumes `mcp-tools/resolve_wallet` + `mcp-tools/resolve_wallets` (replaces in-bot `freeside_auth` proxy when ready)
- `loa-freeside/apps/gateway` (Rust) is the JWKS issuance runtime; this module's Zod claims schemas mirror its issued JWT shape
- `0xHoneyJar/freeside-worlds` worlds opt in via `compose_with: freeside-auth` in `world-manifest.yaml`
- `0xHoneyJar/freeside-score` consumers JOIN `User` entities here with `Wallet` factor data there — never embed
- Future `freeside-dashboard` Identity tab uses `packages/ui/` for admin views

## References

- Architectural intent: [`freeside-as-identity-spine`](https://github.com/0xHoneyJar/loa-hivemind/blob/main/wiki/concepts/freeside-as-identity-spine.md) (2026-04-16)
- Boundary doctrine: [`score-vs-identity-boundary`](https://github.com/0xHoneyJar/loa-hivemind/blob/main/wiki/concepts/score-vs-identity-boundary.md) (2026-04-29)
- Auth unification audit: `bonfire/grimoires/bonfire/context/auth-unification-seed/02-current-state-audit.md`
- Migration provenance: Supabase → Railway Postgres + Drizzle, 2026-04-03 by notzerker (loa-freeside#153)
- ECS placement: per [[ecs-architecture-freeside]] — User Entity (canonical) + Wallet Entity + Identity Component + AuthSystem
