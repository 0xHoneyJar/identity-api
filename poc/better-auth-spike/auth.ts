// bd-3n1.3 — Better Auth instance proving the PERSON layer for the cluster.
//
// Claims under test (from the verdict POC):
//   1. `user` + multi-`account`-per-user IS the wallet-group.
//   2. SIWE drives wallet auth.
//   3. A per-world JWT can carry a tenant/world claim.
//
// Adapter: Drizzle over better-sqlite3 (zero-infra). Postgres is a swap:
//   provider: "sqlite" -> "pg", and db handle -> drizzle(pgPool). Nothing else
//   in this file changes.
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { siwe } from "better-auth/plugins/siwe";
import { jwt } from "better-auth/plugins/jwt";
import { organization } from "better-auth/plugins/organization";
import { bearer } from "better-auth/plugins/bearer";
import { randomBytes } from "node:crypto";
import { verifyMessage as viemVerifyMessage } from "viem";
import { db } from "./db";

// Berachain mainnet. The SIWE plugin DEFAULTS chainId to 1 (Ethereum); the
// per-request chainId flows through to `verifyMessage` below, so a wallet can
// sign for 80094 and we verify it the same way. EIP-191 personal_sign is
// chain-agnostic at the signature level — chainId is a claim INSIDE the SIWE
// message, not part of the signature curve — so viem.verifyMessage works for
// any chainId. (EIP-1271 contract wallets would need a per-chain RPC; EOAs
// like our viem test wallet do not.)
export const BERACHAIN_ID = 80094;

export const auth = betterAuth({
  // In-memory secret is fine for a spike; production reads from env.
  secret: "spike-only-secret-not-for-production-bd3n1p3",
  baseURL: "http://localhost:3000",

  database: drizzleAdapter(db, {
    provider: "sqlite",
    // We pass our generated Drizzle schema so the adapter maps model->table.
    schema: require("./schema"),
  }),

  // A per-world claim needs a home on the user row. `activeWorld` is the
  // world/tenant the session is currently scoped to. This is the field that
  // flows into the JWT via jwt.definePayload below.
  user: {
    additionalFields: {
      activeWorld: {
        type: "string",
        required: false,
        input: true,
      },
    },
  },

  plugins: [
    siwe({
      domain: "localhost:3000",
      // Server-generated nonce. Production would persist+expire these; for the
      // spike we mint a random hex nonce. Better Auth stores it in the
      // `verification` table keyed by wallet, and checks it at /siwe/verify.
      getNonce: async () => randomBytes(16).toString("hex"),
      // THE verify hook. Better Auth hands us {message, signature, address,
      // chainId}; we delegate to viem. This is exactly where Berachain (80094)
      // support lives — no special-casing needed for EOAs.
      verifyMessage: async ({ message, signature, address }) => {
        try {
          return await viemVerifyMessage({
            address: address as `0x${string}`,
            message,
            signature: signature as `0x${string}`,
          });
        } catch (e) {
          console.error("[siwe.verifyMessage] viem verify threw:", e);
          return false;
        }
      },
    }),

    // Per-world JWT. EdDSA/Ed25519 by default; /jwks exposes the public key.
    jwt({
      jwt: {
        issuer: "http://localhost:3000",
        audience: "freeside-cluster",
        expirationTime: "15m",
        // THE per-world claim mechanism. We read the user's activeWorld and
        // stamp it into the JWT payload as `world` + `tenant`. A downstream
        // building reads jwt.world to scope authorization to that world.
        definePayload: ({ user }) => ({
          world: (user as any).activeWorld ?? null,
          tenant: (user as any).activeWorld ?? null,
          wallet_group_user_id: user.id,
        }),
      },
    }),

    // Organization plugin models multi-world membership (the OTHER way to carry
    // a world claim: organization = world, membership = which worlds a person
    // belongs to). Demoed alongside the custom-claim path.
    organization(),

    // Bearer lets us replay the session token as `Authorization: Bearer <token>`
    // in a server-side call (avoids reconstructing the signed session cookie).
    bearer(),
  ],
});

export type Auth = typeof auth;
