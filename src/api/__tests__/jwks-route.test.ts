/**
 * jwks-route.test.ts — GET /.well-known/jwks.json (#29).
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import {
  __generateTestEs256KeyMaterial,
  exportSvcPublicJwk,
} from "@freeside-auth/adapters"
import app from "../index"

let baseUrl = ""

describe("JWKS route", () => {
  beforeAll(async () => {
    const { pkcs8Pem } = await __generateTestEs256KeyMaterial()
    process.env.SVC_JWT_SIGNING_KEY_PEM = pkcs8Pem
    process.env.SVC_JWT_SIGNING_KEY_KID = "svc-test-kid"
    app.listen({ port: 0, hostname: "127.0.0.1", banner: false })
    const port = app.server?.port
    if (!port) throw new Error("test boot: app.server.port unavailable")
    baseUrl = `http://127.0.0.1:${port}`
  })

  afterAll(async () => {
    delete process.env.SVC_JWT_SIGNING_KEY_PEM
    delete process.env.SVC_JWT_SIGNING_KEY_KID
    await app.stop()
  })

  it("returns active svc public key", async () => {
    const res = await fetch(`${baseUrl}/.well-known/jwks.json`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { keys?: Array<{ kid?: string; alg?: string }> }
    expect(body.keys?.length).toBe(1)
    expect(body.keys?.[0]?.kid).toBe("svc-test-kid")
    expect(body.keys?.[0]?.alg).toBe("ES256")
  })

  it("exportSvcPublicJwk matches route shape", async () => {
    const pem = process.env.SVC_JWT_SIGNING_KEY_PEM
    if (!pem) throw new Error("missing test pem")
    const jwk = await exportSvcPublicJwk(pem, "svc-test-kid")
    expect(jwk.use).toBe("sig")
    expect(jwk.kty).toBe("EC")
  })
})
