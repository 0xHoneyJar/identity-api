/**
 * svc-JWT conformance suite — substrate-grade gate (PRD NF-Sec-1).
 *
 * Runs the 11 D-1.1 §8 canonical scenarios + 6 total-function fuzz cases
 * + 4 order-of-operations invariants against a `verifier` function.
 * Returns a structured `ConformanceResult` — does NOT throw on
 * failure. The caller (test file, CI step, ad-hoc script) decides how
 * to surface failures.
 *
 * Why a callable suite (not just a test file):
 *   - Every consumer cell reruns this suite in its OWN CI against its
 *     OWN verifier wrapper (the cell may wrap `verifySvcJwt` with
 *     retries, cell-specific role mapping, etc.).
 *   - A test-file-only suite would only validate the auth-sdk's own
 *     consumption; the callable form gives downstream cells the same
 *     gate.
 *   - Sibling: `__tests__/conformance.test.ts` invokes
 *     `runConformanceSuite()` with the default verifier and asserts
 *     `result.ok === true`. That's THIS package's M-3 gate.
 *
 * Cluster-shared fixtures (NOT consumer-customizable):
 *   - ES256 keypair generated fresh per run (deterministic outcomes
 *     don't need deterministic keys — the suite controls all inputs).
 *   - JWKS document with one publishable key under kid `svc-2026-05-26-a`.
 *   - In-memory denylist stubs (allow-all, deny-all, throwing).
 *
 * Spec: `grimoires/svc-jwt-spec.md` §8 + the sibling adapter test file
 * `packages/adapters/src/__tests__/svc-jwt-verifier.test.ts` (T-2.7).
 *
 * **EXPLICIT NON-PRESENCE**: NO replay scenarios. Replay is mechanically
 * impossible by design under D2.5-12 per-request issuance. If a cell
 * adds a replay scenario here, the per-request model is being violated
 * upstream — surface that to the operator instead.
 */

import {
  SignJWT,
  generateKeyPair,
  exportJWK,
  type JWK,
} from 'jose';
import {
  verifySvcJwt,
  type SvcJwtJwksCache,
  type DenylistCheck,
  type SvcJwtVerifyOpts,
  type SvcJwtVerifyErrorCode,
  type SvcJwtVerifyResult,
} from '../verify';

// ─── Public types ──────────────────────────────────────────────────────

/**
 * Verifier callable expected by the suite. Signature matches `verifySvcJwt`.
 * Cells with a wrapper pass it here; the suite controls `opts` internally.
 */
export type ConformanceVerifier = (
  jwt: string,
  opts: SvcJwtVerifyOpts,
) => Promise<SvcJwtVerifyResult>;

export interface ConformanceSuiteOptions {
  /** Verifier function. Default: `verifySvcJwt` from `@freeside-auth/auth-sdk`. */
  verifier?: ConformanceVerifier;
  /** When true, every result carries a `message` (not just failures). */
  verbose?: boolean;
}

export interface ConformanceScenarioResult {
  /** Human-readable scenario name (D-1.1 §8 + fuzz + order-of-ops). */
  name: string;
  /** Expected outcome: `'ok'` for success or the `SvcJwtVerifyErrorCode`. */
  expected: 'ok' | SvcJwtVerifyErrorCode;
  /**
   * Actual outcome. `'THREW'` is a hard failure of the total-function
   * guarantee — `verify` MUST never throw, even on garbage input.
   */
  actual: 'ok' | SvcJwtVerifyErrorCode | 'THREW';
  /** True iff `expected === actual`. */
  pass: boolean;
  /** Diagnostic — populated on failure or when `verbose: true`. */
  message?: string;
  /** Populated for Scenario 11 (denylist match) to validate ruleId propagation. */
  ruleId?: string;
}

export interface ConformanceResult {
  scenarios: ConformanceScenarioResult[];
  /** True iff every scenario passed. */
  ok: boolean;
  passed: number;
  failed: number;
  total: number;
}

/**
 * Externally-exposed fixture surface — read-only descriptors of the
 * cluster-canonical test constants. Cells that want to mint custom JWTs
 * against the same key material can import these for diagnostics or
 * deeper integration scenarios beyond the standard 21+ cases.
 *
 * Do NOT vendor these for production — they are test-domain values.
 */
export interface ConformanceFixtures {
  readonly iss: string;
  readonly aud: string;
  readonly sub: string;
  readonly role: string;
  readonly kid: string;
  readonly jwksUrl: string;
  readonly defaultJti: string;
}

export const FIXTURES: ConformanceFixtures = Object.freeze({
  iss: 'https://identity.0xhoneyjar.xyz',
  aud: 'mint-api',
  sub: 'activities-api',
  role: 'mint.invoke',
  kid: 'svc-2026-05-26-a',
  jwksUrl: 'https://identity.0xhoneyjar.xyz/.well-known/jwks.json',
  defaultJti: 'Yp3Q5w8aLm9N2bV4xT6sKg',
});

// ─── Internal helpers ──────────────────────────────────────────────────

interface MintOptions {
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
}

class SuiteJwksCache implements SvcJwtJwksCache {
  private readonly store = new Map<string, JWK[]>();

  async get(url: string): Promise<JWK[] | null> {
    return this.store.get(url) ?? null;
  }

  async set(url: string, keys: JWK[], _ttlSec: number): Promise<void> {
    this.store.set(url, keys);
  }
}

const allowAllDenylist: DenylistCheck = {
  async matches() {
    return { denied: false };
  },
};

function denyAllDenylist(reason: string, ruleId: string): DenylistCheck {
  return {
    async matches() {
      return { denied: true, reason, ruleId };
    },
  };
}

const throwingDenylist: DenylistCheck = {
  async matches() {
    throw new Error('Postgres connection refused');
  },
};

interface Harness {
  privateKey: CryptoKey;
  publicJwk: JWK;
  mint(opts?: MintOptions): Promise<string>;
  baseOpts(overrides?: Partial<SvcJwtVerifyOpts>): SvcJwtVerifyOpts;
}

async function buildHarness(): Promise<Harness> {
  const { privateKey, publicKey } = await generateKeyPair('ES256', {
    extractable: true,
  });
  const publicJwk = await exportJWK(publicKey);
  publicJwk.kid = FIXTURES.kid;
  publicJwk.alg = 'ES256';
  publicJwk.use = 'sig';

  const cache = new SuiteJwksCache();
  await cache.set(FIXTURES.jwksUrl, [publicJwk], 3600);

  const mint: Harness['mint'] = async (opts = {}) => {
    const now = Math.floor(Date.now() / 1000);
    const iat = opts.iat ?? now;
    const exp = opts.exp ?? iat + 3600;
    const nbf = opts.nbf ?? iat;
    return new SignJWT({
      iss: opts.iss ?? FIXTURES.iss,
      aud: opts.aud ?? FIXTURES.aud,
      sub: opts.sub ?? FIXTURES.sub,
      role: opts.role ?? FIXTURES.role,
      iat,
      exp,
      nbf,
      jti: opts.jti ?? FIXTURES.defaultJti,
    })
      .setProtectedHeader({
        alg: opts.alg ?? 'ES256',
        typ: opts.typ ?? 'JWT',
        kid: opts.kid ?? FIXTURES.kid,
      })
      .sign(privateKey);
  };

  const baseOpts: Harness['baseOpts'] = (overrides = {}) => ({
    expectedIss: FIXTURES.iss,
    expectedAud: FIXTURES.aud,
    expectedRole: FIXTURES.role,
    jwksCache: cache,
    denylistCheck: allowAllDenylist,
    jwksUrl: FIXTURES.jwksUrl,
    ...overrides,
  });

  return { privateKey, publicJwk, mint, baseOpts };
}

function classify(result: SvcJwtVerifyResult): 'ok' | SvcJwtVerifyErrorCode {
  return result.ok ? 'ok' : result.code;
}

interface RunSpec {
  name: string;
  expected: 'ok' | SvcJwtVerifyErrorCode;
  run: (h: Harness) => Promise<{ jwt: string; opts: SvcJwtVerifyOpts }>;
  /** Optional post-check on success (e.g., assert ruleId for DENIED_BY_RULE). */
  postCheck?: (result: SvcJwtVerifyResult) => string | undefined;
}

async function executeScenario(
  spec: RunSpec,
  harness: Harness,
  verifier: ConformanceVerifier,
  verbose: boolean,
): Promise<ConformanceScenarioResult> {
  let actual: 'ok' | SvcJwtVerifyErrorCode | 'THREW';
  let message: string | undefined;
  let ruleId: string | undefined;
  let raw: SvcJwtVerifyResult | undefined;
  let jwt: string | undefined;
  let opts: SvcJwtVerifyOpts | undefined;

  // Stage 1: build fixtures via spec.run(). A throw here is a SETUP
  // failure (the harness couldn't mint a JWT or build opts) — distinct
  // from a verifier-side throw, and reported as such for clear CI
  // diagnostics. The total-function guarantee is for `verifier()`, not
  // for the suite's own setup.
  try {
    const r = await spec.run(harness);
    jwt = r.jwt;
    opts = r.opts;
  } catch (err) {
    actual = 'THREW';
    message =
      err instanceof Error
        ? `suite setup threw (spec.run): ${err.message}`
        : 'suite setup threw (non-Error)';
    return {
      name: spec.name,
      expected: spec.expected,
      actual,
      pass: false,
      message,
    };
  }

  // Stage 2: invoke the verifier. A throw here violates the total-
  // function guarantee per D-1.1; the suite captures it and labels
  // `actual: 'THREW'` so the failure is visible and bound to the
  // verifier (not to the suite's fixtures).
  try {
    raw = await verifier(jwt, opts);
    actual = classify(raw);
    if (raw.ok === false) {
      message = raw.message;
      ruleId = raw.ruleId;
    } else if (verbose) {
      // Verbose mode: pin the contract that passing scenarios also
      // carry a diagnostic message (helps downstream CI logs).
      message = 'ok';
    }
  } catch (err) {
    actual = 'THREW';
    message =
      err instanceof Error
        ? `verifier threw: ${err.message}`
        : 'verifier threw (non-Error)';
  }

  const pass = actual === spec.expected;
  let postCheckMessage: string | undefined;
  if (pass && spec.postCheck && raw) {
    postCheckMessage = spec.postCheck(raw);
  }

  const finalPass = pass && postCheckMessage === undefined;
  // verbose: surface diagnostic message even on PASS (postCheck wins if
  // populated; otherwise the regular message). Default: suppress
  // message on success to keep CI logs quiet.
  const surfacedMessage = !finalPass || verbose ? (postCheckMessage ?? message) : undefined;
  return {
    name: spec.name,
    expected: spec.expected,
    actual,
    pass: finalPass,
    message: surfacedMessage,
    ruleId,
  };
}

// ─── Scenario catalog ──────────────────────────────────────────────────

function buildScenarios(): RunSpec[] {
  return [
    // ─── D-1.1 §8 canonical 11 ─────────────────────────────────────────
    {
      name: 'Scenario 1: valid svc-JWT → ok',
      expected: 'ok',
      run: async (h) => ({ jwt: await h.mint(), opts: h.baseOpts() }),
    },
    {
      name: 'Scenario 2: invalid signature → INVALID_SIG',
      expected: 'INVALID_SIG',
      run: async (h) => {
        const jwt = await h.mint();
        const parts = jwt.split('.');
        const sig = Buffer.from(parts[2]!, 'base64url');
        sig[sig.length - 1] = sig[sig.length - 1]! ^ 0xff;
        const tampered = `${parts[0]}.${parts[1]}.${sig.toString('base64url')}`;
        return { jwt: tampered, opts: h.baseOpts() };
      },
    },
    {
      name: 'Scenario 3: role mismatch → ROLE_MISMATCH',
      expected: 'ROLE_MISMATCH',
      run: async (h) => ({
        jwt: await h.mint({ role: 'wrong.role' }),
        opts: h.baseOpts(),
      }),
    },
    {
      name: 'Scenario 4: aud mismatch → AUD_MISMATCH',
      expected: 'AUD_MISMATCH',
      run: async (h) => ({
        jwt: await h.mint({ aud: 'wrong-cell' }),
        opts: h.baseOpts(),
      }),
    },
    {
      name: 'Scenario 5: iss mismatch → ISS_MISMATCH',
      expected: 'ISS_MISMATCH',
      run: async (h) => ({
        jwt: await h.mint({ iss: 'https://evil.example.com' }),
        opts: h.baseOpts(),
      }),
    },
    {
      name: 'Scenario 6: kid prefix disallowed (user- to svc-verifier) → KID_DISALLOWED',
      expected: 'KID_DISALLOWED',
      run: async (h) => ({
        jwt: await h.mint({ kid: 'user-2026-05-26-a' }),
        opts: h.baseOpts(),
      }),
    },
    {
      name: 'Scenario 7: expired (exp past now-skewSec) → EXPIRED',
      expected: 'EXPIRED',
      run: async (h) => {
        const now = Math.floor(Date.now() / 1000);
        return {
          jwt: await h.mint({ iat: now - 7200, nbf: now - 7200, exp: now - 3600 }),
          opts: h.baseOpts(),
        };
      },
    },
    {
      name: 'Scenario 8: nbf future (nbf > now+skewSec) → NBF_FUTURE',
      expected: 'NBF_FUTURE',
      run: async (h) => {
        const now = Math.floor(Date.now() / 1000);
        return {
          jwt: await h.mint({ iat: now, nbf: now + 3600, exp: now + 7200 }),
          opts: h.baseOpts(),
        };
      },
    },
    {
      name: 'Scenario 9: malformed JWT → MALFORMED',
      expected: 'MALFORMED',
      run: async (h) => ({ jwt: 'not.a.jwt', opts: h.baseOpts() }),
    },
    {
      name: 'Scenario 10: JWKS unreachable → JWKS_UNREACHABLE',
      expected: 'JWKS_UNREACHABLE',
      run: async (h) => {
        const jwt = await h.mint();
        const emptyCache = new SuiteJwksCache();
        return {
          jwt,
          opts: h.baseOpts({
            jwksCache: emptyCache,
            fetch: async () => new Response('Internal Server Error', { status: 500 }),
          }),
        };
      },
    },
    {
      name: 'Scenario 11: denylist match → DENIED_BY_RULE',
      expected: 'DENIED_BY_RULE',
      run: async (h) => ({
        jwt: await h.mint(),
        opts: h.baseOpts({
          denylistCheck: denyAllDenylist('key compromise', 'rule-deadbeef'),
        }),
      }),
      postCheck: (result) => {
        if (result.ok) return 'expected denied result but got ok';
        if (result.ruleId !== 'rule-deadbeef') {
          return `ruleId propagation failed: expected "rule-deadbeef", got ${JSON.stringify(result.ruleId)}`;
        }
        return undefined;
      },
    },

    // ─── 6 total-function fuzz cases ──────────────────────────────────
    {
      name: 'Fuzz 1: verify("") returns MALFORMED without throwing',
      expected: 'MALFORMED',
      run: async (h) => ({ jwt: '', opts: h.baseOpts() }),
    },
    {
      name: 'Fuzz 2: verify("bogus") returns MALFORMED without throwing',
      expected: 'MALFORMED',
      run: async (h) => ({ jwt: 'bogus', opts: h.baseOpts() }),
    },
    {
      name: 'Fuzz 3: verify(undefined as any) returns MALFORMED without throwing',
      expected: 'MALFORMED',
      run: async (h) => ({ jwt: undefined as unknown as string, opts: h.baseOpts() }),
    },
    {
      name: 'Fuzz 4: verify(null as any) returns MALFORMED without throwing',
      expected: 'MALFORMED',
      run: async (h) => ({ jwt: null as unknown as string, opts: h.baseOpts() }),
    },
    {
      name: 'Fuzz 5: verify("a.b.c") returns MALFORMED without throwing',
      expected: 'MALFORMED',
      run: async (h) => ({ jwt: 'a.b.c', opts: h.baseOpts() }),
    },
    {
      name: 'Fuzz 6: verify("...") (three empty parts) returns MALFORMED without throwing',
      expected: 'MALFORMED',
      run: async (h) => ({ jwt: '...', opts: h.baseOpts() }),
    },

    // ─── 4 order-of-operations invariants (D-1.1 §5) ─────────────────
    // Order 1 is implicit: if the verifier had reached JWKS fetch, the
    // 500-returning fetch below would have surfaced JWKS_UNREACHABLE. The
    // EXPIRED outcome IS the short-circuit proof.
    {
      name: 'Order 1: expired JWT short-circuits before JWKS fetch (no I/O for invalid)',
      expected: 'EXPIRED',
      run: async (h) => {
        const now = Math.floor(Date.now() / 1000);
        const jwt = await h.mint({ iat: now - 7200, nbf: now - 7200, exp: now - 3600 });
        return {
          jwt,
          opts: h.baseOpts({
            jwksCache: new SuiteJwksCache(),
            fetch: async () => new Response('boom', { status: 500 }),
          }),
        };
      },
    },
    {
      name: 'Order 2: iss mismatch short-circuits before JWKS fetch',
      expected: 'ISS_MISMATCH',
      run: async (h) => {
        const jwt = await h.mint({ iss: 'https://evil.example.com' });
        return {
          jwt,
          opts: h.baseOpts({
            jwksCache: new SuiteJwksCache(),
            fetch: async () => new Response('boom', { status: 500 }),
          }),
        };
      },
    },
    {
      name: 'Order 3: kid-prefix mismatch short-circuits before JWKS fetch',
      expected: 'KID_DISALLOWED',
      run: async (h) => {
        const jwt = await h.mint({ kid: 'user-2026-05-26-a' });
        return {
          jwt,
          opts: h.baseOpts({
            jwksCache: new SuiteJwksCache(),
            fetch: async () => new Response('boom', { status: 500 }),
          }),
        };
      },
    },
    {
      name: 'Order 4: throwing denylist → DENYLIST_UNAVAILABLE (fail-CLOSED per NF-Sec-1)',
      expected: 'DENYLIST_UNAVAILABLE',
      run: async (h) => ({
        jwt: await h.mint(),
        opts: h.baseOpts({ denylistCheck: throwingDenylist }),
      }),
    },
  ];
}

// ─── Public entrypoint ─────────────────────────────────────────────────

/**
 * Run the substrate-grade conformance suite. Default verifier is
 * `verifySvcJwt`; pass `opts.verifier` to validate a cell-specific
 * wrapper.
 *
 * Total scenarios: 21 (11 canonical + 6 fuzz + 4 order-of-ops).
 * Never throws — even verifier-thrown errors are captured as
 * `actual: 'THREW'` for the relevant scenario.
 *
 * @example
 * const result = await runConformanceSuite();
 * if (!result.ok) {
 *   for (const s of result.scenarios.filter(x => !x.pass)) {
 *     console.error(`FAIL: ${s.name} — expected ${s.expected}, got ${s.actual}: ${s.message}`);
 *   }
 * }
 */
export async function runConformanceSuite(
  opts: ConformanceSuiteOptions = {},
): Promise<ConformanceResult> {
  const verifier = opts.verifier ?? verifySvcJwt;
  const verbose = opts.verbose ?? false;
  const harness = await buildHarness();
  const specs = buildScenarios();

  const scenarios: ConformanceScenarioResult[] = [];
  for (const spec of specs) {
    const result = await executeScenario(spec, harness, verifier, verbose);
    scenarios.push(result);
  }

  const passed = scenarios.filter((s) => s.pass).length;
  const failed = scenarios.length - passed;
  return {
    scenarios,
    ok: failed === 0,
    passed,
    failed,
    total: scenarios.length,
  };
}
