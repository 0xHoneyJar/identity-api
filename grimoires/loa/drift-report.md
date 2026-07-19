# Drift Report

> Generated: 2026-07-19 · `/ride --enriched` Phase 4  
> Sources: code vs `legacy/pre-ride-2026-07-19/prd.md` vs handoff `CLAUDE_PROMPT.md`

## Summary

| Category | Count | Severity |
|----------|------:|----------|
| Ghost (claimed, missing) | 8 | Critical |
| Hallucinated / Stale | 3 | High |
| Shadow (code, weak docs) | 4 | Medium |
| Aligned | 9 | Healthy |

**Drift score: 48 / 100** (revised after deep extract agents) — spine SoR + SIWE/profile compose are real; handoff hex/intents are ghosts; INTENT/CLAUDE still deny writer/signer; PRD overclaims user-session ES256 (svc-only in code).

## Critical Ghosts

| Claim | Source | Code |
|-------|--------|------|
| Hexagonal `src/domain|application|ports/inbound` layout | handoff CLAUDE_PROMPT:15-27 | **NOT FOUND** — packages/{ports,engine,adapters} instead |
| Tables `link_intents`, `auth_intents`, `credential_links`, `credential_proofs`, `identity_sessions` | CLAUDE_PROMPT:123-130 | **NOT FOUND** — see `0001_init_spine.up.sql` actual tables |
| `CompleteCredentialLink` application module | handoff reference-impl | **NOT FOUND** — link via `resolve-spine` + `src/api/routes/link.ts` |
| Telegram OIDC adapter | CLAUDE_PROMPT:71 | **NOT FOUND** (provider enum allows `telegram` in SQL only) |
| Passkey/WebAuthn bridge | CLAUDE_PROMPT:77; beads | **NOT FOUND** in adapters |
| In-package MCP tool implementations | mcp-tools README planned tools | **NOT FOUND** — README scaffold only (`packages/mcp-tools/`) |
| Handoff `UNIQUE(provider, issuer, subject)` three-part key | CLAUDE_PROMPT:82 | **PARTIAL** — `linked_accounts` PK is `(provider, external_id)` (`0001:73`) — no separate `issuer` column |
| Addressless AuthIntent ladder as first-class entity | CLAUDE_PROMPT:141-149 | **NOT FOUND** as domain type — auth uses `auth_nonces` + routes |

## Critical Hallucinations / Stale

| Claim | Source | Reality |
|-------|--------|---------|
| Engine ships "4-tier resolve algorithm" | `packages/engine/package.json` description | `[STALE]` `resolve-spine.ts:21-27` — wallet-first single-tier today; no `resolve-tier.ts` |
| CLAUDE.md hard-rule: midi SINGLE WRITER / no signer | root `CLAUDE.md` | `[STALE vs PRD v3.0]` — code has spine writes + JWTSigner/LocalEs256; CLAUDE.md banner says PRD wins |
| v1 user sessions via Local ES256 + own JWKS | archived PRD FR-J2 / README banner | `[HALLUCINATED]` user path = HS256 `src/jwt-mint.ts`; `LocalEs256Signer` + JWKS are **svc-JWT only** (`local-es256-signer.ts`, `well-known-jwks.ts`); `HttpJWTSigner` seam unused |
| “ships validator, NOT a signer” | CLAUDE.md / INTENT | `[HALLUCINATED]` process signs user HS256 + svc ES256 |
| `/v1/mibera/dimensions` still 501 | stale route header comments | `[STALE docs]` handler calls `composeMiberaDimensions` (`profile.ts`) |

## Shadows (code exists, under-documented in handoff)

| Code | Evidence |
|------|----------|
| Hyper-based HTTP runtime + OpenAPI | `src/api/index.ts`, `src/hyper/` |
| svc-JWT issuance + denylist | migrations 0005-0006, routes `v1/auth/*` |
| world_managers + world_name_model | migrations 0007-0008 |
| Discord link + OAuth routes | `discord-link.ts`, `auth-discord.ts`, `discord-oauth.ts` |

## Aligned

| Claim | Evidence |
|-------|----------|
| identity-api owns spine tables (SoR) | `0001_init_spine.up.sql` header + engine write helpers |
| Score/holdings not embedded in spine | `0001:13-14` |
| SIWE / EIP-191 bridges exist | `credential-bridge-siwe.ts`, `eip191.ts` |
| Dynamic as linkage/backfill provider | `linked_accounts` CHECK includes `dynamic_user_id`; `credential-bridge-dynamic.ts` |
| JWTSigner port + HttpJWTSigner | `ports/jwt-signer.port.ts`, `http-jwt-signer.ts` |
| JWKS well-known route | `well-known-jwks.ts` registered in `src/api/index.ts:99` |
| getProfile / getMiberaDimensions routes | `src/api/index.ts:90-91` |
| Audit on link mutations | `resolve-spine.ts:31-34` |
| Package hexagonal-ish ports←engine←adapters | dependency comments in `resolve-spine.ts:14-18` |

## Verification notes for claims-to-verify.md

See Phase 1 file — high-priority UNVERIFIED→GHOST items are the handoff intent tables and hexagonal tree.
