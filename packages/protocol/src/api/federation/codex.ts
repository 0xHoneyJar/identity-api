/**
 * Federation contract — mibera-codex wire shapes (T2.1).
 *
 * mibera-codex (`@0xhoneyjar/construct-mibera-codex`) is the Mibera lore
 * source-of-truth: per-tokenId 7-dimension profiles (archetype / ancestor /
 * sun-sign / element / swag / drug / parcel + grail bindings). Per
 * registry.yaml `codex` lives at `https://codex.0xhoneyjar.xyz` and its
 * `lookup_mibera` surface returns the canonical `MiberaEntry` shape.
 *
 * Source of truth (discovery findings — see t2.1 build notes):
 *
 *   - The local checkout at `~/Documents/GitHub/mibera-codex/src/types.ts`
 *     defines `MiberaEntry` with the per-token 7-dim shape. The data lives
 *     at `_codex/data/miberas.jsonl`; the `lookupMibera(id: number)`
 *     in-process function returns one entry (or null).
 *
 *   - The codex's PRIMARY transport is MCP (stdio + HTTP at
 *     `/codex/mcp` via @modelcontextprotocol/sdk). There is currently NO
 *     plain-HTTP REST endpoint for `lookup_mibera` — the only HTTP
 *     surfaces in `bin/http.ts` are `/healthz`, `/.well-known/mcp.json`,
 *     `/.well-known/beacon.json`, and the MCP JSON-RPC route.
 *
 *   - **Two options for T2.1 — chosen + justified**:
 *
 *       (A) Vendor the codex's lookup library + bundle the JSONL data —
 *           identity-api becomes in-process for codex reads. REJECTED:
 *           bundles ~10k lines of JSONL (read-once at module load); the
 *           data shape can drift without identity-api noticing.
 *
 *       (B) Wire an MCP client — call the lookup as an MCP tool over
 *           streamable-http transport. REJECTED for T2.1 scope: would
 *           require pulling `@modelcontextprotocol/sdk` (multi-package
 *           dependency), authoring the MCP session lifecycle, and
 *           handling tool-call error semantics in the adapter. T2.1 is
 *           a port-foundation task — that's T3+ infrastructure.
 *
 *       (C) **CHOSEN** — author the port + adapter against a PROJECTED
 *           REST shape (`GET /v1/mibera/:tokenId` returning a single
 *           `MiberaEntry`-shaped body, plus `POST /v1/mibera/batch`
 *           with `{tokenIds: number[]}` for the multi-token Mibera-
 *           dimensions resolver T3.1 will call). Document the projection
 *           as a known integration gap; codex either (a) adds the thin
 *           HTTP wrapper around `lookupMibera`, (b) we add an MCP-client
 *           adapter implementing the same port, or (c) we vendor the
 *           library and add an in-process adapter. The PORT contract is
 *           stable across all three transports — which is the whole
 *           point of the port/adapter pattern.
 *
 *   - The codex beacon.yaml declares `pricing: model: free` and `auth:
 *     kind: none` — no API key needed. The HTTP/MCP gateway at
 *     `https://mcp.0xhoneyjar.xyz/codex/mcp` is open.
 *
 * Per Pattern B (T1.10) these Zod schemas live alongside other api/* shapes.
 *
 * Source: PRD v3.0 §4.5 (FR-P3 codex compose), SDD §5.4 + §6, registry.yaml,
 * `~/Documents/GitHub/mibera-codex/src/types.ts:46-78`,
 * `~/Documents/GitHub/mibera-codex/src/lookups/mibera.ts`,
 * `~/Documents/GitHub/mibera-codex/beacon.yaml`.
 */

import { z } from "zod"

// ─── enums (mirror mibera-codex/src/types.ts) ───────────────────────────────

/**
 * The 4 canonical archetypes. Mirrors `Archetype` at
 * `~/Documents/GitHub/mibera-codex/src/types.ts:1`.
 */
export const CodexArchetypeSchema = z.enum([
  "Freetekno",
  "Milady",
  "Acidhouse",
  "Chicago/Detroit",
])
export type CodexArchetype = z.infer<typeof CodexArchetypeSchema>

/**
 * Western-element classification of a Mibera. Mirrors `MiberaEntry.element`.
 */
export const CodexElementSchema = z.enum(["Earth", "Fire", "Water", "Air"])
export type CodexElement = z.infer<typeof CodexElementSchema>

/**
 * Swag-rank ordinal. Mirrors `MiberaEntry.swag_rank`. Lowercased / mixed-
 * case forms intentionally NOT supported — codex authoritative-strings come
 * out of the JSONL as `Sss` / `Ss` etc.
 */
export const CodexSwagRankSchema = z.enum(["Sss", "Ss", "S", "A", "B", "C", "D", "F"])
export type CodexSwagRank = z.infer<typeof CodexSwagRankSchema>

// ─── HTTP path / body schemas ───────────────────────────────────────────────

/**
 * `GET /v1/mibera/:tokenId` path parameter. Token IDs are integers in the
 * 1..10000 range (codex JSONL has 10k Mibera entries; ID = token-id).
 */
export const CodexGetMiberaPathSchema = z.object({
  tokenId: z.coerce.number().int().positive().max(10000),
})
export type CodexGetMiberaPath = z.infer<typeof CodexGetMiberaPathSchema>

/**
 * `POST /v1/mibera/batch` request body. Used by T3.1 (Mibera dimensions
 * resolver) when it needs multiple Mibera per-token profiles in one round-
 * trip (after `InventoryPort.getHoldings(wallet)` returns the wallet's
 * tokenIds for the Mibera contract).
 *
 * Cap at 100 token IDs per request — bounds the upstream JSONL scan + the
 * response payload. Callers requesting more should batch-paginate.
 */
export const CodexGetMiberaBatchReqSchema = z.object({
  tokenIds: z
    .array(z.number().int().positive().max(10000))
    .min(1)
    .max(100),
})
export type CodexGetMiberaBatchReq = z.infer<typeof CodexGetMiberaBatchReqSchema>

// ─── response shapes ────────────────────────────────────────────────────────

/**
 * One Mibera token's 7-dimension profile + cosmetic / lore attributes.
 *
 * Mirrors `MiberaEntry` from mibera-codex/src/types.ts:46-78 verbatim.
 *
 * The 7 dimensions T3.1 cares about (the "Mibera dimensions" surface):
 *   - archetype (the cultural anchor)
 *   - ancestor (the lineage anchor)
 *   - element (Earth/Fire/Water/Air)
 *   - sun_sign (zodiac)
 *   - drug (psychogeographic marker)
 *   - swag_rank + swag_score (curated tier)
 *   - parcel (optional spatial binding)
 *
 * Cosmetic fields (background/body/hair/etc.) are surfaced for the UX layer
 * (avatar reconstruction) but identity-api's compose doesn't read them
 * directly. They round-trip verbatim through `/v1/profile` (T2.3) for any
 * UX consumer that wants them.
 */
export const CodexMiberaEntrySchema = z.object({
  id: z.number().int().positive(),
  archetype: CodexArchetypeSchema,
  ancestor: z.string(),
  time_period: z.string(),
  birthday: z.string(),
  birth_coordinates: z.string(),
  sun_sign: z.string(),
  moon_sign: z.string(),
  ascending_sign: z.string(),
  element: CodexElementSchema,
  swag_rank: CodexSwagRankSchema,
  swag_score: z.number(),
  background: z.string(),
  body: z.string(),
  hair: z.string().nullable(),
  eyes: z.string(),
  eyebrows: z.string(),
  mouth: z.string(),
  shirt: z.string().nullable(),
  hat: z.string().nullable(),
  glasses: z.string().nullable(),
  mask: z.string().nullable(),
  earrings: z.string().nullable(),
  face_accessory: z.string().nullable(),
  tattoo: z.string().nullable(),
  item: z.string().nullable(),
  drug: z.string(),
  parcel: z.number().int().positive().optional(),
})
export type CodexMiberaEntry = z.infer<typeof CodexMiberaEntrySchema>

/**
 * `GET /v1/mibera/:tokenId` response — a single `MiberaEntry` body.
 *
 * On not-found the server returns 404 with the standard error envelope
 * (handled in the adapter as `reason: 'not_found'`); the schema below is
 * the 200 body only.
 */
export const CodexGetMiberaRespSchema = CodexMiberaEntrySchema
export type CodexGetMiberaResp = z.infer<typeof CodexGetMiberaRespSchema>

/**
 * `POST /v1/mibera/batch` response. Returns an array of entries for the
 * tokenIds that were found; not-found token IDs are silently omitted (the
 * caller dedupes against its request set if it needs to detect missing
 * IDs). Ordering is NOT guaranteed to match request order — the caller
 * should build its own `Map<tokenId, entry>` keyed lookup.
 *
 * The not-found-silent posture matches how T3.1 will use the data:
 * iterating the wallet's holdings and decorating each with codex traits;
 * a token that's in the wallet but NOT in the codex JSONL is a degraded
 * codex-side state, not an identity-api error.
 */
export const CodexGetMiberaBatchRespSchema = z.object({
  miberas: z.array(CodexMiberaEntrySchema).readonly(),
})
export type CodexGetMiberaBatchResp = z.infer<typeof CodexGetMiberaBatchRespSchema>
