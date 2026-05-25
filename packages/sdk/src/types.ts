/**
 * Re-exports of the typed request/response shapes for @freeside-auth/identity-client.
 *
 * Single source of truth: the Zod schemas in `@freeside-auth/protocol/api`.
 * The SDK derives TS types via `z.infer<>` — when the server's schemas
 * evolve (next sprint, next breaking change), the SDK types follow
 * automatically the next time the consumer re-vendors. NO drift surface.
 *
 * Per the vendoring contract (README.md §Vendoring): consumers copy this
 * entire `packages/sdk/src/` tree into their app. The protocol/api
 * imports below become relative paths in the vendored copy (the README
 * documents the renaming script). The TYPES, by Zod's inference, follow
 * along with no manual surgery.
 */

// ─── auth surface (FR-A1 / FR-A2) ───────────────────────────────────────────
export type {
  ChallengeReq,
  ChallengeResp,
  VerifyReq,
  VerifyResp,
} from "@freeside-auth/protocol/api"

// ─── resolve + identity (FR-R1..R4 + FR-A3) ─────────────────────────────────
export type {
  ResolveProvider,
  ResolveHitResp,
  IdentityWallet,
  IdentityLinkedAccount,
  IdentityWorldIdentity,
  IdentityResp,
} from "@freeside-auth/protocol/api"

// ─── profile + mibera (FR-P1 + FR-M1, T2.3 / T3.2 stubs) ────────────────────
export type {
  ProfileQuery,
  ProfileResp,
  MiberaDimensionsQuery,
  MiberaDimensionsResp,
} from "@freeside-auth/protocol/api"

// ─── link (FR-C1, T4.1 stub) ────────────────────────────────────────────────
export type {
  LinkVerifiedWalletReq,
  LinkVerifiedWalletResp,
} from "@freeside-auth/protocol/api"

// ─── runtime schemas (also re-exported, for callers who want Zod parse) ─────
//
// Use case: `client.identity.get(userId)` returns a typed `IdentityResp`
// by default (no runtime parse). For consumers who want defense-in-depth
// against a server-side schema drift, they can opt in:
//
//   import { IdentityRespSchema } from "@freeside-auth/identity-client";
//   const raw = await client.identity.get(userId);
//   const parsed = IdentityRespSchema.parse(raw); // throws on shape drift
//
// The SDK does NOT parse responses by default because (a) it adds latency,
// (b) honest server behavior never violates the schema, and (c) the type
// system already enforces compile-time conformity. Opt-in only.

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
} from "@freeside-auth/protocol/api"
