/**
 * @freeside-auth/identity-client (vendored as @0xhoneyjar/identity downstream)
 *
 * Source-distributed typed HTTP client for identity-api. See README.md for
 * vendoring instructions; this package is NOT published to npm (PRD v3.0
 * §11 post-verify lock-in — sovereignty + supply-chain shrinkage).
 *
 * Surface:
 *
 *   import { createIdentityClient } from "@freeside-auth/identity-client";
 *
 *   const client = createIdentityClient({
 *     // Production target: Railway-hosted (PRD v3.0 §3 D4 — single-instance,
 *     // Hyper-backed). The canonical subdomain is `identity.{org-tld}` (no
 *     // `-api` segment). For 0xHoneyJar deployment this is
 *     // `https://identity.0xhoneyjar.xyz` — verified live 2026-05-26
 *     // (Railway custom domain + AWS Route53 CNAME → 74s1e7bu.up.railway.app).
 *     baseUrl: process.env.IDENTITY_API_URL ?? "https://identity.0xhoneyjar.xyz",
 *     jwt: () => myAuthStore.getAccessToken(),
 *   });
 *
 *   const ch  = await client.auth.challenge({ walletAddress, scheme: "siwe" });
 *   const v   = await client.auth.verify({ nonce: ch.nonce, signature, walletAddress, scheme: "siwe" });
 *   const me  = await client.me();
 *   const u   = await client.resolve.byWallet(walletAddress);   // null on 404
 *
 *   // typed errors:
 *   try { await client.auth.verify({...}); }
 *   catch (e) {
 *     if (e instanceof UnauthorizedError) { /* re-prompt *\/ }
 *     if (e instanceof NetworkError)      { /* retry *\/ }
 *   }
 */

export { createIdentityClient } from "./client"
export type {
  IdentityClient,
  CreateIdentityClientOpts,
  LinkVerifiedWalletOpts,
} from "./client"

// Errors — re-exported at the top level so consumers can use them
// in catch blocks without diving into subpaths.
export {
  IdentityApiError,
  UnauthorizedError,
  ConflictError,
  ValidationError,
  NotImplementedError,
  NetworkError,
  type ServerErrorEnvelope,
} from "./errors"

// Types + (opt-in) runtime Zod schemas. Most callers only need the types;
// the schemas are available for consumers who want client-side response
// validation as defense-in-depth against server schema drift.
export type {
  ChallengeReq,
  ChallengeReqValidated,
  ChallengeResp,
  VerifyReq,
  VerifyReqValidated,
  VerifyResp,
  ResolveProvider,
  ResolveHitResp,
  IdentityWallet,
  IdentityLinkedAccount,
  IdentityWorldIdentity,
  IdentityResp,
  ProfileQuery,
  ProfileResp,
  MiberaDimensionsQuery,
  MiberaDimensionsResp,
  LinkVerifiedWalletReq,
  LinkVerifiedWalletResp,
} from "./types"

export {
  ChallengeReqSchema,
  ChallengeRespSchema,
  VerifyReqSchema,
  VerifyRespSchema,
  WalletAddressParamSchema,
  ProviderParamSchema,
  ExternalIdParamSchema,
  WorldSlugParamSchema,
  NymParamSchema,
  UserIdParamSchema,
  ResolveHitRespSchema,
  IdentityRespSchema,
  ProfileQuerySchema,
  ProfileRespSchema,
  MiberaDimensionsQuerySchema,
  MiberaDimensionsRespSchema,
  LinkVerifiedWalletReqSchema,
  LinkVerifiedWalletRespSchema,
} from "./types"

// Transport — exported for advanced callers who want to layer middleware
// (e.g. wrap with retries, logging, OTel) BEFORE the high-level client.
// Most users don't need this; createIdentityClient(...) is the canonical
// entry point.
export {
  createTransport,
  type FetchLike,
  type JwtResolver,
  type Transport,
  type TransportOpts,
  type TransportRequestOpts,
} from "./transport"
