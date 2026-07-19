# Context Coverage

> Generated: 2026-07-19 by `/ride --enriched` Phase 1
> Interview: skipped (user_interaction=false on riding-codebase; handoff already ingested)

## Files Analyzed

| File | Key topics |
|------|------------|
| `handoff/.../README.md` | identity-api as SoR/issuer; providers as adapters |
| `handoff/.../CLAUDE_PROMPT.md` | Hexagonal layout; link/auth use cases; security invariants; wallet auth ladder |
| `handoff/.../docs/architecture/REFERENCE_ARCHITECTURE.md` | Ports/adapters topology; VerifiedCredentialEvidence |
| `handoff/.../docs/architecture/DOMAIN_MODEL.md` | CanonicalUser, CredentialKey, LinkIntent, collision policy |
| `handoff/.../docs/architecture/SECURITY_MODEL.md` | PKCE binding; no auto-link by email/handle |
| `handoff/.../docs/decisions/ADR-001..003` | SoR, credential adapters, wallet auth ladder |
| `handoff/.../docs/runbooks/IMPLEMENTATION_SEQUENCE.md` | Vertical-slice order |
| `handoff/.../reference-implementation/` | Projection skeleton (CompleteCredentialLink, InMemory, etc.) |
| `handoff/.../artifacts/*ahp*` | Auth-linking AHP matrix/report (decision weights) |
| `grimoires/loa/prd.md` (pre-existing v3.0) | G-1..G-6 SoR graduation, SIWE-first, profile compose |

## Topics Already Covered (skip in interview)

- Canonical SoR ownership (identity-api writes spine)
- Hexagonal dependency direction
- Link collision policy (no silent merge)
- Wallet auth ladder (session → AuthIntent → SIWX/SIWE → CAIP → session)
- Provider-neutral credential key `(provider, issuer, subject)`

## Gaps to Explore Against Code

- Whether `domain/` / `application/` / `ports/` layout exists vs packages/engine+adapters
- Whether `link_intents` / `auth_intents` / `identity_sessions` tables exist
- Discord OAuth2 + Telegram OIDC adapter presence
- JWTSigner / JWKS reality vs handoff "do not replace casually"
- Resolve-tier wallet-first graduation status

## Claims Extracted

See `claims-to-verify.md`.
