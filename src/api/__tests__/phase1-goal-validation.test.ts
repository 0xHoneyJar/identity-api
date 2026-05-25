/**
 * phase1-goal-validation.test.ts — the consolidated Phase 1 acceptance suite.
 *
 * Bead: arrakis-kng6 (T1.TEST). SDD §10.2. Branch: feat/t1.test-phase1-e2e.
 *
 * STRATEGY (T1.TEST scope per the bead spec):
 *
 *   This file is NOT a re-implementation of every focused test that the
 *   T1.0–T1.10 tasks already authored. Each sub-requirement HAS its own
 *   purpose-built test suite (cross-linked below). This file is the
 *   CONSOLIDATED ACCEPTANCE SUITE — one place where the three Phase 1
 *   PRD goals (G-1, G-2, G-3) are PROVEN END-TO-END by walking the full
 *   happy path through real systems, plus the few cross-cutting
 *   regressions no single prior task owned.
 *
 *   The closing report for Phase 1 cites THIS file as executable evidence.
 *
 * MAP — what this suite asserts vs what it cross-links:
 *
 *   Section A — spine-resolution (G-2 / FR-R6)
 *     ✓ HERE: full unified walk — auth-mints user → 2 wallets linked →
 *       discord account linked → 2 nyms in 2 worlds claimed → 5 lookups
 *       (2 wallets + 1 discord + 2 nyms) ALL return same user_id.
 *     ↪ Cross-link: packages/adapters/src/__tests__/postgres-spine-adapter.test.ts
 *       (per-method coverage — resolveByWallet/Account/Nym/getIdentity)
 *     ↪ Cross-link: packages/engine/src/__tests__/resolve-spine.test.ts
 *       (engine-level orchestration + race retry)
 *
 *   Section B — one-primary-per-user (FR-R5)
 *     ✓ HERE: unified test — auth-mints user with W1 primary → setPrimary(W2)
 *       via spine → assert exactly one is_primary row + users.primary_wallet
 *       mirrored.
 *     ↪ Cross-link: packages/adapters/src/__tests__/primary_wallet_trigger.test.ts
 *       (10 cases: install, swap, soft-unlink isolation, multi-user
 *       isolation, self-reset, INSERT, hard guarantees, down, re-install)
 *
 *   Section C — auth-wallet-first / zero-Dynamic (G-3 / FR-A4 / NFR-4)
 *     ✓ HERE: 1. inline-run check-dynamic-quarantine.sh → exit 0 asserted;
 *             2. e2e POST /v1/auth/verify with scheme="dynamic_user_id" →
 *                400 Zod enum rejection at HTTP boundary;
 *             3. direct file scan over live-path roots → zero violations
 *                (defense-in-depth — independent detector from #1).
 *     ↪ Cross-link: scripts/__tests__/check-dynamic-quarantine.test.ts
 *       (script behavior — current-tree + synthetic-violation)
 *     ↪ Cross-link: src/api/__tests__/auth-bridge-quarantine.test.ts
 *       (registry shape — usableInLivePath flags per scheme)
 *
 *   Section D — nonce-single-use (FR-A1)
 *     ✓ HERE: unified SDK-facing test — challenge → verify happy →
 *       re-verify SAME nonce → 401 nonce_replayed (proves replay defense
 *       reaches the consumer + audit row landed).
 *     ↪ Cross-link: packages/adapters/src/__tests__/postgres-spine-adapter-nonces.test.ts
 *       (adapter-level: mint, consume, replay, expired, scheme-mismatch,
 *       unknown, concurrent race — 10-way race proof)
 *     ↪ Cross-link: packages/engine/src/__tests__/auth-nonces.test.ts
 *       (engine-level: nonce orchestration with audit pairing)
 *
 *   Section E — beacon-valid (FR-B2)
 *     ✓ HERE: 1. structural assertions on the beacon yaml (slug regex,
 *                is_not.length ≥ 2, composes_with keys ⊇ {inventory-api,
 *                score-api, codex}, slug matches ^[a-z][a-z0-9-]*-api$);
 *             2. if loa-freeside sibling dist is reachable: full
 *                validateBeaconV3 → res.ok === true (skips otherwise).
 *     ↪ Cross-link: grimoires/loa/notes/t1.8-beacon-notes.md (the original
 *       T1.8 validation receipt with the negative-control mutations).
 *
 *   Section F — sdk-roundtrip (G-1 / FR-B4 / NFR-6)
 *     ✓ HERE: unified end-to-end — SDK against REAL spine on real PG +
 *       real viem signature; walks challenge → verify → me with returned
 *       JWT → asserts typed Identity composite shape returned correctly.
 *     ↪ Cross-link: packages/sdk/src/__tests__/client.integration.test.ts
 *       (mock-spine; 21 cases covering every route + error class branch)
 *     ↪ Cross-link: packages/sdk/src/__tests__/transport.test.ts
 *       (URL construction, header composition, error mapping)
 *     ↪ Cross-link: packages/sdk/src/__tests__/types.type-test.ts
 *       (compile-time type-shape assertions)
 *
 * GATING + SAFETY:
 *   - Sections A, B, D, F SKIP without TEST_DATABASE_URL (real-PG tests).
 *   - Sections C and E run unconditionally (no DB needed).
 *   - SCRATCH_DB_HINTS gate refuses to drop on non-scratch DB.
 *   - Mirrors auth-flow.test.ts and postgres-spine-adapter.test.ts gating
 *     verbatim — same conventions, same scratch protection.
 *
 * WHY THIS FILE LIVES UNDER src/api/__tests__/:
 *   It boots the Hyper app via `import app from "../index"` (same as
 *   auth-flow.test.ts + routes.test.ts). The unified G-1..G-3 acceptance
 *   walk is e2e through the HTTP surface — placing the suite here keeps
 *   the import path local + co-located with the existing end-to-end tests.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import { SQL } from "bun"
import { spawnSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"

import app from "../index"
import { migrate } from "../../../packages/adapters/src/migrate"
import { PostgresSpineAdapter } from "../../../packages/adapters/src/postgres-spine-adapter"
import { __resetSpineForTest, __setSpineForTest } from "../spine"
import { createIdentityClient } from "../../../packages/sdk/src/client"

// ─── shared fixtures + helpers (mirrors auth-flow.test.ts) ──────────────────

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL
const MIGRATIONS_DIR = resolve(
  __dirname,
  "..",
  "..",
  "..",
  "packages",
  "adapters",
  "src",
  "migrations",
)
const REPO_ROOT = resolve(__dirname, "..", "..", "..")
const QUARANTINE_SCRIPT = resolve(REPO_ROOT, "scripts", "check-dynamic-quarantine.sh")
const BEACON_YAML_PATH = resolve(REPO_ROOT, "packages", "protocol", "beacon.yaml")

// Where the canonical loa-freeside beacon-v3 validator lives on this
// machine. Same path the T1.8 build notes recorded for the original
// validation receipt. Optional dependency — Section E falls back to
// structural assertions when missing (no new dep added per bead constraint).
const LOA_FREESIDE_BEACON_VALIDATOR =
  "/Users/zksoju/Documents/GitHub/loa-freeside/packages/beacon-schema/dist/src/index.js"
const LOA_FREESIDE_YAML_PARSER =
  "/Users/zksoju/Documents/GitHub/loa-freeside/packages/beacon-schema/node_modules/yaml/dist/index.js"

const SCRATCH_DB_HINTS = ["test", "scratch", "ephemeral", "ci", "tmp", "preview"]

function looksLikeScratchUrl(url: string): boolean {
  try {
    const u = new URL(url)
    const dbName = u.pathname.replace(/^\//, "").toLowerCase()
    if (!dbName) return false
    return SCRATCH_DB_HINTS.some((hint) => dbName.includes(hint))
  } catch {
    return false
  }
}

async function dropAllSpineState(sql: SQL): Promise<void> {
  await sql.unsafe(`
    DROP TRIGGER IF EXISTS trg_sync_primary_wallet ON wallet_links;
    DROP FUNCTION IF EXISTS sync_primary_wallet();
    DROP TABLE IF EXISTS auth_nonces CASCADE;
    DROP TABLE IF EXISTS audit_events CASCADE;
    DROP TABLE IF EXISTS world_identity CASCADE;
    DROP TABLE IF EXISTS worlds CASCADE;
    DROP TABLE IF EXISTS linked_accounts CASCADE;
    DROP TABLE IF EXISTS wallet_links CASCADE;
    DROP TABLE IF EXISTS users CASCADE;
    DROP TABLE IF EXISTS schema_migrations CASCADE;
  `)
}

async function clearSpineRows(sql: SQL): Promise<void> {
  // Same TRUNCATE pattern as auth-flow.test.ts — RESTART IDENTITY CASCADE.
  await sql.unsafe(`
    TRUNCATE TABLE
      auth_nonces,
      audit_events,
      world_identity,
      linked_accounts,
      wallet_links,
      users
    RESTART IDENTITY CASCADE;
  `)
}

async function seedTestWorld(sql: SQL, slug: string): Promise<void> {
  await sql`
    INSERT INTO worlds (world_slug, display_name)
    VALUES (${slug}, ${slug})
    ON CONFLICT (world_slug) DO NOTHING
  `
}

interface ChallengeRespWire {
  nonce: string
  message: string
  expires_at: string
}

interface VerifyRespWire {
  user_id: string
  primary_wallet: string
  session: { token: string; expires_at: number }
}

interface UnauthorizedRespWire {
  error: "unauthorized"
  code: string
  message?: string
}

// ─── HTTP-facing auth helper (real signature) ───────────────────────────────

async function runAuthFlowHttp(
  baseUrl: string,
  acct: { signMessage: (opts: { message: string }) => Promise<`0x${string}`> },
  wallet: string,
  scheme: "siwe" | "eip191",
): Promise<{ status: number; body: VerifyRespWire }> {
  const chRes = await fetch(`${baseUrl}/v1/auth/challenge`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ walletAddress: wallet, scheme }),
  })
  if (chRes.status !== 200) {
    return {
      status: chRes.status,
      body: { user_id: "", primary_wallet: "", session: { token: "", expires_at: 0 } },
    }
  }
  const challenge = (await chRes.json()) as ChallengeRespWire
  const signature = await acct.signMessage({ message: challenge.message })
  const vfRes = await fetch(`${baseUrl}/v1/auth/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      nonce: challenge.nonce,
      signature,
      walletAddress: wallet,
      scheme,
    }),
  })
  return { status: vfRes.status, body: (await vfRes.json()) as VerifyRespWire }
}

// ─── Sections C + E run unconditionally (no DB needed) ──────────────────────
//
// These are placed FIRST so they execute even when TEST_DATABASE_URL is unset.
// Sections A, B, D, F (which need real PG) are gated below with `describe.skipIf`.

// ─── Section C — auth-wallet-first / zero-Dynamic (G-3 / FR-A4 / NFR-4) ─────

describe("Phase 1 · Section C · auth-wallet-first / zero-Dynamic (G-3 / FR-A4)", () => {
  it("inline-runs scripts/check-dynamic-quarantine.sh → exit 0 (FR-A4 live-path gate)", () => {
    // Run the same shell gate that CI runs. The script walks src/, packages/
    // engine/, packages/ports/, packages/protocol/, packages/adapters/ for
    // import statements pulling in @dynamic-labs/*. Exit 0 is the load-bearing
    // proof that the live path is Dynamic-SDK-free.
    const result = spawnSync("bash", [QUARANTINE_SCRIPT], {
      encoding: "utf-8",
      env: process.env,
    })
    if (result.status !== 0) {
      throw new Error(
        `quarantine script failed (exit ${result.status}).\n` +
          `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
      )
    }
    expect(result.status).toBe(0)
    expect(result.stdout).toContain("OK: zero @dynamic-labs/* live-path imports detected.")
  })

  it("e2e: POST /v1/auth/verify with scheme='dynamic_user_id' → 400 (Zod enum rejection)", async () => {
    // Boot the app on an ephemeral port — no spine needed; the rejection
    // happens at Hyper's .body() Zod boundary BEFORE the handler runs.
    // This is the defense-in-depth proof: even if someone removed the
    // bridge's usableInLivePath check, the request would never decode.
    app.listen({ port: 0, hostname: "127.0.0.1", banner: false })
    const port = app.server?.port
    if (!port) throw new Error("Section C: app.server.port unavailable after listen")
    const baseUrl = `http://127.0.0.1:${port}`
    try {
      const res = await fetch(`${baseUrl}/v1/auth/verify`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          nonce: "any-nonce-string-here",
          signature: `0x${"a".repeat(130)}`,
          walletAddress: `0x${"a".repeat(40)}`,
          scheme: "dynamic_user_id", // ← rejected by Zod enum (siwe|eip191 only)
        }),
      })
      // Zod enum violation → 400 at the HTTP boundary
      expect(res.status).toBe(400)
    } finally {
      await app.stop()
    }
  })

  it("source-tree assertion: zero live-path files import @dynamic-labs/* (direct file scan)", () => {
    // Second-line check: a direct find+grep over the same live-path roots
    // the quarantine script walks. Asserts the SAME invariant via a
    // different mechanism, so a bug in one detector doesn't mask a
    // regression that the other would catch.
    const liveRoots = [
      resolve(REPO_ROOT, "src"),
      resolve(REPO_ROOT, "packages", "engine", "src"),
      resolve(REPO_ROOT, "packages", "ports", "src"),
      resolve(REPO_ROOT, "packages", "protocol", "src"),
      resolve(REPO_ROOT, "packages", "adapters", "src"),
    ].filter((p) => existsSync(p))

    const violations: string[] = []
    for (const root of liveRoots) {
      // Hand-rolled lite-walk via shell `find` + `grep -lE` (no new deps).
      // Pattern matches the same import-shape the quarantine script uses.
      const tryGrep = spawnSync(
        "bash",
        [
          "-c",
          `find "${root}" -type f \\( -name "*.ts" -o -name "*.tsx" -o -name "*.mts" -o -name "*.cts" \\) ` +
            `! -path "*/node_modules/*" -print0 | ` +
            `xargs -0 grep -lE '(^[[:space:]]*(import|export).*from[[:space:]]+["'"'"']@dynamic-labs/|import\\(["'"'"']@dynamic-labs/|require\\(["'"'"']@dynamic-labs/|^[[:space:]]*import[[:space:]]+["'"'"']@dynamic-labs/)' 2>/dev/null || true`,
        ],
        { encoding: "utf-8" },
      )
      if (tryGrep.stdout.trim()) {
        for (const line of tryGrep.stdout.trim().split("\n")) {
          violations.push(line.trim())
        }
      }
    }
    if (violations.length > 0) {
      throw new Error(
        `Live-path @dynamic-labs/* imports detected (G-3 / FR-A4 regression):\n  ${violations.join("\n  ")}`,
      )
    }
    expect(violations).toEqual([])
  })
})

// ─── Section E — beacon-valid (FR-B2) ───────────────────────────────────────

describe("Phase 1 · Section E · beacon-valid (FR-B2)", () => {
  function loadBeaconYaml(): string {
    return readFileSync(BEACON_YAML_PATH, "utf-8")
  }

  it("beacon yaml file exists at packages/protocol/beacon.yaml (FR-B1/FR-B2 contract artifact)", () => {
    expect(existsSync(BEACON_YAML_PATH)).toBe(true)
  })

  it("slug matches the *-api convention regex (ADR-008 §D-11)", () => {
    const yaml = loadBeaconYaml()
    // The slug line in the beacon yaml. Permissive of trailing whitespace +
    // comment characters; rejects malformed identity.
    const m = yaml.match(/^\s*slug:\s*"?([a-z][a-z0-9-]*)"?\s*$/m)
    expect(m).not.toBeNull()
    const slug = m![1]!
    expect(slug).toBe("identity-api")
    // ADR-008 §D-11 regex for *-api convention
    expect(/^[a-z][a-z0-9-]*-api$/.test(slug)).toBe(true)
  })

  it("is_not has ≥ 2 entries (BeaconV3 IsNotEntry minimum cardinality)", () => {
    const yaml = loadBeaconYaml()
    // Capture the YAML list under `is_not:` up to the next top-level key.
    const isNotBlock = yaml.match(/^is_not:\n((?:\s+-\s.*\n)+)/m)
    expect(isNotBlock).not.toBeNull()
    const entries = isNotBlock![1]!.split("\n").filter((l) => /^\s+-\s/.test(l))
    expect(entries.length).toBeGreaterThanOrEqual(2)
    // PRD §4.1 FR-B2 named four anti-scope items; T1.8 authored four.
    expect(entries.length).toBeGreaterThanOrEqual(4)
  })

  it("is_not entries start with required imperative prefixes (Does NOT|Will NOT|Refuses to)", () => {
    const yaml = loadBeaconYaml()
    const isNotBlock = yaml.match(/^is_not:\n((?:\s+-\s.*\n)+)/m)!
    const entries = isNotBlock[1]!
      .split("\n")
      .map((l) => l.match(/^\s+-\s*"?(.+?)"?\s*$/)?.[1] ?? null)
      .filter((s): s is string => s !== null)
    expect(entries.length).toBeGreaterThanOrEqual(4)
    for (const entry of entries) {
      const ok = /^(Does NOT|Will NOT|Refuses to)/.test(entry)
      if (!ok) {
        throw new Error(`is_not entry missing required prefix: "${entry}"`)
      }
      expect(ok).toBe(true)
    }
  })

  it("composes_with keys ⊇ {inventory-api, score-api, codex} (PRD §4.1 FR-B2 verbatim)", () => {
    const yaml = loadBeaconYaml()
    // Top-level composes_with block — captures only the immediate child keys
    // (lines with 2-space indent followed by name:).
    const block = yaml.match(/^composes_with:\n((?:\s{2}\S.*\n|\s{4,}.*\n|\s*#.*\n)+)/m)
    expect(block).not.toBeNull()
    const childKeys: string[] = []
    for (const line of block![1]!.split("\n")) {
      const m = line.match(/^  ([a-z][a-z0-9-]*):\s*$/)
      if (m) childKeys.push(m[1]!)
    }
    expect(childKeys).toContain("inventory-api")
    expect(childKeys).toContain("score-api")
    expect(childKeys).toContain("codex")
  })

  it("capabilities surface lists ≥ 10 entries (G-1 SDK + MCP capability roster)", () => {
    const yaml = loadBeaconYaml()
    const block = yaml.match(/^capabilities:\n((?:\s+-\s.*\n)+)/m)
    expect(block).not.toBeNull()
    const entries = block![1]!.split("\n").filter((l) => /^\s+-\s/.test(l))
    // T1.8 build notes documented 10 capabilities; the test asserts the
    // floor (more is fine — added routes append entries here).
    expect(entries.length).toBeGreaterThanOrEqual(10)
  })

  it("validateBeaconV3 returns ok=true via loa-freeside dist (when sibling repo is reachable)", async () => {
    // OPTIONAL — the bead spec allows the validator dependency to live in
    // the sibling loa-freeside repo's dist build. This test runs the
    // canonical validator if reachable, otherwise it skips (the structural
    // assertions above carry the regression-test weight on machines
    // without the sibling repo).
    if (!existsSync(LOA_FREESIDE_BEACON_VALIDATOR)) {
      // Skipping is preferred over failing because the bead constraint
      // forbids adding the validator as a new dependency. Local dev +
      // CI machines without the sibling checkout get the structural
      // assertions; machines WITH it get the full schema check.
      console.warn(
        `[Section E] loa-freeside beacon-schema dist not at ${LOA_FREESIDE_BEACON_VALIDATOR} — falling back to structural assertions only.`,
      )
      return
    }
    if (!existsSync(LOA_FREESIDE_YAML_PARSER)) {
      console.warn(
        `[Section E] loa-freeside yaml parser not at ${LOA_FREESIDE_YAML_PARSER} — falling back to structural assertions only.`,
      )
      return
    }
    // Dynamic-import via absolute file URL so the test doesn't have to
    // resolve the sibling repo through node's module-resolution algorithm
    // (which would require it to be a dependency).
    const validatorMod = await import(LOA_FREESIDE_BEACON_VALIDATOR)
    const yamlMod = await import(LOA_FREESIDE_YAML_PARSER)
    const yamlContent = readFileSync(BEACON_YAML_PATH, "utf-8")
    const parsed = yamlMod.parse(yamlContent)
    const result = validatorMod.validateBeaconV3(parsed)
    if (!result.ok) {
      throw new Error(
        `validateBeaconV3 failed (FR-B2 regression):\n  error: ${String(result.error)}`,
      )
    }
    expect(result.ok).toBe(true)
    expect(result.beacon?.slug).toBe("identity-api")
    expect(result.beacon?.is_not?.length).toBeGreaterThanOrEqual(2)
    const composesKeys = Object.keys(result.beacon?.composes_with ?? {})
    expect(composesKeys).toContain("inventory-api")
    expect(composesKeys).toContain("score-api")
    expect(composesKeys).toContain("codex")
  })
})

// ─── Sections A, B, D, F — gated by TEST_DATABASE_URL (real PG) ─────────────

describe.skipIf(!TEST_DATABASE_URL)(
  "Phase 1 · Sections A/B/D/F (real-PG e2e) (T1.TEST)",
  () => {
    const databaseUrl = TEST_DATABASE_URL as string
    let baseUrl: string
    let realSpine: PostgresSpineAdapter
    let bookkeepingSql: SQL

    beforeAll(async () => {
      if (!looksLikeScratchUrl(databaseUrl)) {
        throw new Error(
          `phase1-goal-validation.test: TEST_DATABASE_URL DB name does not look scratch-shaped ` +
            `(expected substring: ${SCRATCH_DB_HINTS.join(", ")}). Refusing to drop on non-scratch DB.`,
        )
      }
      const sql = new SQL(databaseUrl)
      try {
        await dropAllSpineState(sql)
      } finally {
        await sql.close()
      }
      await migrate({ databaseUrl, migrationsDir: MIGRATIONS_DIR, verb: "up" })
      realSpine = new PostgresSpineAdapter(databaseUrl)
      __setSpineForTest(realSpine)
      bookkeepingSql = new SQL(databaseUrl)
      // Seed BOTH worlds — Section A claims two nyms in two different worlds.
      await seedTestWorld(bookkeepingSql, "thj")
      await seedTestWorld(bookkeepingSql, "mibera")
      app.listen({ port: 0, hostname: "127.0.0.1", banner: false })
      const port = app.server?.port
      if (!port) {
        throw new Error("phase1-goal-validation.test: app.server.port unavailable after listen")
      }
      baseUrl = `http://127.0.0.1:${port}`
    })

    afterAll(async () => {
      await app.stop()
      await realSpine.close()
      await bookkeepingSql.close()
      __resetSpineForTest()
      const sql = new SQL(databaseUrl)
      try {
        await dropAllSpineState(sql)
      } finally {
        await sql.close()
      }
    })

    beforeEach(async () => {
      await clearSpineRows(bookkeepingSql)
      // Re-seed worlds since TRUNCATE wiped them.
      await seedTestWorld(bookkeepingSql, "thj")
      await seedTestWorld(bookkeepingSql, "mibera")
    })

    // ─── Section A — spine-resolution (G-2 / FR-R6) ─────────────────────

    describe("Section A · spine-resolution (G-2)", () => {
      it("G-2 unified walk: 1 human / 2 wallets / 2 nyms / 1 discord → ALL 5 lookups return SAME user_id", async () => {
        // PROOF of G-2 success metric verbatim (PRD §1):
        //   "one human with 2 verified wallets + 2 per-world nyms resolves
        //    to a single user_id from wallet, discord id, or (world, nym)"
        //
        // The canonical entrypoint for minting a user is /v1/auth/verify
        // (G-3 wallet-first). We use that for W1. For W2 — the second
        // wallet on the SAME human — Phase 1 has no public "link
        // additional wallet" endpoint (that's the Phase-4 cycle-c
        // redirect surface), so we directly call the spine adapter for
        // W2 + the discord account + both nyms. This is the documented
        // shape of Phase 1: auth onboards a human via one wallet;
        // additional wallets/accounts/nyms are spine-direct writes via
        // the engine until /link/* endpoints land (T4.x).
        //
        // The G-2 success metric is about CONVERGENCE under READ — that
        // five different lookup paths return one user_id. The metric
        // makes no claim about which write surfaces are public.

        // ─── Setup: one human onboards via SIWE on wallet W1 ────────
        const pkA = generatePrivateKey()
        const acctA = privateKeyToAccount(pkA)
        const W1 = acctA.address.toLowerCase()

        const flow = await runAuthFlowHttp(baseUrl, acctA, W1, "siwe")
        expect(flow.status).toBe(200)
        const userId = flow.body.user_id
        expect(userId).toMatch(/^[0-9a-f-]{36}$/) // UUID

        // ─── Link W2 to the SAME user (via the spine — Phase 1 posture) ──
        const pkB = generatePrivateKey()
        const acctB = privateKeyToAccount(pkB)
        const W2 = acctB.address.toLowerCase()
        await realSpine.linkWallet({
          userId,
          walletAddress: W2,
          isPrimary: false, // W1 stays primary
        })

        // ─── Link discord account to the SAME user ────────────────
        const DISCORD_ID = "discord-test-user-7777"
        await realSpine.linkAccount({
          userId,
          provider: "discord",
          externalId: DISCORD_ID,
        })

        // ─── Claim two nyms in two worlds for the SAME user ────────
        const NYM_THJ = "honeykeeper"
        const NYM_MIBERA = "fullshape"
        await realSpine.claimNym({ userId, worldSlug: "thj", nym: NYM_THJ })
        await realSpine.claimNym({ userId, worldSlug: "mibera", nym: NYM_MIBERA })

        // ─── THE LOAD-BEARING ASSERTIONS — 5 lookups, 1 user_id ────
        const client = createIdentityClient({ baseUrl })

        // (1) resolve.byWallet(W1) → SAME user_id
        const hitW1 = await client.resolve.byWallet(W1)
        expect(hitW1).not.toBeNull()
        expect(hitW1!.user_id).toBe(userId)

        // (2) resolve.byWallet(W2) → SAME user_id
        const hitW2 = await client.resolve.byWallet(W2)
        expect(hitW2).not.toBeNull()
        expect(hitW2!.user_id).toBe(userId)

        // (3) resolve.byAccount('discord', DISCORD_ID) → SAME user_id
        const hitDiscord = await client.resolve.byAccount("discord", DISCORD_ID)
        expect(hitDiscord).not.toBeNull()
        expect(hitDiscord!.user_id).toBe(userId)

        // (4) resolve.byNym('thj', NYM_THJ) → SAME user_id
        const hitThj = await client.resolve.byNym("thj", NYM_THJ)
        expect(hitThj).not.toBeNull()
        expect(hitThj!.user_id).toBe(userId)

        // (5) resolve.byNym('mibera', NYM_MIBERA) → SAME user_id
        const hitMibera = await client.resolve.byNym("mibera", NYM_MIBERA)
        expect(hitMibera).not.toBeNull()
        expect(hitMibera!.user_id).toBe(userId)

        // All 5 paths converge to ONE user_id. G-2 success metric satisfied.
        const uniqueUserIds = new Set([
          hitW1!.user_id,
          hitW2!.user_id,
          hitDiscord!.user_id,
          hitThj!.user_id,
          hitMibera!.user_id,
        ])
        expect(uniqueUserIds.size).toBe(1)
        expect(Array.from(uniqueUserIds)[0]).toBe(userId)

        // ─── DB invariant: exactly ONE user row ──────────────────
        const users = (await bookkeepingSql`SELECT user_id FROM users`) as Array<{
          user_id: string
        }>
        expect(users).toHaveLength(1)
        expect(users[0]!.user_id).toBe(userId)

        // ─── Composite getIdentity reflects the full graph ────────
        const identity = await client.identity.get(userId)
        expect(identity).not.toBeNull()
        expect(identity!.user_id).toBe(userId)
        expect(identity!.wallets).toHaveLength(2)
        expect(identity!.linked_accounts).toHaveLength(1)
        expect(identity!.world_identities).toHaveLength(2)
        // Primary wallet stays W1 (the auth-onboarded one)
        expect(identity!.primary_wallet).toBe(W1)
        // Verify both wallets are present
        const walletAddrs = identity!.wallets.map((w) => w.wallet_address).sort()
        expect(walletAddrs).toEqual([W1, W2].sort())
        // Verify both worlds are present
        const worldNyms = identity!.world_identities
          .map((wi) => `${wi.world_slug}/${wi.nym}`)
          .sort()
        expect(worldNyms).toEqual([`thj/${NYM_THJ}`, `mibera/${NYM_MIBERA}`].sort())
      })
    })

    // ─── Section B — one-primary-per-user (FR-R5) ───────────────────────

    describe("Section B · one-primary-per-user (FR-R5)", () => {
      it("FR-R5 unified: setPrimary(W2) demotes W1 + mirrors users.primary_wallet (single-statement promote)", async () => {
        // PROOF of FR-R5 invariant: exactly one is_primary=TRUE per user_id.
        // The atomic semantics are exercised exhaustively by
        // primary_wallet_trigger.test.ts; here we run ONE consolidated test
        // that walks the post-auth happy path:
        //   1. Auth onboards user with W1 primary (the trigger fires on
        //      first-ever INSERT and mirrors).
        //   2. Link W2 non-primary.
        //   3. setPrimary(W2) — the T1.3 BEFORE-trigger payoff: in ONE
        //      statement, W1 demotes + W2 promotes + users.primary_wallet
        //      mirrors. Invariant holds.

        const pk = generatePrivateKey()
        const acct = privateKeyToAccount(pk)
        const W1 = acct.address.toLowerCase()
        const W2 = "0xbbbb000000000000000000000000000000000002"

        // Setup via auth flow (mints user with W1 primary)
        const flow = await runAuthFlowHttp(baseUrl, acct, W1, "siwe")
        expect(flow.status).toBe(200)
        const userId = flow.body.user_id
        expect(flow.body.primary_wallet).toBe(W1)

        // Pre-state: W1 is primary, users.primary_wallet = W1
        const pre = (await bookkeepingSql`
          SELECT primary_wallet FROM users WHERE user_id = ${userId}
        `) as Array<{ primary_wallet: string }>
        expect(pre[0]!.primary_wallet).toBe(W1)

        // Link W2 non-primary
        await realSpine.linkWallet({
          userId,
          walletAddress: W2,
          isPrimary: false,
        })

        // Pre-promote check: still ONE primary (W1), users mirror untouched
        const linksBefore = (await bookkeepingSql`
          SELECT wallet_address, is_primary FROM wallet_links
           WHERE user_id = ${userId} AND unlinked_at IS NULL
        `) as Array<{ wallet_address: string; is_primary: boolean }>
        expect(linksBefore.filter((l) => l.is_primary).length).toBe(1)

        // SINGLE-STATEMENT PROMOTE — the T1.3 BEFORE-trigger payoff
        const ok = await realSpine.setPrimary({ userId, walletAddress: W2 })
        expect(ok).toBe(true)

        // ─── INVARIANT: exactly ONE is_primary=TRUE row ─────────────
        const linksAfter = (await bookkeepingSql`
          SELECT wallet_address, is_primary FROM wallet_links
           WHERE user_id = ${userId} AND unlinked_at IS NULL
           ORDER BY wallet_address ASC
        `) as Array<{ wallet_address: string; is_primary: boolean }>
        const primaryCount = linksAfter.filter((l) => l.is_primary).length
        expect(primaryCount).toBe(1)
        // The primary is W2 now
        const primaryLink = linksAfter.find((l) => l.is_primary)
        expect(primaryLink!.wallet_address).toBe(W2)
        // W1 is now non-primary
        const w1Link = linksAfter.find((l) => l.wallet_address === W1)
        expect(w1Link!.is_primary).toBe(false)

        // ─── users.primary_wallet mirror reflects the swap ──────────
        const post = (await bookkeepingSql`
          SELECT primary_wallet FROM users WHERE user_id = ${userId}
        `) as Array<{ primary_wallet: string }>
        expect(post[0]!.primary_wallet).toBe(W2)
      })
    })

    // ─── Section D — nonce-single-use (FR-A1) ───────────────────────────

    describe("Section D · nonce-single-use (FR-A1)", () => {
      it("FR-A1 unified: SDK flow — challenge → verify happy → re-verify SAME nonce → 401 nonce_replayed", async () => {
        // PROOF of FR-A1 replay defense REACHING THE CONSUMER via the SDK.
        // The adapter-level test (postgres-spine-adapter-nonces.test.ts)
        // proves the spine refuses a used nonce. The engine-level test
        // (auth-nonces.test.ts) proves the orchestrator translates that
        // refusal. THIS test proves the chain holds all the way through
        // the HTTP route + SDK error translation — i.e., a real consumer
        // gets the security guarantee.
        //
        // The SDK doesn't yet expose a typed wrapper for /v1/auth/verify
        // 401 → typed error class (that's incremental client work
        // beyond T1.10's stub surface). For Phase 1 acceptance we drive
        // the e2e via raw fetch and assert wire-level shape — the SDK
        // would just wrap this same response.

        const pk = generatePrivateKey()
        const acct = privateKeyToAccount(pk)
        const wallet = acct.address.toLowerCase()

        // SDK-issued challenge
        const client = createIdentityClient({ baseUrl })
        const ch = await client.auth.challenge({ walletAddress: wallet, scheme: "eip191" })
        expect(ch.nonce).toMatch(/^[A-Za-z0-9_-]{43}$/) // 32-byte base64url
        const signature = await acct.signMessage({ message: ch.message })

        // Verify #1 — happy path via the same fetch surface the SDK uses
        const verifyBody = JSON.stringify({
          nonce: ch.nonce,
          signature,
          walletAddress: wallet,
          scheme: "eip191",
        })
        const v1 = await fetch(`${baseUrl}/v1/auth/verify`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: verifyBody,
        })
        expect(v1.status).toBe(200)
        const v1Body = (await v1.json()) as VerifyRespWire
        expect(v1Body.user_id).toMatch(/^[0-9a-f-]{36}$/)

        // Verify #2 — REPLAY (same nonce + same signature + same body) → 401
        const v2 = await fetch(`${baseUrl}/v1/auth/verify`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: verifyBody,
        })
        expect(v2.status).toBe(401)
        const v2Body = (await v2.json()) as UnauthorizedRespWire
        expect(v2Body.error).toBe("unauthorized")
        expect(v2Body.code).toBe("nonce_replayed")

        // Audit invariant: the spine recorded a nonce_rejected(used) event.
        // Belt-and-suspenders — the replay rejection lands in the audit
        // log per NFR-5, observable in the trail.
        const rejects = (await bookkeepingSql`
          SELECT payload FROM audit_events WHERE event_type = 'nonce_rejected'
        `) as Array<{ payload: { reason: string } }>
        expect(rejects.length).toBeGreaterThanOrEqual(1)
        expect(rejects.some((r) => r.payload.reason === "used")).toBe(true)
      })
    })

    // ─── Section F — sdk-roundtrip (G-1 / FR-B4 / NFR-6) ───────────────

    describe("Section F · sdk-roundtrip against real spine (G-1)", () => {
      it("G-1 unified: SDK boots against REAL spine + walks challenge → verify → me with typed Identity composite", async () => {
        // PROOF of G-1 metrics that are testable from inside this repo:
        //   - The SDK source-distributed factory creates a working client
        //     against a running identity-api (mock-spine integration test
        //     proves the route binding; THIS test additionally proves the
        //     real PG spine round-trip end-to-end).
        //   - JWT issued by /v1/auth/verify validates on /v1/me.
        //   - The full Identity composite shape is returned + typed
        //     correctly at the SDK consumer surface.
        //
        // The remaining G-1 metrics (beacon broadcasts valid V3, registry
        // entry, gateway federation manifest reachability) are off-process
        // assertions — beacon validity is Section E; registry entry is
        // T1.9 in loa-freeside (cross-link in the evidence doc); gateway
        // reachability happens at deploy.

        const pk = generatePrivateKey()
        const acct = privateKeyToAccount(pk)
        const wallet = acct.address.toLowerCase()

        // Pre-flight: SDK boots
        const client = createIdentityClient({ baseUrl })

        // Step 1: challenge (FR-A1) — SDK-typed call
        const challenge = await client.auth.challenge({
          walletAddress: wallet,
          scheme: "siwe",
          domain: "identity-api.test",
          uri: "https://identity-api.test",
          chainId: 1,
          statement: "Sign in to identity-api test.",
        })
        // Typed compile-time + runtime assertions
        const nonce: string = challenge.nonce
        const message: string = challenge.message
        const expiresAt: string = challenge.expires_at
        expect(nonce).toMatch(/^[A-Za-z0-9_-]{43}$/)
        expect(message).toContain("identity-api.test wants you to sign in")
        expect(message).toContain(nonce)
        expect(typeof expiresAt).toBe("string")

        // Step 2: sign the message with viem off-line
        const signature = await acct.signMessage({ message })

        // Step 3: verify (FR-A2) — SDK-typed call
        const verified = await client.auth.verify({
          nonce,
          signature,
          walletAddress: wallet,
          scheme: "siwe",
        })
        // Typed compile-time + runtime assertions
        const userId: string = verified.user_id
        const primaryWallet: string = verified.primary_wallet
        const token: string = verified.session.token
        expect(userId).toMatch(/^[0-9a-f-]{36}$/)
        expect(primaryWallet).toBe(wallet)
        expect(token.split(".")).toHaveLength(3) // JWT has 3 segments

        // Step 4: /me — typed SDK with bearer auth — proves issued JWT works
        const authedClient = createIdentityClient({ baseUrl, jwt: token })
        const me = await authedClient.me()
        // Compile-time typed access (a real consumer's tsc would catch
        // a SDK type drift right here).
        const meUserId: string = me.user_id
        const mePrimary: string | null = me.primary_wallet
        expect(meUserId).toBe(userId)
        expect(mePrimary).toBe(wallet)
        expect(me.wallets).toHaveLength(1)
        expect(me.wallets[0]!.wallet_address).toBe(wallet)
        expect(me.wallets[0]!.is_primary).toBe(true)
        expect(me.linked_accounts).toHaveLength(0) // first-time user
        expect(me.world_identities).toHaveLength(0) // no nyms claimed

        // Step 5: identity.get(userId) by direct lookup — public surface
        const identity = await client.identity.get(userId)
        expect(identity).not.toBeNull()
        // Compile-time typed access — `identity` narrows from `IdentityResp |
        // null` to `IdentityResp` after the null-check.
        const ident: NonNullable<typeof identity> = identity!
        expect(ident.user_id).toBe(userId)
        expect(ident.primary_wallet).toBe(wallet)

        // Step 6: resolve.byWallet — different SDK surface, same user_id
        const hit = await client.resolve.byWallet(wallet)
        expect(hit).not.toBeNull()
        expect(hit!.user_id).toBe(userId)

        // ALL paths converge on the same user_id, typed at the consumer
        // surface. G-1 acceptance metric satisfied for the testable
        // sub-metrics. (Beacon valid = Section E; registry/gateway =
        // off-process / evidence doc.)
      })
    })
  },
)
