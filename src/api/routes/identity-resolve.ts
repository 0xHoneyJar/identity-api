/**
 * POST /v1/identity/resolve — the v1 merge facade (bd-2wo.38.2 · SDD §5).
 *
 * Batch-resolve wallets to ONE pre-merged identity each: spine join (SoR) +
 * score-api group-aware onchain enrichment, display-name priority applied ONCE
 * server-side (world_nym > discord > score > address). Read-only.
 *
 * Degradation (mirrors /v1/profile, profile.ts:1-11,120-130): a score-api
 * miss/timeout NEVER 5xxes — it degrades the whole batch and still answers 200.
 * Only a real spine I/O failure (engine THROWS) propagates to the global error
 * handler as 5xx; a null spine MISS is not an error (→ user_id:null, address
 * tier). See `grimoires/loa/sdd.md` (PRD v3.0 G-5 / bd-2wo.38).
 */

import { jsonResponse } from "@hyper/core"
import { route } from "../../auth"
import { getSpine } from "../spine"
import { getScore } from "../score"
import {
  resolveByWallet,
  getIdentity,
  normalizeAddress,
  mergeIdentity,
} from "@freeside-auth/engine"
import {
  IdentityResolveReqSchema as IdentityResolveReq,
  type IdentityResolveEntry,
} from "@freeside-auth/protocol/api"

/** Per-source AbortSignal budget for the single batched score-api call. */
const DEFAULT_SCORE_TIMEOUT_MS = 600

export const resolveIdentityBatch = route
  .post("/v1/identity/resolve")
  .meta({
    summary:
      "Batch-resolve wallets to pre-merged identities (spine + score onchain names)",
    mcp: {
      title: "Resolve identities (batch)",
      description:
        "Hand a batch of wallets (≤100), get one pre-merged identity each: display_name (priority world_nym>discord>score>address, applied once server-side), discord {id,linked}, onchain-name passthrough, is_primary_wallet, per-batch degraded flag. Read-only. Per G-5 / bd-2wo.38.",
    },
  })
  .handle(async (c) => {
    // Validate the body in-handler (mirrors /v1/profile's in-handler validate,
    // profile.ts:77-86) rather than via Hyper's `.body(Schema)` builder: the
    // vendored openapi-zod converter crashes walking a `z.array(...)` body
    // schema during OpenAPI generation (Zod-4 ZodArray `_def.type` discriminator
    // bug, src/hyper/openapi-zod/index.ts:66 — logged as a discovered issue).
    // The sealed protocol schema is still the contract; we apply it here.
    const parsed = IdentityResolveReq.safeParse((c as unknown as { body: unknown }).body)
    if (!parsed.success) {
      return jsonResponse(400, {
        code: "invalid_param",
        message: parsed.error.issues[0]?.message ?? "invalid request body",
        issues: parsed.error.issues,
      })
    }
    const body = parsed.data

    // Normalize (lowercase EVM) + dedupe, preserving first-seen order for the
    // order-stable echo. The ≤100 cap + hex format were enforced above.
    const seen = new Set<string>()
    const wallets: string[] = []
    for (const w of body.wallets) {
      const n = normalizeAddress(w)
      if (!seen.has(n)) {
        seen.add(n)
        wallets.push(n)
      }
    }

    // ONE batched score-api call (the dominant latency term) under a per-source
    // AbortController. A miss/timeout degrades the WHOLE batch (score is a
    // single call) — it never propagates as a 5xx.
    // Guard against a misconfigured env: Number("abc") → NaN, and
    // setTimeout(NaN) fires immediately → every request would silently degrade
    // to spine-only. Fall back to the default on NaN / non-positive.
    const envTimeout = Number(process.env.IDENTITY_RESOLVE_SCORE_TIMEOUT_MS)
    const timeoutMs =
      Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : DEFAULT_SCORE_TIMEOUT_MS
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), timeoutMs)
    let scoreResult
    try {
      scoreResult = await getScore().resolveIdentity({ wallets }, { signal: ac.signal })
    } finally {
      clearTimeout(timer)
    }
    const degraded = !scoreResult.ok
    const identities = scoreResult.ok ? scoreResult.data.identities : {}

    // Per-wallet spine reads + merge. A spine THROW (real Postgres I/O error)
    // propagates to the global error handler as 5xx — the spine is the SoR
    // substrate (NFR-2). A null MISS is not an error (user_id=null → address).
    const spine = getSpine()
    const results: IdentityResolveEntry[] = []
    for (const wallet of wallets) {
      const userId = await resolveByWallet(spine, wallet)
      const identity = userId ? await getIdentity(spine, userId) : null
      results.push(
        mergeIdentity({
          wallet,
          spine: identity,
          enrich: identities[wallet],
          worldSlug: body.world_slug,
          degraded,
        }),
      )
    }

    return jsonResponse(200, { results })
  })
