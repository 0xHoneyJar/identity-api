@.claude/loa/CLAUDE.loa.md

# identity-api — agent instructions

Central identity **source of record (SoR)** for the freeside ecosystem: wallet → canonical `user_id` + linked accounts + per-world nyms + session/svc JWT issuance. Building slug: `identity-api`. Workspace packages remain `@freeside-auth/*`; consumers vendor `@0xhoneyjar/identity` / `@0xhoneyjar/auth` source (not npm).

Authoritative plan: `grimoires/loa/prd.md` (cycle auth-linking-adapt). Ride reality: `grimoires/loa/reality/`. Handoff projection: `grimoires/loa/context/handoff/` — **adapt, do not paste** (`ADAPT.md` / D-ADAPT-001).

## Layout

| Path | Role |
|------|------|
| `packages/protocol` | Sealed schemas |
| `packages/ports` | Interfaces (`SpinePort`, `JWTSigner`, bridges) |
| `packages/engine` | Resolve / link / mint / compose orchestration |
| `packages/adapters` | Postgres spine, credential bridges, JWKS, ES256 signers |
| `packages/sdk` | Vendored HTTP client (`identity-client`) |
| `packages/auth-sdk` | Vendored svc-JWT verifier |
| `packages/mcp-tools` | Scaffold only — live agent surface is Hyper `meta.mcp` on routes |
| `src/api` | Hyper HTTP runtime (entry: `src/api/index.ts`) |

## Hard rules (current)

- **identity-api WRITES the spine.** Mint users, `wallet_links`, `linked_accounts`, `world_identity`. midi_profiles → one-time backfill → then reads from identity-api. (Supersedes Phase-0 “midi SINGLE WRITER”.)
- **Signing lives here behind ports.** User sessions: ES256 via `user-` kids (`USER_JWT_SIGNING_KEY_*`) when provisioned; HS256 `JWT_SECRET` is transition-only (non-prod fallback). svc-JWTs: `LocalEs256Signer` with `svc-` kids. `HttpJWTSigner` remains the gateway delegation seam. JWKS at `GET /.well-known/jwks.json` publishes public keys for both planes.
- **Score data is OFF LIMITS.** Join via wallets; never embed factors/ranks/holdings/dimensions in the spine. Per [[score-vs-identity-boundary]].
- **Credential providers are adapters.** SIWE / EIP-191 / Dynamic-backfill bridges + Discord OAuth routes. Do not make Discord/Dynamic/Privy/Reown the SoR.
- **No handoff hexagonal paste.** Do not add parallel `src/domain|application` or `link_intents` tables without a new ADR. Map security invariants onto spine + routes (D-ADAPT-001).
- **Schema governance** from loa-constructs: enum-locked `schema_version`, additive minors, majors need migration + stable `$id`.

## What this repo does NOT own

- World-specific login UX (each world owns wallet/passkey UI)
- Score / inventory / codex computation (compose on read)
- Long-term exclusive ownership of crypto if/when gateway session `/issue` is adopted (`HttpJWTSigner` swap)

## References

- [`freeside-as-identity-spine`](https://github.com/0xHoneyJar/loa-hivemind/blob/main/wiki/concepts/freeside-as-identity-spine.md)
- [`score-vs-identity-boundary`](https://github.com/0xHoneyJar/loa-hivemind/blob/main/wiki/concepts/score-vs-identity-boundary.md)
- Cycle PRD / sprint: `grimoires/loa/prd.md`, `grimoires/loa/sprint.md`
- User session runbook: `grimoires/runbooks/user-session-es256.md`
