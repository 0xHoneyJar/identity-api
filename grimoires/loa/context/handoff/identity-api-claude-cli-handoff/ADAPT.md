# Adapt, do not paste

**Decision D-ADAPT-001 (2026-07-19):** This handoff is a **projection guide**.

- Do **not** create `src/domain|application|composition` trees in identity-api this cycle.
- Do **not** add `link_intents` / `credential_links` / `canonical_users` tables alongside the existing spine.
- Map handoff use-cases onto:
  - `packages/engine/src/resolve-spine.ts` (link + audit)
  - `packages/adapters` credential bridges + Postgres spine
  - `src/api/routes/*` + `src/discord-oauth.ts`
- Preserve handoff **security invariants** (no auto-link by email/handle; collision = hard-fail; session-bound complete).

See cycle PRD: `grimoires/loa/prd.md`.
