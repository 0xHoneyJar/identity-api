---
title: freeside-auth — Product Requirements Document
date: 2026-04-30
phase: Phase 1 (PRD) — discovering-requirements skill output
status: SUPERSEDED 2026-05-24 by grimoires/loa/prd.md (PRD v3.0) — retained for provenance
operator: zksoju
authoring_agent: Claude Opus 4.7 (1M)
parent_seed: ~/bonfire/grimoires/bonfire/context/freeside-auth-requirements-seed-2026-04-29.md
parent_bundle: ~/bonfire/grimoires/bonfire/context/auth-unification-seed/
tracking_issue: 0xHoneyJar/hub-interface#20 (Sign in with THJ — Unified Identity Initiative)
adr_supersedes: ADR-003, ADR-038 (filed as ADR-039 in /architect phase)
---

# freeside-auth — Product Requirements Document

> Sovereign identity module for the Freeside ecosystem. Per-world heterogeneous auth substrate. Canonical user spine + credential resolution + JWT validator client. JWKS issuance stays at `loa-freeside/apps/gateway` (Rust); profile data stays in midi (and per-world Railway PG).

## 1 · Problem Statement

### 1.1 Current state — accumulated fragmentation

Seven THJ ecosystem apps run on six different auth strategies. Six of seven use Dynamic Labs SDK at versions ranging `4.41.1` → `4.67.2` (26+ patch versions apart, fragmented). Sessions are siloed across Turso (Dashboard), localStorage (Honeyroad/Rektdrop), Dynamic cookies (Dimensions/Explorer), Convex (Constructs/Purupuru). Zero apps consume the JWKS infrastructure that `loa-freeside/apps/gateway` already publishes.

> Sources: `auth-unification-seed/02-current-state-audit.md:18-37` (Convergence vs Divergence Map), `:386-405` (Drift vs Documented Architecture), `:498-507` (Cross-App friction)

A SatanElRudo-class cross-app session contamination bug was demonstrated in production on 2026-02-17. Sessions issued by Dynamic for one brand corrupted active sessions on another brand because Dynamic re-keyed the user.

> Source: `auth-unification-seed/01-task-brief.md:57` ("SatanElRudo-class bug demonstrated in production (2026-02-17)")

### 1.2 Operator framing (2026-04-29)

> "this move is the accumulation of years of different authentication and profile requirements and services throughout all of the culturetech apps that we've built"

> Source: `freeside-auth-requirements-seed-2026-04-29.md:57-61`

### 1.3 Operator framing (2026-04-30, post-DIG)

> "the profiles across our apps are on railway… external worlds will likely want sovereign auth, just like how each of our worlds have different usernames and auth requirements"

> Source: `freeside-auth-requirements-seed-2026-04-29.md:§14 Data Reality Addendum`

This is **load-bearing**: per-world auth heterogeneity is a first-class architectural concern, not a degraded case. freeside-auth is a substrate that lets each world declare its own auth requirements while exposing a normalized identity-resolution surface — NOT a forced-uniformity layer.

### 1.4 Why now

- Dynamic Fireblocks acquisition surfaces strategic pricing risk
- Operator's 2026-04-13 declaration: "no Dynamic in net-new surfaces"
- Freeside JWKS infrastructure exists but unconsumed (sunk cost) — `loa-freeside/packages/adapters/agent/s2s-jwt-validator.ts` ready, zero callers
- 98,320 Dynamic users across the ecosystem need a sovereign canonical home before any consumer-app migration
- External worlds (post-Freeside-launch) will need to declare their own auth on this substrate

## 2 · Vision & Goals

### 2.1 Vision

> "Unify our authentication system… Freeside as the integration point so JWKS or any authentication service provided by Freeside we should study… I think a single ID under Freeside would make it easier for us when working across different platforms like Solana SeedVaults and migrating from Dynamic etc."

> Source: `auth-unification-seed/01-task-brief.md:8-11` (operator quote, 2026-04-16)

A canonical user ID issued by Freeside, consumable across brands, credential-agnostic, and chain-agnostic. NOT one giant user table — shared **auth**, siloed **profiles** (per ADR-038).

### 2.2 Architectural shape (locked)

**Three-layer split** per `vault/wiki/concepts/freeside-as-identity-spine.md`:

| Layer | Owner | Concern |
|---|---|---|
| **Credential** | external libs (SIWE, Better Auth, Dynamic legacy, WebAuthn, SeedVault) | proof-of-control of an external identifier (wallet, passkey, OAuth) |
| **Identity** | freeside-auth | canonical user_id + credentials[] graph + handle resolution |
| **Session** | per-world (via JWKS verification) | which user is acting in which world right now |

**Composes with [[freeside-as-subway]]**: identity is a *component* attached to worlds, not a mandate. Each world can choose its auth requirements.

**ECS placement** per `~/Documents/GitHub/freeside-auth/CLAUDE.md:42-48`:
- Entity: `User` (this module) + `Wallet` (score-mibera owns)
- Component: `IdentityComponent` (credentials[], handle, tenant) attaches to User
- System: `AuthSystem` (resolve, link, issue)

### 2.3 Goals (high-level)

| ID | Goal | Source |
|---|---|---|
| GOAL-1 | Ship the spine: canonical user table + credential adapters + JWKS validator | task-brief DoD; seed §3 |
| GOAL-2 | Vertical slice cutover: prove "Freeside JWT replaces Dynamic JWT in request headers without worlds noticing" | anti-scope §positive (`auth-unification-seed/07-anti-scope.md:53`) |
| GOAL-3 | File ADR-039 superseding ADR-003 + ADR-038 | task-brief DoD; seed §6 D1 |
| GOAL-4 | Make per-world heterogeneity a first-class architectural primitive | operator 2026-04-30 framing |
| GOAL-5 | Consolidate 98,320 Dynamic users into canonical user spine without forced re-signup | seed §14 Data Reality; anti-scope `:29` ("link-existing flow mandatory") |

## 3 · Success Metrics & Definition of Done

### 3.1 Initiative-level DoD (not this PRD scope; reference)

> Source: `auth-unification-seed/01-task-brief.md:34-41`

- [ ] Canonical user ID scheme defined and implemented in Freeside
- [ ] Freeside JWKS consumed by **at least 2 worlds in production**
- [ ] Wallet-linking flow that does not contaminate sessions across brands
- [ ] Solana credential source wired (or architecturally proven pluggable)
- [ ] Migration flow for existing Dynamic users (link-existing, not re-signup)
- [ ] Documentation in `0xHoneyJar/hivemind` superseding ADR-003 / ADR-038

### 3.2 Sprint-1 DoD (the vertical slice)

| ID | Metric | Target |
|---|---|---|
| M1 | Canonical user mint flow | First credential resolution mints ULID user_id, persists to Postgres, returns JWT |
| M2 | JWKS verification round-trip | Sprawl Dashboard (vertical slice consumer) verifies Freeside JWT via JWKS, fresh+stale cache paths exercised |
| M3 | Dynamic CSV translation fidelity | 98,320 rows → canonical users + credentials[] with zero data loss; idempotent re-runs |
| M4 | Three credential adapters live | SIWE + Passkey + Discord-bot attestation green in integration tests |
| M5 | Per-world auth manifest consumed | World-manifest declares accepted credentials; freeside-auth honors |
| M6 | ADR-039 drafted | Supersedes ADR-003 + ADR-038; ready for hivemind merge |
| M7 | Zero `Co-Authored-By: Dynamic` paths in net-new code | Lint rule blocks `@dynamic-labs/*` import as default; `legacy-migration` allowlist only |

### 3.3 Quality bars

- E2E test coverage for vertical slice happy path + 4 error paths (invalid JWT, expired, JWKS unavailable, wrong tenant)
- Threat model documented (NFR-1.1)
- Audit-pass via `/implement → /review → /audit` gates (anti-scope `:241`: "Auth code = highest scrutiny")

## 4 · Users & Stakeholders

### 4.1 End users

| Persona | Volume | Primary flow |
|---|---|---|
| Wallet-holder (existing Dynamic user) | 98,320 | link-existing-Dynamic on first visit post-cutover; no re-signup |
| Wallet-holder (net-new) | growth | SIWE or Passkey via Better Auth (sovereign tools) |
| In-chat user (Discord/TG) | most THJ members | Bot-as-verifier flow; never sees web auth UI |
| Operator (CM/CEO/CTO/CMO) | small, high-trust | Better Auth + Freeside JWT for sovereign tools (Freeside Dashboard, Constructs Network) |
| External world author | unbounded post-launch | declares own auth requirements via world-manifest; freeside-auth substrate honors heterogeneity |

> Sources: `freeside-auth-requirements-seed-2026-04-29.md:111-122` (ES Discord-bot framing), `:127-134` (sovereignty + privacy)

### 4.2 Engineering stakeholders

| Stakeholder | Touch surface | Coordination ask |
|---|---|---|
| @janitooor | `loa-freeside/apps/gateway` (Rust JWKS issuer); `s2s-jwt-validator.ts` (extraction source) | Lock JWT claims shape; sign off on schema before freeside-auth/protocol publishes |
| @soju | `mibera-dimensions/lib/server/resolve-wallet.ts`; midi profile schemas | Coordinate cutover so midi reads from freeside-auth post-extraction |
| Sprawl Dashboard team | `apps/dashboard/src/lib/server/auth/` | First consumer of Better Auth + Freeside JWT (vertical slice) |
| Eileen Solana (ES) | Discord/TG bot architecture | Bot-as-verifier framing; coordinate ruggy as verifier or sibling persona-bot |
| External world authors (post-launch) | `world-manifest.yaml` | Declare auth components; consume freeside-auth as installable module |

### 4.3 Persona priority for V1

**Operator + ecosystem app developer > end user**, for V1.

Rationale: V1 ships the spine (path C of C-then-B hybrid). Sovereign operator tools adopt first. Consumer apps stay on Dynamic until natural migration windows. End-user-facing UX work scopes into Sprint-2+.

> Source: locked decision per operator args; `auth-unification-seed/05-migration-options.md:69-91` (Path C Pros/Cons)

## 5 · Functional Requirements

### FR-1 — Canonical user spine

| ID | Requirement | Source |
|---|---|---|
| FR-1.1 | The system shall mint a canonical user_id (ULID format) on first credential resolution | seed §6 A1 (autonomous) |
| FR-1.2 | The system shall de-denormalize the Dynamic CSV (98,320 rows, one-row-per-credential) into canonical users + credentials[] without data loss | seed §14 |
| FR-1.3 | The system shall link multiple wallets (per-chain scope) to a single user_id without contaminating sessions across brands | task-brief `:39`; freeside-as-identity-spine wallet-agnostic shape |
| FR-1.4 | The system shall link multiple credential providers (SIWE, Passkey, Discord-bot, Telegram-bot, Better Auth, Dynamic-legacy) to a single user_id | seed §4.2; CLAUDE.md `:18` (composition not absorption) |
| FR-1.5 | The system shall preserve `dynamic_env_id` on canonical user as legacy reference for rollback | anti-scope `:31` ("Do not delete Dynamic env_ids… keep for rollback") |
| FR-1.6 | The system shall support relinking (wallet swap, credential rotation) by mutating the credentials[] array, not the canonical user_id | freeside-as-identity-spine wallet-agnostic shape |

### FR-2 — Credential resolution (3-layer split)

| ID | Requirement | Source |
|---|---|---|
| FR-2.1 | The system shall ship a SIWE credential adapter (mandatory; wallet is table stakes) | seed §6 A3; anti-scope §positive |
| FR-2.2 | The system shall ship a Passkey (WebAuthn) credential adapter | seed §6 A3; soft constraint task-brief `:32` |
| FR-2.3 | The system shall ship a Discord-bot attestation adapter where the bot signs an attestation event submitted to Freeside issuer; bot does NOT mint JWTs | seed §4.1 (ES framing); seed §14.4 secondary critique |
| FR-2.4 | The system shall ship a Telegram-bot attestation adapter (parallel to Discord) | seed §4.1 |
| FR-2.5 | The system shall ship a Better Auth bridge adapter for sovereign tools (operator surface) | path C lock; seed §6 D3 (POC required) |
| FR-2.6 | The system shall ship a Dynamic credential adapter (read-only, post-migration). Dynamic is a **per-world credential option** — not privileged as default, but not banned either. Lint rule blocks `@dynamic-labs/*` as default-import in net-new code; per-world manifests may explicitly opt in. | seed §14.4 (codex review issue 4); anti-scope `:35`; **refined 2026-05-01 per GWK research §G.1 — Dynamic credential UI stays legitimate per-world; we refuse Dynamic as the SPINE, not as a credential adapter** |

### FR-3 — JWT issuance + verification

| ID | Requirement | Source |
|---|---|---|
| FR-3.1 | The system shall mirror the loa-freeside Rust gateway claims shape: `sub` (canonical user_id), `wallets[]`, `credentials[]`, `tenant_id` (world slug), `tier`, `pool_id`, `exp`, `iss`, `aud`, `iat`, `jti` | seed §6 A2 (autonomous); audit `:351-359` |
| FR-3.2 | The system shall ship a JWKS validator client (NOT a signer); JWKS issuance stays at loa-freeside/apps/gateway (Rust) | CLAUDE.md `:19`; locked invariant |
| FR-3.3 | The system shall emit access tokens with 7-day TTL and refresh tokens with 30-day TTL | seed §6 A4 (autonomous default) |
| FR-3.4 | The system shall bind tenant_id (world slug) on JWT issuance per request | audit `:351-359` |
| FR-3.5 | The JWKS validator client shall implement tiered caching: 1h fresh, 72h stale-if-error, 60s refresh cooldown | audit `:344-349` (mirror existing Rust gateway behavior) |

### FR-4 — Per-world heterogeneity (load-bearing)

| ID | Requirement | Source |
|---|---|---|
| FR-4.1 | A world shall declare its accepted credential adapters via `world-manifest.yaml` (e.g., `auth.adapters: [siwe, passkey]`) | operator 2026-04-30 framing; freeside-modules-as-installables shape |
| FR-4.2 | A world shall optionally declare REQUIRED vs ACCEPTED adapters (e.g., Mibera requires SIWE; Purupuru accepts SIWE + Passkey) | operator 2026-04-30 |
| FR-4.3 | An external world shall be able to declare sovereign auth (its own SeedVault, its own OAuth provider) without freeside-auth blocking | operator 2026-04-30 ("external worlds will likely want sovereign auth") |
| FR-4.4 | The world-manifest schema shall version-lock auth declarations per `packages/protocol/VERSIONING.md` (enum-locked schema_version, additive-only minor bumps) | CLAUDE.md `:22`; freeside-modules-as-installables governance import |

### FR-5 — Migration tooling

| ID | Requirement | Source |
|---|---|---|
| FR-5.1 | The system shall ship a Dynamic CSV translator that transforms 98,320 rows into canonical users + credentials[] | seed §14 |
| FR-5.2 | The system shall ship a link-existing-Dynamic flow (no re-signup) | anti-scope `:29` ("Do not force users to re-sign-up… Link-existing flow is mandatory") |
| FR-5.3 | The system shall ship Railway DB read adapters for `mibera-db`, `apdao-db`, `cubquest-db` (per-world profile read) | seed §14 |
| FR-5.4 | The system shall NOT delete Dynamic env_ids from canonical user table after migration (rollback path) | anti-scope `:31` |
| FR-5.5 | The system shall NOT re-key existing Dynamic sessions; sessions expire naturally and are reissued via Freeside JWT on next visit | anti-scope `:30` |

### FR-6 — Vertical slice (Sprawl Dashboard cutover)

| ID | Requirement | Source |
|---|---|---|
| FR-6.1 | Sprawl Dashboard shall replace its current SIWE-Turso flow with Better Auth + Freeside JWT validator | operator args; audit `:42-110` (Dashboard is the cleanest prototype) |
| FR-6.2 | The end-to-end JWT flow shall demonstrate: SIWE proof → freeside-auth canonical user resolution → loa-freeside Rust gateway issues JWT → Sprawl Dashboard verifies via JWKS validator | path C scope |
| FR-6.3 | The vertical slice shall prove the claim "Freeside JWT replaces Dynamic JWT in request headers without worlds noticing" | anti-scope §positive |
| FR-6.4 | The vertical slice shall NOT break existing Dashboard ADMIN_ADDRESSES allowlist semantics | audit `:50` (admin gating is Dashboard-only invariant) |

### FR-7 — MCP-tools surface

| ID | Requirement | Source |
|---|---|---|
| FR-7.1 | The system shall publish `resolve_wallet` MCP tool, replacing the in-bot `freeside_auth` proxy in freeside-ruggy | CLAUDE.md `:11`; existing in-bot tool at `apps/bot/src/agent/freeside_auth/` |
| FR-7.2 | The system shall publish `link_credential` MCP tool (operator + agent surface) | derived from FR-1.4 + agent surface convention |
| FR-7.3 | The system shall publish `issue_jwt_for_world` MCP tool (gateway-mediated; bot does NOT sign) | NFR-1.3 invariant |

## 6 · Non-Functional Requirements

### NFR-1 — Security

| ID | Requirement | Source |
|---|---|---|
| NFR-1.1 | The system shall document a threat model covering canonical user_id minting, merging, revocation, replay defense | seed §14.2 (codex review issue 2) |
| NFR-1.2 | Cross-chain wallet linking shall implement proof-of-control lifecycle: nonce, signed challenge, time-bounded verification window | seed §14.4 secondary (security gap) |
| NFR-1.3 | Discord/TG bots shall NOT mint JWTs and shall NOT share signing keys; bots submit signed attestation events to gateway issuer; gateway returns JWT | seed §14.4 secondary; ES framing 2026-04-24 |
| NFR-1.4 | The system shall pin a privacy posture (zero-knowledge, selective disclosure, cookieless, etc.) — **OPEN**, see DEC-OPEN-8 | seed §4.2 (ES + soju 2026-04-24); seed §6.11 |
| NFR-1.5 | The canonical user table shall be append-only on credential link events; revocation is event-recorded, not row-mutated | derived from audit-trail convention |
| NFR-1.6 | The external-builder surface shall be standard JWKS + OIDC-shaped flow. The system shall NOT require consumer-side SDK adoption to verify a Freeside-issued identity. Any server in any app shall be able to verify a Freeside JWT using only standard cryptographic primitives (JWKS fetch + ES256 verify). | **NEW 2026-05-01 per GWK research §G.2** — GWK's primary positioning weakness is forcing consumer-side wallet-connector SDK adoption; freeside-auth's differentiator is JWKS-as-portable-spine |

### NFR-2 — Performance

| ID | Requirement | Source |
|---|---|---|
| NFR-2.1 | JWKS cache shall implement: 1h fresh, 72h stale-if-error, 60s refresh cooldown | audit `:344-349` (mirror existing) |
| NFR-2.2 | Resolve-and-issue endpoint p95 latency shall be < 200ms | proposed; reviewable in /architect |
| NFR-2.3 | Dynamic CSV translator shall complete 98,320 rows in < 5 minutes (one-time batch; not on hot path) | proposed; reviewable |

### NFR-3 — Reliability

| ID | Requirement | Source |
|---|---|---|
| NFR-3.1 | Stale-if-error JWKS cache shall prevent per-request gateway dependency from world consumers | audit `:344-349` |
| NFR-3.2 | Canonical user creation shall be idempotent; concurrent first-credential resolutions for the same external identifier shall converge to one user_id (no duplicates) | seed §14.2 (revocation/merging concern) |
| NFR-3.3 | The system shall expose break-glass: revoke all sessions for a user_id (operator escape hatch) | derived from Dashboard KILL_SESSIONS pattern, audit `:478` |

### NFR-4 — Operability

| ID | Requirement | Source |
|---|---|---|
| NFR-4.1 | The system shall audit-log: canonical user mint, credential link, credential revocation, JWT issuance | seed §14.2 (audit trail concern) |
| NFR-4.2 | The system shall expose a CLI/MCP for operator triage: lookup user_id by wallet/email/Discord-id; view credentials[]; revoke session | operator surface convention |
| NFR-4.3 | The system shall NOT silently rewrite `sovereign-stack.md:45-51` Dynamic line; supersedes via ADR-039 | anti-scope `:41` |
| NFR-4.4 | DX/UX bar: an external builder shall be able to scaffold their own brand ("Sign in with [their world]") on freeside-auth substrate in **<60 minutes** to a working JWKS-verified session in their first consumer app. Cross-app integration shall NOT require re-signup; canonical user_id portable. | **NEW 2026-05-01 per GWK research §G.4 + operator framing** — operator stated 2026-05-01: "make it very, very seamless is the goal here" |

### NFR-5 — Schema governance

| ID | Requirement | Source |
|---|---|---|
| NFR-5.1 | All schemas shall have enum-locked `schema_version` with stable `$id` | CLAUDE.md `:22` (governance imported from loa-constructs) |
| NFR-5.2 | Minor bumps shall be additive-only | CLAUDE.md `:22` |
| NFR-5.3 | Major bumps shall require migration plan + new file + canonical reference update | CLAUDE.md `:22` |
| NFR-5.4 | Schema location: **OPEN** (DEC-OPEN-6) — `freeside-auth/protocol/` (current scaffold) vs `loa-hounfour` (anti-scope §positive proposal) | anti-scope `:57`; seed §6.9 |

## 7 · Scope

### 7.1 In scope (Sprint-1 vertical slice)

- Canonical user spine: ULID schema, Postgres table, idempotent mint
- Three credential adapters: SIWE (mandatory), Passkey, Discord-bot attestation
- Better Auth bridge adapter (for Sprawl Dashboard cutover)
- Dynamic legacy adapter (read-only, lint-blocked from net-new)
- JWKS validator client (mirror Rust gateway claims shape; tiered cache)
- Dynamic CSV translator (98,320 rows; idempotent)
- Sprawl Dashboard cutover (replace SIWE-Turso with Better Auth + Freeside JWT)
- World-manifest auth declaration (FR-4.1 — first cut)
- ADR-039 draft
- Threat model doc (NFR-1.1)
- 3 MCP tools (resolve_wallet, link_credential, issue_jwt_for_world)

### 7.2 Out of scope for V1 (sequencing — Sprint-2+)

- Telegram-bot adapter (FR-2.4 — design ready; ship after Discord-bot proves shape)
- External world federation primitive (FR-4.3 — design only; substrate hooks; full impl post-launch)
- Mibera Honeyroad / MiDi cutover (consumer apps stay on Dynamic until natural migration window per path C)
- Constructs Explorer / Purupuru cutover (same)
- Solana SeedVault adapter (delegate spike per D-DEL-4)
- OAuth providers (Google, Twitter, Discord-as-OAuth) — anti-scope `:25`
- ERC-4337 / account abstraction — anti-scope `:23`
- Payments / session keys / gas sponsorship — anti-scope `:24`
- Login UI work before backend tested — anti-scope `:43`

### 7.3 Anti-scope (canonical 14 + augmented 3 = 17 hard don'ts)

| ID | Don't | Source |
|---|---|---|
| ANTI-1 | Single user table for profiles (ADR-038: Shared Auth + Siloed Profiles) | `07-anti-scope.md:14` |
| ANTI-2 | Mandate consumer-app migration timeline | `:15` |
| ANTI-3 | Replicate Dynamic's multi-chain wallet widget | `:16` |
| ANTI-4 | Use Dashboard SIWE-Turso as consumer-app template (operator surface ≠ consumer surface) | `:17` |
| ANTI-5 | Wire JWKS verification before issuer ships (sequence: issuer → verifier) | `:18` |
| ANTI-6 | Rewrite all 7 apps in this sprint | `:22` |
| ANTI-7 | Introduce ERC-4337 / account abstraction | `:23` |
| ANTI-8 | Scope-creep into payments / session keys / gas sponsorship | `:24` |
| ANTI-9 | Add OAuth providers (Google/Twitter/Discord-as-OAuth) in v1 | `:25` |
| ANTI-10 | Force users to re-sign-up | `:29` |
| ANTI-11 | Re-key existing Dynamic sessions during migration | `:30` |
| ANTI-12 | Delete Dynamic env_ids from canonical user table | `:31` |
| ANTI-13 | Adopt Better Auth without POC | `:35` |
| ANTI-14 | Ship on 2025-acquired-by-major-vendor without re-eval (Dynamic, Privy, Web3Auth) | `:36` |
| ANTI-15 | Couple identity to chain abstraction layer (privy/turnkey) | `:37` |
| ANTI-16 | Silently supersede `sovereign-stack.md:45-51` Dynamic line — needs ADR-039 | `:41` |
| ANTI-17 | Use "SSO" naming in user copy — call it "Sign in with THJ" | `:42` |
| ANTI-18 | Build login UI before backend e2e tested | `:43` |
| ANTI-19 | Commit auth code without `/implement → /review → /audit` gates | `:44` |
| ANTI-20 | Collapse identity + profile (scaffold has this bug; per ADR-038, profile data NOT in shared canonical) | seed `:245` |
| ANTI-21 | Assume all consumers are web-based (Discord-bot + Telegram-bot are first-class) | seed `:246` |
| ANTI-22 | Over-design package cardinality (collapse 6→3: protocol + runtime + mcp-tools per codex review) | seed `:247`, §14.6 |
| ANTI-23 | Conflate wallet-discovery with cross-app session — GWK treats "your wallet appears in their wallet picker" as the cross-app primitive. Wallet-picker UX is NOT session portability. The cross-app primitive must be a verifiable signed token (JWT via JWKS), not a wallet connection. | **NEW 2026-05-01 per GWK research §E.1 + §G.3** — primary architecture mistake observed in Dynamic Global Wallet Kit |
| ANTI-24 | Force consumer-side SDK adoption to verify a Freeside identity — server in app B must be able to verify a Freeside-issued JWT for app A using only standard JWKS fetch + ES256 verify, no `@freeside-auth/*` import required on the verifier side | **NEW 2026-05-01 per GWK research §F + §G.2** — GWK's hosted lock-in by design; freeside-auth's portability is the differentiator |
| ANTI-25 | Try to out-build Dynamic's multi-chain wallet UI (500+ wallets, EVM/Solana/Bitcoin/Sui) — that's GWK's genuine strength; freeside-auth treats Dynamic-as-credential-layer as legitimate per-world option, NOT as a build-from-scratch target | **NEW 2026-05-01 per GWK research §F (Where Dynamic is genuinely strong)** — honest framing per ANTI-3 (don't replicate Dynamic's wallet widget) refined for the substrate-tier |

### 7.4 Vertical slice plan (Sprint-1)

```
PHASE 1: Schema (5 days)
  - protocol/user.schema.json (TypeBox)
  - protocol/credential.schema.json
  - protocol/jwt-claims.schema.json (mirror Rust gateway shape)
  - protocol/world-manifest-auth.schema.json (FR-4.1)
  - protocol/VERSIONING.md governance imported from loa-constructs

PHASE 2: Engine + ports (5 days)
  - engine/canonical-user.ts (mint, link, lookup; idempotent)
  - engine/resolve-tier.ts (extract from midi/lib/server/resolve-wallet.ts)
  - ports/credential-adapter.ts (interface)
  - ports/jwks-validator.ts (interface)
  - Unit tests against fixtures

PHASE 3: Adapters (7 days)
  - adapters/credential-bridge-siwe.ts
  - adapters/credential-bridge-passkey.ts
  - adapters/credential-bridge-discord-bot.ts (signed attestation; no JWT minting)
  - adapters/credential-bridge-better-auth.ts (Sprawl Dashboard cutover)
  - adapters/credential-bridge-dynamic.ts (legacy, read-only, lint-blocked default)
  - adapters/jwks-validator.ts (extract from loa-freeside/packages/adapters/agent/s2s-jwt-validator.ts)
  - adapters/pg-mibera-profiles.ts (Railway read adapter)
  - adapters/pg-apdao.ts
  - adapters/pg-cubquest.ts
  - adapters/dynamic-csv-translator.ts (98,320 rows, idempotent)

PHASE 4: MCP-tools (3 days)
  - mcp-tools/resolve_wallet
  - mcp-tools/link_credential
  - mcp-tools/issue_jwt_for_world

PHASE 5: Sprawl Dashboard cutover (5 days)
  - Replace SIWE-Turso flow with Better Auth + Freeside JWT
  - JWKS verification round-trip
  - ADMIN_ADDRESSES allowlist preserved
  - E2E tests + soak window

PHASE 6: Distillation (2 days)
  - ADR-039 finalized
  - Threat model doc
  - Migration runbook
  - Retro

Total: ~27 days · 5-6 weeks elapsed
```

> Decomposes to roughly 25-30 beads tasks; full breakdown deferred to /sprint-plan.

## 8 · Decisions Log

### 8.1 LOCKED (operator picked; do not re-litigate)

| ID | Decision | Source |
|---|---|---|
| DEC-LOCK-1 | Migration path = **C-then-B hybrid** (sovereign tools first on Better Auth + Freeside JWT; consumer apps stay on Dynamic until natural windows) | operator args 2026-04-30; seed §141 recommendation |
| DEC-LOCK-2 | Module name = **freeside-auth** (renamed from freeside-identities 2026-04-29) | seed §5; commit `46aeee1` |
| DEC-LOCK-3 | Score-vs-identity boundary holds (no profile data in score-mcp) | `vault/wiki/concepts/score-vs-identity-boundary.md` (2026-04-29 doctrine) |
| DEC-LOCK-4 | Profile data home = Railway (mibera-db, apdao-db, cubquest-db); score-* DBs OUT OF SCOPE | seed §14 |
| DEC-LOCK-5 | Dynamic CSV (98,320 rows, env `137aa286-…`) is canonical legacy migration seed | seed §14 |
| DEC-LOCK-6 | All 22 anti-scope items honored (§7.3) | seed §7; augmented §14.augmentation |
| DEC-LOCK-7 | Per-world auth heterogeneity is FIRST-CLASS architectural concern | operator 2026-04-30 framing |
| DEC-LOCK-8 | Composes with [[freeside-as-subway]]: identity-as-component, not auth-mandate | freeside-modules-as-installables |
| DEC-LOCK-9 | Three-layer split: credential / identity / session (per freeside-as-identity-spine) | vault concept; locked invariant |
| DEC-LOCK-10 | JWKS issuance stays at `loa-freeside/apps/gateway` (Rust); freeside-auth ships **validator + claims schema, NOT signer** | CLAUDE.md `:19`; locked invariant |
| DEC-LOCK-11 | Profile DATA stays in midi (and per-world Railway PG); freeside-auth holds canonical user spine + credential resolution | CLAUDE.md `:18` |
| DEC-LOCK-12 | Vertical slice consumer = **Sprawl Dashboard** (already SIWE-Turso clean prototype) | operator args; audit `:42-110` |

### 8.2 AUTONOMOUS (synthesis decided; reviewable in /architect)

| ID | Decision | Rationale | Source |
|---|---|---|---|
| DEC-AUTO-1 | Canonical user_id format = **ULID** | sortable (timestamp-prefixed), URL-safe, 128-bit, doesn't leak count, more compact than UUIDv4 | seed §6 A1 |
| DEC-AUTO-2 | JWT claims shape mirrors Rust gateway: `sub`, `wallets[]`, `credentials[]`, `tenant_id`, `tier`, `pool_id`, `exp`, `iss`, `aud`, `iat`, `jti` | mirrors existing live shape; zero migration cost on validator side | seed §6 A2; audit `:351-359` |
| DEC-AUTO-3 | Initial credential adapters = **SIWE + Passkey + Discord-bot attestation** | SIWE mandatory (table stakes); Passkey for Pro track + AAL2 path; Discord-bot is largest user surface per ES framing | seed §6 A3 + seed §4.1 |
| DEC-AUTO-4 | JWT TTL = **7d access + 30d refresh** | seed default proposal; balances security with UX | seed §6 A4 |
| DEC-AUTO-5 | Identity table location = **loa-freeside RDS (Postgres)** | identity spine co-locates with issuer (gateway lives there); avoids cross-service coordination on user mint | seed §6 A5 |
| DEC-AUTO-6 | Rate limits (initial): 10 req/min per IP on resolve-and-issue; 100 req/min per session globally | proposed; reviewable in /architect | seed §6 A6 |
| DEC-AUTO-7 | Dev/test strategy: mock JWKS server in `protocol/test-fixtures/`; fixture user CSV slice (1k rows); local Better Auth via docker-compose | proposed | seed §6 A7 |
| DEC-AUTO-8 | Package cardinality: **collapse 6 → 3 at V0.1** (`protocol` + `runtime` + `mcp-tools`); add `ui` only when freeside-dashboard identity work is real | seed §14.6 codex review issue 6; over-design risk | seed §6.aug |
| DEC-AUTO-9 | Dynamic CSV translator = idempotent batch (CSV → users + credentials[]); no live Dynamic API calls in net-new code | matches "Dynamic = legacy-migration" lint policy | DEC-LOCK-5 + ANTI-13 |

### 8.3 OPEN (operator decides at /architect or pre-architect)

| ID | Decision | Recommendation | Source |
|---|---|---|---|
| DEC-OPEN-1 | Better Auth: confirmed, or POC-gated? | **Recommend: POC-gated** (anti-scope `:35` is explicit; POC = Sprint-0.5, 3-day timebox; commits Sprawl Dashboard cutover only on POC pass) | seed §6.3 |
| DEC-OPEN-2 | freeside-auth: new repo (already scaffolded) or extension of `loa-freeside`? | **Recommend: separate repo** (current state — scaffold at `0xHoneyJar/freeside-auth`); composes with `loa-freeside` via published validator client. Rationale: per-module repo matches freeside-* installable doctrine | seed §6.4 |
| DEC-OPEN-3 | JWT verification: per-world via JWKS, or centralized via Freeside gateway? | **Recommend: per-world via JWKS** — already the implementation; resilient (no per-request gateway dep); revocation via short-lived tokens + JWKS rotation | seed §6.5 |
| DEC-OPEN-4 | Solana SeedVault timing: H1 priority, or eventually pluggable? | **Recommend: eventually pluggable** in V1 architecture; SeedVault adapter is Sprint-2+ (delegate spike per D-DEL-4) | seed §6.6; task-brief `:24` |
| DEC-OPEN-5 | Backward-compat: keep `auth.0xhoneyjar.xyz` cookie SSO? | **Recommend: drop** (Freeside JWT is bearer-friendly; cookie SSO complicates cross-brand semantics; ANTI-17 says don't call it SSO) | seed §6.7 |
| DEC-OPEN-6 | Schema location: `freeside-auth/protocol/` vs `loa-hounfour` | **Recommend: `freeside-auth/protocol/`** — module owns its own schemas; `loa-hounfour` is ecosystem-shared but identity is module-scoped; cross-reference but don't relocate | seed §6.9; anti-scope §positive `:57` (push-back from ecosystem doc) |
| DEC-OPEN-7 | Discord/Telegram bot-as-verifier: v1 or backlog? | **Recommend: Discord-bot v1 (FR-2.3); Telegram-bot Sprint-2** — Discord is largest user surface per ES; Telegram parallel design lands once Discord proves shape | seed §6.10 |
| DEC-OPEN-8 | Privacy posture shape | **Recommend: cookieless + selective disclosure** (no third-party cookies; user opts which credentials surface per world request); zero-knowledge as Sprint-3+ research | seed §6.11; ES "this is a privacy heavy thing we need to nail" |

### 8.4 DELEGATE (operator routes to person/spike)

| ID | Decision | Owner |
|---|---|---|
| DEC-DEL-1 | ADR-039 author (operator personal vs delegate) | @zksoju decides at /architect |
| DEC-DEL-2 | @janitooor architectural sign-off on `loa-freeside/apps/gateway` impact (claims shape, issuer endpoint, validator extraction) | @janitooor |
| DEC-DEL-3 | Migration communication plan (when consumer apps eventually port off Dynamic) | post-Sprint-1 GTM call |
| DEC-DEL-4 | Solana SeedVault protocol research spike | separate research session |
| DEC-DEL-5 | Legal/regulatory passkey storage compliance (AAL2 landscape) | external counsel |

## 9 · Risks & Dependencies

### 9.1 Risks

| ID | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| RSK-1 | Better Auth has no Solana adapter — must build or defer | High | Med | Defer Solana to Sprint-2+ (DEC-OPEN-4 = pluggable); SeedVault spike (DEC-DEL-4) |
| RSK-2 | Discord/TG bot attestation requires careful key management | Med | High | NFR-1.3 invariant; bot signs attestation, gateway issues JWT; key rotation plan in threat model (NFR-1.1) |
| RSK-3 | Railway DB heterogeneity — schemas per world differ; adapter complexity grows | Med | Med | One adapter per world DB at first cut; common port interface; defer cross-world unification queries |
| RSK-4 | Dynamic CSV translation fidelity — de-denormalization could miss credentials | Low | High | Idempotent + count-checking translator; assertion: `output_credentials_count == input_csv_rows`; backup CSV as immutable snapshot |
| RSK-5 | SatanElRudo-class cross-app session contamination could re-emerge | Low | High | Per-world tenant_id binding (FR-3.4); JWT scoped to single tenant; audit-log on re-keying events |
| RSK-6 | Schema location indecision (DEC-OPEN-6) blocks scaffold completion | Med | Low | Default to `freeside-auth/protocol/`; revisit if `loa-hounfour` ecosystem coordination materializes |
| RSK-7 | Better Auth POC fails on Solana or critical UX | Med | High | DEC-OPEN-1: POC gates the path; failure → re-evaluate path D (Rust from scratch) or path A (Freeside JWT on Dynamic) |
| RSK-8 | Codex 6 structural issues in scaffold not fully addressed before /implement | Low | Med | Audit-pass via /review-sprint + /audit-sprint; explicit acceptance criteria for each scaffold issue in /sprint-plan |
| RSK-9 | @janitooor unavailable for claims-shape sign-off, blocking schema lock | Med | Med | Schema-from-source (extract from `s2s-jwt-validator.ts`); ratify with janitooor when available; do not block on him for schema mirroring |
| RSK-10 | "Big-bang migration" trap (anti-pattern from anti-scope `:48`) | Low | High | Path C makes consumer-app migration optional; vertical slice = ONE consumer (Sprawl Dashboard) |

### 9.2 Dependencies

| ID | Dependency | Owner | Status | Mitigation |
|---|---|---|---|---|
| DEP-1 | @janitooor: lock JWT claims shape; sign off on validator extraction from `s2s-jwt-validator.ts` | @janitooor | OPEN | Schema mirror is mechanical; ratify; flag PRs in /review |
| DEP-2 | @soju: midi cutover after schemas land (post-Sprint-1) | @soju | OPEN | midi adapter (FR-5.3) reads midi DB; cutover sequenced separately |
| DEP-3 | Better Auth POC | DEC-OPEN-1 | NOT STARTED | Sprint-0.5 timebox |
| DEP-4 | Solana SeedVault research spike | DEC-DEL-4 | DEFERRED | Pluggable arch (DEC-OPEN-4) lets V1 ship without |
| DEP-5 | Sprawl Dashboard team coordination | TBD | OPEN | Vertical slice consumer; coordinate cutover window |
| DEP-6 | loa-freeside Rust gateway issuer endpoint live (`/identity/resolve-and-issue` or equivalent) | @janitooor | OPEN | Issuer-first sequencing per ANTI-5 |
| DEP-7 | Dynamic CSV preserved as immutable snapshot | already pulled | DONE | Path: `~/Downloads/export-d5e7f445-c537-4d7a-9fb0-a35afc42dc30.csv` |
| DEP-8 | Railway DB read access (mibera-db, apdao-db, cubquest-db) | @soju | OPEN | Read-only credentials; will use `railway run` pattern |

## 10 · Technical context (defers to /architect for SDD)

### 10.1 Existing infrastructure to leverage

- **Rust JWKS gateway**: `loa-freeside/apps/gateway/` (built, untested in production-by-worlds)
- **JWKS validator**: `loa-freeside/packages/adapters/agent/s2s-jwt-validator.ts` (tiered cache logic; extract to `freeside-auth/adapters/jwks-validator.ts`)
- **midi resolve-wallet**: `mibera-dimensions/lib/server/resolve-wallet.ts` (extract to `freeside-auth/engine/resolve-tier.ts`)
- **Sprawl Dashboard SIWE**: `apps/dashboard/src/lib/server/auth/siwe.ts` (clean prototype; informs Better Auth bridge tests)
- **In-bot freeside_auth proxy**: `freeside-ruggy/apps/bot/src/agent/freeside_auth/` (replaces with mcp-tools/resolve_wallet)

### 10.2 Net-new infrastructure required

- Better Auth instance (sovereign tools surface; Sprawl Dashboard first consumer)
- Postgres canonical user table in loa-freeside RDS (DEC-AUTO-5)
- Dynamic CSV translator (one-time batch)
- Bot-attestation event channel (Discord-bot signs; gateway issues JWT; transport = HTTP POST to gateway)

### 10.3 Decisions deferred to /architect

- Concrete schema files (TypeBox JSON Schema) for user, credential, jwt-claims, world-manifest-auth
- Postgres table migrations + indexes
- Gateway endpoint contract (`POST /identity/resolve-and-issue`)
- Better Auth integration shape (plugin vs fork)
- Discord-bot attestation event schema + signing key rotation policy
- World-manifest auth declaration syntax (concrete YAML shape)

## 11 · References

### 11.1 Primary context (this PRD)

- `~/bonfire/grimoires/bonfire/context/freeside-auth-requirements-seed-2026-04-29.md` (incl. §14 Data Reality 2026-04-30) — primary seed
- `~/bonfire/grimoires/bonfire/context/auth-unification-seed/` (8 files, 2026-04-16) — ground-truth bundle
- `~/Documents/GitHub/freeside-auth/CLAUDE.md` — module agent instructions
- `~/Documents/GitHub/freeside-auth/docs/INTENT.md`
- `~/Documents/GitHub/freeside-auth/docs/EXTRACTION-MAP.md`
- `~/Documents/GitHub/freeside-auth/docs/INTEGRATION-PATH.md`

### 11.2 Vault concepts

- `~/vault/wiki/concepts/freeside-as-identity-spine.md` — architectural shape
- `~/vault/wiki/concepts/score-vs-identity-boundary.md` — boundary doctrine (2026-04-29)
- `~/vault/wiki/concepts/freeside-as-subway.md` — composition framing
- `~/vault/wiki/concepts/freeside-modules-as-installables.md` — module shape
- `~/vault/wiki/concepts/ecs-architecture-freeside.md` — ECS placement
- `~/vault/wiki/concepts/contracts-as-bridges.md` — schema-as-bridge doctrine
- `~/vault/wiki/sovereign-stack.md` — L1-L5 stack (legacy Dynamic line at §45-51 superseded by ADR-039)

### 11.3 ADRs

- ADR-003: `~/.loa/constructs/packs/hivemind-os/laboratory/decisions/ADR-003-authentication-provider-dynamic-over-alternatives.md` (superseded by ADR-039)
- ADR-038: `~/.loa/constructs/packs/hivemind-os/laboratory/decisions/ADR-038-shared-auth-siloed-profiles.md` (refined by ADR-039)
- ADR-039: TBD (filed at /architect; supersedes ADR-003 + ADR-038)

### 11.4 Tracking issue + scaffold

- `0xHoneyJar/hub-interface#20` — Sign in with THJ tracking issue (the spine)
- `0xHoneyJar/freeside-auth` — scaffold (commit `46aeee1`, renamed 2026-04-29 from `freeside-identities`)

### 11.5 Operator + collaborator conversations

- Discord conv 2026-04-24 (multi-wallet sync, sovereignty, ES Discord-bot framing)
- Operator pushback 2026-04-29 (naming + scaffold review)
- Operator framing 2026-04-30 (Railway data home + per-world heterogeneity invariant)
- Codex adversarial review 2026-04-29 (MAJOR REVISION verdict; 6 structural issues + 4 secondary)

## 12 · Appendices

### 12.1 Dynamic CSV schema (98,320 rows)

**Path**: `~/Downloads/export-d5e7f445-c537-4d7a-9fb0-a35afc42dc30.csv`
**Environment**: `137aa286-922e-4308-835d-eb00d04b9f14` (single Dynamic env — consolidated THJ ecosystem)
**Shape**: 38 columns, denormalized (one row per verified credential)

User cluster (16 cols):
`user_id, user_createdAt, user_updatedAt, user_projectEnvironmentId, user_email, user_firstName, user_lastName, user_alias, user_username, user_lowerUsername, user_phoneNumber, user_tShirtSize, user_firstVisit, user_lastVisit, user_onboardingCompletedAt, user_metadata`

Credential cluster (22 cols):
`verified_credential_address, verified_credential_bio, verified_credential_chain, verified_credential_email, verified_credential_fid, verified_credential_format, verified_credential_id, verified_credential_lastSelectedAt, verified_credential_lowerAddress, verified_credential_oauthAccountId, verified_credential_oauthDisplayName, verified_credential_oauthProvider, verified_credential_oauthUsername, verified_credential_phoneCountryCode, verified_credential_phoneNumber, verified_credential_publicIdentifier, verified_credential_refId, verified_credential_signerRefId, verified_credential_signInEnabled, verified_credential_walletAdditionalAddresses, verified_credential_walletName, verified_credential_walletProvider`

### 12.2 Railway DB inventory (auth-relevant)

| DB project | World(s) | Auth relevance |
|---|---|---|
| `mibera-db` | Mibera (HoneyRoad / MiDi / Dimensions) | Profile data of record (`midi_profiles` table); read adapter FR-5.3 |
| `apdao-db` | APDAO | Governance member profiles; read adapter FR-5.3 |
| `cubquest-db` | CubQuests | User + quest profiles; read adapter FR-5.3 |
| `score-puru` / `score-sprawl` / `score-api` | (score domain) | OUT OF SCOPE per DEC-LOCK-3 |
| `freeside-characters` / `codex-mcp` / others | (module-internal) | OUT OF SCOPE |

### 12.3 7-app current state summary (audit `02-current-state-audit.md`)

| App | Auth library | Session | Chain | Freeside JWKS? |
|---|---|---|---|---|
| Sprawl Dashboard | SIWE v3 + Turso | server-side, 7d | Base 8453 | NO (vertical slice consumer) |
| Sprawl Rektdrop | viem only (no auth) | stateless | Base | NO |
| Mibera Honeyroad | Dynamic v4.41.1 | localStorage + cookies | multi-chain | NO |
| Mibera Dimensions | Dynamic v4.67.2 + JWKS-RSA | cookies + verify | multi-chain | NO |
| Constructs Explorer | Dynamic v4.61.3 + Convex | localStorage + Convex | multi-chain | NO |
| Purupuru / World | Convex (passkey?) | Convex | Base (inferred) | NO |
| loa-freeside | JWKS issuer (Rust) | server-side | platform | YES (built, unused) |

**Convergence ZERO. Divergence on every dimension.** Migration target: shared spine, preserved per-world heterogeneity.

---

## Decisions Index

- 12 LOCKED (operator picked)
- 9 AUTONOMOUS (synthesis, reviewable)
- 8 OPEN (operator picks at /architect)
- 5 DELEGATE (routes to people/spikes)

## G-ID Index

- 7 functional requirement groups (FR-1 through FR-7) · 32 individual FR-IDs · FR-2.6 refined 2026-05-01 (per-world adapter, not legacy-only)
- 5 non-functional requirement groups (NFR-1 through NFR-5) · 21 individual NFR-IDs · NFR-1.6 + NFR-4.4 added 2026-05-01 (GWK research)
- 25 anti-scope items (ANTI-1 through ANTI-25) · ANTI-23/24/25 added 2026-05-01 (GWK research)
- 10 risks (RSK-1 through RSK-10)
- 8 dependencies (DEP-1 through DEP-8)

## Status

✅ **Ready for /architect.**

Carried-forward context:
- 12 LOCKED decisions (do not re-litigate)
- 9 AUTONOMOUS decisions (reviewable in SDD)
- 8 OPEN decisions awaiting operator pick (recommendations included)
- Better Auth POC + janitooor sign-off + Solana spike are upstream of full Sprint-1 execution

Next step: `/architect` consumes this PRD + SDD lock target = C-then-B hybrid + per-world heterogeneity primitive.

---

*Authored 2026-04-30 by Claude Opus 4.7 (1M, /plan-and-analyze) in DIG → ARCH reorient session. Output of Phase 1 of Loa workflow. Phase 2 (/architect) next.*
