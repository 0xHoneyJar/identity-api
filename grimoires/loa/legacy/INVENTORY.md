# Legacy Documentation Inventory

> Generated: 2026-07-19 · `/ride --enriched` Phase 3

## Doc corpus (sampled)

See `doc-files.txt` (24 paths outside `grimoires/loa` + `.claude`). Key entries:

| Path | Type | Key claims |
|------|------|------------|
| `CLAUDE.md` | AI guidance | Module layout; **superseded-in-part** banner → PRD v3.0 wins on writer/signer |
| `README.md` | Project intro | identity-api overview |
| `PROCESS.md` | Process | Large Loa process dump |
| `grimoires/prd.md` | Legacy PRD (non-loa path) | Older building plan |
| `grimoires/sprint.md` | Sprint plan | Execution sequencing |
| `grimoires/svc-jwt-spec.md` | Spec | svc-JWT contracts |
| `grimoires/migrations-spec.md` | Spec | Migration rules |
| `docs/INTENT.md` (if present) | Intent | Phase-0 midi-writer stance (likely stale) |
| `legacy/pre-ride-2026-07-19/prd.md` | Archived | Operator PRD v3.0 (pre-ride) |
| Handoff under `context/handoff/` | Ingest | Hexagonal auth-linking projection |

## CLAUDE.md quality score: **5 / 7**

| Criterion | Score |
|-----------|------:|
| Length >50 lines | 1 |
| Tech stack mentions | 1 |
| Patterns/conventions | 1 |
| Warnings / hard rules | 1 |
| Current vs superseded clarity | 1 (banner present but body still Phase-0) |
| Entry points for agents | 0 (points to packages; runtime in src/api underplayed) |
| Test/verify commands | 0 |

**Verdict:** Usable with PRD-wins banner; body still teaches midi-single-writer — treat as stale relative to code + archived PRD v3.0.

## Deprecation plan (Phase 8)

- Add pointer on archived PRD: "Superseded for ride-grounded view by `grimoires/loa/prd.md` (2026-07-19 ride); operator narrative retained here."
- Do **not** delete handoff or PROCESS.md.
