# Session — Build identity-api #11 Phase 1: wallet-only entry + privacy-by-default name model

> identity-api becomes the **sole generator** of world display-names. The 189 wallet-only honey-road users (invisible to the spine today) get a spine row + a privacy-preserving handle. The MIBERA-XXXX scheme **hoists out of honey-road into the spine** — apps stop hand-rolling identity. Source of truth for the design = this doc (grounded 2026-06-02, all refs cite `file:line`).

## Context

`identity-api#11` (epic: identity-api as the Dynamic/Privy replacement) is gated at Phase 1 by a population problem. Prod spine: **4 users / 3 `world_identity` rows / 192 midi profiles**. The only spine-creating engine API is `linkVerifiedWallet(...)` which **hard-requires `discordId`** (`packages/engine/src/link-verified-wallet.ts:53`; protocol enforces `z.string().min(1)` at `protocol link.ts:23`). Of 192 midi users, **189 are wallet-only (no discord)** → invisible to the SoR. The prior backfill (`scripts/backfill-world-identities.ts`) reached only **3 of 192** for exactly this reason.

This starves three presentation layers off ONE root cause (spine empty for wallet-only users):
- **freeside-dashboard cutover** — consumes `/v1/identity/resolve` (shipped, PR #33) but gets sparse data. NOTES `RESUME` + `sdd.md:L390`: "Dashboard CUTOVER still gated on #11 backfill."
- **honey-road navbar** — 189/192 show `0xAB…cd` instead of a name (the live regression the epic was filed against).
- **characters spotlight / recent-minters** — usernames wired-but-sparse.

### Operator ratification (2026-06-02)

Two forks decided, both reinforcing **one substrate, no per-app hand-rolling, spine is SoR**:

1. **Handle origin = HOIST, not carry.** MIBERA-XXXX is minted inside honey-road today (`mibera-honeyroad/lib/db/schema/index.ts:463` `mibera_id text NOT NULL`, format check `^MIBERA-[A-F0-9]{6}$` at `:480`). Operator: *"that needs to get hoisted to the identity-api layer since I would NOT want each individual app to have to handroll its own systems. This is the exact collapse which /hivemind faced and /recall auth friction."* ⇒ The spine **owns the generation scheme**; it **absorbs** honey-road's existing values for the 189 (so nothing on-screen changes); honey-road becomes a **reader** (Sprint B). This is [[sovereign-aggregator-substitution]] applied to name generation.
2. **Resolver = one, both endpoints.** The privacy-default resolver (generated handle as floor, raw address never default) applies to `/v1/profile` AND `/v1/identity/resolve` (`merge-identity.ts`) **and** JWT display claims. No divergence; every surface projects the same spine.

### MIBERA-XXXX is a privacy primitive, not a fallback

Operator intent: *"when they register, if they don't want to set a name OR even by default this can be set, so that an anonymous conscious community could hide addresses by default instead of showing an ugly shortened address."* The generated handle is the **default-display floor**; the raw shortened address is an explicit, never-default opt-in. The resolver inverts today's `merge-identity.ts:76-77` (which terminates on the raw wallet address).

## Run via — Loa sprint cycle (REQUIRED, no latitude)

Auth + **schema migration + persistence** on the identity SoR = **zero creative latitude** (CLAUDE.md). Full gate, non-negotiable review:
```
/sprint-plan            # turn the task breakdown below into a sprint + beads
   → /run sprint-N      # implement → /review-sprint → /audit-sprint, circuit breaker, test-first
```
Alt (operator's call at kickoff): `code-implement-and-review` composition (the proven adversarial path this cycle).

### ⚠ Base-branch sequencing (decide before `/sprint-plan`)

`merge-identity.ts` + the resolve facade live on `w2.5-sprint-3-auth-sdk-source-distributed` (**28 commits ahead of main**), pending the operator's `#28` prod-flip. The one-resolver decision touches `merge-identity.ts`, so this build must base off that branch OR off main **after** `#28` lands. **Recommended:** flip `#28`→main first (NOTES says it is already mergeable), then base Sprint A off clean main. Otherwise base off `w2.5-sprint-3...` and accept the compounded stack.

## Persona

ARCH (`the-arcade`/OSTROM) + craft lens. Reuse over reinvention; structural discipline on the SoR.

---

## What to Build — Sprint A (identity-api, this build · dependency-ordered)

> Every concrete ref below was grounded against the tree on 2026-06-02. Reuse the named primitives; do not reinvent linkage/audit logic.

### A1 · Migration `0008_world_name_model` (test-first)
The name model is a **registry, not a 3-tier** — the evolvable edge (a new world = INSERT rows, zero code change). Today `world_identity` is a flat `nym TEXT` with `UNIQUE (world_slug, nym)` (`0001_init_spine.up.sql:92-99`) — no type, priority, opt-in, or soft-delete.

- `world_name_types` — per-world scheme registry: `(world_slug FK, name_type, generator_kind CHECK IN ('generated_scheme','derived','authored'), pattern, default_priority INT, is_opt_in BOOL, created_at)` PK `(world_slug, name_type)`.
- `world_identity_names` — per-user name rows: `(user_id FK, world_slug, name_type, value, priority INT, is_opt_in BOOL, assigned_at, retired_at NULL)`, FK `(world_slug, name_type)→world_name_types`. Multiple rows per `(user,world)`; soft-retire via `retired_at` (mirrors `wallet_links.unlinked_at`). `UNIQUE (world_slug, name_type, value) WHERE retired_at IS NULL` **replaces** the old single-column `UNIQUE (world_slug, nym)` (incompatible with multi-name).
- **Keep `world_identity.nym`** as a denormalized default-display pointer (do NOT drop) + a `BEFORE` trigger recomputing it from the resolver (mirror `0002_primary_wallet_trigger`), so `SpineWorldIdentity` + `merge-identity.ts:57` keep working unchanged.
- **Seed `mibera`:** `('mibera','claimed_nym','authored',NULL,10,false)`, `('mibera','generated','generated_scheme','^MIBERA-[A-F0-9]{6}$',50,false)`, `('mibera','raw_short_addr','derived',NULL,90,TRUE)`. Lower priority = preferred. **Do NOT add a `mibera_id` column** — the value is a `generated` name row, not a column.
- `0008.down`: drop trigger + both tables; `nym` untouched. Clean reversal.

### A2 · Spine port + adapter — `SpineWorldName` + name primitives (test-first)
Add `SpineWorldName` to `spine.port.ts`; additive `world_names: readonly SpineWorldName[]` on `SpineIdentityShape` (`spine.port.ts:81-89`). Adapter primitives:
- `claimGeneratedName(txn, {userId, worldSlug})` — reads the world's `generated_scheme` + `pattern`, mints a conforming value (collision-checked against the partial unique index), INSERTs `world_identity_names`, emits `name_assigned` audit. **This is the hoisted generator.**
- `importName(txn, {userId, worldSlug, nameType, value})` — absorbs an externally-minted value (the backfill's honey-road `mibera_id` + `display_name`); same audit.
- surface `world_names` in `getIdentity`.

### A3 · Engine — `linkWalletOnly` orchestrator (test-first)
`packages/engine/src/link-wallet-only.ts`, exported from `index.ts` (alongside `linkVerifiedWallet`, `index.ts:139-158`). Mirrors `linkVerifiedWallet` **minus the discord axis**:
```ts
linkWalletOnly(spine, { worldSlug, walletAddress, dynamicUserId?, importedNames? }, { resolver?, actor? })
  → { ok, userId, walletAddress, idempotent, conflictResolved, generatedName }
```
Inside `spine.withTransaction` (as `link-verified-wallet.ts:165`): `resolveByWallet` → `mintUser` if unknown → `linkWalletWithAudit(isPrimary:true)` (`resolve-spine.ts:159-186`) → optional `linkAccountWithAudit(provider='dynamic_user_id')` → **claim or import the generated name** (`importedNames` present → `importName`; absent → `claimGeneratedName`) → umbrella `link_wallet_only` audit. **NEVER** writes `provider='discord'`. Conflict resolver: 3-case, injectable, defaults first-claim / idempotent-noop.

### A4 · `resolveDisplayName` pure function (test-first)
Beside `merge-identity.ts`, sharing its precedence vocabulary, consuming `SpineWorldName[]`:
`resolveDisplayName(world_names, { includeOptIn = false })` → lowest-priority **active, non-opt-in** name. Privacy invariant (test it): `includeOptIn=false` **NEVER** returns the raw address, even when no other name exists. `display_source` enum extends with `'generated'` (+ `'raw_short_addr'` only when opt-in requested).

### A5 · Wire the ONE resolver into BOTH endpoints (test-first)
- `/v1/profile` (`compose-profile.ts:194-290`) — add an OPTIONAL `display_name` + `display_source` block (additive, non-breaking) via `resolveDisplayName`.
- `/v1/identity/resolve` (`merge-identity.ts:55-78`) — replace the raw-address terminal fallback (`:76-77`) with `resolveDisplayName`. ⚠ This also changes **JWT display-claim** semantics (wider blast radius) — covered by the operator's "both endpoints" decision; assert byte-shape on the signer path is untouched (only the display value changes).

### A6 · Backfill + revert (test-first)
`scripts/backfill-wallet-only-from-midi.ts` mirrors `backfill-midi-profiles.ts` (entry guard, `--dry-run`, exit codes 0/1/2/3, two DB connections in `finally`):
- SELECT `midi_profiles WHERE wallet_address IS NOT NULL AND discord_id IS NULL` (the 189 the current backfill skips at `backfill-midi-profiles.ts:134-138`). Read `wallet_address`, `dynamic_user_id`, `mibera_id` (NOT NULL — 100% coverage), `display_name`.
- MAP → `linkWalletOnly({ worldSlug:'mibera', walletAddress, dynamicUserId?, importedNames: [{type:'generated', value: mibera_id}, {type:'claimed_nym', value: display_name}] }, { actor:'backfill-wallet' })`. **Absorb, don't regenerate** (preserves what honey-road shows).
- Idempotent via `linkWalletOnly.idempotent`. **HARD count assertion** post-run: active `wallet_links` ≥ prior + 189, else exit 3 (new precedent — no existing backfill asserts this).
- Revert sibling `backfill-wallet-only-from-midi-revert.ts`: soft-unlink `actor='backfill-wallet'` linkages + retire minted names; idempotent via `unlinked_at IS NULL` / `retired_at IS NULL`.

### A7 · E2E (+ optional route, operator's call)
Disposable PG → migrate `0008` → backfill 189-row fixture → assert every user has a default-display resolving to a name (claimed nym, else MIBERA-XXXX) and **never** the raw address → `/v1/profile` + `/v1/identity/resolve` agree → revert → baseline. Optional `POST /v1/link/wallet-only` (mirror `link.ts:53-107` `X-Service-Token` gating, wallet-only schema with NO `discordId`) — defer unless operator wants it this sprint; backfill drives the engine directly meanwhile.

## What to Build — Sprint B (cross-repo follow-on · NOT this build)

`mibera-honeyroad`: repoint name reads to identity-api `/v1/profile`, **deprecate honey-road's local `mibera_id` minting** (find the mint site; today only the schema is grounded at `lib/db/schema/index.ts:463`). identity-api becomes the sole generator. Sequenced **after** Sprint A lands + the prod backfill runs + the dashboard cutover. Track as a coord task.

## What NOT to Build

- ❌ TBA graduation, which-account-earns-badge, person↔account merge rules — the **kaironic frontiers** ([[identity-account-capability-model]]); this is pure off-chain spine population.
- ❌ The honey-road repoint / mint-deprecation (Sprint B, cross-repo).
- ❌ Any touch of the ES256 signer / JWKS / `/v1/auth/verify` CredentialBridge — only the display *value* in JWT claims changes, never the signing path (assert byte-unchanged).
- ❌ Chunking / batch-size machinery — the reachable population is <200; the 192-cap is a feature, not a scale problem (PRD v3.0 §11).
- ❌ A `mibera_id` spine column — it is a `generated` name row.

## Risks

- **192-name strategic cap** — the backfill seeds ≤192 names; broad coverage of arbitrary future minters needs the `/verify` flywheel (forward). Necessary, not sufficient. Do not over-engineer for scale that does not exist.
- **Prod-flip dependency** — landing code does NOT satisfy the cutover gate; the **real backfill must run against prod** (operator-cred-gated) and consumers must read the new resolved block. Sequence: `#28`→main → migrate `0008` → backfill (real run) → verify coverage → cutover.
- **Two-endpoint / JWT blast radius** — A5 touches `merge-identity.ts` → `/v1/identity/resolve` + JWT display claims. Accepted by the "both endpoints" decision; the review gate must confirm the signer path is byte-unchanged.
- **Schema-breaking `UNIQUE`** — relaxing `UNIQUE (world_slug, nym)` must not break `claimNymWithAudit` (`resolve-spine.ts:247-285`), which writes `world_identity` directly. Keep `nym` + PK; move uniqueness into `world_identity_names`.
- **Generation determinism (RESOLVED by absorb)** — because the 189 absorb honey-road's existing `mibera_id`, backfill is idempotent on the name axis. The spine's `claimGeneratedName` (new users only) must be collision-safe against the partial unique index.

## Verify

`bun test` green incl. new: engine no-discord assertion + atomicity rollback; `resolveDisplayName` privacy invariant (raw addr structurally unreachable as default) + priority + per-world isolation; migration `0008` up→down→up round-trip + trigger recompute + uniqueness; backfill filter/idempotency/dry-run/HARD-count/revert; E2E coverage + two-endpoint agreement. Typecheck clean on touched files. Signer/JWKS/verify byte-unchanged assertions.

## Key References

| Topic | Path |
|---|---|
| Epic | `0xHoneyJar/identity-api#11` |
| discord-required path (to clone, minus discord) | `packages/engine/src/link-verified-wallet.ts:53,165`, `protocol link.ts:23` |
| spine primitives to reuse | `packages/engine/src/resolve-spine.ts:159-238` (`mintUser`/`linkWalletWithAudit`/`linkAccountWithAudit`) |
| flat name model to extend | `0001_init_spine.up.sql:92-99`, `spine.port.ts:55-59,81-89` |
| resolver to invert | `merge-identity.ts:55-78` (raw-addr fallback at `:76-77`) |
| profile compose | `compose-profile.ts:194-290` |
| backfill precedent | `scripts/backfill-midi-profiles.ts` (+ `-revert.ts`), skip-filter at `:134-138` |
| midi coverage fact | `mibera-honeyroad/lib/db/schema/index.ts:463,480` (`mibera_id` NOT NULL, format-checked) |
| trigger pattern | `0002_primary_wallet_trigger` |
| route + svc-token gating | `src/api/routes/link.ts:53-107` |
| base-branch dep | `w2.5-sprint-3-auth-sdk-source-distributed` (28 ahead of main; `#28` prod-flip pending) |
