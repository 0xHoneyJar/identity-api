/**
 * check-dynamic-quarantine.test.ts — quarantine script behavior tests (T1.7).
 *
 * Two behaviors to verify:
 *   (a) The script exits 0 against the CURRENT codebase (live tree).
 *   (b) The script exits 1 if a synthetic @dynamic-labs/* import lands in
 *       a live-path file (proves the gate would catch a real violation).
 *
 * (b) is the load-bearing test — without it, the script could be exit-0
 * for the wrong reason (e.g., broken find / broken regex). We mutate a
 * scratch live-path file in /tmp, point the script at it, and assert
 * exit 1.
 *
 * Strategy for (b): we can't point the script at a different REPO_ROOT
 * (the LIVE_PATH_ROOTS are computed from script-location). Instead we
 * use a different strategy: copy the script into a synthetic repo
 * mirror in /tmp, plant an offending file under the mirror's live-path
 * tree, and run the copy. The script's relative-path discovery follows
 * its own location, so the mirror's tree is what gets scanned.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { execSync, spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, copyFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve as resolvePath } from "node:path"

const REAL_REPO_ROOT = resolvePath(__dirname, "..", "..")
const REAL_SCRIPT = join(REAL_REPO_ROOT, "scripts", "check-dynamic-quarantine.sh")

describe("check-dynamic-quarantine.sh — current-tree assertion", () => {
  it("exits 0 against the actual freeside-auth tree (no live-path Dynamic SDK imports)", () => {
    const result = spawnSync("bash", [REAL_SCRIPT], {
      encoding: "utf-8",
      env: process.env,
    })
    if (result.status !== 0) {
      // Surface stdout+stderr so a regression here points at the offending file.
      throw new Error(
        `Quarantine script failed unexpectedly on current tree (exit ${result.status}).\n` +
          `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
      )
    }
    expect(result.status).toBe(0)
    expect(result.stdout).toContain("OK: zero @dynamic-labs/* live-path imports detected.")
  })
})

describe("check-dynamic-quarantine.sh — synthetic violation detection", () => {
  let mirrorRoot: string

  beforeEach(() => {
    // Build a synthetic repo mirror with the same shape the script
    // expects: REPO_ROOT/scripts/check-dynamic-quarantine.sh +
    // REPO_ROOT/{src,packages/adapters/src,…}/.
    mirrorRoot = mkdtempSync(join(tmpdir(), "quarantine-test-"))
    mkdirSync(join(mirrorRoot, "scripts"), { recursive: true })
    mkdirSync(join(mirrorRoot, "src", "api", "routes"), { recursive: true })
    mkdirSync(join(mirrorRoot, "packages", "adapters", "src"), { recursive: true })
    mkdirSync(join(mirrorRoot, "packages", "engine", "src"), { recursive: true })
    mkdirSync(join(mirrorRoot, "packages", "ports", "src"), { recursive: true })
    mkdirSync(join(mirrorRoot, "packages", "protocol", "src"), { recursive: true })

    copyFileSync(REAL_SCRIPT, join(mirrorRoot, "scripts", "check-dynamic-quarantine.sh"))
    execSync(`chmod +x ${join(mirrorRoot, "scripts", "check-dynamic-quarantine.sh")}`)
  })

  afterEach(() => {
    if (mirrorRoot && existsSync(mirrorRoot)) {
      rmSync(mirrorRoot, { recursive: true, force: true })
    }
  })

  it("exits 0 against an empty synthetic mirror (no source files)", () => {
    const result = spawnSync(
      "bash",
      [join(mirrorRoot, "scripts", "check-dynamic-quarantine.sh")],
      { encoding: "utf-8" },
    )
    expect(result.status).toBe(0)
  })

  it("exits 1 when a real `import ... from \"@dynamic-labs/sdk-react-core\"` lands in src/api/routes/", () => {
    // Plant the violation: a copy of T1.6 auth.ts shape with an added
    // Dynamic SDK import. This simulates someone adding live-session
    // validation against Dynamic — the exact class of regression FR-A4
    // prohibits.
    const offendingFile = join(mirrorRoot, "src", "api", "routes", "auth.ts")
    writeFileSync(
      offendingFile,
      [
        '/**',
        ' * synthetic auth.ts — used by quarantine test only.',
        ' */',
        '',
        'import { DynamicClient } from "@dynamic-labs/sdk-react-core"',
        '',
        'export const verifyDynamicSession = async () => {',
        '  return DynamicClient.validate()',
        '}',
        '',
      ].join("\n"),
    )

    const result = spawnSync(
      "bash",
      [join(mirrorRoot, "scripts", "check-dynamic-quarantine.sh")],
      { encoding: "utf-8" },
    )
    expect(result.status).toBe(1)
    expect(result.stdout + result.stderr).toContain("ERROR")
    expect(result.stdout + result.stderr).toContain("@dynamic-labs")
    expect(result.stdout + result.stderr).toContain("auth.ts")
  })

  it("exits 1 when @dynamic-labs/* lands in packages/adapters/src (covers the bridge file's own quarantine)", () => {
    // Plant a violation in a different live-path root. The Dynamic
    // bridge itself lives here — so this also proves the bridge file is
    // not exempt from the gate (its IMPLEMENTATION must not use the SDK).
    const offendingFile = join(mirrorRoot, "packages", "adapters", "src", "some-adapter.ts")
    writeFileSync(
      offendingFile,
      'import * as DL from "@dynamic-labs/sdk-react-core"\n\nexport const x = DL.something\n',
    )

    const result = spawnSync(
      "bash",
      [join(mirrorRoot, "scripts", "check-dynamic-quarantine.sh")],
      { encoding: "utf-8" },
    )
    expect(result.status).toBe(1)
  })

  it("exits 1 when @dynamic-labs/* is added as a direct dep in a live-path package.json", () => {
    // Adding the SDK to package.json deps is its own violation shape —
    // even if not yet imported, it signals intent and represents
    // surface-area expansion.
    writeFileSync(
      join(mirrorRoot, "packages", "adapters", "package.json"),
      JSON.stringify(
        {
          name: "@freeside-auth/adapters",
          version: "0.1.0",
          dependencies: {
            "@dynamic-labs/sdk-react-core": "^4.0.0",
          },
        },
        null,
        2,
      ),
    )

    const result = spawnSync(
      "bash",
      [join(mirrorRoot, "scripts", "check-dynamic-quarantine.sh")],
      { encoding: "utf-8" },
    )
    expect(result.status).toBe(1)
  })

  it("does NOT flag a benign comment mentioning @dynamic-labs (proves the regex skips prose)", () => {
    // Plant a file that mentions the package name in a comment but
    // doesn't import it. This is the existing pattern in the bridge
    // file's JSDoc — must not trigger the gate.
    writeFileSync(
      join(mirrorRoot, "packages", "adapters", "src", "doc-only.ts"),
      [
        '/**',
        ' * doc-only.ts — explains the @dynamic-labs/* discipline.',
        ' *',
        ' * The bridge does NOT import @dynamic-labs/sdk-react-core.',
        ' */',
        '',
        'export const NOTE = "see @dynamic-labs/sdk for the upstream API"',
        '',
      ].join("\n"),
    )

    const result = spawnSync(
      "bash",
      [join(mirrorRoot, "scripts", "check-dynamic-quarantine.sh")],
      { encoding: "utf-8" },
    )
    expect(result.status).toBe(0)
  })

  it("exits 1 for `import \"@dynamic-labs/foo\"` (side-effect import)", () => {
    writeFileSync(
      join(mirrorRoot, "src", "api", "side.ts"),
      'import "@dynamic-labs/sdk-react-core"\n',
    )
    const result = spawnSync(
      "bash",
      [join(mirrorRoot, "scripts", "check-dynamic-quarantine.sh")],
      { encoding: "utf-8" },
    )
    expect(result.status).toBe(1)
  })

  it("exits 1 for dynamic `import(\"@dynamic-labs/foo\")`", () => {
    writeFileSync(
      join(mirrorRoot, "src", "api", "dyn.ts"),
      'export async function load() { return await import("@dynamic-labs/sdk-react-core") }\n',
    )
    const result = spawnSync(
      "bash",
      [join(mirrorRoot, "scripts", "check-dynamic-quarantine.sh")],
      { encoding: "utf-8" },
    )
    expect(result.status).toBe(1)
  })

  it("exits 1 for CJS `require(\"@dynamic-labs/foo\")`", () => {
    writeFileSync(
      join(mirrorRoot, "src", "api", "cjs.cjs"),
      'const dl = require("@dynamic-labs/sdk-react-core");\nmodule.exports = dl;\n',
    )
    const result = spawnSync(
      "bash",
      [join(mirrorRoot, "scripts", "check-dynamic-quarantine.sh")],
      { encoding: "utf-8" },
    )
    expect(result.status).toBe(1)
  })

  it("exits 1 for re-export `export { x } from \"@dynamic-labs/foo\"`", () => {
    writeFileSync(
      join(mirrorRoot, "src", "api", "reexport.ts"),
      'export { foo } from "@dynamic-labs/sdk-react-core"\n',
    )
    const result = spawnSync(
      "bash",
      [join(mirrorRoot, "scripts", "check-dynamic-quarantine.sh")],
      { encoding: "utf-8" },
    )
    expect(result.status).toBe(1)
  })
})
