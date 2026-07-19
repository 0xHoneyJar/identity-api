# Terminology

> Generated: 2026-07-19 · `/ride --enriched` Phase 14 · max ~50 terms

| Term | Meaning in this repo | Avoid confusing with |
|------|----------------------|----------------------|
| Spine | PG tables for identity SoR | Score DB / midi profiles |
| `users` | Canonical human row | Handoff `canonical_users` |
| `wallet_links` | Verified wallet binding | Wallet connection UX state |
| `linked_accounts` | Off-chain provider binding | Handoff `credential_links` |
| `external_id` | Provider subject id | OIDC `issuer` (not stored separately) |
| Provider | `discord` / `telegram` / `dynamic_user_id` | Credential bridge name |
| World identity | Per-world nym row | Global username |
| JWTSigner | Port for signing user/service JWTs | Discord bot tokens |
| svc-JWT | Service JWT (cell) | End-user session JWT |
| HttpJWTSigner | Delegates to gateway | LocalEs256Signer |
| LocalEs256Signer | File/env ES256 for svc-JWT | User HS256 middleware |
| Credential bridge | External proof → canonical proof | OAuth route handlers |
| Resolve | Map wallet/account/nym → user | DNS / ENS |
| Audit event | Spine `audit_events` row | Traefik access logs |
| Hyper | Vendored HTTP framework under `src/hyper` | Hyperliquid |
| `@freeside-auth/*` | Workspace package scope | Published npm name |
| `@0xhoneyjar/identity` | Vendored consumer alias for SDK | Workspace name |
| MCP tools | Planned agent tools | Implemented Hyper MCP meta opt-in |
| Handoff | 2026-07-19 auth-linking package in context/ | Production code |
| PRD v3.0 (archived) | Operator narrative pre-ride | Ride-grounded `prd.md` |
