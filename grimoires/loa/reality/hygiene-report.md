# Hygiene Report

> Generated: 2026-07-19 · `/ride --enriched` Phase 2b  
> Flag for human decision — do not auto-fix.

## Outside / unusual layout

| Finding | Evidence | Decision needed |
|---------|----------|-----------------|
| Vendored Hyper runtime under `src/hyper/` | `src/hyper/core/app.ts` | Keep as fork vs extract package? |
| `packages/mcp-tools` has README only — no `src/` | `packages/mcp-tools/README.md:21` "Status: scaffolded" | Accept scaffold or implement? |
| Handoff extracted under `grimoires/loa/context/handoff/` | context ingest 2026-07-19 | Keep as context; do not paste into `src/` |
| Stash still holds pre-loa-update WIP | `git stash list` | `stash pop` when ready |

## Commented / stub debt

| Finding | Evidence |
|---------|----------|
| authJwtPlugin still HS256 with ES256 TODO | `src/api/index.ts:74-76` |
| Package engine README claims 4-tier resolve; code says single-tier today | `packages/engine/src/resolve-spine.ts:21-27` |
| Tech-debt markers (39 hits scoped) | `reality/tech-debt.txt` |

## Dependency notes

| Finding | Evidence |
|---------|----------|
| Workspace packages still named `@freeside-auth/*` | `packages/*/package.json` |
| External alias `@0xhoneyjar/identity` / `@0xhoneyjar/auth` documented as vendored | `packages/sdk` / `auth-sdk` package.json descriptions |

## Dead code philosophy

No deletions performed. Items above are flags only.
