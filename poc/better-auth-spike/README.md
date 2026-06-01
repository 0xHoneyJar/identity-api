# bd-3n1.3 — Better Auth fit POC (code spike)

De-risks the GO decision for the freeside-auth sovereign-auth cycle by BOOTING
Better Auth and running the PERSON-layer flow against a live DB.

## What it proves

1. **SIWE login** — nonce → sign (viem EOA) → verify → session; creates `user` + `account`.
2. **Wallet-group** — N `account` rows under 1 `user` (the load-bearing claim).
3. **Per-world JWT** — a `world`/`tenant` claim flows into the JWT via `jwt.definePayload`.

## Stack

- `better-auth@1.6.13` + plugins `siwe`, `jwt`, `organization`, `bearer`
- DB adapter: **Drizzle** over **bun:sqlite** (zero-infra; no native addon compile).
  Postgres is a connection-string swap — see `db.ts` + `auth.ts` (`provider: "sqlite"` → `"pg"`).
- `viem@2.52.0` for the throwaway test wallet + SIWE signing/verification.
- `siwe@3.0.0` to build the SIWE message.

## Re-run

```bash
cd poc/better-auth-spike
bun install
bun run gen-schema.ts   # getSchema() -> spike-ddl.sql + schema.ts (CLI-free, version-locked)
bun run migrate.ts      # fresh SQLite, applies DDL (9 tables)
bun run demo.ts         # the proof — pastes real output
```

`gen-schema.ts` replaces `@better-auth/cli generate`: it calls better-auth's own
`getSchema()` so the schema NEVER drifts from the runtime (the external CLI tops
out at 1.4.21 while the runtime is 1.6.13).

## Files

| File | Role |
|------|------|
| `auth.ts` | The Better Auth instance (plugins + Drizzle adapter + per-world claim). |
| `db.ts` | Drizzle + bun:sqlite handle. Postgres swap documented inline. |
| `gen-schema.ts` | Schema/DDL generator via better-auth `getSchema()`. |
| `schema.ts` | GENERATED Drizzle tables (do not edit). |
| `spike-ddl.sql` | GENERATED SQLite DDL. |
| `migrate.ts` | Applies the DDL to a fresh DB. |
| `demo.ts` | The runnable proof. |

NEVER committed/pushed — pure spike.
