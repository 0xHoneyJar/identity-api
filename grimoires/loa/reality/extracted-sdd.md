# Extracted SDD (code reality)

## Topology

```
src/api (Hyper HTTP) ──► packages/engine (resolve/link/mint) ──► packages/ports
         │                         │
         │                         ▼
         └──────────────► packages/adapters (Postgres spine, bridges, signers)
                                  │
                                  ▼
                         packages/protocol (schemas)
```

`packages/sdk` + `packages/auth-sdk` = consumer-facing vendored clients.  
`packages/mcp-tools` = docs-only scaffold.  
`src/hyper/**` = vendored HTTP substrate.

## Modules (packages)

| Package | Role | Evidence |
|---------|------|----------|
| `@freeside-auth/protocol` | Wire schemas | `packages/protocol/package.json` |
| `@freeside-auth/ports` | Interfaces (SpinePort, JWTSigner, bridges) | `packages/ports/src/` |
| `@freeside-auth/engine` | Resolve/link/mint orchestration | `packages/engine/src/resolve-spine.ts`, `mint-jwt-orchestrator.ts` |
| `@freeside-auth/adapters` | PG + bridges + JWKS + signers | `packages/adapters/src/` |
| `@freeside-auth/identity-client` | HTTP client (vendored) | `packages/sdk/` |
| `@freeside-auth/auth-sdk` | svc-JWT verifier (vendored) | `packages/auth-sdk/` |
| `@freeside-auth/mcp-tools` | Planned MCP (no src) | `packages/mcp-tools/README.md` |
| `@freeside-auth/ui` | Future admin UI | package.json "FUTURE" |

## Data model (spine)

| Table | Purpose | Migration |
|-------|---------|-----------|
| `users` | Canonical user_id | `0001:29` |
| `wallet_links` | Wallet↔user + primary | `0001:39` |
| `linked_accounts` | discord/telegram/dynamic_user_id | `0001:67` UNIQUE(provider,external_id) |
| `worlds` / `world_identity` | Per-world nyms | `0001:83-99` |
| `audit_events` | Append-ish audit | `0001:110` |
| `auth_nonces` | Pre-user wallet auth | `0001:127` |
| `cell_api_keys` | Cell auth | `0003` |
| `operator_grants` | Ops | `0004` |
| `service_jwt_*` | svc-JWT issue/denylist | `0005-0006` |
| `world_managers` / name model | CM + nym types | `0007-0008` |
| world_identity upsert trigger | Upsert recompute | `0009` |

**Not present:** `canonical_users`, `credential_links`, `credential_proofs`, `link_intents`, `auth_intents`, `identity_sessions` (handoff names).

## API surface (registered)

From `src/api/index.ts:81-107`: health, auth challenge/verify, me, resolve (wallet/account/nym/identity), profile + mibera dimensions, identity batch, link verified/wallet-only, discord link + oauth, JWKS, service JWT, denylist check, managed worlds, openapi.

## Auth / session

- Route auth via `authJwtPlugin` — currently `HS256` `[GROUNDED]` `src/api/index.ts:74-76`
- Session helpers in `src/hyper/session/` + `src/auth.ts`
- Discord OAuth helpers in `src/discord-oauth.ts`
- User JWT signing: `JWTSigner` → `HttpJWTSigner` (gateway) or test in-memory; svc-JWT: `LocalEs256Signer`

## Credential adapters present

- `credential-bridge-siwe.ts`
- `credential-bridge-eip191.ts`
- `credential-bridge-dynamic.ts`
- Discord HTTP routes (not a separate hexagonal "adapter package")
