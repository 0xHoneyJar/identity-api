#!/usr/bin/env bash
# scripts/check-dynamic-quarantine.sh — live-path Dynamic SDK quarantine gate.
#
# T1.7 (bead arrakis-1ma8) — enforces the FR-A4 invariant: NO `@dynamic-labs/*`
# import in the live auth path. Per PRD §3 D3-reframed + §4.3 FR-A4,
# `dynamic_user_id` survives only as a backfill credential in linked_accounts;
# the live `/v1/auth/verify` path is wallet-first (SIWE/EIP-191) and the
# Dynamic SDK must not be reachable from it.
#
# What this script does:
#   1. Walks the live-path source tree (src/, packages/engine/, the live-path
#      adapter files explicitly listed below) looking for IMPORT statements
#      that pull in `@dynamic-labs/*`.
#   2. Excludes pure documentation comments (lines mentioning the package
#      name purely as text — e.g., the bridge file's prose explaining the
#      discipline). Detection is via shape-of-import-line matching, not
#      substring grep.
#   3. Exit 1 if any live-path import is found. Exit 0 otherwise.
#
# What this script does NOT do:
#   - Does NOT check node_modules/ (transitive deps land there; the
#     discipline is about direct application code).
#   - Does NOT check test fixtures' own behavior — but does check test
#     source files for accidental imports.
#   - Does NOT check the Dynamic bridge file itself (the bridge's name
#     mentions Dynamic, but its IMPLEMENTATION must not import the SDK —
#     it processes already-extracted strings. The file IS scanned by
#     virtue of being under packages/adapters/src/).
#
# Wired to package.json as `npm run check:dynamic-quarantine`.

set -euo pipefail

# Where this script lives → up one level to the repo root.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# Live-path roots: every directory containing source that runs in the
# /v1/auth/verify request path. Adding a new directory to the live path
# means adding it here too — explicit allow-list (deny-by-default).
LIVE_PATH_ROOTS=(
  "${REPO_ROOT}/src"
  "${REPO_ROOT}/packages/engine/src"
  "${REPO_ROOT}/packages/ports/src"
  "${REPO_ROOT}/packages/protocol/src"
  "${REPO_ROOT}/packages/adapters/src"
)

# Patterns that constitute a real IMPORT of @dynamic-labs/*.
# We use extended-regex (-E) for grouping. Each pattern is OR'd via -e.
#
# IMPORT_PATTERNS shape:
#   • `import ... from "@dynamic-labs/..."`     — named/default/namespace
#   • `import "@dynamic-labs/..."`              — side-effect import
#   • `import("@dynamic-labs/...")`             — dynamic import
#   • `require("@dynamic-labs/...")`            — CJS interop
#   • `from "@dynamic-labs/..."`                — re-export `export ... from`
#
# All patterns key on the surrounding syntax + the package-name in a
# quoted string. Comments saying `// @dynamic-labs is forbidden` won't
# match because there's no `import`/`require`/`from` keyword followed by
# a quoted string.
IMPORT_PATTERNS=(
  '^[[:space:]]*import[[:space:]].*from[[:space:]]+["'"'"']@dynamic-labs/'
  '^[[:space:]]*import[[:space:]]+["'"'"']@dynamic-labs/'
  'import\(["'"'"']@dynamic-labs/'
  'require\(["'"'"']@dynamic-labs/'
  '^[[:space:]]*export[[:space:]].*from[[:space:]]+["'"'"']@dynamic-labs/'
)

violations=0
violation_lines=""

for root in "${LIVE_PATH_ROOTS[@]}"; do
  if [[ ! -d "${root}" ]]; then
    # A missing root isn't a violation — the directory might not yet
    # exist (e.g., a fresh checkout that hasn't run install). Skip
    # silently rather than fail.
    continue
  fi

  # find all .ts / .tsx / .js / .mjs / .cjs files (exclude node_modules
  # defensively even though it shouldn't appear under packages/*/src).
  while IFS= read -r -d '' file; do
    for pattern in "${IMPORT_PATTERNS[@]}"; do
      # -H prints the file path; -n prints the line number; -E extended regex.
      # Run grep with `|| true` so a no-match doesn't trigger set -e.
      matches="$(grep -EnH "${pattern}" "${file}" 2>/dev/null || true)"
      if [[ -n "${matches}" ]]; then
        violations=$((violations + 1))
        violation_lines+="${matches}"$'\n'
      fi
    done
  done < <(find "${root}" \
    -type d -name node_modules -prune -o \
    -type f \( -name '*.ts' -o -name '*.tsx' -o -name '*.js' -o -name '*.mjs' -o -name '*.cjs' \) \
    -print0)
done

# Also check package.json files in the live path — adding the SDK as a
# direct dep is a different shape of violation (might not be imported yet
# but signals intent to import in the live path).
PACKAGE_JSON_PATHS=(
  "${REPO_ROOT}/package.json"
  "${REPO_ROOT}/packages/engine/package.json"
  "${REPO_ROOT}/packages/ports/package.json"
  "${REPO_ROOT}/packages/protocol/package.json"
  "${REPO_ROOT}/packages/adapters/package.json"
)

for pjson in "${PACKAGE_JSON_PATHS[@]}"; do
  if [[ -f "${pjson}" ]]; then
    # Look for `@dynamic-labs/*` as a dependency key in either dependencies
    # or devDependencies. A simple grep is sufficient because package.json
    # JSON doesn't have line-comments.
    if grep -EnH '"@dynamic-labs/[^"]+"[[:space:]]*:' "${pjson}" >/dev/null 2>&1; then
      violations=$((violations + 1))
      violation_lines+="$(grep -EnH '"@dynamic-labs/[^"]+"[[:space:]]*:' "${pjson}")"$'\n'
    fi
  fi
done

if [[ ${violations} -gt 0 ]]; then
  printf '\n'
  printf 'ERROR: live-path Dynamic SDK quarantine violation(s) detected.\n'
  printf '\n'
  printf 'Per PRD §3 D3-reframed + §4.3 FR-A4, the live auth path MUST NOT\n'
  printf 'import @dynamic-labs/*. dynamic_user_id is a BACKFILL-only credential\n'
  printf '(handled by credential-bridge-dynamic.ts, which itself does not need\n'
  printf 'the SDK — it processes already-extracted strings).\n'
  printf '\n'
  printf 'Offending lines:\n'
  printf '%s' "${violation_lines}"
  printf '\n'
  printf 'Remediation: remove the import. If you genuinely need Dynamic SDK\n'
  printf 'access for live verification, that is a PRD-level reframing — open\n'
  printf 'a discussion before re-introducing it.\n'
  exit 1
fi

printf 'OK: zero @dynamic-labs/* live-path imports detected.\n'
exit 0
