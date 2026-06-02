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

<!-- provenance: DERIVED -->
identity-api — the central identity SoR for the freeside ecosystem. Hyper-based single-service building: wallet-first auth (SIWE + legacy EIP-191), resolution spine (users / wallets[] / credentials / per-world nyms), read-time compose over inventory + score + codex. Externally consumed as source-distributed vendored client (NOT npm).

The framework provides 40 specialized skills, built with TypeScript/JavaScript, Python, Shell.

## Key Capabilities
<!-- provenance: DERIVED -->
The project exposes 15 key entry points across its public API surface.

### .claude/commands/scripts

- **check_audit_prerequisites** — Check prerequisites for audit phase (`./.claude/commands/scripts/common.sh:148`)
- **check_dir_exists** — Check if a directory exists (`./.claude/commands/scripts/common.sh:47`)
- **check_file_exists** — Check if a file exists (`./.claude/commands/scripts/common.sh:38`)
- **check_implement_prerequisites** — Check prerequisites for implementation phase (`./.claude/commands/scripts/common.sh:133`)
- **check_review_prerequisites** — Check prerequisites for review phase (`./.claude/commands/scripts/common.sh:140`)
- **check_reviewer_report** — Check if reviewer.md exists for a sprint (`./.claude/commands/scripts/common.sh:117`)
- **check_senior_approval** — Check if senior lead has approved the sprint (`./.claude/commands/scripts/common.sh:103`)
- **check_setup_complete** — Check if setup has been completed (`./.claude/commands/scripts/common.sh:56`)
- **check_sprint_dir** — Check if sprint directory exists (`./.claude/commands/scripts/common.sh:125`)
- **check_sprint_in_plan** — Check if sprint exists in sprint.md (`./.claude/commands/scripts/common.sh:77`)
- **check_sprint_not_completed** — Check if sprint is already completed (`./.claude/commands/scripts/common.sh:93`)
- **error** — Print error message and exit (`./.claude/commands/scripts/common.sh:14`)
- **get_user_type** — Get user type from setup marker (`./.claude/commands/scripts/common.sh:63`)
- **is_thj_user** — Check if user is THJ developer (`./.claude/commands/scripts/common.sh:72`)
- **success** — Print success message (`./.claude/commands/scripts/common.sh:25`)

## Architecture
<!-- provenance: DERIVED -->
The architecture follows a three-zone model: System (`.claude/`) contains framework-managed scripts and skills, State (`grimoires/`, `.beads/`) holds project-specific artifacts and memory, and App (`src/`, `lib/`) contains developer-owned application code. The framework orchestrates       40 specialized skills through slash commands.
```mermaid
graph TD
    coverage[coverage]
    docs[docs]
    grimoires[grimoires]
    packages[packages]
    scripts[scripts]
    spike[spike]
    src[src]
    Root[Project Root]
    Root --> coverage
    Root --> docs
    Root --> grimoires
    Root --> packages
    Root --> scripts
    Root --> spike
    Root --> src
```
Directory structure:
```
./coverage
./coverage/tmp
./docs
./grimoires
./grimoires/loa
./grimoires/runbooks
./grimoires/specs
./grimoires/tracks
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
./spike
./spike/gen-client.ts
./src
./src/api
./src/hyper
```

## Interfaces
<!-- provenance: DERIVED -->
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
- **/flatline-reviewer** — Uflatline reviewer
- **/flatline-scorer** — Uflatline scorer
- **/flatline-skeptic** — Uflatline skeptic
- **/gpt-reviewer** — Ugpt reviewer
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
- **/flatline-attacker** — Uflatline attacker
- **/graduated-trust** — The L4 primitive maintains a per-(scope, capability, actor) trust ledger
- **/hitl-jury-panel** — Replace `AskUserQuestion`-class decisions during operator absence with a panel of ≥3 deliberately-diverse panelists. Each panelist (model + persona) returns a view and reasoning; the skill logs all views BEFORE selection, then picks one binding view via a deterministic seed derived from `(decision_id, context_hash)`. Provides an autonomous adjudication primitive without compromising auditability.
- **/loa-setup** — /loa setup — Onboarding Wizard
- **/scheduled-cycle-template** — Compose `/schedule` (cron registration) with the existing autonomous-mode primitives into a generic 5-phase cycle: **read state → decide → dispatch → await → log**. Caller plugs five small phase scripts (the *DispatchContract*) into a YAML; the L3 lib runs them under a flock, records every phase to a hash-chained audit log, and (optionally) consults the L2 cost gate before letting any work begin.
- **/soul-identity-doc** — L7 soul-identity-doc
- **/spiraling** — Spiraling — /spiral Autopoietic Meta-Orchestrator
- **/structured-handoff** — L6 structured-handoff
- **/validating-construct-manifest** — Validate a construct pack directory before it lands in a registry or a local install. Surfaces:

## Module Map
<!-- provenance: DERIVED -->
| Module | Files | Purpose | Documentation |
|--------|-------|---------|---------------|
| `coverage/` | 2 | Ucoverage | \u2014 |
| `docs/` | 3 | Documentation | \u2014 |
| `grimoires/` | 108 | Loa state and memory files | \u2014 |
| `packages/` | 152 | Documentation | \u2014 |
| `scripts/` | 7 | Utility scripts | \u2014 |
| `spike/` | 1405 | Uspike | \u2014 |
| `src/` | 81 | Source code | \u2014 |

## Verification
<!-- provenance: CODE-FACTUAL -->
- Trust Level: **L2 — CI Verified**
- CI/CD: GitHub Actions (1 workflows)
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
head_sha: 05c533cdbdbf94a7c7ff081200721ff5e067e0ea
generated_at: 2026-06-01T18:56:09Z
generator: butterfreezone-gen v1.0.0
sections:
  agent_context: 7ae89494865852a9f73d536c07238701977f03776aeea0dcf7a5f7c77a928b87
  capabilities: b1901b285afaff1ab69386c70539785c317413a7749845657cd1520bae196dec
  architecture: e381f746602f858fd558b6553e797d5174497439aefa452748fa0c39df90812e
  interfaces: f2a41f373dd0b133e7dffd3d0aa2e0beadf9875183d5001fbd283fab6b99b16a
  module_map: e512009b9c52c36a3422d1d916215cb30da08d3c8eb6d2d33273381db79a04e9
  verification: a59789866c39f86c188d1f601b7b94205f06c5504cb4b51903bd48bb53208886
  agents: ca263d1e05fd123434a21ef574fc8d76b559d22060719640a1f060527ef6a0b6
  ecosystem: bf204a5475b7b85166f8ab5325771e6e95bea3ec48cbd49fb690edeba4780999
  quick_start: eade50bb4d2a23f52903ea46cb5f7afc98b9d6795d48f48ee4ece1a0e5dff6db
-->
