# Architecture Overview

```
Clients (worlds, bots, cells)
        │
        ▼
┌───────────────────┐
│ src/api (Hyper)   │  HTTP + OpenAPI + session/JWT middleware
└─────────┬─────────┘
          │
          ▼
┌───────────────────┐
│ packages/engine   │  resolve / link / mint orchestration
└─────────┬─────────┘
          │ depends on ports only
          ▼
┌───────────────────┐     ┌────────────────────┐
│ packages/ports    │◄────│ packages/protocol  │ schemas
└─────────┬─────────┘     └────────────────────┘
          │ implemented by
          ▼
┌───────────────────┐
│ packages/adapters │  Postgres spine · bridges · JWKS · signers
└─────────┬─────────┘
          ▼
      PostgreSQL
```

**Resolve:** HTTP → engine `resolveBy*` → `SpinePort` → Postgres.  
**Link:** HTTP → engine `link*WithAudit` → spine write + `audit_events`.  
**Mint:** engine `mint-jwt-orchestrator` → `JWTSigner.sign`.

**Boundary:** Score/inventory federate at read time (e.g. `http-inventory-adapter.ts`) — not stored on spine (`0001` header).
