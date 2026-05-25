# `@freeside-auth/identity-client` — typed HTTP client for identity-api

> Source-distributed typed SDK. **NOT an npm package.** Consumers vendor this
> directory's `src/` tree into their own repo (shadcn-style `add` pattern).

Per PRD v3.0 §11 post-verify lock-ins: external consumption of identity-api
is **vendored source** (sovereignty + supply-chain shrinkage), NOT a
published `@0xhoneyjar/identity` npm dependency. The two-organ consume
model is **source-distributed typed client (code-mode) + MCP (discovery)**.

This README explains:

1. [What this is](#what-this-is)
2. [Why source distribution](#why-source-distribution)
3. [Vendoring](#vendoring) — the canonical instructions
4. [API surface](#api-surface) — every method with an example
5. [Error handling](#error-handling) — the typed exception hierarchy
6. [Type-safety guarantees](#type-safety-guarantees)
7. [Updating a vendored copy](#updating-a-vendored-copy)
8. [Deferred work](#deferred-work)

---

## What this is

A small (~5 files, ~600 lines) typed HTTP client for identity-api:

- **Typed** — every method's request and response shape is derived from
  the SAME Zod schemas the server uses to validate. No drift; the
  consumer's `tsc` catches shape mismatches at compile time.
- **Source-distributed** — you copy `packages/sdk/src/` into your tree and
  pin it to a commit SHA. Upstream changes don't break you until you
  re-vendor.
- **Web-Standards-only** — uses `fetch`, `URL`, `Headers`, `JSON`. Runs
  in Bun, modern Node, browsers, and edge runtimes (Cloudflare Workers,
  Vercel Edge, Bun Workers).
- **Pluggable transport** — pass your own `fetch` shim for testing or for
  layering middleware (retries, logging, OTel).

## Why source distribution

| Property | npm distribution | Source distribution |
|----------|------------------|---------------------|
| Supply-chain attack surface | one more `npm install` line, transitively trusted | zero — only your existing `zod` peer |
| Version agency | upstream's `^x.y.z` range silently accepts updates | you pin a commit SHA; updates are explicit |
| Type drift on server upgrade | the published `.d.ts` may lag the server | you re-vendor and `git diff` the change |
| Build artifacts in your tree | one symlink in `node_modules` | source files you can step into during debug |
| Customization | fork, publish, maintain | edit the local copy, commit |
| Boot speed | adds ~1 dependency | zero, the files compile with the rest of your app |

Doctrinally: this matches Hyper's "distributed as source" framing
(`hyperjs.ai`) — the SDK and its server are aligned in their distribution
posture. The shadcn registry pattern proved the operational model at
scale; we apply it to API clients.

## Vendoring

> **Read this section once. It is the contract.**

The SDK lives at `packages/sdk/src/` inside the `identity-api` repo. To use it
from a downstream consumer (e.g., `mibera-honeyroad`, Sietch, a world app):

### Step 1 — Clone the source repo (at a pinned commit)

```bash
# Pin to a known-good commit. The HEAD of `main` is the rolling tip;
# real consumers should pin to a tag or specific SHA.
git clone https://github.com/0xHoneyJar/identity-api.git /tmp/identity-api
cd /tmp/identity-api
git checkout <commit-sha>        # e.g., the commit hash of this README
git log -1 --format='%H'         # record the SHA — your consumer's source-of-truth
```

### Step 2 — Copy the SDK source into your consumer

```bash
mkdir -p /path/to/your-app/src/vendor/identity-client
cp -R /tmp/identity-api/packages/sdk/src/ /path/to/your-app/src/vendor/identity-client/
# Also copy the protocol/api schemas — the SDK imports them:
mkdir -p /path/to/your-app/src/vendor/identity-protocol/api
cp -R /tmp/identity-api/packages/protocol/src/api/ /path/to/your-app/src/vendor/identity-protocol/api/
```

### Step 3 — Rewrite the cross-package imports

The vendored SDK imports `@freeside-auth/protocol/api`. Inside your tree,
rewrite those to a relative path:

```bash
# from your-app root
find src/vendor/identity-client -name "*.ts" -exec sed -i.bak \
  's|@freeside-auth/protocol/api|../identity-protocol/api|g' {} \;
find src/vendor/identity-client -name "*.bak" -delete
```

Or if your tsconfig has path aliases, point `@0xhoneyjar/identity/protocol`
at `src/vendor/identity-protocol/api` and leave the SDK source untouched
modulo the alias.

### Step 4 — Pin the source commit in your consumer

Record the upstream SHA so re-vendoring is a known-state operation:

```bash
# your-app/src/vendor/identity-client/VENDOR.md
cat <<EOF > /path/to/your-app/src/vendor/identity-client/VENDOR.md
Upstream: https://github.com/0xHoneyJar/identity-api
Commit:   <the SHA from step 1>
Vendored: $(date -u +"%Y-%m-%dT%H:%M:%SZ")
Path:     packages/sdk/src/
Modifications: import-rewrite (@freeside-auth/protocol/api → relative)
EOF
```

### Step 5 — Import from your local path

```ts
// your-app/src/auth/identityClient.ts
import { createIdentityClient } from "@/vendor/identity-client"

export const identity = createIdentityClient({
  baseUrl: process.env.IDENTITY_API_URL!,
  jwt: () => sessionStore.getAccessToken(),
})
```

### Step 6 — Schedule a re-vendor cadence

Re-vendor on a monthly cadence OR when the upstream releases a
breaking-change tag. The flow:

```bash
# Fetch upstream
git -C /tmp/identity-api fetch
git -C /tmp/identity-api log --oneline <pinned-sha>..origin/main -- packages/sdk packages/protocol/src/api

# If nothing has changed in those paths, you're up to date.
# Otherwise, repeat steps 2-4 with the new SHA and review the diff:
git -C /tmp/identity-api diff <pinned-sha>..origin/main -- packages/sdk packages/protocol/src/api
```

The diff is the entire change surface — review it before adopting.

## API surface

```ts
import {
  createIdentityClient,
  UnauthorizedError,
  ConflictError,
  ValidationError,
  NotImplementedError,
  NetworkError,
  IdentityApiError,
} from "@/vendor/identity-client"

const client = createIdentityClient({
  baseUrl: "https://identity-api.fly.dev",
  jwt: () => myStore.getJwt(),         // optional; required for me()
  defaultHeaders: { "x-app-id": "honey-road" },
  fetch: customFetch,                   // optional; default = globalThis.fetch
})
```

### Auth (FR-A1, FR-A2)

```ts
// Step 1: ask for a challenge for a wallet
const challenge = await client.auth.challenge({
  walletAddress: "0xabc...",
  scheme: "siwe",                       // optional, defaults to "siwe"
  // SIWE EIP-4361 surface (optional):
  domain: "honey-road.app",
  uri: "https://honey-road.app",
  chainId: 1,
  statement: "Sign in to honey-road",
})
// → { nonce: "abc…", message: "honey-road.app wants you to sign in…", expires_at: "2026-…" }

// Step 2: have the wallet sign challenge.message off-line, then submit:
const signature = await wallet.signMessage(challenge.message)
const verified = await client.auth.verify({
  nonce: challenge.nonce,
  signature,
  walletAddress: "0xabc...",
  scheme: "siwe",
})
// → { user_id: "uuid…", primary_wallet: "0xabc…", session: { token: "jwt…", expires_at: 1234567890 } }
// Side-effects on the wire: Set-Cookie for idapi_sess + csrf (encrypted-cookie session).
```

### Self-view / resolve / identity (FR-A3 + FR-R1..R4)

```ts
// requires `jwt:` configured on the client
const me = await client.me()
// → IdentityResp: { user_id, primary_wallet, wallets[], linked_accounts[], world_identities[] }

// Spine reads — 404 → null (the routine-negative-answer convention)
const user = await client.identity.get(userId)         // IdentityResp | null
const hit  = await client.resolve.byWallet("0xabc")    // { user_id } | null
const acct = await client.resolve.byAccount("discord", "disc-123")
const nym  = await client.resolve.byNym("mibera", "fullshape")
```

### Profile + Mibera (FR-P1, FR-M1, T2.3 / T3.2 stubs)

```ts
// Both of these throw NotImplementedError(501) until their tasks land.
// The typed surface is available TODAY so you can write the call site.
try {
  const profile = await client.profile.get({ world: "mibera", userId })
} catch (e) {
  if (e instanceof NotImplementedError) {
    // expected until T2.3 lands; render the placeholder
  } else throw e
}

const dims = await client.mibera.dimensions({ wallet: "0xabc" })
// T3.2 will populate the per-token 7-dim profile (archetype/ancestor/element/
// tarot/era/molecule/swag + grail).
```

### Service-to-service link (FR-C1, T4.1 stub)

```ts
// Used by Sietch's verify completion path (cycle-c redirect).
const linked = await client.link.verifiedWallet(
  {
    worldSlug: "mibera",
    discordId: "disc-123",
    walletAddress: "0xabc...",
    dynamicUserId: "dyn-456",            // optional backfill
  },
  { serviceToken: process.env.IDENTITY_S2S_TOKEN! },  // required
)
```

## Error handling

Every method throws a subclass of `IdentityApiError` (or `NetworkError`,
which also IS-A `IdentityApiError` so the catch-all works):

```
IdentityApiError                   (base; HTTP 4xx/5xx with envelope)
  ├── UnauthorizedError            (401: invalid_nonce, signature_invalid, …)
  ├── ConflictError                (409: cross_user_collision, …)
  ├── ValidationError              (400: malformed input — usually means
  │                                  the SDK is out of sync with the server)
  ├── NotImplementedError          (501: stub awaiting T2.3 / T3.2 / T4.1)
  └── (other 4xx/5xx fall through as bare IdentityApiError)

NetworkError                        (no response: DNS / socket / abort)
```

Catch-block discipline:

```ts
try {
  const verified = await client.auth.verify({...})
} catch (e) {
  if (e instanceof UnauthorizedError) {
    // switch on e.code: "invalid_nonce" / "nonce_replayed" / "signature_invalid" / etc.
    return promptResign(e.code)
  }
  if (e instanceof ConflictError) {
    return showConflictHelp(e.code)
  }
  if (e instanceof NetworkError) {
    return retryWithBackoff()
  }
  throw e   // genuine 5xx; let it bubble
}
```

Every error carries:

- `e.status`         — HTTP status code (0 for `NetworkError`)
- `e.code`           — machine-readable code from the server envelope (e.g. `"invalid_nonce"`)
- `e.message`        — human-readable sentence (NEVER branch on this — branch on `code`)
- `e.requestId`      — server-side `x-request-id` for cross-log correlation
- `e.envelope`       — the full parsed server envelope (`{error, code, message, details?, …}`)
- `e.rawBody`        — raw text body when JSON parse failed (rare 5xx case)

## Type-safety guarantees

The SDK's typing pulls from the same Zod schemas the server validates against
(`@freeside-auth/protocol/api`). Concretely:

- Per-route input/output types are `z.input<typeof Schema>` /
  `z.infer<typeof Schema>` — the consumer's `tsc` produces full
  autocomplete + compile-time errors on shape mismatch.
- The `scheme` enum admits ONLY `"siwe" | "eip191"` — the typed surface
  refuses `"dynamic_user_id"` at compile time (FR-A4 quarantine enforced
  at the boundary).
- Optional fields with `.default()` are optional on the caller side
  (`client.auth.challenge({ walletAddress })` compiles — the server fills
  `scheme: "siwe"` server-side). Advanced consumers who need the
  post-validate shape can import `*ReqValidated` types.
- 404 reads return `null` not throwing — the SDK's resolve/identity
  methods return `Hit | null` so the negative case is a value, not an
  exception.

Optional opt-in runtime validation:

```ts
import { IdentityRespSchema } from "@/vendor/identity-client"

const raw = await client.identity.get(userId)
if (raw) {
  const parsed = IdentityRespSchema.parse(raw)   // throws on schema drift
}
```

## Updating a vendored copy

When you re-vendor:

1. `git -C /tmp/identity-api log --oneline <old-sha>..origin/main -- packages/sdk packages/protocol/src/api` — list changes
2. Review the diff: `git -C /tmp/identity-api diff <old-sha>..origin/main -- packages/sdk packages/protocol/src/api`
3. Repeat steps 2-4 from the vendoring section with the new SHA
4. Run your app's full test suite — the typed surface catches most
   breakages at compile time, but runtime contracts (cookie names,
   header names) need integration coverage

The risk profile of a vendored update is **bounded**: you control when it
happens, what changes, and you can `git revert` your vendored-copy commit
without affecting upstream.

## Deferred work

- **profile.get** (`/v1/profile`) — 501 until T2.3 (bead `arrakis-eqxj`). Once
  T2.3 lands, the SDK surface is unchanged; the response inflates from
  `z.unknown()`-loose to a tight per-source-compose shape. Re-vendor at
  that point.
- **mibera.dimensions** (`/v1/mibera/dimensions`) — 501 until T3.2 (bead
  `arrakis-g407`). Same pattern: response shape tightens.
- **link.verifiedWallet** (`/v1/link/verified-wallet`) — 501 until T4.1
  (bead `arrakis-hyde`). The `serviceToken` mechanism is provisional —
  Sprint-1.x will codify the chosen header. Re-vendor at that point and
  the SDK call shape may change.
- **ES256 swap** (Sprint-1.1 #3 / FR-J2) — the SDK is agnostic to the
  signing algorithm (it never validates JWTs itself; the server signs +
  the server verifies on `/v1/me`). When the issuer swaps HS256 → ES256,
  the SDK does NOT change. Consumers verifying tokens themselves DO need
  the JWKS endpoint (`/.well-known/jwks.json`); the SDK does not provide
  a JWKS-fetching helper today (likely a separate vendored module).
- **Per-call JWT override** — the current `jwt:` is client-scoped. If a
  consumer wants per-call token (e.g., elevating to a service token for
  one call), they'd construct a second client. Add per-call override as
  a non-breaking SDK extension if real demand surfaces.

## License

MIT — same as the parent `identity-api` repo.
