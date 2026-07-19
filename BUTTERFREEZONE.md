<!-- AGENT-CONTEXT
name: identity-api
type: framework
purpose: identity-api — the central identity SoR for the freeside ecosystem. Hyper-based single-service building: wallet-first auth (SIWE + legacy EIP-191), resolution spine (users / wallets[] / credentials / per-world nyms), read-time compose over inventory + score + codex. Externally consumed as source-distributed vendored client (NOT npm).
key_files: [CLAUDE.md, .claude/loa/CLAUDE.loa.md, .loa.config.yaml, .claude/scripts/, .claude/skills/, package.json]
interfaces:
  core: [/auditing-security, /autonomous-agent, /bridgebuilder-review, /browsing-constructs, /bug-triaging]
  project: [/cost-budget-enforcer, /cross-repo-status-reader, /flatline-attacker, /graduated-trust, /hitl-jury-panel]
dependencies: [git, jq, yq, node]
capability_requirements:
  - filesystem: read
  - filesystem: write (scope: state)
  - filesystem: write (scope: app)
  - git: read_write
  - shell: execute
  - github_api: read_write (scope: external)
version: 0.1.0
installation_mode: unknown
trust_level: L2-verified
-->

# identity-api

<!-- provenance: CODE-FACTUAL -->
identity-api — the central identity SoR for the freeside ecosystem. Hyper-based single-service building: wallet-first auth (SIWE + legacy EIP-191), resolution spine (users / wallets[] / credentials / per-world nyms), read-time compose over inventory + score + codex. Externally consumed as source-distributed vendored client (NOT npm).

The framework provides 41 specialized skills, built with TypeScript/JavaScript, Python, Shell.

## Key Capabilities
<!-- provenance: CODE-FACTUAL -->

### API Surface
#### HTTP (registered in `src/api/index.ts`)
- Area — Routes (files)
- Health — `routes/health.ts`
- Auth — `auth.ts` challenge/verify
- Me — `me.ts`
- Resolve — `resolve.ts` wallet/account/nym/identity
- Profile — `profile.ts` getProfile, getMiberaDimensions
- Batch — `identity-resolve.ts`
- Link — `link.ts` verified-wallet, wallet-only
- Discord — `discord-link.ts`, `auth-discord.ts`
- JWKS — `well-known-jwks.ts`
- svc-JWT — `v1/auth/service-jwt`, denylist check
- CM — `v1/users/managed-worlds`
- Docs — `/openapi.json`, `/docs`
#### Package exports (consumers)
- Package — Surface
- `@freeside-auth/identity-client` (`packages/sdk`) — Typed HTTP client
- `@freeside-auth/auth-sdk` — svc-JWT verify / JWKS cache
- `@freeside-auth/protocol` — Schemas / types

## Architecture
<!-- provenance: CODE-FACTUAL -->
The architecture follows a three-zone model: System (`.claude/`) contains framework-managed scripts and skills, State (`grimoires/`, `.beads/`) holds project-specific artifacts and memory, and App (`src/`, `lib/`) contains developer-owned application code. The framework orchestrates       41 specialized skills through slash commands.
```mermaid
graph TD
    docs[docs]
    grimoires[grimoires]
    packages[packages]
    scripts[scripts]
    src[src]
    tests[tests]
    Root[Project Root]
    Root --> docs
    Root --> grimoires
    Root --> packages
    Root --> scripts
    Root --> src
    Root --> tests
```
Directory structure:
```
./docs
./grimoires
./grimoires/freeside
./grimoires/loa
./grimoires/runbooks
./packages
./packages/adapters
./packages/auth-sdk
./packages/engine
./packages/mcp-tools
./packages/ports
./packages/protocol
./packages/sdk
./packages/ui
./scripts
./scripts/__tests__
./src
./src/api
./src/hyper
./tests
./tests/acvp
```

## Interfaces
<!-- provenance: CODE-FACTUAL -->
### Skill Commands

#### Loa Core

- **/auditing-security** — Paranoid Cypherpunk Auditor
- **/autonomous-agent** — Autonomous Agent Orchestrator
- **/bridgebuilder-review** — Bridgebuilder — Autonomous PR Review
- **/browsing-constructs** — Unified construct discovery surface for the Constructs Network. This skill is a **thin API client** — all search intelligence, ranking, and composability analysis lives in the Constructs Network API.
- **/bug-triaging** — Bug Triage Skill
- **/butterfreezone-gen** — BUTTERFREEZONE Generation Skill
- **/continuous-learning** — Continuous Learning Skill
- **/deploying-infrastructure** — DevOps Crypto Architect Skill
- **/designing-architecture** — Architecture Designer
- **/discovering-requirements** — Discovering Requirements
- **/enhancing-prompts** — Enhancing Prompts
- **/eval-running** — Eval Running Skill
- **/flatline-knowledge** — Provides optional NotebookLM integration for the Flatline Protocol, enabling external knowledge retrieval from curated AI-powered notebooks.
- **/flatline-reviewer** — Flatline reviewer
- **/flatline-scorer** — Flatline scorer
- **/flatline-skeptic** — Flatline skeptic
- **/gpt-reviewer** — Gpt reviewer
- **/implementing-tasks** — Sprint Task Implementer
- **/managing-credentials** — /loa-credentials — Credential Management
- **/mounting-framework** — Mounting the Loa Framework
- **/planning-sprints** — Sprint Planner
- **/red-teaming** — Use the Flatline Protocol's red team mode to generate creative attack scenarios against design documents. Produces structured attack scenarios with consensus classification and architectural counter-designs.
- **/reviewing-code** — Senior Tech Lead Reviewer
- **/riding-codebase** — Riding Through the Codebase
- **/rtfm-testing** — RTFM Testing Skill
- **/run-bridge** — Run Bridge — Autonomous Excellence Loop
- **/run-mode** — Run Mode Skill
- **/simstim-workflow** — Simstim - HITL Accelerated Development Workflow
- **/translating-for-executives** — DevRel Translator Skill (Enterprise-Grade v2.0)
#### Project-Specific

- **/cost-budget-enforcer** — Daily token-cap enforcement for autonomous Loa cycles. Replaces the
- **/cross-repo-status-reader** — Read structured cross-repo state for ≤50 repos in parallel via `gh api`, with TTL cache + stale fallback, BLOCKER extraction from each repo's `grimoires/loa/NOTES.md` tail, and per-source error capture so one repo's failure does not abort the full read. The operator-visibility primitive for the Agent-Network Operator (P1).
- **/flatline-attacker** — Flatline attacker
- **/graduated-trust** — The L4 primitive maintains a per-(scope, capability, actor) trust ledger
- **/hitl-jury-panel** — Replace `AskUserQuestion`-class decisions during operator absence with a panel of ≥3 deliberately-diverse panelists. Each panelist (model + persona) returns a view and reasoning; the skill logs all views BEFORE selection, then picks one binding view via a deterministic seed derived from `(decision_id, context_hash)`. Provides an autonomous adjudication primitive without compromising auditability.
- **/loa-aleph** — Loa Aleph host orchestration
- **/loa-setup** — /loa setup — Onboarding Wizard
- **/scheduled-cycle-template** — Compose `/schedule` (cron registration) with the existing autonomous-mode primitives into a generic 5-phase cycle: **read state → decide → dispatch → await → log**. Caller plugs five small phase scripts (the *DispatchContract*) into a YAML; the L3 lib runs them under a flock, records every phase to a hash-chained audit log, and (optionally) consults the L2 cost gate before letting any work begin.
- **/soul-identity-doc** — L7 soul-identity-doc
- **/spiraling** — Spiraling — /spiral Autopoietic Meta-Orchestrator
- **/structured-handoff** — L6 structured-handoff
- **/validating-construct-manifest** — Validate a construct pack directory before it lands in a registry or a local install. Surfaces:

## Module Map
<!-- provenance: CODE-FACTUAL -->
| Module | Files | Purpose | Documentation |
|--------|-------|---------|---------------|
| `docs/` | 3 | Documentation | \u2014 |
| `grimoires/` | 183 | Loa state and memory files | \u2014 |
| `packages/` | 174 | Documentation | \u2014 |
| `scripts/` | 12 | Utility scripts | \u2014 |
| `src/` | 96 | Source code | \u2014 |
| `tests/` | 3 | Test suites | \u2014 |

## Verification
<!-- provenance: CODE-FACTUAL -->
- Trust Level: **L2 — CI Verified**
- 3 test files across 1 suite
- CI/CD: GitHub Actions (2 workflows)
- Type safety: TypeScript

## Agents
<!-- provenance: DERIVED -->
The project defines 1 specialized agent persona.

| Agent | Identity | Voice |
|-------|----------|-------|
| Bridgebuilder | You are the Bridgebuilder — a senior engineering mentor who has spent decades building systems at scale. | Your voice is warm, precise, and rich with analogy. |

## Ecosystem
<!-- provenance: OPERATIONAL -->
### Dependencies
- `@types/bun`
- `@usehyper/cli`
- `jose`
- `typescript`
- `viem`
- `zod`

## Quick Start
<!-- provenance: OPERATIONAL -->
Available commands:

- `npm run dev` — bun
- `npm run start` — bun
- `npm run build` — bun
- `npm run test` — bun
<!-- ground-truth-meta
head_sha: 09e3e248f80f292509c00fcc54034b0ef4d6c4c7
generated_at: 2026-07-19T22:06:24Z
generator: butterfreezone-gen v1.0.0
sections:
  agent_context: 7ae89494865852a9f73d536c07238701977f03776aeea0dcf7a5f7c77a928b87
  capabilities: eac5157c375e3302e37005b49cbcdd4b16d2328c11ce36c57eec113dad885d18
  architecture: 36ed36a6001b92cda504d5abe69994db6bce8d35a1903f7a9c068aa2baa472d7
  interfaces: 154ee7c6c0b3e2256f53301ef8aae7841bc9d71f83ca347b5aeff01f12fe137d
  module_map: 4ead5b2f2c3299a4fd5778d91fed0d1cab9f5154cdb1b41d328b5cddf798d586
  verification: c49674d7283e0b9e5d3c3c64991bb2db8df42d72478090bca25303476cdb57ff
  agents: ca263d1e05fd123434a21ef574fc8d76b559d22060719640a1f060527ef6a0b6
  ecosystem: 616f402774141d02cf9efcaf76f7fac43b8a50ba9d2971a9f8767c1159fc39cf
  quick_start: eade50bb4d2a23f52903ea46cb5f7afc98b9d6795d48f48ee4ece1a0e5dff6db
-->
