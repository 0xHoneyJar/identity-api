> ⚠️ **SUPERSEDED (2026-07-19):** Phase-0 "midi writer / validator-only" stance is obsolete. See `CLAUDE.md` hard rules + `grimoires/loa/prd.md` (D1 writer SoR, D-JWT-001 user ES256).

# INTENT — why freeside-auth exists

> The auth-unification audit (2026-04-16, `bonfire/grimoires/bonfire/context/auth-unification-seed/02-current-state-audit.md`) named the problem: "Freeside JWKS infrastructure exists in loa-freeside/apps/gateway but is not consumed by any world. ZERO worlds issue Freeside tenant JWTs. Each world authenticates users independently." This module ends that.

## What freeside-auth is

A sealed module providing:
1. **Schemas** for the canonical user model (User Entity + IdentityComponent + JWT claims + credential proof shapes)
2. **Adapters** that satisfy ports against today's reality (midi Postgres + loa-freeside JWKS)
3. **An MCP surface** so agent consumers (ruggy + future persona-bots) get one stable contract
4. **A headless engine** with the 4-tier resolve algorithm, credential-link logic, and JWT verifier — pure functions
5. (Future) **Admin UI** for freeside-dashboard's identity tab

## What freeside-auth is NOT

- ❌ A credential provider — not replacing Dynamic / Better Auth / SeedVault. Composes with them.
- ❌ The JWKS issuance runtime — that stays at `loa-freeside/apps/gateway` (Rust). This module is the verify side + claims schema.
- ❌ The profile data of record — midi onboarding remains the WRITER. This module READS via the Postgres adapter.
- ❌ A user table extension into score-mibera — per [[score-vs-identity-boundary]] (2026-04-29 doctrine), score keeps factor data, identity stays here. They JOIN via `User.wallets[]`; never embed.
- ❌ A user-facing login UI — worlds own their login UX.

## What it extracts (provenance)

| from | what | becomes |
|---|---|---|
| `mibera-dimensions/lib/server/resolve-wallet.ts` | 4-tier resolve algorithm (Tier 1: dynamic_user_id; Tier 2: additional_wallets; Tier 3: wallet_groups; Tier 4: direct) | `engine/resolve-tier.ts` |
| `mibera-dimensions/lib/supabase.ts` | (stale) Supabase client — replaced post-2026-04-03 migration | `adapters/pg-midi-profiles.ts` (Railway PG) |
| `mibera-dimensions/types/supabase.ts` | `midi_profiles` row schema | `protocol/identity-component.schema.json` |
| `mibera-dimensions/scripts/observer/railway-query.sh` | Railway Postgres connection pattern (`RAILWAY_MIBERA_DATABASE_URL`) | adapter env contract |
| `freeside-ruggy/apps/bot/src/agent/freeside_auth/server.ts` | In-bot MCP impl with cache + tier filtering | `mcp-tools/` + `adapters/pg-midi-profiles.ts` |
| `loa-freeside/packages/adapters/agent/s2s-jwt-validator.ts` | JWKS validator (cache 1h fresh / 72h stale / 60s refresh cooldown) | `adapters/jwks-validator.ts` + `engine/jwt-verify.ts` |
| `loa-freeside/apps/gateway` (Rust) | JWT issuance — stays put | mirrored in `protocol/jwt-claims.schema.json` |
| `vault/wiki/concepts/freeside-as-identity-spine.md` | Architectural intent — the canonical claims doc | shapes `protocol/jwt-claims.schema.json` |
| `vault/wiki/concepts/score-vs-identity-boundary.md` | The seam doctrine | enforced by package boundary discipline (see CLAUDE.md hard rules) |
| `bonfire/grimoires/bonfire/context/auth-unification-seed/` | 8-file seed bundle | `docs/INTEGRATION-PATH.md` migration phasing |

## Why now

- **Ruggy V0.5-D shipped** with an in-bot freeside_auth MCP that proves the resolve_wallet pattern works against real users. Extraction unblocks the next consumer (Dixie, B2B operator interface).
- **Score-mibera#70** filed 2026-04-29 to ship factor metadata from score-mcp. The boundary cleanly carves identity off; this module is the symmetric half of that ask.
- **Auth seed bundle** has been ready since 2026-04-16 — open decisions captured, migration options outlined. Operator's call to scaffold (2026-04-29) clears the path.
- **Solana support coming** (Purupuru). SeedVault is "another credential source" per the spine doctrine. Without this module, every world reinvents credential bridging.

## Success criteria

This module succeeds when:
1. ruggy's in-bot `freeside_auth` proxy is deleted, replaced by `import { createIdentitiesMcpServer } from '@freeside-auth/mcp-tools'`.
2. The first non-ruggy consumer (Dixie or Sprawl Dashboard or a future bot) installs the package and gets identity resolution without re-deriving the algorithm.
3. The JWKS server in loa-freeside/apps/gateway is consumed by AT LEAST ONE world via this module's `adapters/jwks-validator.ts`.
4. A Solana credential lands without architectural rewrites — just a new bridge adapter.

## Anti-success — drift signals

- A consumer reaches into midi_profiles directly instead of through this adapter
- score-mibera adds a `handle` column to its own data layer
- A world's auth flow encodes its own JWT claims shape instead of using `protocol/jwt-claims.schema.json`
- A second writer to the user table appears outside midi onboarding

If any of these surface, this module's boundary discipline failed and needs hardening.
