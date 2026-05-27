#!/usr/bin/env bash
# packages/auth-sdk/scripts/check-coverage.sh
#
# M-3 coverage gate enforcer for auth-sdk.
#
# Runs `bun test --coverage` on the auth-sdk package and asserts:
#   - Every file in packages/auth-sdk/src/ reports % Lines >= 90.
#
# Why bun + this script (not c8):
#   - Bun's --coverage reports % Lines + % Funcs but NOT % Branches.
#   - c8 wrapping `bun test` reports 0% across the board (c8 instruments
#     via NODE_V8_COVERAGE which Bun does not honor).
#   - Until either bun ships branch coverage OR we wire a Node-based
#     test-runner shim, branch% (M-3's 80 threshold) is a forward-track
#     enforcement gap. Auth-sdk is mostly thin re-exports + simple
#     classes, so branch density is low and manual review suffices.
#
# The script parses bun's coverage table and checks the auth-sdk rows.
# Exits 0 on pass, 1 on any file < 90% lines, 2 on script error.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
THRESHOLD_LINES=90
PACKAGE_PREFIX="packages/auth-sdk/src/"

cd "${REPO_ROOT}"

# Run bun's coverage; capture both stdout (table) and stderr (test output)
output="$(bun test --coverage packages/auth-sdk 2>&1)"

# Bun's table format (per inspection):
#   File path                           |   % Lines |   % Funcs | Uncovered lines
#   packages/auth-sdk/src/x.ts          |    93.10  |   100.00  | 1,5
#
# We grep for rows under `packages/auth-sdk/src/` and pull the % Lines column.

# shellcheck disable=SC2207
auth_sdk_rows=( $(echo "${output}" | grep -E "^\s+${PACKAGE_PREFIX}" || true) )

if [[ ${#auth_sdk_rows[@]} -eq 0 ]]; then
  # No rows means coverage didn't include auth-sdk files — either the test
  # didn't import them or bun's table format changed.
  echo "ERROR: no coverage rows found under ${PACKAGE_PREFIX}" >&2
  echo "Raw bun test output:" >&2
  echo "${output}" >&2
  exit 2
fi

failures=0
total_files=0

# Parse line-by-line. The table format is:
#   <whitespace><filepath><whitespace>|<whitespace>NN.NN<whitespace>|<whitespace>NN.NN<whitespace>|<rest>
while IFS= read -r line; do
  if [[ -z "${line}" ]]; then continue; fi
  # Extract the filepath (column 1) and % Lines (column 2)
  filepath="$(echo "${line}" | awk -F'|' '{print $1}' | xargs)"
  pct_lines="$(echo "${line}" | awk -F'|' '{print $2}' | xargs)"

  if [[ -z "${pct_lines}" || ! "${pct_lines}" =~ ^[0-9]+(\.[0-9]+)?$ ]]; then
    continue
  fi

  total_files=$((total_files + 1))
  # Use awk for float comparison (bash builtins do integers only)
  below="$(awk -v p="${pct_lines}" -v t="${THRESHOLD_LINES}" 'BEGIN { print (p < t) ? "yes" : "no" }')"
  if [[ "${below}" == "yes" ]]; then
    echo "FAIL: ${filepath} = ${pct_lines}% lines (< ${THRESHOLD_LINES}%)" >&2
    failures=$((failures + 1))
  else
    echo "PASS: ${filepath} = ${pct_lines}% lines"
  fi
done < <(echo "${output}" | grep -E "^\s+${PACKAGE_PREFIX}")

echo ""
echo "auth-sdk coverage gate:"
echo "  files checked: ${total_files}"
echo "  threshold:     ${THRESHOLD_LINES}% lines"
echo "  failures:      ${failures}"

# Forward-track: emit the branch-coverage caveat so CI logs carry it.
echo ""
echo "NOTE: M-3 also specifies branches >= 80%. Bun does not currently"
echo "report branch coverage. The auth-sdk is mostly thin re-exports +"
echo "simple classes — branch density is low. See:"
echo "  packages/auth-sdk/scripts/check-coverage.sh (header) for the"
echo "  forward-track plan."

if [[ ${failures} -gt 0 ]]; then
  exit 1
fi
exit 0
