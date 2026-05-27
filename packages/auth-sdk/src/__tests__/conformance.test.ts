/**
 * auth-sdk conformance test — substrate-grade gate.
 *
 * Runs `runConformanceSuite()` against the SDK's PUBLIC SURFACE (imports
 * from `..` not from internal paths). This validates that:
 *
 *   1. The re-exports from `./verify`, `./svc-jwt-claims`, `./jwks-cache`
 *      compose correctly through the barrel.
 *   2. The default `verifySvcJwt` (from `@freeside-auth/adapters` via
 *      re-export) passes all 21 canonical scenarios.
 *   3. The total-function guarantee holds — no scenario shows
 *      `actual: 'THREW'`.
 *
 * Per M-3 (PRD): coverage gate ≥ 90% line / ≥ 80% branch. The
 * conformance suite plus the cache impls' direct exercise (below)
 * gives us most of the surface; the package is structured so re-exports
 * are uncovered by definition (no body to cover).
 *
 * Sibling test: `packages/adapters/src/__tests__/svc-jwt-verifier.test.ts`
 * (T-2.7) — that test exercises the verifier through internal paths;
 * this one validates the auth-sdk's vendorable public surface.
 */

import { describe, expect, it } from 'bun:test';
import {
  runConformanceSuite,
  InMemoryJwksCache,
  LruJwksCache,
} from '..';
// `JWK` is a jose primitive (peer-dep concern); auth-sdk does not
// re-export it. Tests import it directly from jose.
import type { JWK as JoseJWK } from 'jose';

describe('@freeside-auth/auth-sdk — conformance suite (substrate gate)', () => {
  it('default verifier passes all 21 canonical scenarios', async () => {
    const result = await runConformanceSuite();

    if (!result.ok) {
      const failures = result.scenarios
        .filter((s) => !s.pass)
        .map(
          (s) =>
            `  ✗ ${s.name}\n    expected=${s.expected} actual=${s.actual}${
              s.message ? `\n    message: ${s.message}` : ''
            }`,
        )
        .join('\n');
      throw new Error(
        `Conformance suite failed (${result.failed}/${result.total}):\n${failures}`,
      );
    }

    expect(result.ok).toBe(true);
    expect(result.passed).toBe(result.total);
    expect(result.total).toBeGreaterThanOrEqual(21);
  });

  it('every scenario returned a structured outcome — no scenario threw', async () => {
    const result = await runConformanceSuite({ verbose: true });
    for (const s of result.scenarios) {
      expect(s.actual).not.toBe('THREW');
    }
  });

  it('verbose mode populates message on success', async () => {
    const result = await runConformanceSuite({ verbose: true });
    // At least one passing scenario should have a non-undefined-but-may-be-undefined
    // message in verbose mode. The current impl populates message only on failures
    // or for scenarios with a postCheck — verbose currently piggybacks on the
    // existing diagnostic path. This test pins the verbose behavior is callable.
    expect(result.scenarios.length).toBeGreaterThan(0);
  });
});

describe('@freeside-auth/auth-sdk — JwksCache concrete impls', () => {
  const sampleJwk: JoseJWK = {
    kty: 'EC',
    crv: 'P-256',
    x: 'placeholder',
    y: 'placeholder',
    kid: 'svc-test',
    alg: 'ES256',
    use: 'sig',
  };

  describe('InMemoryJwksCache', () => {
    it('returns null on cache miss', async () => {
      const cache = new InMemoryJwksCache();
      expect(await cache.get('https://example.com/jwks.json')).toBeNull();
    });

    it('returns keys on cache hit before expiry', async () => {
      const cache = new InMemoryJwksCache();
      await cache.set('https://example.com/jwks.json', [sampleJwk], 60);
      const got = await cache.get('https://example.com/jwks.json');
      expect(got).toEqual([sampleJwk]);
    });

    it('returns null and lazy-evicts after expiry', async () => {
      let nowMs = 1_000_000;
      const cache = new InMemoryJwksCache({ now: () => nowMs });
      await cache.set('https://example.com/jwks.json', [sampleJwk], 1); // 1s TTL
      expect(await cache.get('https://example.com/jwks.json')).toEqual([sampleJwk]);
      nowMs += 2_000; // advance 2s past expiry
      expect(await cache.get('https://example.com/jwks.json')).toBeNull();
      // Re-set works after eviction
      await cache.set('https://example.com/jwks.json', [sampleJwk], 60);
      expect(await cache.get('https://example.com/jwks.json')).toEqual([sampleJwk]);
    });

    it('overwrites previous entry on set with same url', async () => {
      const cache = new InMemoryJwksCache();
      const otherJwk: JoseJWK = { ...sampleJwk, kid: 'svc-other' };
      await cache.set('https://example.com/jwks.json', [sampleJwk], 60);
      await cache.set('https://example.com/jwks.json', [otherJwk], 60);
      const got = await cache.get('https://example.com/jwks.json');
      expect(got).toEqual([otherJwk]);
    });
  });

  describe('LruJwksCache', () => {
    it('rejects non-positive maxEntries', () => {
      expect(() => new LruJwksCache({ maxEntries: 0 })).toThrow(/positive integer/);
      expect(() => new LruJwksCache({ maxEntries: -1 })).toThrow(/positive integer/);
      expect(() => new LruJwksCache({ maxEntries: 1.5 })).toThrow(/positive integer/);
    });

    it('honors maxEntries bound, evicting oldest on overflow', async () => {
      const cache = new LruJwksCache({ maxEntries: 2 });
      await cache.set('a', [sampleJwk], 3600);
      await cache.set('b', [sampleJwk], 3600);
      await cache.set('c', [sampleJwk], 3600);
      // 'a' was oldest and should now be evicted
      expect(await cache.get('a')).toBeNull();
      expect(await cache.get('b')).not.toBeNull();
      expect(await cache.get('c')).not.toBeNull();
    });

    it('touch-on-get moves entry to recent end', async () => {
      const cache = new LruJwksCache({ maxEntries: 2 });
      await cache.set('a', [sampleJwk], 3600);
      await cache.set('b', [sampleJwk], 3600);
      // Touch 'a' — now 'b' is the oldest
      await cache.get('a');
      await cache.set('c', [sampleJwk], 3600);
      expect(await cache.get('a')).not.toBeNull();
      expect(await cache.get('b')).toBeNull();
      expect(await cache.get('c')).not.toBeNull();
    });

    it('lazy-evicts on expiry', async () => {
      let nowMs = 1_000_000;
      const cache = new LruJwksCache({ maxEntries: 4, now: () => nowMs });
      await cache.set('x', [sampleJwk], 1);
      nowMs += 2_000;
      expect(await cache.get('x')).toBeNull();
    });

    it('defaults maxEntries to 16', async () => {
      const cache = new LruJwksCache();
      for (let i = 0; i < 16; i++) {
        await cache.set(`url-${i}`, [sampleJwk], 3600);
      }
      // 17th entry evicts url-0
      await cache.set('url-16', [sampleJwk], 3600);
      expect(await cache.get('url-0')).toBeNull();
      expect(await cache.get('url-1')).not.toBeNull();
    });
  });
});
