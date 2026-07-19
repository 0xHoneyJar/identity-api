# Consistency Report

> Generated: 2026-07-19 · `/ride --enriched` Phase 5

## Score: **7 / 10**

Strong ports/adapters/engine separation inside packages; naming drift between handoff vocabulary, package scope (`@freeside-auth/*`), and repo slug (`identity-api`).

## Naming patterns

| Pattern | Convention observed | Conflicts |
|---------|---------------------|-----------|
| Packages | `@freeside-auth/<pkg>` | Repo/product = `identity-api`; consumers alias `@0xhoneyjar/identity` |
| Spine tables | `users`, `wallet_links`, `linked_accounts` | Handoff: `canonical_users`, `credential_links` |
| Credential key | `(provider, external_id)` | Handoff: `(provider, issuer, subject)` |
| Routes | `/v1/...` Hyper `route.get/post` | Consistent within `src/api/routes` |
| Bridges | `credential-bridge-<name>.ts` | Consistent |
| Migrations | `NNNN_name.{up,down}.sql` | Consistent through 0009 |

## Organization

| Area | Assessment |
|------|------------|
| packages/* hexagonal (ports/protocol/engine/adapters) | Aligned, clear arrows |
| HTTP in `src/api` not under packages | Intentional runtime building |
| `src/hyper` large vendored tree | Mixing substrate + product in one tree |
| mcp-tools empty of src | Docs/code asymmetry |

## Improvement opportunities (flag only)

1. Rename or dual-document `@freeside-auth` → identity-api vocabulary in READMEs.
2. Either implement handoff intent tables **or** mark handoff as future-cycle (avoid dual schemas).
3. Land `resolve-tier.ts` or stop claiming 4-tier in package.json.
4. Implement or demote `packages/mcp-tools` from "planned tools" table to "deferred".
5. Swap HS256 → ES256 when Local/Http signer path is production-ready (`src/api/index.ts:75`).

## Breaking-change watchlist

- Changing `linked_accounts` PK to add `issuer` (handoff) would be a migration + resolve rewrite.
- Introducing parallel `credential_links` alongside `linked_accounts` risks dual SoR.
