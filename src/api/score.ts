/**
 * src/api/score.ts — singleton ScorePort accessor for route handlers + the
 * compose orchestrator (T2.1).
 *
 * Mirrors `src/api/spine.ts` exactly: lazy build, env-driven config, test seams.
 *
 * Production posture:
 *   - SCORE_API_URL is read on first call (optional — falls back to
 *     DEFAULT_SCORE_BASE_URL per registry.yaml).
 *   - SCORE_API_KEY is read at build time. score-api gates /v1/* with
 *     `X-API-Key`; without the key the adapter still constructs (so
 *     dev-without-key boots), but all federated calls return
 *     `unauthorized` from the upstream — T2.2's compose-fan-out surfaces
 *     them in `degraded[]`.
 *   - Per FR-P3: a missing/invalid score key is NOT fatal at boot. The
 *     /v1/profile request still completes 200 with the score source
 *     listed in `degraded[]`.
 *
 * Test seams: `__setScoreForTest(port)` / `__resetScoreForTest()`.
 *
 * Source: PRD v3.0 §4.5, SDD §5.4, T1.5 src/api/spine.ts pattern.
 */

import { HttpScoreAdapter } from "@freeside-auth/adapters"
import type { ScorePort } from "@freeside-auth/ports"

let _score: ScorePort | null = null

function buildScoreFromEnv(): ScorePort {
  const baseUrl = process.env.SCORE_API_URL
  const apiKey = process.env.SCORE_API_KEY
  return new HttpScoreAdapter({
    ...(baseUrl ? { baseUrl } : {}),
    ...(apiKey ? { apiKey } : {}),
  })
}

/**
 * Return the process-wide ScorePort singleton, building it from env on first
 * call. Cached for the life of the process.
 */
export function getScore(): ScorePort {
  if (!_score) _score = buildScoreFromEnv()
  return _score
}

// ─── test seams ──────────────────────────────────────────────────────────

export function __setScoreForTest(port: ScorePort): void {
  _score = port
}

export function __resetScoreForTest(): void {
  _score = null
}
