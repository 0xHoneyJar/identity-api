/**
 * createIdentityClient — the typed factory for @freeside-auth/identity-client.
 *
 * Returns a hierarchical client object whose every method has full
 * compile-time typing derived from the SAME Zod schemas the server uses
 * to validate requests (`@freeside-auth/protocol/api`). No codegen step;
 * the types flow through `z.infer<>` at the consumer's tsc pass.
 *
 * Surface (mirrors PRD §4 functional requirements):
 *
 *   const client = createIdentityClient({ baseUrl: "..." })
 *
 *   // auth (FR-A1, FR-A2)
 *   await client.auth.challenge({ walletAddress, scheme })       → ChallengeResp
 *   await client.auth.verify({ nonce, signature, walletAddress, scheme }) → VerifyResp
 *
 *   // me / resolve / identity (FR-A3, FR-R1..R4)
 *   await client.me()                            → IdentityResp     (requires JWT)
 *   await client.identity.get(userId)            → IdentityResp | null
 *   await client.resolve.byWallet(address)       → { user_id } | null
 *   await client.resolve.byAccount(p, eid)       → { user_id } | null
 *   await client.resolve.byNym(slug, nym)        → { user_id } | null
 *
 *   // stub surface (typed today; 501 at runtime until the task lands)
 *   await client.profile.get({ world, ... })         → ProfileResp        (T2.3)
 *   await client.mibera.dimensions({ ... })          → MiberaDimensionsResp (T3.2)
 *   await client.link.verifiedWallet({ ... }, opts)  → LinkVerifiedWalletResp (T4.1)
 *
 * Error handling: every method throws a subclass of `IdentityApiError`
 * (or `NetworkError`) on failure. The three resolve.* methods translate
 * 404 → `null` (so callers don't have to catch for the negative case);
 * every other 4xx/5xx propagates the typed error. See errors.ts for the
 * full hierarchy.
 *
 * Per PRD §11: this is NOT an npm package. Consumers vendor `packages/sdk/`
 * AS SOURCE into their tree (shadcn-style `add`). See README.md §Vendoring.
 */

import { createTransport, type FetchLike, type JwtResolver, type Transport } from "./transport"
import type {
  ChallengeReq,
  ChallengeResp,
  IdentityResp,
  LinkVerifiedWalletReq,
  LinkVerifiedWalletResp,
  LinkWalletOnlyReq,
  LinkWalletOnlyResp,
  MiberaDimensionsQuery,
  MiberaDimensionsResp,
  ProfileQuery,
  ProfileResp,
  ResolveHitResp,
  ResolveProvider,
  VerifyReq,
  VerifyResp,
} from "@freeside-auth/protocol/api"

// ─── client construction options ───────────────────────────────────────────

export interface CreateIdentityClientOpts {
  /** Base URL of the identity-api deployment (e.g. https://identity-api.fly.dev). */
  readonly baseUrl: string
  /** Override fetch (default: `globalThis.fetch`). Useful for tests + edge runtimes. */
  readonly fetch?: FetchLike
  /** Default headers merged into every request. */
  readonly defaultHeaders?: Record<string, string>
  /**
   * Bearer JWT, or a getter returning one. Applied as `Authorization: Bearer <token>`
   * on every authenticated request (`me()`, future `profile.get()` with auth, etc.).
   *
   * Pass a getter (not a string) when your token rotates — the SDK calls
   * the getter on every request so the freshest token wins.
   */
  readonly jwt?: JwtResolver
  /**
   * Override the bearer header. Default: "authorization".
   *
   * Most callers will NOT touch this; provided for unusual edge deployments
   * (some reverse proxies strip "authorization" and use a custom header).
   */
  readonly authHeader?: string
}

// ─── per-call options (rare; only `link.verifiedWallet` exposes them) ──────

export interface LinkVerifiedWalletOpts {
  /**
   * Service-to-service token. Required for `link.verifiedWallet` because the
   * endpoint is S2S (NOT user-session) per SDD §5.5 — Sietch calls it from
   * its verify completion path. The header name + value are caller-supplied
   * because Sprint-1.x will codify the chosen mechanism; the SDK keeps it
   * flexible.
   */
  readonly serviceToken: string
  /** Header name. Default: "x-service-token". */
  readonly serviceTokenHeader?: string
}

/**
 * Per-call options for `link.walletOnly`. The wallet-only ingress uses the
 * SAME S2S `X-Service-Token` auth as `link.verifiedWallet` — distinct from the
 * end-user JWT. Aliased to the verified-wallet opts so the two S2S surfaces
 * stay in lockstep.
 */
export type LinkWalletOnlyOpts = LinkVerifiedWalletOpts

// ─── the typed client surface ──────────────────────────────────────────────

export interface IdentityClient {
  readonly auth: {
    challenge(input: ChallengeReq): Promise<ChallengeResp>
    verify(input: VerifyReq): Promise<VerifyResp>
  }
  /**
   * Self-view (the JWT bearer's identity). Returns the full Identity shape
   * per FR-A3 / SDD §5.2. Requires `jwt:` configured at client construction
   * (or per-call via the future per-call jwt override, not yet exposed).
   */
  me(): Promise<IdentityResp>
  readonly identity: {
    /**
     * Spine reader by user_id. 404 → null (returns the negative case as a
     * value, since "user not found" is a routine answer, not an exception).
     */
    get(userId: string): Promise<IdentityResp | null>
  }
  readonly resolve: {
    /** FR-R1. 404 → null. */
    byWallet(address: string): Promise<ResolveHitResp | null>
    /** FR-R2. 404 → null. */
    byAccount(provider: ResolveProvider, externalId: string): Promise<ResolveHitResp | null>
    /** FR-R3. 404 → null. */
    byNym(worldSlug: string, nym: string): Promise<ResolveHitResp | null>
  }
  readonly profile: {
    /**
     * FR-P1. 501 today (NotImplementedError); typed surface remains for
     * forward-compat — callers writing this code today get the same compile
     * errors they'll get once T2.3 lands.
     */
    get(query: ProfileQuery): Promise<ProfileResp>
  }
  readonly mibera: {
    /**
     * FR-M1 / G-6 headline (honey-road slice). 501 today; T3.2 implements.
     */
    dimensions(query: MiberaDimensionsQuery): Promise<MiberaDimensionsResp>
  }
  readonly link: {
    /**
     * FR-C1 cycle-c redirect ingress. S2S — pass the service token at call
     * time, not at client construction (a single SDK consumer typically only
     * uses this endpoint, but its credentials are distinct from the
     * end-user-facing JWT). 501 today; T4.1 implements.
     */
    verifiedWallet(input: LinkVerifiedWalletReq, opts: LinkVerifiedWalletOpts): Promise<LinkVerifiedWalletResp>
    /**
     * Wallet-only ingress (Sprint B part 1). The sibling of `verifiedWallet`
     * for users with NO discord — mints the world name. Same S2S service
     * token. New wallet → 200 with `generated_name` set; known wallet → 200
     * `idempotent: true` with `generated_name` = the user's existing handle,
     * or a freshly-claimed handle when the user had no world name yet
     * (claims-if-missing, #39); null only when the user holds world names but
     * none of type `generated`. No 409 on this path.
     */
    walletOnly(input: LinkWalletOnlyReq, opts: LinkWalletOnlyOpts): Promise<LinkWalletOnlyResp>
  }
}

// ─── the factory ───────────────────────────────────────────────────────────

export function createIdentityClient(opts: CreateIdentityClientOpts): IdentityClient {
  const transport: Transport = createTransport({
    baseUrl: opts.baseUrl,
    fetch: opts.fetch,
    defaultHeaders: opts.defaultHeaders,
    jwt: opts.jwt,
    authHeader: opts.authHeader,
  })

  return {
    auth: {
      async challenge(input: ChallengeReq): Promise<ChallengeResp> {
        return transport.request<ChallengeResp>({
          method: "POST",
          path: "/v1/auth/challenge",
          body: input,
        })
      },
      async verify(input: VerifyReq): Promise<VerifyResp> {
        return transport.request<VerifyResp>({
          method: "POST",
          path: "/v1/auth/verify",
          body: input,
        })
      },
    },

    async me(): Promise<IdentityResp> {
      return transport.request<IdentityResp>({
        method: "GET",
        path: "/v1/me",
        requireAuth: true,
      })
    },

    identity: {
      async get(userId: string): Promise<IdentityResp | null> {
        return resolveOrNull(
          transport.request<IdentityResp>({
            method: "GET",
            path: "/v1/identity/:userId",
            pathParams: { userId },
          }),
        )
      },
    },

    resolve: {
      async byWallet(address: string): Promise<ResolveHitResp | null> {
        return resolveOrNull(
          transport.request<ResolveHitResp>({
            method: "GET",
            path: "/v1/resolve/wallet/:address",
            pathParams: { address },
          }),
        )
      },
      async byAccount(provider: ResolveProvider, externalId: string): Promise<ResolveHitResp | null> {
        return resolveOrNull(
          transport.request<ResolveHitResp>({
            method: "GET",
            path: "/v1/resolve/account/:provider/:externalId",
            pathParams: { provider, externalId },
          }),
        )
      },
      async byNym(worldSlug: string, nym: string): Promise<ResolveHitResp | null> {
        return resolveOrNull(
          transport.request<ResolveHitResp>({
            method: "GET",
            path: "/v1/resolve/nym/:worldSlug/:nym",
            pathParams: { worldSlug, nym },
          }),
        )
      },
    },

    profile: {
      async get(query: ProfileQuery): Promise<ProfileResp> {
        return transport.request<ProfileResp>({
          method: "GET",
          path: "/v1/profile",
          query: {
            world: query.world,
            userId: query.userId,
            wallet: query.wallet,
          },
        })
      },
    },

    mibera: {
      async dimensions(query: MiberaDimensionsQuery): Promise<MiberaDimensionsResp> {
        return transport.request<MiberaDimensionsResp>({
          method: "GET",
          path: "/v1/mibera/dimensions",
          query: {
            userId: query.userId,
            wallet: query.wallet,
          },
        })
      },
    },

    link: {
      async verifiedWallet(
        input: LinkVerifiedWalletReq,
        callOpts: LinkVerifiedWalletOpts,
      ): Promise<LinkVerifiedWalletResp> {
        const headerName = (callOpts.serviceTokenHeader ?? "x-service-token").toLowerCase()
        return transport.request<LinkVerifiedWalletResp>({
          method: "POST",
          path: "/v1/link/verified-wallet",
          body: input,
          headers: { [headerName]: callOpts.serviceToken },
        })
      },
      async walletOnly(
        input: LinkWalletOnlyReq,
        callOpts: LinkWalletOnlyOpts,
      ): Promise<LinkWalletOnlyResp> {
        const headerName = (callOpts.serviceTokenHeader ?? "x-service-token").toLowerCase()
        return transport.request<LinkWalletOnlyResp>({
          method: "POST",
          path: "/v1/link/wallet-only",
          body: input,
          headers: { [headerName]: callOpts.serviceToken },
        })
      },
    },
  }
}

/**
 * Translate a 404 into `null` — the SDK convention for `resolve.*` +
 * `identity.get`. Other errors propagate.
 *
 * Why this pattern: "user not found" is a ROUTINE answer for spine reads;
 * forcing every caller to wrap `try/catch` for 404 would be hostile. Other
 * 4xx (400 malformed input, 401 wrong auth) and 5xx (server error) are
 * NOT routine and propagate.
 */
async function resolveOrNull<T>(p: Promise<T>): Promise<T | null> {
  try {
    return await p
  } catch (e) {
    // Use a string-name check to avoid coupling this helper to the errors
    // module's class identity (helps when consumers vendor a renamed copy).
    if (e && typeof e === "object" && "status" in e && (e as { status: number }).status === 404) {
      return null
    }
    throw e
  }
}
