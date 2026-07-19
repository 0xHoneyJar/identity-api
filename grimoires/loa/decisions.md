# Decision Archaeology

> Generated: 2026-07-19 · `/ride --enriched` Phase 13

## Active decisions (evidence in-repo)

| ID | Decision | Evidence | Age signal |
|----|----------|----------|------------|
| D-spine-sor | identity-api owns PG spine (users/wallets/accounts) | `0001_init_spine.up.sql` header | 2026 cycle |
| D-score-boundary | No score/holdings in spine | `0001:13-14` | Locked |
| D-ports-engine | Engine depends on ports, not adapters | `resolve-spine.ts:14-18` | Locked |
| D-dynamic-demote | `dynamic_user_id` is linked_accounts provider | `0001:69` CHECK | Locked |
| D-jwt-signer-port | Signing behind `JWTSigner` | `ports/jwt-signer.port.ts` | Locked |
| D-svc-local-es256 | svc-JWT local ES256 signer | `local-es256-signer.ts` | W2.5 |
| D-hyper-runtime | HTTP via Hyper in `src/api` | `src/api/index.ts` | Active |
| D-vendor-sdk | `@0xhoneyjar/identity` source-distributed | sdk package.json description | PRD v3.0 lock-in |

## Stale / disputed decisions

| Decision | Conflict |
|----------|----------|
| midi single-writer | CLAUDE.md body vs spine write code + archived PRD Q1 |
| No signer in this repo | CLAUDE.md vs JWTSigner + LocalEs256Signer |
| 4-tier resolve shipped | package.json vs resolve-spine single-tier comment |
| Handoff hexagonal SoR shape | CLAUDE_PROMPT vs packages layout |

## Handoff ADRs (claims — not yet ratified in code)

| ADR | Claim | Code status |
|-----|-------|-------------|
| ADR-001 | identity-api as SoR | Aligned in spirit; table names differ |
| ADR-002 | Credential adapters | Partial (SIWE/EIP191/Dynamic; missing TG/passkey) |
| ADR-003 | Wallet auth ladder | Partial (auth_nonces + routes; no AuthIntent entity) |
