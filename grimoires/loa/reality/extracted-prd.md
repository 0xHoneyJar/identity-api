# Extracted PRD (code reality)

> Code-derived requirements only. Not a product vision rewrite.  
> Operator PRD v3.0 archived at `legacy/pre-ride-2026-07-19/prd.md`.

## Who the system serves (from code)

| Actor | Evidence |
|-------|----------|
| End-user with wallet | `/v1/auth/*`, wallet link routes — `src/api/routes/auth.ts`, `link.ts` |
| Discord-linked user | `discord-link.ts`, `auth-discord.ts`, `src/discord-oauth.ts` |
| Service/cell consumers | `v1/auth/service-jwt`, denylist — `src/api/routes/v1/auth/` |
| World/CM operators | `v1/users/managed-worlds` |
| Agents (planned) | MCP tools README only — `packages/mcp-tools/README.md` |

## Capabilities present in code

1. **Spine SoR writes/reads** — users, wallet_links, linked_accounts, world_identity `[GROUNDED]` `0001_init_spine.up.sql:29-119`
2. **Wallet-first resolve + link-with-audit** — `[GROUNDED]` `packages/engine/src/resolve-spine.ts:49+`
3. **SIWE / EIP-191 / Dynamic credential bridges** — `[GROUNDED]` `packages/adapters/src/credential-bridge-*.ts`
4. **HTTP API on Hyper** — resolve, profile, link, discord, JWKS, svc-JWT `[GROUNDED]` `src/api/index.ts:81-107`
5. **JWTSigner port + Http + Local ES256 (svc)** — `[GROUNDED]` `ports/jwt-signer.port.ts`, `local-es256-signer.ts`
6. **Profile / Mibera dimensions routes registered** — `[GROUNDED]` `src/api/index.ts:90-91`

## Capabilities claimed but absent (handoff / docs)

| Claim | Status |
|-------|--------|
| Hexagonal `domain/` / `application/` tree | **GHOST** — not in repo |
| `link_intents` / `auth_intents` / `credential_links` tables | **GHOST** — spine uses `linked_accounts` + `auth_nonces` |
| `CompleteCredentialLink` use case module | **GHOST** — link flows in engine + routes |
| MCP tool implementations in-package | **GHOST** — README scaffold only |
| Full 4-tier resolve-tier.ts | **STALE claim** — `resolve-spine.ts:21-27` says single-tier today |

## Non-goals visible in schema

- No score/dimensions/holdings columns on spine — `[GROUNDED]` `0001_init_spine.up.sql:13-14`
