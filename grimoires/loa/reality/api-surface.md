# API Surface

## HTTP (registered in `src/api/index.ts`)

| Area | Routes (files) |
|------|----------------|
| Health | `routes/health.ts` |
| Auth | `auth.ts` challenge/verify |
| Me | `me.ts` |
| Resolve | `resolve.ts` wallet/account/nym/identity |
| Profile | `profile.ts` getProfile, getMiberaDimensions |
| Batch | `identity-resolve.ts` |
| Link | `link.ts` verified-wallet, wallet-only |
| Discord | `discord-link.ts`, `auth-discord.ts` |
| JWKS | `well-known-jwks.ts` |
| svc-JWT | `v1/auth/service-jwt`, denylist check |
| CM | `v1/users/managed-worlds` |
| Docs | `/openapi.json`, `/docs` |

## Package exports (consumers)

| Package | Surface |
|---------|---------|
| `@freeside-auth/identity-client` (`packages/sdk`) | Typed HTTP client |
| `@freeside-auth/auth-sdk` | svc-JWT verify / JWKS cache |
| `@freeside-auth/protocol` | Schemas / types |
| `@freeside-auth/ports` | Interfaces for embedders |
| `@freeside-auth/mcp-tools` | **Planned only** (README) |

## Engine functions (selected)

- `resolveByWallet`, link/setPrimary with audit — `packages/engine/src/resolve-spine.ts`
- `MintJwtOrchestrator` — `packages/engine/src/mint-jwt-orchestrator.ts`
