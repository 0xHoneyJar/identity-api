// bd-3n1.3 — RUNNABLE PROOF. Boots the Better Auth instance and exercises the
// full flow against a live (SQLite) DB. Run: bun run demo.ts
//
// Proves (or disproves) the three verdict-POC claims with real output:
//   1. SIWE login creates user + account.
//   2. account x N under user x 1 IS the wallet-group.
//   3. A per-world JWT can carry a tenant/world claim.
import { auth, BERACHAIN_ID } from "./auth";
import { sqlite } from "./db";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { SiweMessage } from "siwe";
import { decodeJwt } from "jose";

const DOMAIN = "localhost:3000";
const ORIGIN = "http://localhost:3000";

function hr(label: string) {
  console.log("\n" + "=".repeat(72) + "\n" + label + "\n" + "=".repeat(72));
}

// Build + sign a SIWE message with a viem EOA. Returns the exact message bytes
// + signature that better-auth's verifyMessage hook will check via viem.
async function siweSign(
  pk: `0x${string}`,
  nonce: string,
  chainId: number,
) {
  const account = privateKeyToAccount(pk);
  const msg = new SiweMessage({
    domain: DOMAIN,
    address: account.address, // EIP-55 checksummed by viem
    statement: "Sign in to the Freeside cluster.",
    uri: ORIGIN,
    version: "1",
    chainId,
    nonce,
    issuedAt: new Date().toISOString(),
  }).prepareMessage();

  // EIP-191 personal_sign — local signing, NO RPC needed (the account object
  // from privateKeyToAccount signs offline). Chain-agnostic at the sig layer.
  const signature = await account.signMessage({ message: msg });
  return { address: account.address, message: msg, signature };
}

// Full SIWE login: nonce -> sign -> verify. Returns the verify result + the
// Set-Cookie header (so we can replay the session into the JWT call).
async function siweLogin(pk: `0x${string}`, chainId: number) {
  const account = privateKeyToAccount(pk);
  // 1. getNonce(walletAddress) — better-auth mints + stores it keyed by addr:chain
  const { nonce } = await auth.api.getSiweNonce({
    body: { walletAddress: account.address, chainId },
  });
  // 2. build + 3. sign
  const { address, message, signature } = await siweSign(pk, nonce, chainId);
  // 4. verify -> session.
  // FRICTION: /siwe/verify has requireRequest:true — the server-side auth.api
  // call MUST carry a `request` (and headers) or it 400s "Request is required".
  // FRICTION: `returnHeaders:true` returned an empty body for us; `asResponse:true`
  // gives the clean Response (status + JSON body + Set-Cookie). We use that.
  const res = (await auth.api.verifySiweMessage({
    body: { walletAddress: address, message, signature, chainId },
    request: new Request(ORIGIN + "/api/auth/siwe/verify", { method: "POST" }),
    headers: new Headers(),
    asResponse: true,
  })) as Response;
  const response = await res.json();
  const setCookie = res.headers.get("set-cookie");
  return { nonce, address, message, signature, response, status: res.status, setCookie };
}

// ---- DB query helpers (raw SQL so the proof is engine-level, not ORM-level) ----
const q = (sql: string, ...args: any[]) => sqlite.query(sql).all(...args);

async function main() {
  hr("BOOT — Better Auth instance");
  console.log("better-auth: 1.6.13 | runtime: bun " + Bun.version + " (bun:sqlite)");
  console.log("plugins:", auth.options.plugins?.map((p: any) => p.id).join(", "));
  console.log(
    "auth.api endpoints (subset):",
    ["getSiweNonce", "verifySiweMessage", "getToken", "getJwks", "verifyJWT", "createOrganization", "setActiveOrganization"]
      .filter((k) => k in auth.api)
      .join(", "),
  );
  console.log("DB tables:", q("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").map((r: any) => r.name).join(", "));

  // Two throwaway test wallets.
  const pk1 = generatePrivateKey();
  const pk2 = generatePrivateKey();
  const addr1 = privateKeyToAccount(pk1).address;
  const addr2 = privateKeyToAccount(pk2).address;
  console.log("\ntest wallet #1:", addr1);
  console.log("test wallet #2:", addr2);

  // =====================================================================
  hr("STEP 1 — SIWE login (wallet #1)");
  // =====================================================================
  const login1 = await siweLogin(pk1, 1); // chainId 1 = the SIWE plugin default
  console.log("getNonce ->", login1.nonce);
  console.log("SIWE message signed:\n---\n" + login1.message + "\n---");
  console.log("signature:", login1.signature.slice(0, 26) + "...");
  console.log("verify HTTP status:", login1.status);
  console.log("verify result:", JSON.stringify(login1.response, null, 2));
  const sessionToken1 = (login1.response as any).token as string;
  // The signed session cookie (token.signature) — replayed into later calls.
  const cookie1 = (login1.setCookie ?? "").split(";")[0];
  console.log("session cookie (for replay):", cookie1.slice(0, 60) + "...");

  const users1 = q("SELECT id, name, email, activeWorld FROM user");
  const accounts1 = q("SELECT id, userId, providerId, accountId FROM account");
  const wallets1 = q('SELECT userId, address, chainId, isPrimary FROM walletAddress');
  console.log("\nuser rows:", JSON.stringify(users1, null, 2));
  console.log("account rows:", JSON.stringify(accounts1, null, 2));
  console.log("walletAddress rows:", JSON.stringify(wallets1, null, 2));
  const userId = (users1[0] as any).id;
  console.log(`\n=> after wallet #1: ${users1.length} user, ${accounts1.length} account, ${wallets1.length} walletAddress`);

  // =====================================================================
  hr("STEP 2 — Wallet-group: link a 2nd wallet to the SAME user");
  // =====================================================================
  // FINDING: the SIWE plugin's /siwe/verify links a wallet to an EXISTING user
  // ONLY when that wallet address was seen before (same-address lookup). It does
  // NOT auto-merge two DIFFERENT wallets into the active session's user. So the
  // "link another wallet to my account" operation is APPLICATION-OWNED: the app
  // attaches a 2nd account + walletAddress row to the authenticated user via the
  // adapter. We demonstrate BOTH:
  //   (2a) the application-side link (different wallet -> same user) — THE claim.
  //   (2b) the plugin-native same-wallet-different-chain grouping (bonus).

  // ---- 2a: app-side link of wallet #2 to user #1 ----
  // First make wallet #2 sign (proving control) — same SIWE ceremony, but instead
  // of letting verify create a NEW user, the app binds it to the current user.
  const { address: a2, nonce: n2 } = await (async () => {
    const acct = privateKeyToAccount(pk2);
    const { nonce } = await auth.api.getSiweNonce({ body: { walletAddress: acct.address, chainId: 1 } });
    const signed = await siweSign(pk2, nonce, 1);
    // Verify the signature ourselves via the same viem path the plugin uses,
    // proving wallet #2 control, THEN link to user #1 (the app's "link" op).
    const { verifyMessage } = await import("viem");
    const ok = await verifyMessage({ address: signed.address as `0x${string}`, message: signed.message, signature: signed.signature as `0x${string}` });
    console.log("wallet #2 SIWE signature valid (viem):", ok);
    return { address: signed.address, nonce };
  })();

  // Use the better-auth adapter directly to attach the 2nd wallet to user #1.
  const ctx = await auth.$context;
  await ctx.adapter.create({
    model: "walletAddress",
    data: { userId, address: a2, chainId: 1, isPrimary: false, createdAt: new Date() },
  });
  await ctx.internalAdapter.createAccount({
    userId,
    providerId: "siwe",
    accountId: `${a2}:1`,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  console.log("linked wallet #2 to user #1 via adapter (account + walletAddress)");

  // ---- 2b: plugin-native grouping — wallet #1 signs again on Berachain ----
  // Same address, different chainId -> plugin finds the existing user by bare
  // address and attaches a NEW account+walletAddress WITHOUT a new user.
  const login1bera = await siweLogin(pk1, BERACHAIN_ID);
  console.log(`wallet #1 re-login on Berachain (chainId ${BERACHAIN_ID}) verify:`, JSON.stringify((login1bera.response as any), null, 2));

  // ---- THE LOAD-BEARING QUERY ----
  const groupAccounts = q(
    "SELECT a.id, a.userId, a.providerId, a.accountId FROM account a WHERE a.userId = ? ORDER BY a.accountId",
    userId,
  );
  const groupWallets = q(
    "SELECT userId, address, chainId, isPrimary FROM walletAddress WHERE userId = ? ORDER BY address, chainId",
    userId,
  );
  const userCount = q("SELECT COUNT(*) AS n FROM user") as any[];
  console.log("\n--- WALLET-GROUP PROOF ---");
  console.log("total user rows in DB:", userCount[0].n);
  console.log(`accounts under user ${userId}:`, JSON.stringify(groupAccounts, null, 2));
  console.log(`walletAddress rows under user ${userId}:`, JSON.stringify(groupWallets, null, 2));
  console.log(
    `\n=> ${(groupAccounts as any[]).length} account rows under ${userCount[0].n} user. ` +
      `WALLET-GROUP CLAIM: ${(groupAccounts as any[]).length >= 2 && userCount[0].n === 1 ? "HOLDS" : "DOES NOT HOLD"}`,
  );

  // =====================================================================
  hr("STEP 3 — Per-world JWT with a tenant/world claim");
  // =====================================================================
  // Set the user's activeWorld so definePayload stamps it into the JWT.
  await ctx.adapter.update({
    model: "user",
    where: [{ field: "id", operator: "eq", value: userId }],
    update: { activeWorld: "mibera" },
  });
  console.log("set user.activeWorld = 'mibera'");

  // Mint a JWT for the session. getToken uses sessionMiddleware; we replay the
  // signed session cookie from STEP 1.
  // FRICTION: the plain `auth.api.*` return wrapper yielded `{}` for getToken in
  // this server-side calling convention; `asResponse:true` returns the real
  // Response (status 200 + {token}). asResponse is the reliable pattern.
  const tokenRes = (await auth.api.getToken({
    headers: new Headers({ Cookie: cookie1 }),
    request: new Request(ORIGIN + "/api/auth/token", { method: "GET", headers: { Cookie: cookie1 } }),
    asResponse: true,
  })) as Response;
  const jwt = (await tokenRes.json()).token as string;
  console.log("getToken HTTP status:", tokenRes.status);
  console.log("issued JWT:", jwt.slice(0, 40) + "..." + jwt.slice(-12));

  const claims = decodeJwt(jwt);
  console.log("\nDECODED JWT CLAIMS:\n" + JSON.stringify(claims, null, 2));
  console.log("\n--- PER-WORLD CLAIM CHECK ---");
  console.log("world claim:", (claims as any).world);
  console.log("tenant claim:", (claims as any).tenant);
  console.log("sub (== user id / wallet-group id):", claims.sub);
  console.log("iss:", claims.iss, "| aud:", claims.aud);
  console.log(
    "PER-WORLD JWT CLAIM:",
    (claims as any).world === "mibera" ? "HOLDS (custom claim flows through definePayload)" : "DOES NOT HOLD",
  );

  // ---- organization path: world = organization ----
  console.log("\n--- organization-plugin path (world = organization) ---");
  const orgRes = (await auth.api.createOrganization({
    body: { name: "Mibera World", slug: "mibera" },
    headers: new Headers({ Cookie: cookie1 }),
    request: new Request(ORIGIN + "/api/auth/organization/create", { method: "POST", headers: { Cookie: cookie1 } }),
    asResponse: true,
  })) as Response;
  const org = await orgRes.json();
  console.log("createOrganization HTTP status:", orgRes.status);
  console.log("created organization:", JSON.stringify({ id: (org as any)?.id, slug: (org as any)?.slug, name: (org as any)?.name }, null, 2));
  const members = q("SELECT organizationId, userId, role FROM member");
  console.log("member rows:", JSON.stringify(members, null, 2));
  console.log(
    "=> a person can belong to N organizations (worlds); membership table = which worlds. " +
      "Both the custom `world` claim AND org membership are viable per-world mechanisms.",
  );

  // verify the JWT against the instance's JWKS (proves the signature is real)
  hr("BONUS — JWT signature verification against /jwks");
  const verified = await auth.api.verifyJWT({ body: { token: jwt } });
  const vpayload = (verified as any)?.payload ?? null;
  console.log("verifyJWT ->", vpayload ? "VALID signature, payload.sub=" + vpayload.sub + ", payload.world=" + vpayload.world : "INVALID");

  hr("DONE");
  sqlite.close();
}

main().catch((e) => {
  console.error("DEMO FAILED:", e);
  process.exit(1);
});
