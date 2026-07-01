/**
 * GET /.well-known/jwks.json — public JWKS document (identity-api#29).
 *
 * Publishes svc-class ES256 public keys from env (`SVC_JWT_SIGNING_KEY_*`).
 * User-class keys land in the same document when provisioned (forward-track).
 */

import { jsonResponse } from "@hyper/core"
import { buildJwksDocumentFromEnv } from "@freeside-auth/adapters"
import { route } from "../../auth"

export const wellKnownJwks = route
  .get("/.well-known/jwks.json")
  .meta({
    summary: "JSON Web Key Set for svc-JWT verification",
    mcp: {
      title: "JWKS",
      description: "Returns the public keys used to verify identity-api issued svc-JWTs.",
    },
  })
  .handle(async () => {
    const document = await buildJwksDocumentFromEnv()
    return jsonResponse(200, document, {
      headers: { "cache-control": "public, max-age=3600" },
    })
  })
