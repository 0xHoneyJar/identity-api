# Over-Engineering / Simplicity Audit

> Generated: 2026-07-19 · `/ride --enriched` Phase 15

## Shortcut ledger (keep)

| Shortcut | Why it's OK |
|----------|-------------|
| Wallet-first single-tier resolve before full 4-tier file | `resolve-spine.ts` documents intentional staging |
| MCP package README-only | Avoids premature bot contract freeze |
| HS256 middleware TODO | Explicit debt marker vs silent wrong alg |

## Overbuild risks

| Risk | Signal | Recommendation |
|------|--------|----------------|
| Parallel handoff schema | New `link_intents` beside working spine | Prefer extend `linked_accounts` + `auth_nonces` unless ADR forces intents |
| Dual package namespaces | `@freeside-auth` + `@0xhoneyjar` + repo `identity-api` | Document mapping once; don't rename mid-flight without migration |
| Large vendored Hyper tree | `src/hyper/**` | Treat as substrate; don't "clean up" during auth work |
| AHP matrix without bead mapping | artifacts unused | Translate top criteria → beads or archive |

## YAGNI flags

- Implementing full hexagonal `domain/` tree while engine/ports already exist — high cost, low incremental safety if ports stay pure.
- Telegram + passkey before Discord/SIWE paths are production-hardened.
