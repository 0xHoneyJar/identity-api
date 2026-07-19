/**
 * User-session ES256 mint ↔ Hyper verifyJwt round-trip (D-JWT-001).
 */

import { afterEach, describe, expect, it } from "bun:test"
import {
  __generateTestEs256KeyMaterial,
  buildUserJwksDocumentFromEnv,
} from "@freeside-auth/adapters"
import { verifyJwt, type JWK } from "@hyper/auth-jwt"
import {
  __resetUserSessionSignerForTest,
  mintSessionJwt,
} from "../../jwt-mint"
import { JWT_SECRET } from "../../auth"

afterEach(() => {
  delete process.env.USER_JWT_SIGNING_KEY_PEM
  delete process.env.USER_JWT_SIGNING_KEY_KID
  __resetUserSessionSignerForTest()
})

describe("mintSessionJwt ES256", () => {
  it("mints ES256 when USER_JWT_SIGNING_KEY_* set and verifies via JWKS", async () => {
    const { pkcs8Pem } = await __generateTestEs256KeyMaterial()
    process.env.USER_JWT_SIGNING_KEY_PEM = pkcs8Pem
    process.env.USER_JWT_SIGNING_KEY_KID = "user-mint-test-a"
    __resetUserSessionSignerForTest()

    const session = await mintSessionJwt({
      sub: "11111111-1111-4111-8111-111111111111",
      primaryWallet: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    })

    expect(session.alg).toBe("ES256")
    expect(session.claims.sub).toBe("11111111-1111-4111-8111-111111111111")

    const userJwks = await buildUserJwksDocumentFromEnv()
    const { header, payload } = await verifyJwt(session.token, {
      algorithms: ["HS256", "ES256"],
      secret: JWT_SECRET,
      jwks: { keys: userJwks.keys as JWK[] },
    })

    expect(header.alg).toBe("ES256")
    expect(header.kid).toBe("user-mint-test-a")
    expect(payload.sub).toBe(session.claims.sub)
    expect(payload.iss).toBe("identity-api")
    expect(payload.aud).toBe("freeside")
  })

  it("falls back to HS256 when user keys unset (non-prod)", async () => {
    __resetUserSessionSignerForTest()
    const prev = process.env.NODE_ENV
    process.env.NODE_ENV = "development"
    try {
      const session = await mintSessionJwt({
        sub: "22222222-2222-4222-8222-222222222222",
        primaryWallet: null,
      })
      expect(session.alg).toBe("HS256")

      const { header, payload } = await verifyJwt(session.token, {
        algorithms: ["HS256", "ES256"],
        secret: JWT_SECRET,
        jwks: { keys: [] },
      })
      expect(header.alg).toBe("HS256")
      expect(payload.sub).toBe(session.claims.sub)
    } finally {
      if (prev === undefined) delete process.env.NODE_ENV
      else process.env.NODE_ENV = prev
    }
  })

  it("fails loud in production when user keys unset", async () => {
    __resetUserSessionSignerForTest()
    const prev = process.env.NODE_ENV
    process.env.NODE_ENV = "production"
    try {
      await expect(
        mintSessionJwt({
          sub: "33333333-3333-4333-8333-333333333333",
          primaryWallet: null,
        }),
      ).rejects.toThrow(/USER_JWT_SIGNING_KEY_PEM/)
    } finally {
      if (prev === undefined) delete process.env.NODE_ENV
      else process.env.NODE_ENV = prev
    }
  })
})
