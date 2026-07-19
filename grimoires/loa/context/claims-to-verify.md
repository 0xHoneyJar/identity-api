# Claims to Verify

> Generated: 2026-07-19 by `/ride --enriched` Phase 1
> Sources: handoff package + existing PRD v3.0

## Architecture Claims

| Claim | Source | Verification strategy |
|-------|--------|----------------------|
| identity-api is canonical SoR and token issuer | handoff README; CLAUDE_PROMPT L9–11; ADR-001 | Find JWTSigner, JWKS route, user mint/write path |
| Hexagonal layout: domain/application/ports/adapters | CLAUDE_PROMPT L15–27 | Glob for those dirs vs packages/{engine,adapters,ports,protocol} |
| Dependencies point inward only | REFERENCE_ARCHITECTURE.md | Import graph sample on adapters → domain |
| Providers (Discord/Telegram/SIWE/etc.) are adapters only | CLAUDE_PROMPT L11; ADR-002 | Confirm no provider SDK types in domain/engine core |
| Preserve signer/JWKS casually | CLAUDE_PROMPT L163 | Locate signer implementation + rotation docs |

## Domain Claims

| Claim | Source | Verification strategy |
|-------|--------|----------------------|
| Credential uniquely keyed by `(provider, issuer, subject)` | CLAUDE_PROMPT L82; SECURITY_MODEL | Schema/migration UNIQUE constraint |
| Never auto-link by email/username/handle | CLAUDE_PROMPT L83 | Grep link paths for email matching |
| Link intent binds initiating user+session | CLAUDE_PROMPT L84–85 | Find LinkIntent model + complete flow |
| Completion: new→link; same→idempotent; other→collision | CLAUDE_PROMPT L136–138 | CompleteCredentialLink / link_credential use case |
| CAIP-2 / CAIP-10 for wallets | CLAUDE_PROMPT L87 | Wallet link schema + normalize helpers |
| Tables: canonical_users, credential_links, proofs, link_intents, auth_intents, identity_sessions, audit | CLAUDE_PROMPT L123–130 | migrations/*.sql |

## Product / PRD Claims

| Claim | Source | Verification strategy |
|-------|--------|----------------------|
| G-1 building-standard (BeaconV3, registry, SDK, MCP) | prd.md §1 | beacon files, mcp-tools, package exports |
| G-2 resolve spine as writer (users↔wallets↔linked_accounts↔world_identity) | prd.md §1 | resolve-tier + write adapters |
| G-3 SIWE primary; Dynamic demoted to backfill | prd.md §1 | credential-bridge-siwe vs dynamic |
| G-4 cycle-c redirect via identity-api client | prd.md §1 | HTTP/MCP link surface used by cycle-c |
| G-5 getProfile compose (no embed score/holdings) | prd.md §1 | getProfile symbol search |
| G-6 Mibera dimensions on honey-road | prd.md §1 | dimensions compose path |

## Tribal / WIP

| Claim | Source | Notes |
|-------|--------|-------|
| Handoff is projection guide, not paste target | CLAUDE_PROMPT L172 | Treat reference-implementation as shape, not truth |
| AHP artifacts encode auth-linking priorities | artifacts/*ahp* | Decision weights — not runtime code |
| Existing PRD v3.0 supersedes greenfield v1 | prd.md frontmatter | Archive before rewrite in Phase 6 |

## WIP Status (from NOTES / beads — unverified)

| Item | Source | Status to verify |
|------|--------|------------------|
| world_identity upsert migration 0009 done | NOTES.md | Confirm migration file exists |
| Many bd-2wo.* credential/MCP tasks ready | `bd ready` | Map to packages presence |
