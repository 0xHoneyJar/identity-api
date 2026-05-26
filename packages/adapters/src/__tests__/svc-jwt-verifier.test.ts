/**
 * svc-JWT Verifier conformance suite — W2.5 cluster-auth substrate
 * (D-1.1 §8). 11 canonical scenarios + total-function fuzz cases.
 *
 * Substrate-grade: every consumer cell reruns this suite in its CI; the
 * verifier surface is treated as a contract. Any test that fails here
 * blocks merge across the cluster.
 *
 * NO replay scenarios — mechanically impossible by design under D2.5-12
 * per-request issuance. If you find yourself wanting to add one, the
 * per-request model is being violated upstream.
 */

import { describe, expect, it } from 'bun:test';
import {
  SignJWT,
  generateKeyPair,
  exportJWK,
  type JWK,
} from 'jose';
import {
  verify,
  type JwksCache,
  type DenylistCheck,
  type VerifyOpts,
} from '../svc-jwt-verifier';

// ─── Test fixtures ─────────────────────────────────────────────────────

const ISS = 'https://identity.0xhoneyjar.xyz';
const AUD = 'mint-api';
const SUB = 'activities-api';
const ROLE = 'mint.invoke';
const KID = 'svc-2026-05-26-a';
const JWKS_URL = 'https://identity.0xhoneyjar.xyz/.well-known/jwks.json';

interface TestKeys {
  privateKey: CryptoKey;
  publicJwk: JWK;
}

/**
 * Generate an ES256 keypair + matching JWK for tests. Cached at the
 * module level so the 11 scenarios share a single keypair — the
 * 80–120ms generateKeyPair cost runs once per suite, not per test.
 */
let _testKeys: TestKeys | null = null;
async function getTestKeys(): Promise<TestKeys> {
  if (_testKeys) return _testKeys;
  const { privateKey, publicKey } = await generateKeyPair('ES256', {
    extractable: true,
  });
  const publicJwk = await exportJWK(publicKey);
  publicJwk.kid = KID;
  publicJwk.alg = 'ES256';
  publicJwk.use = 'sig';
  _testKeys = { privateKey, publicJwk };
  return _testKeys;
}

/** Mint a well-formed svc-JWT for tests. All claims/headers overridable. */
async function mintTestJwt(opts: {
  iss?: string;
  aud?: string;
  sub?: string;
  role?: string;
  kid?: string;
  alg?: string;
  typ?: string;
  iat?: number;
  exp?: number;
  nbf?: number;
  jti?: string;
  privateKey?: CryptoKey;
} = {}): Promise<string> {
  const keys = await getTestKeys();
  const now = Math.floor(Date.now() / 1000);
  const iat = opts.iat ?? now;
  const exp = opts.exp ?? iat + 3600;
  const nbf = opts.nbf ?? iat;

  return new SignJWT({
    iss: opts.iss ?? ISS,
    aud: opts.aud ?? AUD,
    sub: opts.sub ?? SUB,
    role: opts.role ?? ROLE,
    iat,
    exp,
    nbf,
    jti: opts.jti ?? 'Yp3Q5w8aLm9N2bV4xT6sKg',
  })
    .setProtectedHeader({
      alg: opts.alg ?? 'ES256',
      typ: opts.typ ?? 'JWT',
      kid: opts.kid ?? KID,
    })
    .sign(opts.privateKey ?? keys.privateKey);
}

/**
 * In-memory JwksCache stub. Tests can pre-populate via `.set()` or let
 * the verifier fall through to `opts.fetch`.
 */
class InMemoryJwksCache implements JwksCache {
  private store = new Map<string, JWK[]>();

  async get(url: string): Promise<JWK[] | null> {
    return this.store.get(url) ?? null;
  }

  async set(url: string, keys: JWK[], _ttlSec: number): Promise<void> {
    this.store.set(url, keys);
  }
}

/** Always-allow denylist (no deny rules). */
const allowAllDenylist: DenylistCheck = {
  async matches() {
    return { denied: false };
  },
};

/** Always-deny denylist (matches every JWT with a fixed rule). */
function denyAllDenylist(reason = 'test deny', ruleId = 'rule-test-001'): DenylistCheck {
  return {
    async matches() {
      return { denied: true, reason, ruleId };
    },
  };
}

/** Denylist that throws — simulates Postgres outage. */
const throwingDenylist: DenylistCheck = {
  async matches() {
    throw new Error('Postgres connection refused');
  },
};

/** Build VerifyOpts with the cache pre-populated and sensible defaults. */
async function makeOpts(overrides: Partial<VerifyOpts> = {}): Promise<VerifyOpts> {
  const keys = await getTestKeys();
  const cache = new InMemoryJwksCache();
  await cache.set(JWKS_URL, [keys.publicJwk], 3600);
  return {
    expectedIss: ISS,
    expectedAud: AUD,
    expectedRole: ROLE,
    jwksCache: cache,
    denylistCheck: allowAllDenylist,
    jwksUrl: JWKS_URL,
    ...overrides,
  };
}

// ─── 11 D-1.1 §8 scenarios ─────────────────────────────────────────────

describe('svc-JWT verifier — D-1.1 §8 conformance scenarios', () => {
  it('Scenario 1: valid svc-JWT → { ok: true, claims }', async () => {
    const jwt = await mintTestJwt();
    const opts = await makeOpts();
    const result = await verify(jwt, opts);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.claims.iss).toBe(ISS);
      expect(result.claims.aud).toBe(AUD);
      expect(result.claims.sub).toBe(SUB);
      expect(result.claims.role).toBe(ROLE);
      expect(result.claims.jti).toBe('Yp3Q5w8aLm9N2bV4xT6sKg');
    }
  });

  it('Scenario 2: invalid signature → INVALID_SIG', async () => {
    const jwt = await mintTestJwt();
    // Tamper the last sig byte. The signature is the last segment.
    const parts = jwt.split('.');
    const sigBytes = Buffer.from(parts[2]!, 'base64url');
    sigBytes[sigBytes.length - 1] = sigBytes[sigBytes.length - 1]! ^ 0xff;
    const tamperedSig = sigBytes.toString('base64url');
    const tamperedJwt = `${parts[0]}.${parts[1]}.${tamperedSig}`;
    const opts = await makeOpts();
    const result = await verify(tamperedJwt, opts);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('INVALID_SIG');
    }
  });

  it('Scenario 3: role mismatch → ROLE_MISMATCH', async () => {
    const jwt = await mintTestJwt({ role: 'wrong.role' });
    const opts = await makeOpts();
    const result = await verify(jwt, opts);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('ROLE_MISMATCH');
    }
  });

  it('Scenario 4: aud mismatch → AUD_MISMATCH', async () => {
    const jwt = await mintTestJwt({ aud: 'wrong-cell' });
    const opts = await makeOpts();
    const result = await verify(jwt, opts);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('AUD_MISMATCH');
    }
  });

  it('Scenario 5: iss mismatch → ISS_MISMATCH', async () => {
    const jwt = await mintTestJwt({ iss: 'https://evil.example.com' });
    const opts = await makeOpts();
    const result = await verify(jwt, opts);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('ISS_MISMATCH');
    }
  });

  it('Scenario 6: kid disallowed (user- prefix sent to svc-verifier) → KID_DISALLOWED', async () => {
    // We can't use mintTestJwt here because Effect.Schema validates `kid`
    // against /^svc-.+$/ at HEADER signing — actually no, SignJWT doesn't
    // run our schema. We use `kid: 'user-2026-05-26-a'`.
    const jwt = await mintTestJwt({ kid: 'user-2026-05-26-a' });
    const opts = await makeOpts();
    const result = await verify(jwt, opts);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('KID_DISALLOWED');
    }
  });

  it('Scenario 7: expired (exp past now - skewSec) → EXPIRED', async () => {
    const now = Math.floor(Date.now() / 1000);
    const jwt = await mintTestJwt({
      iat: now - 7200,
      nbf: now - 7200,
      exp: now - 3600, // expired 1h ago
    });
    const opts = await makeOpts();
    const result = await verify(jwt, opts);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('EXPIRED');
    }
  });

  it('Scenario 8: nbf future (nbf > now + skewSec) → NBF_FUTURE', async () => {
    const now = Math.floor(Date.now() / 1000);
    const jwt = await mintTestJwt({
      iat: now,
      nbf: now + 3600, // not valid for another hour
      exp: now + 7200,
    });
    const opts = await makeOpts();
    const result = await verify(jwt, opts);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('NBF_FUTURE');
    }
  });

  it('Scenario 9: malformed JWT → MALFORMED', async () => {
    const opts = await makeOpts();
    const result = await verify('not.a.jwt', opts);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('MALFORMED');
    }
  });

  it('Scenario 10: JWKS unreachable → JWKS_UNREACHABLE', async () => {
    const jwt = await mintTestJwt();
    // Empty cache + a fetch impl that returns 500.
    const emptyCache = new InMemoryJwksCache();
    const opts: VerifyOpts = {
      expectedIss: ISS,
      expectedAud: AUD,
      expectedRole: ROLE,
      jwksCache: emptyCache,
      denylistCheck: allowAllDenylist,
      jwksUrl: JWKS_URL,
      fetch: async () =>
        new Response('Internal Server Error', { status: 500 }),
    };
    const result = await verify(jwt, opts);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('JWKS_UNREACHABLE');
    }
  });

  it('Scenario 11: denylist match → DENIED_BY_RULE', async () => {
    const jwt = await mintTestJwt();
    const opts = await makeOpts({
      denylistCheck: denyAllDenylist('key compromise', 'rule-deadbeef'),
    });
    const result = await verify(jwt, opts);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('DENIED_BY_RULE');
      expect(result.ruleId).toBe('rule-deadbeef');
      expect(result.message).toContain('key compromise');
    }
  });
});

// ─── DENYLIST_UNAVAILABLE — fail-CLOSED on Postgres outage ────────────

describe('svc-JWT verifier — denylist outage', () => {
  it('throwing denylist → DENYLIST_UNAVAILABLE (fail-CLOSED per NF-Sec-1)', async () => {
    const jwt = await mintTestJwt();
    const opts = await makeOpts({ denylistCheck: throwingDenylist });
    const result = await verify(jwt, opts);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('DENYLIST_UNAVAILABLE');
    }
  });
});

// ─── Total-function fuzz — verify() MUST NEVER throw ──────────────────

describe('svc-JWT verifier — total-function guarantee', () => {
  it('verify("") returns without throwing', async () => {
    const opts = await makeOpts();
    const result = await verify('', opts);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('MALFORMED');
  });

  it('verify("bogus") returns without throwing', async () => {
    const opts = await makeOpts();
    const result = await verify('bogus', opts);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('MALFORMED');
  });

  it('verify(undefined as any) returns without throwing', async () => {
    const opts = await makeOpts();
    const result = await verify(undefined as unknown as string, opts);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('MALFORMED');
  });

  it('verify(null as any) returns without throwing', async () => {
    const opts = await makeOpts();
    const result = await verify(null as unknown as string, opts);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('MALFORMED');
  });

  it('verify("a.b.c") (three parts, all base64-garbage) returns without throwing', async () => {
    const opts = await makeOpts();
    const result = await verify('a.b.c', opts);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('MALFORMED');
  });

  it('verify("...") (three empty parts) returns without throwing', async () => {
    const opts = await makeOpts();
    const result = await verify('...', opts);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('MALFORMED');
  });
});

// ─── Order-of-operations invariants ───────────────────────────────────

describe('svc-JWT verifier — order-of-operations (D-1.1 §5)', () => {
  it('expired JWT short-circuits BEFORE JWKS fetch (no-I/O for invalid)', async () => {
    const now = Math.floor(Date.now() / 1000);
    const jwt = await mintTestJwt({
      iat: now - 7200,
      nbf: now - 7200,
      exp: now - 3600,
    });
    // Empty cache + throwing fetch — if JWKS fetch is reached, we crash.
    // The expired-check at step 3 short-circuits before reaching step 6.
    const emptyCache = new InMemoryJwksCache();
    let fetchCalls = 0;
    const opts: VerifyOpts = {
      expectedIss: ISS,
      expectedAud: AUD,
      expectedRole: ROLE,
      jwksCache: emptyCache,
      denylistCheck: allowAllDenylist,
      jwksUrl: JWKS_URL,
      fetch: async () => {
        fetchCalls++;
        return new Response('boom', { status: 500 });
      },
    };
    const result = await verify(jwt, opts);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('EXPIRED');
    expect(fetchCalls).toBe(0); // STEP 3 < STEP 6 — no JWKS fetch
  });

  it('iss mismatch short-circuits BEFORE JWKS fetch', async () => {
    const jwt = await mintTestJwt({ iss: 'https://evil.example.com' });
    const emptyCache = new InMemoryJwksCache();
    let fetchCalls = 0;
    const opts: VerifyOpts = {
      expectedIss: ISS,
      expectedAud: AUD,
      expectedRole: ROLE,
      jwksCache: emptyCache,
      denylistCheck: allowAllDenylist,
      jwksUrl: JWKS_URL,
      fetch: async () => {
        fetchCalls++;
        return new Response('boom', { status: 500 });
      },
    };
    const result = await verify(jwt, opts);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('ISS_MISMATCH');
    expect(fetchCalls).toBe(0);
  });

  it('aud mismatch short-circuits BEFORE denylist query', async () => {
    const jwt = await mintTestJwt({ aud: 'wrong-cell' });
    let denylistCalls = 0;
    const trackingDenylist: DenylistCheck = {
      async matches() {
        denylistCalls++;
        return { denied: false };
      },
    };
    const opts = await makeOpts({ denylistCheck: trackingDenylist });
    const result = await verify(jwt, opts);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('AUD_MISMATCH');
    expect(denylistCalls).toBe(0); // STEP 8 < STEP 10 — no denylist query
  });

  it('role mismatch short-circuits BEFORE denylist query', async () => {
    const jwt = await mintTestJwt({ role: 'wrong.role' });
    let denylistCalls = 0;
    const trackingDenylist: DenylistCheck = {
      async matches() {
        denylistCalls++;
        return { denied: false };
      },
    };
    const opts = await makeOpts({ denylistCheck: trackingDenylist });
    const result = await verify(jwt, opts);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('ROLE_MISMATCH');
    expect(denylistCalls).toBe(0);
  });
});

/*
 * ════════════════════════════════════════════════════════════════════
 * EXPLICIT NON-PRESENCE — D2.5-12 anchor.
 *
 * NO replay scenarios — mechanically impossible by design under D2.5-12
 * per-request issuance. If you find yourself wanting to add one, the
 * per-request model is being violated upstream.
 *
 * Specifically, this suite does NOT exercise:
 *   - REPLAYED_JTI error code (does not exist).
 *   - `replayStore` opt on VerifyOpts (does not exist).
 *   - A `checkAndRecord` call in the order-of-ops (does not exist).
 *
 * The denylist (DENIED_BY_RULE) is the ONLY persistence-affecting
 * verify-time check post-D2.5-12. The svc-JWT spec §5 "Explicit
 * non-presence (§0a anchor)" section is the authoritative source.
 *
 * Re-introducing any of the above is a defect — file an issue per the
 * inter-doc consistency check in the Sprint 1 build doc.
 * ════════════════════════════════════════════════════════════════════
 */
