/**
 * GET /.well-known/jwks.json — public JWKS document (identity-api#29 · D-JWT-001).
 *
 * Publishes both kid-prefix planes from env:
 *   - user-*: USER_JWT_SIGNING_KEY_* (user-session verification)
 *   - svc-*:  SVC_JWT_SIGNING_KEY_*  (svc-JWT / cell verification)
 *
 * Planes are operationally independent — rotating one does not affect the other.
 */

import { jsonResponse } from "@hyper/core"
import { buildJwksDocumentFromEnv } from "@freeside-auth/adapters"
import { route } from "../../auth"

export const wellKnownJwks = route
  .get("/.well-known/jwks.json")
  .meta({
    summary: "JSON Web Key Set for user-session and svc-JWT verification",
    mcp: {
      title: "JWKS",
      description:
        "Returns public ES256 keys for identity-api issued tokens: user-session (user-* kids) and svc-JWTs (svc-* kids).",
    },
  })
  .handle(async () => {
    const document = await buildJwksDocumentFromEnv()
    return jsonResponse(200, document, {
      headers: { "cache-control": "public, max-age=3600" },
    })
  })
