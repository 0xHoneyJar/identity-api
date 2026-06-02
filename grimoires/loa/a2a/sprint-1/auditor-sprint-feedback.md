# Security Audit — Sprint 1: `POST /v1/identity/resolve` Merge Facade

**Auditor:** Paranoid Cypherpunk Auditor · **Bead:** `bd-2wo.38` (38.1–38.4) · **Date:** 2026-06-02
**Prereqs:** report ✓ (`reviewer.md`), senior approval ✓ ("All good", `engineer-feedback.md`), not previously COMPLETED ✓.

## Verdict

**APPROVED - LETS FUCKING GO**

No CRITICAL or HIGH security issues introduced by this sprint. The feature is additive, read-only, and the auth substrate is provably untouched. Approval carries **two MEDIUM pre-cutover conditions** (below) that are non-blocking for the gated build but MUST be resolved before the dashboard cutover.

## Hard Constraints — verified

| Check | Method | Result |
|-------|--------|--------|
| **AC-13** — signer/JWKS/svc-JWT verify/`CredentialBridge`/denylist/service-jwt byte-unchanged | `git diff --stat <base> -- <10 auth paths>` | **EMPTY ✓** |
| **AC-14** — no migrations / `*.up.sql` / persistence | `git diff --name-only <base> \| grep -E '\.up\.sql\|migrations/'` | **EMPTY ✓** |
| No-embed — route stores nothing | code read: only `resolveByWallet`/`getIdentity` reads + 1 score read; no `writeAuditEvent`/INSERT | **✓** |

## Security Checklist

- **Secrets:** `X-API-Key` is `private readonly apiKey` (`http-score-adapter.ts:95`), sourced from env at singleton build; logged ONLY as `hasApiKey: boolean` (`resolveIdentity` context). No hardcoded credential, no key value logged. **✓**
- **Injection:** `resolveIdentity` is **body-only** — fixed URL `${baseUrl}/v1/identity/resolve` (`:136`), wallets in the JSON body (`:141`), NOT in any URL path. Spine reads go through the parameterized `SpinePort` adapter. Wallets are Zod-validated `0x+40hex` + lowercase-normalized before use. No SQLi / path-traversal surface. **✓**
- **Input validation:** body validated in-handler against `IdentityResolveReqSchema` (`.min(1).max(100)`, hex regex) → 400 `{code:"invalid_param", issues}` on failure; `.max(100)` caps the batch (DoS bound); dedupe prevents amplification. **✓**
- **Data privacy / PII:** discord `external_id` is an opaque snowflake (NO username — column doesn't exist); score `basename`/`pfp_url`/`twitter_source` are NOT surfaced; no emails/secrets. **✓** (see MEDIUM-1 on the open-posture amplification.)
- **Error handling:** score outage → 200 + per-batch `degraded`, never 5xx (verified by tests). Spine I/O throw → 5xx via the shared global handler (see MEDIUM-2). 400 returns Zod field messages only (not sensitive). **✓**
- **Auth posture:** route has NO `.auth()` — the sibling open-read posture (OQ-3 default). Consistent with `/v1/profile` + `/v1/resolve/*`. The verify implementation was NOT touched. **✓** (see MEDIUM-1.)
- **Robustness:** `IDENTITY_RESOLVE_SCORE_TIMEOUT_MS` NaN-guarded (`Number.isFinite && >0`, route:65-69) — closed the silent-universal-degrade footgun the review found. **✓**

## Findings (non-blocking)

### MEDIUM-1 — open-posture batch exposure of wallet→identity (pre-cutover decision)
On an unauthenticated endpoint, a caller can POST ≤100 wallets and harvest `wallet → {user_id, discord_id, nyms}` in one shot. The data is ALREADY open via per-wallet `/v1/profile` + the two-step resolve, so this introduces **no new data class** — but it amplifies harvesting convenience (batch).
- **Why non-blocking now:** ships BEHIND the contract-first bridge (`IDENTITY_RESOLVE_URL` mock-fallback); production cutover is GATED on #11 + backfill; prod coverage is tiny (5 users / 3 nyms); OQ-3 is an explicit, documented deferral to T-A2.
- **Condition before cutover:** resolve OQ-3 — decide whether the route needs `.auth()` (svc-JWT) AND/OR rate-limiting before it serves production traffic. If protected: add `.auth()` to the route ONLY (never the verify impl, AC-13).

### MEDIUM-2 — pre-existing 5xx info-disclosure in the shared global handler (out of scope)
The Hyper global handler `asHyperError` (`src/hyper/core/error.ts:78`) returns `e.message` on an uncaught throw → a real Postgres/spine error string is echoed on 500. This facade's spine-throw→5xx path uses the SAME pattern as the shipped `/v1/profile` + `/v1/link` — it is **pre-existing and building-wide**, NOT introduced here. Tracked as **bd-eda** (`discovered-during:bd-2wo.38.2`, security, P3). Hardening (sanitize 5xx messages / spine adapter throws sanitized errors) is out of this sprint's scope.

### LOW — empty-string nym guard (defense-in-depth)
`mergeIdentity` selects a `world_nym` on `worldNym !== undefined`; an empty `""` nym (shouldn't exist — `NymParamSchema.min(3)` at claim) would yield `display_name=""`. Optional guard. Non-blocking.

## Conclusion

The code is correct, the boundary holds, the auth substrate is provably untouched, and the only real exposure (MEDIUM-1) is gated behind the contract-first bridge with an explicit pre-cutover decision point. **Sprint 1 APPROVED.** The two MEDIUM items are tracked and conditional on cutover, not on shipping the gated build.
