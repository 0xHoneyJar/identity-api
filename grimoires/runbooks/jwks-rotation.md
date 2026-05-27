# JWKS Rotation Runbook — svc-JWT signing keys (D-1.1 §7)

> Operator-runnable procedure for rotating the cluster's svc-JWT ES256
> signing key. Covers: scheduled rotation (planned), emergency rotation
> (suspected compromise), and verification recipes. Independent from
> the user-JWT signing key rotation per D-1.1 §7 — do NOT bundle them.

## Quick reference

| Concept | Value |
|---------|-------|
| Algorithm | ES256 (ECDSA P-256) — fixed per ADR-002 |
| kid format | `svc-{YYYY-MM-DD}-{seq}` (e.g., `svc-2026-05-26-a`) |
| Current env | `SVC_JWT_SIGNING_KEY_PEM` + `SVC_JWT_SIGNING_KEY_KID` |
| Previous env (overlap) | `SVC_JWT_SIGNING_KEY_PEM_PREV` + `SVC_JWT_SIGNING_KEY_KID_PREV` |
| Max svc-JWT TTL | 3600s (1h) — per D-1.1 §3 |
| Overlap window | ≥ 2 × max-TTL = **2h minimum** |
| JWKS cache TTL (verifier-side) | 3600s (1h) — bounded by `JWKS_CACHE_TTL_SEC` |
| Independence | Rotate svc-keys WITHOUT touching user-keys (D-1.1 §7) |

## The 2-key model

Identity-api always signs with the **current** key. Verifiers (cells)
fetch the JWKS document and accept any key listed there. During rotation:

```
                       ┌─ JWKS document ─┐
   sign with kid_NEW → │  kid_PREV (key) │ ← verifiers accept (in-flight JWTs)
                       │  kid_NEW  (key) │ ← verifiers accept (newly minted)
                       └─────────────────┘
```

The overlap exists so JWTs minted under `kid_PREV` (still inside their
≤1h TTL window) continue to verify until they expire. After ≥ 2× the
max TTL elapses (2h minimum), no in-flight JWT can carry `kid_PREV` —
the old key drops out of the JWKS document, completing the rotation.

## Procedure — scheduled rotation

### Step 0 — preconditions

- [ ] You are the operator on duty (not delegated to an agent).
- [ ] Current deploy is healthy (no active incidents touching auth).
- [ ] No coordinated emergency-rotation is already in flight.
- [ ] `gh` CLI logged in with deploy access.
- [ ] You have `openssl` ≥ 3.0 OR Bun ≥ 1.3 on the workstation.

### Step 1 — generate the new ES256 keypair

The PEM format must be PKCS#8 (the format `jose.importPKCS8` accepts).

Option A — using openssl (works anywhere openssl is installed):

```bash
# Pick today's date + a sequence letter for the new kid
NEW_KID="svc-$(date -u +%Y-%m-%d)-a"   # bump to -b if -a already exists

# Generate the EC P-256 private key in PKCS#8
openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 \
  -pkeyopt ec_param_enc:named_curve \
  -out /tmp/svc-jwt-${NEW_KID}.pkcs8.pem

# Sanity: should print "id-ecPublicKey ... P-256"
openssl pkey -in /tmp/svc-jwt-${NEW_KID}.pkcs8.pem -text -noout | head -10

echo "kid=${NEW_KID}"
echo "pem=/tmp/svc-jwt-${NEW_KID}.pkcs8.pem"
```

Option B — using Bun + jose (matches what `LocalEs256Signer` will consume):

```bash
NEW_KID="svc-$(date -u +%Y-%m-%d)-a"

bun --eval '
  const { generateKeyPair, exportPKCS8 } = await import("jose");
  const { privateKey } = await generateKeyPair("ES256", { extractable: true });
  const pem = await exportPKCS8(privateKey);
  process.stdout.write(pem);
' > /tmp/svc-jwt-${NEW_KID}.pkcs8.pem

echo "kid=${NEW_KID}"
echo "pem=/tmp/svc-jwt-${NEW_KID}.pkcs8.pem"
```

Verify the file mode is 0600 — the private key is sensitive material:

```bash
chmod 0600 /tmp/svc-jwt-${NEW_KID}.pkcs8.pem
ls -l /tmp/svc-jwt-${NEW_KID}.pkcs8.pem
```

### Step 2 — promote the current key to PREV slot

Record current key + kid values before overwriting (you'll set both
env vars in step 3 atomically):

```bash
# Capture current values from your deploy provider (Railway/Fly/etc.)
# Example for Railway:
railway variables --service identity-api --kv \
  | grep -E '^SVC_JWT_SIGNING_KEY_(PEM|KID)='
```

Set in your deploy provider:

```
SVC_JWT_SIGNING_KEY_PEM_PREV = <current SVC_JWT_SIGNING_KEY_PEM value>
SVC_JWT_SIGNING_KEY_KID_PREV = <current SVC_JWT_SIGNING_KEY_KID value>
```

> **Do NOT redeploy yet.** Step 3 sets the NEW values; deploying after
> Step 2 alone would orphan the previous key without publishing the new
> one — every in-flight cell would fail verify.

### Step 3 — set the new key as current

Set in your deploy provider:

```
SVC_JWT_SIGNING_KEY_PEM = <contents of /tmp/svc-jwt-${NEW_KID}.pkcs8.pem>
SVC_JWT_SIGNING_KEY_KID = ${NEW_KID}
```

Trigger redeploy. Wait for healthy status.

### Step 4 — verify JWKS now publishes BOTH kids

The JWKS endpoint is `/.well-known/jwks.json` on the identity-api
service. After redeploy:

```bash
ID_API="https://identity.0xhoneyjar.xyz"

curl -s "${ID_API}/.well-known/jwks.json" \
  | jq '.keys | map({kid, alg, use, crv})'
```

Expected output: **both** the new kid AND the previous kid appear:

```json
[
  { "kid": "svc-2026-05-26-a", "alg": "ES256", "use": "sig", "crv": "P-256" },
  { "kid": "svc-2026-04-12-a", "alg": "ES256", "use": "sig", "crv": "P-256" }
]
```

> **Forward-track caveat (W2.5 Sprint 3)**: as of cluster commit
> `37896b9`, the `/.well-known/jwks.json` endpoint composer is NOT YET
> built. `LocalEs256Signer` exposes the active kid but the HTTP route
> that publishes the JWKS document is the next sprint's work. Until
> that endpoint lands, this step is a forward-track checkpoint —
> operators must populate verifier caches programmatically with the
> current public JWK pair. Re-validate this step after the JWKS endpoint
> ships.

If the new key is missing or unchanged, the env-var update did not take
effect. Common causes:

- Deploy provider cached old env (force a fresh deploy, not a restart).
- Env-var name typo (must be exact: `SVC_JWT_SIGNING_KEY_PEM` not
  `SVC_JWT_PEM`).
- PEM truncation (deploy providers may strip newlines — use
  multi-line-aware var entry; verify the value starts with
  `-----BEGIN PRIVATE KEY-----`).

### Step 5 — confirm cells can verify with the new key

Pick one downstream cell and run its conformance suite OR exercise one
real cross-cell call:

```bash
# Example: trigger an action that requires svc-JWT verify
curl -fsS -X POST "${ID_API}/v1/auth/service-jwt" \
  -H "x-cell-key: ${YOUR_CELL_API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{ "aud": "test-cell", "role": "test.probe", "ttl_sec": 60 }' \
  | jq '.access_token'
```

The returned JWT carries `kid: ${NEW_KID}` in its header. Decode +
verify against the cell's JWKS cache.

### Step 6 — wait the overlap window (≥ 2h)

The previous key MUST stay in JWKS for at least:

```
overlap_window ≥ 2 × MAX_SVC_JWT_TTL_SEC = 2 × 3600 = 7200 seconds (2h)
```

Any svc-JWT minted under `kid_PREV` BEFORE step 3 has at most 1h TTL.
Waiting 2× max-TTL ensures every in-flight JWT has expired before the
old key drops out.

> **Why 2× and not 1×**: at exactly `now = max_TTL` after the rotation,
> a JWT minted RIGHT BEFORE the rotation but with `exp = max_TTL` is
> still valid for verifiers honoring the 30s skew tolerance. Doubling
> the window absorbs the skew + any small clock drift across cells.

Set a calendar reminder for `${rotation_time} + 2h + 30min` (the buffer
gives the operator a clean "is the queue drained" check).

### Step 7 — drop the previous key

After ≥ 2h has elapsed:

In your deploy provider, **unset** both:

```
SVC_JWT_SIGNING_KEY_PEM_PREV
SVC_JWT_SIGNING_KEY_KID_PREV
```

Trigger redeploy. Wait for healthy status.

### Step 8 — verify JWKS now shows ONLY the new kid

```bash
curl -s "${ID_API}/.well-known/jwks.json" \
  | jq '.keys | map(.kid)'
```

Expected:

```json
[ "svc-2026-05-26-a" ]
```

If the previous kid still appears, the env-var unset did not take
effect (see Step 4 troubleshooting). Re-deploy; do NOT proceed until
the JWKS document shows ONLY the new kid.

### Step 9 — securely destroy the previous key material

The PREV PEM is no longer accepted by verifiers but is still sensitive
material until destroyed:

```bash
# If the operator stored a copy locally during step 2:
shred -u /tmp/svc-jwt-${OLD_KID}.pkcs8.pem 2>/dev/null \
  || rm -P /tmp/svc-jwt-${OLD_KID}.pkcs8.pem  # macOS
```

Record the rotation in the operator log:

```
${rotation_date} — svc-key rotation
  from: ${OLD_KID}
  to:   ${NEW_KID}
  reason: scheduled (or "emergency: <reason>")
  overlap end: ${rotation_date} + 2h actual
  destroyed: ${destroy_time}
```

## Procedure — emergency rotation (suspected compromise)

If the **current** signing key is suspected compromised:

### Step E1 — deny the compromised kid cluster-wide

Insert a denylist rule covering EVERY JWT signed by the compromised kid:

```bash
# Connect to identity-api Postgres
psql "${IDENTITY_DB_URL}" <<'SQL'
INSERT INTO service_jwt_denylist (kid, jti, sub, reason, rule_id, created_at)
VALUES (
  'svc-2026-04-12-a',   -- the compromised kid
  NULL,                 -- jti=NULL → wildcard (every JWT with this kid)
  NULL,                 -- sub=NULL → wildcard (every calling cell)
  'compromise:2026-05-26T15:00Z incident-001',
  'rule-compromise-' || gen_random_uuid()::text,
  now()
);
SQL
```

Per D-1.1 §6, this rule is CONJUNCTIVE null-as-wildcard: every JWT
matching `kid = 'svc-2026-04-12-a'` is denied regardless of jti / sub.
Verifiers fail-CLOSED on the next denylist refresh.

### Step E2 — execute steps 1-9 above

The procedure is identical to scheduled rotation EXCEPT the overlap
window MAY be reduced if the operator judges that immediate revocation
outweighs the cost of in-flight call failures:

| Scenario | Recommended overlap |
|----------|---------------------|
| Compromise confirmed, no cluster impact yet | Standard 2h overlap |
| Compromise + active exploitation | Skip overlap — set PREV to NULL in Step 3; in-flight JWTs under old kid will 401 KID_DISALLOWED at verify (the denylist rule from Step E1 also catches them) |

When skipping the overlap, downstream cells will see a brief auth-error
spike as in-flight JWTs invalidate. Communicate to dependent cells
BEFORE Step 3.

### Step E3 — remove the denylist rule after rotation completes

After Step 9 (old kid dropped from JWKS), the denylist rule is
redundant — no key under that kid exists in the trust set. Remove the
rule to keep the denylist table clean:

```bash
psql "${IDENTITY_DB_URL}" -c \
  "DELETE FROM service_jwt_denylist WHERE rule_id = 'rule-compromise-...';"
```

## Independence from user-JWT rotation

Per D-1.1 §7: svc-kid rotation is **independent** from user-kid rotation.
The two kid classes share the JWKS document but rotate on their own
cadences:

- **svc-keys** (`svc-` prefix): rotated by THIS runbook.
- **user-keys** (`user-` prefix): rotated by the user-JWT runbook (the
  Hyper auth substrate; separate procedure).

The cluster's JWKS document publishes BOTH classes simultaneously. A
svc-only rotation MUST NOT touch user-key env vars; verifier
kid-prefix disambiguation (D-1.1 §5 step 5) ensures the two classes
don't collide even in shared cache.

## Verification recipes

### Test the conformance suite end-to-end

```bash
cd /path/to/your/cell
bun test svc-jwt-conformance.test.ts
# Expected: 21/21 scenarios pass
```

### Decode an svc-JWT without verifying

```bash
JWT=eyJhbGc...   # the JWT string

# Header
echo "${JWT}" | cut -d. -f1 | base64 -d 2>/dev/null | jq

# Payload (claims)
echo "${JWT}" | cut -d. -f2 | base64 -d 2>/dev/null | jq
```

### Confirm the active kid at the issuer

```bash
ID_API="https://identity.0xhoneyjar.xyz"

# Mint a test JWT (requires a valid cell API key for an operator-grants entry)
curl -fsS -X POST "${ID_API}/v1/auth/service-jwt" \
  -H "x-cell-key: ${OPERATOR_CELL_KEY}" \
  -H "Content-Type: application/json" \
  -d '{ "aud": "kid-probe", "role": "ops.read", "ttl_sec": 60 }' \
  | jq -r .access_token \
  | cut -d. -f1 \
  | base64 -d 2>/dev/null \
  | jq -r .kid
```

Compare against the kid published in `${ID_API}/.well-known/jwks.json`.

## Forward-track

- **`/.well-known/jwks.json` endpoint composer** — the HTTP route that
  reads `SVC_JWT_SIGNING_KEY_PEM` + `..._PREV` env pairs and emits the
  combined JWKS document is forward-track (not yet built as of W2.5
  Sprint 3).
- **Automation script** — this runbook is operator-runnable as written.
  When rotation cadence becomes high-frequency, port steps 1-9 to a
  `scripts/rotate-svc-key.sh` that drives the deploy-provider CLI.
- **Multi-region coordination** — if identity-api ever deploys to
  multiple regions with independent env stores, Step 3+7 needs a per-region
  deploy gate. Not in scope for W2.5.

## Related

- Canonical spec: `grimoires/svc-jwt-spec.md` §7 (rotation procedure spec).
- Migrations: `packages/adapters/src/migrations/0006_svc_jwt_denylist.up.sql` (denylist table referenced in emergency rotation).
- Verifier source: `packages/adapters/src/svc-jwt-verifier.ts` + the
  conformance suite at `packages/auth-sdk/src/conformance/index.ts`.
- Sibling runbooks: TBD — user-JWT rotation procedure lives separately.
