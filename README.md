# identity-api

<div align="center">

[![CI](https://github.com/0xHoneyJar/identity-api/actions/workflows/ci.yml/badge.svg)](https://github.com/0xHoneyJar/identity-api/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

</div>

**One human. Many wallets. One `user_id`.** The freeside ecosystem's identity source of record — wallet-first auth, credential linking, session + service JWTs, read-time profile compose. Worlds authenticate against this building; they do not each invent a private identity graph.

<div align="center">
<h3>Get the repo</h3>

```bash
git clone https://github.com/0xHoneyJar/identity-api.git && cd identity-api && bun install
```

**Smoke a running instance:**

```bash
curl -sS "$IDENTITY_API_URL/health"
```

</div>

---

## TL;DR

**The Problem**: Every world (mibera, honey-road, bots, dashboards) used to resolve “who is this wallet?” differently — Dynamic here, midi there, Discord somewhere else — so one person became many IDs and sessions never composed.

**The Solution**: `identity-api` owns the **resolution spine** in Postgres, issues **user-session** and **svc** JWTs, and exposes a Hyper HTTP API (+ OpenAPI). Consumers vendor a typed client (`@0xhoneyjar/identity`) — source-distributed, not an npm runtime dependency.

### Why use identity-api?

| Feature | What it does |
|---------|----------------|
| **Spine as SoR** | Writes `users` / `wallet_links` / `linked_accounts` / `world_identity` — not a read-only shim over midi |
| **Wallet-first auth** | SIWE + EIP-191 bridges; Dynamic demoted to backfill linkage |
| **Dual JWT planes** | User sessions (`user-` ES256 kids) + svc-JWTs (`svc-` kids); public keys on `/.well-known/jwks.json` |
| **Compose, don't embed** | `getProfile` / Mibera dimensions join inventory + score + codex at read time — score stays out of the spine |
| **Agent surface** | Routes opt into Hyper `meta.mcp`; OpenAPI at `/openapi.json` |

---

### Quick example

```bash
# Dev server (Bun + Hyper)
bun run migrate          # apply packages/adapters migrations
bun run dev              # http://0.0.0.0:3000

# Challenge → verify (wallet auth)
curl -sS -X POST localhost:3000/v1/auth/challenge \
  -H 'content-type: application/json' \
  -d '{"address":"0x…","scheme":"siwe"}'

# Resolve
curl -sS localhost:3000/v1/resolve/wallet/0x…

# Batch merge (dashboard facade)
curl -sS -X POST localhost:3000/v1/identity/resolve \
  -H "authorization: Bearer $SESSION" \
  -H 'content-type: application/json' \
  -d '{"wallets":["0x…"],"world":"mibera"}'

# JWKS (user + svc public keys)
curl -sS localhost:3000/.well-known/jwks.json
```

---

## Design philosophy

1. **Code is the SoR, docs catch up** — Phase-0 “midi writes / this only validates” is dead. See `CLAUDE.md` hard rules.
2. **Three layers stay separate** — Credential (SIWE/Discord/…) · Identity (spine) · Session (JWT). Providers never become the user store.
3. **Score stays over there** — Join via wallets; never store ranks/factors/holdings on the spine ([score-vs-identity-boundary](https://github.com/0xHoneyJar/loa-hivemind/blob/main/wiki/concepts/score-vs-identity-boundary.md)).
4. **Ports before paste** — Extend `packages/{ports,engine,adapters}` + routes. Do not paste handoff hexagonal trees (`grimoires/loa/context/handoff/.../ADAPT.md`).
5. **Kid-prefix discipline** — `user-*` vs `svc-*` keys must never mix privileges.

---

## Comparison

| Concern | identity-api | Per-world Dynamic / Better Auth | midi profiles alone |
|---------|--------------|----------------------------------|---------------------|
| Canonical `user_id` | Owns spine | Provider-scoped subjects | Legacy writer (backfill source) |
| Multi-wallet primary | `wallet_links` + triggers | Ad-hoc | Partial |
| Cross-world nyms | `world_identity` | Usually none | World-specific |
| Session JWT | ES256 user plane (+ HS256 transition) | Vendor sessions | N/A |
| Score embedding | Forbidden | Often tangled | Mixed |
| Consumer SDK | Vendored `@0xhoneyjar/identity` | SDK lock-in | Direct SQL |

---

## Installation

### 1. Clone + install

```bash
git clone https://github.com/0xHoneyJar/identity-api.git
cd identity-api
bun install
```

### 2. Environment (minimum)

```bash
export DATABASE_URL=postgres://…          # spine
export JWT_SECRET="$(openssl rand -base64 48)"   # HS256 transition / dual-verify
export SESSION_SECRET="$(openssl rand -base64 48)"

# Production user sessions (required when NODE_ENV=production)
export USER_JWT_SIGNING_KEY_PEM="$(cat user.pkcs8.pem)"
export USER_JWT_SIGNING_KEY_KID=user-2026-07-19-a

# svc-JWT plane (cells)
export SVC_JWT_SIGNING_KEY_PEM="$(cat svc.pkcs8.pem)"
export SVC_JWT_SIGNING_KEY_KID=svc-2026-07-19-a
```

Full session-key runbook: [`grimoires/runbooks/user-session-es256.md`](grimoires/runbooks/user-session-es256.md).

### 3. Migrate + run

```bash
bun run migrate
bun run dev          # or: bun run start
```

### 4. Consume from another repo (vendored client)

Do **not** `npm install @0xhoneyjar/identity`. Copy/vendor `packages/sdk` (and `auth-sdk` for svc verify) shadcn-style — see `packages/sdk/README.md`.

---

## Quick start (numbered)

1. Provision Postgres and set `DATABASE_URL`.
2. `bun install && bun run migrate`.
3. Set secrets (`JWT_SECRET`, session, preferably `USER_JWT_*` + `SVC_JWT_*`).
4. `bun run dev` — open `/docs` for Swagger UI.
5. Hit `/v1/auth/challenge` → sign → `/v1/auth/verify` → call `/v1/me`.
6. Wire a world client via vendored SDK pointing at your deploy URL.

---

## HTTP surface (selected)

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/health` | Liveness |
| `POST` | `/v1/auth/challenge` · `/v1/auth/verify` | Wallet auth |
| `GET` | `/v1/me` | Session subject |
| `GET` | `/v1/resolve/wallet/:address` | Resolve |
| `GET` | `/v1/resolve/account/:provider/:id` | Discord / telegram / dynamic id |
| `GET` | `/v1/identity/:userId` | Full identity composite |
| `POST` | `/v1/identity/resolve` | Batch merge facade |
| `GET` | `/v1/profile` · `/v1/mibera/dimensions` | Read-time compose |
| `POST` | `/v1/link/verified-wallet` · `/wallet-only` | Link |
| `GET` | `/v1/link/discord/initiate` · `/callback` | Discord link (session-bound) |
| `GET` | `/.well-known/jwks.json` | User + svc public keys |
| `POST` | `/v1/auth/service-jwt` | Cell svc-JWT issue |
| `GET` | `/openapi.json` · `/docs` | Contract + UI |

Entry: `src/api/index.ts`.

---

## Packages

| Workspace | npm name | Role |
|-----------|----------|------|
| `packages/protocol` | `@freeside-auth/protocol` | Sealed schemas |
| `packages/ports` | `@freeside-auth/ports` | `SpinePort`, `JWTSigner`, bridges |
| `packages/engine` | `@freeside-auth/engine` | Resolve / link / mint / compose |
| `packages/adapters` | `@freeside-auth/adapters` | Postgres, SIWE/EIP191/Dynamic bridges, ES256 signers, JWKS |
| `packages/sdk` | `@freeside-auth/identity-client` | Vendored HTTP client → `@0xhoneyjar/identity` |
| `packages/auth-sdk` | `@freeside-auth/auth-sdk` | Vendored svc-JWT verify → `@0xhoneyjar/auth` |
| `packages/mcp-tools` | `@freeside-auth/mcp-tools` | Scaffold only — live MCP is Hyper `meta.mcp` on routes |
| `packages/ui` | `@freeside-auth/ui` | Future admin UI |

---

## Configuration

See `.env` / Railway secrets. High-signal vars:

| Variable | Plane |
|----------|--------|
| `DATABASE_URL` | Spine |
| `PORT` | HTTP (default `3000`, bind `0.0.0.0`) |
| `JWT_SECRET` | HS256 dual-verify / transition |
| `USER_JWT_SIGNING_KEY_PEM` / `_KID` (+ optional `_PREV`) | User ES256 |
| `SVC_JWT_SIGNING_KEY_PEM` / `_KID` (+ optional `_PREV`) | svc ES256 |
| Discord OAuth vars | Link + social login routes |

Agent-oriented snapshot: [`BUTTERFREEZONE.md`](BUTTERFREEZONE.md) (regenerate with `/butterfreezone-gen`).

---

## Architecture

```
                    worlds / bots / cells / dashboards
                                   │
                                   ▼
┌──────────────────────────────────────────────────────────────┐
│  src/api  (Hyper)  — routes, session, OpenAPI, meta.mcp      │
└────────────────────────────┬─────────────────────────────────┘
                             │
                             ▼
┌──────────────────────────────────────────────────────────────┐
│  packages/engine  — resolve-spine · link*WithAudit · mint    │
│                     compose-profile · merge-identity           │
└────────────────────────────┬─────────────────────────────────┘
                             │ ports only
                             ▼
┌──────────────────────┐   ┌─────────────────────┐
│  packages/ports      │◄──│  packages/protocol   │
└──────────┬───────────┘   └─────────────────────┘
           │ implemented by
           ▼
┌──────────────────────────────────────────────────────────────┐
│  packages/adapters — PostgresSpine · bridges · LocalEs256*   │
│                      JWKS composer · HttpJWTSigner (seam)    │
└────────────────────────────┬─────────────────────────────────┘
                             ▼
                        PostgreSQL spine
```

Freeside write rule of thumb: **writes go to the `*-api` that owns the noun**; reads may come from projection BFFs. Identity nouns live here.

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `USER_JWT_SIGNING_KEY_* required in production` | Provision user ES256 keys per `grimoires/runbooks/user-session-es256.md` |
| Sessions verify but mint still HS256 in CI | Set `USER_JWT_*` in CI — do not rely on HS256 fallback |
| `401 malformed_token` on `/v1/me` | Bearer is not a JWT — expected for garbage tokens |
| Discord link `409` | Credential already linked to another `user_id` — no silent merge |
| Migrations fail | `bun run migrate:status`; ensure `DATABASE_URL` points at empty/clean DB for fresh apply |
| Score data in spine? | Don't — compose via profile routes only |

---

## Limitations

- **HS256 user mint** still exists as a non-prod transition fallback; production must use `USER_JWT_*`.
- **`packages/mcp-tools`** has no implementation source yet — use route `meta.mcp`.
- **Telegram / passkey / CAIP-10** credential paths are not first-class in this repo yet (provider enum may reserve telegram).
- **HttpJWTSigner → Rust gateway** is a preserved seam, not the live user-session path today.
- **World login UX** stays in each world — this building is the SoR + API, not the wallet picker UI.

---

## FAQ

**Is this still `freeside-auth`?**  
Repo/building slug is `identity-api`. Workspace packages keep `@freeside-auth/*` during migration; consumers vendor as `@0xhoneyjar/identity`.

**Does midi still write identity?**  
No for the spine. midi is a backfill source; identity-api mints and links.

**Where do JWTs come from?**  
User sessions: local ES256 (`user-` kids) when keys are set. svc-JWTs: `LocalEs256Signer` (`svc-` kids). Both publish to `/.well-known/jwks.json`.

**Can Discord / Dynamic own the user?**  
No. They are adapters / linked credentials. Collision = hard fail, never silent merge.

**How do agents call this?**  
Hyper MCP tools from annotated routes, or HTTP + OpenAPI. Not the empty `mcp-tools` package.

**Where is the plan?**  
`grimoires/loa/prd.md`, `grimoires/loa/sprint.md`, ride reality under `grimoires/loa/reality/`.

---

## Scripts

| Command | Purpose |
|---------|---------|
| `bun run dev` | Hot reload API |
| `bun run start` | Production listen |
| `bun test` | Test suite |
| `bun run typecheck` | `tsc --noEmit` |
| `bun run migrate` | Apply SQL migrations |
| `bun run check` | Dynamic-SDK quarantine lint |

---

## About Contributions

*About Contributions:* Please don't take this the wrong way, but I do not accept outside contributions for any of my projects. I simply don't have the mental bandwidth to review anything, and it's my name on the thing, so I'm responsible for any problems it causes; thus, the risk-reward is highly asymmetric from my perspective. I'd also have to worry about other "stakeholders," which seems unwise for tools I mostly make for myself for free. Feel free to submit issues, and even PRs if you want to illustrate a proposed fix, but know I won't merge them directly. Instead, I'll have Claude or Codex review submissions via `gh` and independently decide whether and how to address them. Bug reports in particular are welcome. Sorry if this offends, but I want to avoid wasted time and hurt feelings. I understand this isn't in sync with the prevailing open-source ethos that seeks community contributions, but it's the only way I can move at this velocity and keep my sanity.

---

## License

MIT — see repository metadata (`package.json`).

## Agent entry

For AI agents, prefer [`BUTTERFREEZONE.md`](BUTTERFREEZONE.md) + [`CLAUDE.md`](CLAUDE.md) over skimming this README alone.
