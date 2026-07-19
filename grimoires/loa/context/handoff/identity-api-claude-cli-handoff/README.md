# identity-api Claude CLI Handoff

A self-contained implementation handoff for platform- and chain-agnostic identity, wallet authentication, and Discord/Telegram linking.

## Core decision

`identity-api` remains the canonical identity source of record and issuer. External providers, wallet kits, and auth vendors are adapters. They do not own canonical users, merge authority, durable identity sessions, or final token contracts.

## Run

From the target repository root:

```bash
claude "$(cat /path/to/identity-api-claude-cli-handoff/CLAUDE_PROMPT.md)"
```

## Hexagonal dependency rule

```text
Adapters -> Ports -> Application -> Domain
```

See `docs/architecture/REFERENCE_ARCHITECTURE.md` and the projection-oriented TypeScript skeleton in `reference-implementation/`.
