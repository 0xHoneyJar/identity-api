/**
 * src/api/codex.ts — singleton CodexPort accessor for route handlers + the
 * compose orchestrator (T2.1).
 *
 * Mirrors `src/api/spine.ts` exactly: lazy build, env-driven config, test seams.
 *
 * Production posture:
 *   - CODEX_API_URL is read on first call (optional — falls back to
 *     DEFAULT_CODEX_BASE_URL per registry.yaml).
 *   - No auth (codex beacon: pricing=free, auth=none).
 *
 * Test seams: `__setCodexForTest(port)` / `__resetCodexForTest()`.
 *
 * Source: PRD v3.0 §4.5, SDD §5.4, T1.5 src/api/spine.ts pattern.
 */

import { HttpCodexAdapter } from "@freeside-auth/adapters"
import type { CodexPort } from "@freeside-auth/ports"

let _codex: CodexPort | null = null

function buildCodexFromEnv(): CodexPort {
  const baseUrl = process.env.CODEX_API_URL
  return new HttpCodexAdapter({
    ...(baseUrl ? { baseUrl } : {}),
  })
}

/**
 * Return the process-wide CodexPort singleton, building it from env on first
 * call. Cached for the life of the process.
 */
export function getCodex(): CodexPort {
  if (!_codex) _codex = buildCodexFromEnv()
  return _codex
}

// ─── test seams ──────────────────────────────────────────────────────────

export function __setCodexForTest(port: CodexPort): void {
  _codex = port
}

export function __resetCodexForTest(): void {
  _codex = null
}
