# Loading Plan

> Generated: 2026-07-19 · `/ride --enriched` Phase 0.5
> Probe: ~41k lines · ~428k est. tokens · **Medium** → prioritized load

## Strategy

| Priority | Paths | Decision |
|----------|-------|----------|
| P0 | `packages/{ports,protocol,engine,adapters}/src` · `src/api` · migrations | Full load / deep read |
| P1 | `packages/{sdk,auth-sdk}/src` · `src/auth.ts` · `src/discord-oauth.ts` | Excerpt key exports |
| P2 | `src/hyper/**` (vendored Hyper runtime) | Structure only — not identity domain |
| P3 | `packages/ui` · `packages/mcp-tools` (README-only) | Note status |
| Skip | `node_modules` · `.claude` · handoff reference-impl paste | Excluded |

## Relevance rationale

Identity SoR truth lives in spine migrations + engine resolve/link + HTTP routes. Hyper is transport substrate. Handoff `reference-implementation/` is a projection claim, not this repo's code.
