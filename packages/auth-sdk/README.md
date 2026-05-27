# `@freeside-auth/auth-sdk` — svc-JWT verifier SDK

> Source-distributed cell-side typed verifier. **NOT an npm package.**
> Consumers vendor this directory's `src/` tree into their own repo
> (shadcn-style `add` pattern) per PRD v3.0 §11 post-verify lock-ins.

Per the cluster's **sovereign source-distribution doctrine** (`project_sovereign-code-distribution`): external consumption is via **vendored source** (sovereignty + supply-chain shrinkage), NOT a published `@0xhoneyjar/auth` npm dependency. The two-organ consume model is **source-distributed typed code (code-mode) + MCP (discovery)**.

This README explains:

1. [What this is](#what-this-is)
2. [Why source distribution](#why-source-distribution)
3. [Vendoring](#vendoring) — the canonical instructions
4. [API surface](#api-surface) — every export with an example
5. [Conformance suite](#conformance-suite) — the substrate-grade M-3 gate
6. [JwksCache impls](#jwkscache-impls) — when to pick which
7. [Error-code mapping](#error-code-mapping) — verifier code → HTTP status
8. [Updating a vendored copy](#updating-a-vendored-copy)
9. [Sibling vs this package](#sibling-vs-this-package)
10. [Deferred work](#deferred-work)

---

## What this is

A small (~5 source files, ~600 lines + tests) typed verifier for cluster
service-to-service JWTs (svc-JWTs):

- **Typed** — verify-result is a discriminated union (`{ok: true, claims}` |
  `{ok: false, code, message}`); error codes are an exhaustive enum. The
  consumer's `tsc` catches mishandled cases at compile time.
- **Total** — `verifySvcJwt` MUST NEVER throw, even on garbage input.
  The 6-case fuzz suite enforces this.
- **Source-distributed** — you copy `packages/auth-sdk/src/` (+ transitive
  `packages/protocol/` + `packages/adapters/` source) into your tree and
  pin to a commit SHA. Upstream changes don't break you until you
  re-vendor.
- **Substrate-grade gated** — the SDK ships a callable `runConformanceSuite`
  that runs 21 D-1.1 §8 scenarios + fuzz + order-of-ops invariants. Cells
  rerun the suite in their own CI against their own verifier wrapper.

## Why source distribution

| Property | npm distribution | Source distribution |
|----------|------------------|---------------------|
| Supply-chain attack surface | one more `npm install` line | zero — only your existing `jose` peer |
| Version agency | upstream's `^x.y.z` silently accepts updates | you pin a commit SHA; updates are explicit |
| Type drift on server upgrade | the published `.d.ts` may lag the server | you re-vendor and `git diff` the change |
| Customization | fork, publish, maintain | edit the local copy, commit |
| Boot speed | adds ~3 deps (auth-sdk + protocol + adapters) | zero, the files compile with the rest of your app |

Doctrinally: matches Hyper's "distributed as source" framing. Composes
with `[[sovereign-stack]]` + `[[saas-exit-vectors]]` + `[[contracts-as-bridges]]`.

## Vendoring

> **Read this section once. It is the contract.**

The SDK lives at `packages/auth-sdk/src/` inside the `identity-api` repo.
This package **re-exports** from `@freeside-auth/protocol` and
`@freeside-auth/adapters`; vendoring it requires copying THREE source
trees into the consumer.

### Step 1 — Clone the source repo (at a pinned commit)

```bash
git clone https://github.com/0xHoneyJar/identity-api.git /tmp/identity-api
cd /tmp/identity-api
git checkout <commit-sha>        # pin to a known-good SHA
git log -1 --format='%H'         # record it
```

### Step 2 — Copy the three source trees into your consumer

The strict-minimum transitive list is **two files** (the auth-sdk's
re-export chain ends here):

```bash
VENDOR=/path/to/your-app/src/vendor

# auth-sdk itself — copy CONTENTS of src/ EXCLUDING __tests__/ into
# auth-sdk/. The `/.` after src skips the directory and copies its
# children, so the vendored layout ends up as auth-sdk/index.ts NOT
# auth-sdk/src/index.ts (matching the import shape `from '@/vendor/auth-sdk'`
# below). The rsync excludes __tests__ — those import `bun:test` and
# would break typecheck on non-Bun consumers (Node, Deno, browser).
# Consumers wanting the conformance suite re-run it via the runtime
# `runConformanceSuite()` callable — they do NOT need to vendor the
# bun-specific test wrappers.
mkdir -p "${VENDOR}/auth-sdk"
rsync -a --exclude '__tests__/' /tmp/identity-api/packages/auth-sdk/src/ "${VENDOR}/auth-sdk/"
# If rsync is unavailable, the cp-then-remove equivalent:
#   cp -R /tmp/identity-api/packages/auth-sdk/src/. "${VENDOR}/auth-sdk/"
#   rm -rf "${VENDOR}/auth-sdk/__tests__"

# Transitive: protocol (svc-jwt-claims Effect.Schema)
mkdir -p "${VENDOR}/auth-protocol"
cp /tmp/identity-api/packages/protocol/src/svc-jwt-claims.ts "${VENDOR}/auth-protocol/"

# Transitive: adapters (the verify function)
mkdir -p "${VENDOR}/auth-adapters"
cp /tmp/identity-api/packages/adapters/src/svc-jwt-verifier.ts "${VENDOR}/auth-adapters/"
```

After this step the vendored tree should look like (note: NO
`__tests__/` directory — those are excluded for non-Bun portability):

```
src/vendor/
├── auth-sdk/
│   ├── conformance/
│   ├── index.ts
│   ├── jwks-cache.ts
│   ├── svc-jwt-claims.ts
│   └── verify.ts
├── auth-protocol/
│   └── svc-jwt-claims.ts
└── auth-adapters/
    └── svc-jwt-verifier.ts
```

> **DenylistCheck is BYO**. The auth-sdk re-exports the `DenylistCheck`
> *interface* (`{ matches(kid, jti, sub): Promise<{denied, ...}> }`) but
> NO concrete impl. Consumers provide their own — the cluster default
> is HTTP-indirection to `POST /v1/auth/denylist/check` (for cells
> without direct PG access). If you want identity-api's
> `PostgresDenylistCheck` (rare — only cells with direct PG access),
> copy `packages/adapters/src/denylist-postgres.ts` AND
> `packages/adapters/src/postgres-split-adapter.ts` (transitively
> pulls in `@freeside-auth/ports` + the `pg` npm package).

### Step 3 — Rewrite the cross-package imports

The vendored sources still import `@freeside-auth/protocol` and
`@freeside-auth/adapters` (workspace aliases). Rewrite ALL three
vendored directories — the transitive copies need the same pass:

```bash
# From your-app root — rewrite ALL vendored trees (sdk + transitive)
VENDOR=src/vendor
for dir in "${VENDOR}/auth-sdk" "${VENDOR}/auth-adapters" "${VENDOR}/auth-protocol"; do
  find "${dir}" -name '*.ts' -exec sed -i.bak \
    -e 's|@freeside-auth/protocol|../auth-protocol/svc-jwt-claims|g' \
    -e 's|@freeside-auth/adapters|../auth-adapters/svc-jwt-verifier|g' {} \;
done
find "${VENDOR}" -name '*.bak' -delete
```

Or — if your tsconfig has path aliases — point
`@0xhoneyjar/auth/protocol` at `src/vendor/auth-protocol` etc. and leave
the SDK source untouched modulo the alias.

### Step 4 — Install the peer dependencies

Add to your consumer's `package.json`:

```jsonc
{
  "dependencies": {
    "@effect/schema": "^0.75",
    "effect": "^3.10.0",
    "jose": "^6.0.0"
  }
}
```

> The auth-sdk does **NOT** appear in your `dependencies`. The vendored
> source is part of your tree; only the peers (`@effect/schema`,
> `effect`, `jose`) are npm dependencies.

### Step 5 — Pin the source commit

```bash
cat <<EOF > /path/to/your-app/src/vendor/auth-sdk/VENDOR.md
Upstream: https://github.com/0xHoneyJar/identity-api
Commit:   <the SHA from step 1>
Vendored: $(date -u +"%Y-%m-%dT%H:%M:%SZ")
Path:     packages/auth-sdk/src/ (+ transitive protocol/, adapters/)
Modifications: import-rewrite (@freeside-auth/* → relative)
EOF
```

### Step 6 — Import + use

```ts
import {
  verifySvcJwt,
  InMemoryJwksCache,
  runConformanceSuite,
} from '@/vendor/auth-sdk';
import { PostgresDenylistCheck } from '@/vendor/auth-adapters/denylist-postgres';

const cache = new InMemoryJwksCache();
const denylistCheck = new PostgresDenylistCheck({ sql: yourBunSql });

const result = await verifySvcJwt(jwt, {
  expectedIss: 'https://identity.0xhoneyjar.xyz',
  expectedAud: 'your-cell-name',
  expectedRole: 'your.capability',
  jwksUrl: 'https://identity.0xhoneyjar.xyz/.well-known/jwks.json',
  jwksCache: cache,
  denylistCheck,
});

if (!result.ok) {
  return new Response(JSON.stringify({ code: result.code }), {
    status: HTTP_STATUS_BY_CODE[result.code], // see "Error-code mapping" below
  });
}
// result.claims is typed SvcJwtClaims with iss/aud/sub/role/iat/exp/nbf/jti.
```

### Step 7 — Run the conformance suite as a CI gate

```ts
// your-app/test/auth-conformance.test.ts
import { runConformanceSuite } from '@/vendor/auth-sdk';
import { describe, it, expect } from 'bun:test';

describe('svc-JWT conformance (substrate gate)', () => {
  it('passes all 21 canonical scenarios', async () => {
    const result = await runConformanceSuite();
    if (!result.ok) {
      console.error(result.scenarios.filter(s => !s.pass));
    }
    expect(result.ok).toBe(true);
  });
});
```

### Step 8 — Schedule a re-vendor cadence

Re-vendor monthly OR on upstream's breaking-change tag:

```bash
git -C /tmp/identity-api fetch
git -C /tmp/identity-api log --oneline <pinned-sha>..origin/main -- \
  packages/auth-sdk packages/protocol/src/svc-jwt-claims.ts \
  packages/adapters/src/svc-jwt-verifier.ts \
  packages/adapters/src/denylist-postgres.ts
```

If those paths are unchanged you're up to date. Otherwise, `git diff`
the path set, review, repeat steps 2-5 with the new SHA.

## API surface

### `verifySvcJwt(jwt, opts) → Promise<SvcJwtVerifyResult>`

The 10-step D-1.1 §5 verify pipeline:

```
1. Parse JWT shape (3 dot-separated parts)        — no I/O
2. Decode + validate header (alg/typ/kid schema)  — no I/O
3. exp / nbf vs now ± skewSec                     — no I/O
4. iss === expectedIss                            — no I/O
5. kid prefix check (re-validate against opts)    — no I/O
6. Fetch JWKS via cache                           — 1 I/O (cache hit = 0)
7. Signature verify (ES256)                       — no further I/O
8. aud === expectedAud                            — no I/O
9. role === expectedRole                          — no I/O
10. Denylist query (kid/jti/sub conjunctive)      — 1 I/O
```

Returns:

```ts
type SvcJwtVerifyResult =
  | { ok: true; claims: SvcJwtClaims }
  | { ok: false; code: SvcJwtVerifyErrorCode; message: string; ruleId?: string };
```

### `runConformanceSuite(opts?) → Promise<ConformanceResult>`

See [Conformance suite](#conformance-suite).

### `InMemoryJwksCache` / `LruJwksCache`

See [JwksCache impls](#jwkscache-impls).

### Schemas + decoders

```ts
import { SvcJwtClaims, SvcJwtHeader, decodeSvcJwtClaims } from '@/vendor/auth-sdk';
// SvcJwtClaims + SvcJwtHeader are @effect/schema Schemas (value + type).
```

## Conformance suite

The substrate-grade M-3 gate. 21 scenarios:

| # | Group | Name | Expected |
|---|-------|------|----------|
| 1 | D-1.1 §8 | valid JWT | `ok: true` |
| 2 |  | invalid signature | `INVALID_SIG` |
| 3 |  | role mismatch | `ROLE_MISMATCH` |
| 4 |  | aud mismatch | `AUD_MISMATCH` |
| 5 |  | iss mismatch | `ISS_MISMATCH` |
| 6 |  | kid prefix (user- to svc-) | `KID_DISALLOWED` |
| 7 |  | expired | `EXPIRED` |
| 8 |  | nbf future | `NBF_FUTURE` |
| 9 |  | malformed | `MALFORMED` |
| 10 |  | JWKS unreachable | `JWKS_UNREACHABLE` |
| 11 |  | denylist match | `DENIED_BY_RULE` |
| 12-17 | fuzz | `''`, `'bogus'`, `undefined`, `null`, `'a.b.c'`, `'...'` | `MALFORMED` (none throw) |
| 18-21 | order-of-ops | expired/iss/kid short-circuit before JWKS fetch; throwing denylist → `DENYLIST_UNAVAILABLE` | matches D-1.1 §5 |

NO replay scenarios — replay is **mechanically impossible** by design
under D2.5-12 per-request issuance. Adding one would signal an upstream
violation.

## JwksCache impls

| Class | Capacity | When to use |
|-------|----------|-------------|
| `InMemoryJwksCache` | unbounded | single upstream issuer (common case — every cell verifies identity-api only) |
| `LruJwksCache({maxEntries})` | bounded | federation gateway / multi-cluster verifier |

Both honor per-entry TTL (`ttlSec` passed to `set`). Lazy eviction on
`get` after expiry. Both accept `now: () => number` for deterministic
tests.

## Error-code mapping

The verifier returns a structured `code`; the caller maps to HTTP:

| Code | HTTP | Class |
|------|------|-------|
| `MALFORMED` | 400 | Bad request — structural parse fail |
| `INVALID_SIG` | 401 | Auth — signature verification failed |
| `EXPIRED` | 401 | Auth — exp past now-skew |
| `NBF_FUTURE` | 401 | Auth — nbf past now+skew |
| `ISS_MISMATCH` | 401 | Auth — wrong issuer |
| `KID_DISALLOWED` | 401 | Auth — kid prefix mismatch OR key not in JWKS |
| `ROLE_MISMATCH` | 403 | Forbidden — capability mismatch |
| `AUD_MISMATCH` | 403 | Forbidden — wrong audience cell |
| `DENIED_BY_RULE` | 403 | Forbidden — denylist match |
| `JWKS_UNREACHABLE` | 503 | Fail-CLOSED per NF-Sec-1 |
| `DENYLIST_UNAVAILABLE` | 503 | Fail-CLOSED per NF-Sec-1 |

## Updating a vendored copy

1. List changes:
   ```bash
   git -C /tmp/identity-api log --oneline <old-sha>..origin/main -- \
     packages/auth-sdk packages/protocol/src/svc-jwt-claims.ts \
     packages/adapters/src/svc-jwt-verifier.ts \
     packages/adapters/src/denylist-postgres.ts
   ```
2. Review the diff.
3. Repeat vendor steps 2-5 with the new SHA.
4. Re-run the conformance suite — if any scenario fails, that's the
   breakage signal.

The risk profile is **bounded**: you control when it happens, what
changes, and you can `git revert` your vendored-copy commit without
affecting upstream.

## Sibling vs this package

The cluster ships TWO source-distributed SDKs:

| Package | Internal name | Vendored alias | Purpose |
|---------|--------------|----------------|---------|
| `packages/sdk/` | `@freeside-auth/identity-client` | `@0xhoneyjar/identity` | **HTTP** client — typed methods for `/v1/auth/challenge`, `/v1/me`, `/v1/identity/:id`, etc. |
| `packages/auth-sdk/` | `@freeside-auth/auth-sdk` | `@0xhoneyjar/auth` | **Crypto / verification** — `verifySvcJwt`, conformance suite, JwksCache impls |

They coexist. A cell receiving an svc-JWT calls `verifySvcJwt` (this
package). A cell calling identity-api's HTTP surface uses
`identity-client`. Both vendor via the same shadcn `add` pattern.

## Deferred work

- **`/.well-known/jwks.json` endpoint** — the JWKS document MUST be
  served by identity-api for verifiers to fetch keys. As of W2.5 Sprint 3
  the endpoint is forward-track; `LocalEs256Signer` exposes the active
  `kid` but the HTTP route composer that publishes JWKS to the world is
  the next sprint's work. Until then, cells in private deployment can
  populate `JwksCache` programmatically with the current public JWK.
- **2-key rotation env handling in code** — the runbook (`grimoires/runbooks/jwks-rotation.md`)
  documents the env contract (`SVC_JWT_SIGNING_KEY_PEM` +
  `SVC_JWT_SIGNING_KEY_PEM_PREV`); the JWKS composer that emits BOTH
  kids during overlap is forward-track.
- **`freeside-cli vendor add auth-sdk`** — the build doc references a
  CLI command for one-line vendoring; not authored in this sprint. The
  manual recipe above is the current contract.

## License

MIT — same as the parent `identity-api` repo.
