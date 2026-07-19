# Trajectory Self-Audit

> Generated: 2026-07-19 · `/ride --enriched` Phase 9

## Grounding quality

| Artifact | Assessment |
|----------|------------|
| drift-report.md | Claims cited to migrations/routes/package files |
| prd.md / sdd.md | Markers used; operator G-goals labeled CLAIMED vs GROUNDED |
| gaps.md | Tied to drift items |
| reality/* | Prefer paths over prose |

## Ungrounded / weak spots

1. End-to-end honey-road profile compose — **ASSUMPTION** (GAP-009)
2. cycle-c consumer cutover — **INFERRED** only
3. Background extraction agents may add nuance not merged if they finish later — re-check trajectory

## Ghost feature check (negative grounding)

Confirmed absent: handoff hexagonal dirs, intent tables, mcp-tools src, CompleteCredentialLink module, Telegram OIDC adapter.

## EDD scenarios (major findings)

1. **Spine write path:** Given Postgres with 0001 applied, linking a wallet emits `wallet_links` + `audit_events` via engine helpers.
2. **Provider uniqueness:** Inserting same `(provider, external_id)` for two users fails on PK.
3. **MCP absence:** Importing `@freeside-auth/mcp-tools` createServer — expect fail/missing export until src lands.
