# User-session ES256 mint + JWKS (D-JWT-001)

> Operator procedure for provisioning and rotating **user-session** ES256
> signing keys. Independent from svc-JWT keys (`SVC_JWT_SIGNING_KEY_*`) —
> do **not** reuse kids or PEMs across planes.

## Quick reference

| Concept | Value |
|---------|-------|
| Algorithm | ES256 (ECDSA P-256) |
| kid format | `user-{YYYY-MM-DD}-{seq}` (e.g. `user-2026-07-19-a`) |
| Active env | `USER_JWT_SIGNING_KEY_PEM` + `USER_JWT_SIGNING_KEY_KID` |
| Previous env (overlap) | `USER_JWT_SIGNING_KEY_PEM_PREV` + `USER_JWT_SIGNING_KEY_KID_PREV` |
| Session TTL | 3600s (1h) |
| JWKS | `GET /.well-known/jwks.json` (user-* + svc-* keys) |
| Mint module | `src/jwt-mint.ts` |
| Verify | Hyper `@hyper/auth-jwt` — dual-path ES256 (JWKS) + HS256 (`JWT_SECRET`) |

## Plane isolation

| Plane | kid prefix | Env prefix | Consumers |
|-------|------------|------------|-----------|
| User session | `user-` | `USER_JWT_SIGNING_KEY_*` | `/v1/auth/verify`, `/v1/me`, `.auth()` routes |
| Service | `svc-` | `SVC_JWT_SIGNING_KEY_*` | `/v1/auth/service-jwt`, cell verifiers |

Mixing prefixes fails boot-time signer construction (`createLocalUserEs256Signer` / `createLocalEs256Signer`).

## Provision (first time / production)

Production **requires** user ES256 keys. Without them, `mintSessionJwt` throws.

```bash
KEY_DIR="${HOME}/.cache/freeside-auth/user-keys"
mkdir -p "${KEY_DIR}" && chmod 0700 "${KEY_DIR}"

NEW_KID="user-$(date -u +%Y-%m-%d)-a"
KEY_FILE="${KEY_DIR}/user-jwt-${NEW_KID}.pkcs8.pem"

(
  umask 077
  openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 \
    -out "${KEY_FILE}"
)
chmod 0600 "${KEY_FILE}"
test "$(stat -f '%Lp' "${KEY_FILE}" 2>/dev/null || stat -c '%a' "${KEY_FILE}")" = "600"

# Export PEM into Railway / deploy secrets:
#   USER_JWT_SIGNING_KEY_PEM=<contents of KEY_FILE>
#   USER_JWT_SIGNING_KEY_KID=$NEW_KID
```

Confirm JWKS after deploy:

```bash
curl -sS "$IDENTITY_API_BASE/.well-known/jwks.json" | jq '.keys[] | {kid, alg, use}'
# Expect a key with kid matching USER_JWT_SIGNING_KEY_KID
```

## Transition (dev / tests)

If `USER_JWT_SIGNING_KEY_*` are unset and `NODE_ENV !== production`:

- Mint falls back to **HS256** (`JWT_SECRET`) with a console warning.
- Verify still accepts **both** ES256 (when JWKS has user keys) and HS256.

Do not rely on HS256 in production.

## Rotation (overlap)

1. Generate new key + `user-…` kid (same openssl recipe).
2. Set `USER_JWT_SIGNING_KEY_PEM_PREV` / `_KID_PREV` to the **current** active pair.
3. Set `USER_JWT_SIGNING_KEY_PEM` / `_KID` to the **new** pair.
4. Redeploy. JWKS lists both keys; mint uses the new kid only.
5. Wait ≥ 2h (2 × max session TTL), then clear PREV env vars and redeploy.

Full svc-plane rotation detail (same 2-key model): `grimoires/runbooks/jwks-rotation.md`.

## Verify recipes

```bash
# Mint path is exercised by auth verify; unit coverage:
bun test packages/adapters/src/__tests__/local-user-es256-signer.test.ts
bun test src/api/__tests__/jwt-mint-es256.test.ts
```

## CI requirement

CI jobs that exercise auth mint/verify **must** set `USER_JWT_SIGNING_KEY_PEM` and `USER_JWT_SIGNING_KEY_KID` (ephemeral P-256) so `mintSessionJwt` returns `alg: "ES256"`. Relying on the HS256 fallback hides production readiness gaps (bridge finding F012).
