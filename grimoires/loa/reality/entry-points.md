# Entry Points

| Entry | Path | Notes |
|-------|------|-------|
| HTTP server | `src/api/index.ts` `import.meta.main` | `PORT` default 3000, `hostname: 0.0.0.0` |
| Auth install | `src/auth.ts` | Must load before routes (`.auth()` sugar) |
| Engine API | `packages/engine/src/index.ts` | Orchestrators export |
| Adapters barrel | `packages/adapters/src/index.ts` | Bridges, signers, PG |
| Migrations | `packages/adapters/src/migrations/*.sql` | 0001-0009 |

## Env (sampled from `reality/env-vars.txt`)

Key families observed: `PORT`, JWT/session secrets, DB URLs, Discord OAuth, svc-JWT PEM/kid, JWKS URLs. Treat `reality/env-vars.txt` as the scrape list — not a complete `.env.example` audit.
