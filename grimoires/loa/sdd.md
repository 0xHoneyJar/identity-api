---
title: SDD — identity-api (ride-grounded)
status: ride-extracted 2026-07-19
ride: --enriched
---

# SDD — identity-api (Code-Grounded)

## 1. Tech stack `[GROUNDED]`

| Layer | Choice | Evidence |
|-------|--------|----------|
| Runtime | Bun + Hyper HTTP | `src/api/index.ts`, `src/hyper/` |
| Language | TypeScript | packages + src |
| DB | PostgreSQL + SQL migrations | `packages/adapters/src/migrations/` |
| Schemas | protocol package (Effect/zod-style seals) | `packages/protocol/` |
| Auth crypto | jose / ES256 for svc-JWT; HS256 user middleware today | `local-es256-signer.ts`; `src/api/index.ts:75` |
| Packaging | npm workspaces `@freeside-auth/*` | `packages/*/package.json` |

## 2. Module structure

See `reality/extracted-sdd.md`. Dependency rule in engine: ports only, not adapters — `[GROUNDED]` `resolve-spine.ts:14-18`.

## 3. Data model

Canonical spine tables in migration `0001` (+ 0002-0009 extensions). Handoff table names are **not** implemented — map conceptually:

| Handoff name | Repo reality |
|--------------|--------------|
| canonical_users | `users` |
| credential_links | `linked_accounts` (+ wallet_links for wallets) |
| link_intents / auth_intents | **absent** (use `auth_nonces` + HTTP state) |
| identity_sessions | Hyper/session cookie layer — not spine table |
| identity_audit_events | `audit_events` |

## 4. API surface

Registered routes in `src/api/index.ts:81-132`. OpenAPI at `/openapi.json` + `/docs`.

## 5. Resolve design

`[GROUNDED]` Wallet-first engine helpers in `resolve-spine.ts`.  
`[DISPUTED: package.json vs resolve-spine.ts]` Full 4-tier fallback file not present; comments describe future composition.

## 6. Credential design

Bridges implement `ICredentialBridge`-style translation to canonical proofs (`credential-bridge-*.ts`). Discord linking is route-level OAuth, not a bridge file.

## 7. Signing design

| Path | Impl |
|------|------|
| Port | `JWTSigner` `packages/ports/src/jwt-signer.port.ts` |
| Remote | `HttpJWTSigner` → gateway |
| Local svc | `LocalEs256Signer` / env loader |
| Verify | `jwks-validator`, `svc-jwt-verifier`, `auth-sdk` |

## 8. Security notes `[GROUNDED]`

- No silent merge documented in engine audit collision paths (verify per route tests)
- `linked_accounts` uniqueness on `(provider, external_id)` — not issuer-scoped
- CSRF/session helpers under `src/hyper/session/`

## Grounding Summary

| Marker | Approx % |
|--------|---------:|
| GROUNDED | 85% |
| DISPUTED | 5% |
| INFERRED | 10% |
