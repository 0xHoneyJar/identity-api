/**
 * JwksCache concrete implementations — auth-sdk default surface.
 *
 * The verifier (`verifySvcJwt`) requires a `JwksCache` opt; this module
 * ships the two default impls consumers should pick between:
 *
 *   - `InMemoryJwksCache` — single-process, unbounded. Good for cells
 *     with one or two upstream JWKS URLs (the common case in this
 *     cluster — every cell verifies against identity-api only).
 *
 *   - `LruJwksCache` — single-process, bounded. Good for cells that
 *     federate across multiple identity issuers (rare today; useful
 *     when a cell talks to identity-api + a partner-cluster JWKS).
 *
 * Both impls honor the per-entry `ttlSec` passed to `set()`. The verifier
 * passes `JWKS_CACHE_TTL_SEC = 3600` (1h). Operators tuning for higher
 * rotation cadence can pass a smaller value.
 *
 * Threading: JavaScript is single-threaded per realm; concurrent get/set
 * are safe. If a cell sandboxes verify across Workers, give each Worker
 * its own cache instance (Map is not cross-realm).
 *
 * Spec: D-1.1 §5 (mandatory cache — per-request JWKS fetch is a DoS
 * vector). The verifier returns `JWKS_UNREACHABLE` if cache + fetch
 * both fail, so a no-op cache is structurally fine for offline tests
 * (set returns void, get returns null, the verifier hits the fetch path).
 */

import type { JWK } from 'jose';
// Import via ./verify (which re-exports SvcJwtJwksCache from adapters) so
// the vendored auth-sdk has ONE rewrite point for the @freeside-auth/adapters
// alias — not two. Reduces drift between workspace + vendored layouts.
import type { SvcJwtJwksCache } from './verify';

interface CacheEntry {
  keys: JWK[];
  expiresAt: number;
}

export interface JwksCacheOptions {
  /** Test-injectable clock (ms). Default: `Date.now()`. */
  now?: () => number;
}

/**
 * Unbounded in-memory JwksCache. Entries expire on `get()` after their
 * `expiresAt` window; eviction is lazy (no background sweep).
 *
 * Use when the set of upstream JWKS URLs is small + bounded (the common
 * case: every cell verifies identity-api's single JWKS document).
 */
export class InMemoryJwksCache implements SvcJwtJwksCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly nowFn: () => number;

  constructor(opts: JwksCacheOptions = {}) {
    this.nowFn = opts.now ?? (() => Date.now());
  }

  async get(url: string): Promise<JWK[] | null> {
    const entry = this.entries.get(url);
    if (!entry) return null;
    if (entry.expiresAt <= this.nowFn()) {
      this.entries.delete(url);
      return null;
    }
    // Shallow-copy so a caller mutating the returned array (or jose helpers
    // doing so under the hood) cannot corrupt the cached entry for future
    // hits. Individual JWK objects are still shared — jose treats them as
    // immutable internally.
    return entry.keys.slice();
  }

  async set(url: string, keys: JWK[], ttlSec: number): Promise<void> {
    // Defensive copy on STORE so a caller mutating their array after
    // set() cannot retroactively poison the cache (mirrors the slice()
    // on get(); the cache owns its own copy in either direction).
    this.entries.set(url, {
      keys: keys.slice(),
      expiresAt: this.nowFn() + ttlSec * 1000,
    });
  }
}

export interface LruJwksCacheOptions extends JwksCacheOptions {
  /** Max retained entries (>= 1). Default: 16. */
  maxEntries?: number;
}

/**
 * Bounded LRU JwksCache. On `get()` hit, the entry moves to the recent
 * end of the eviction order. On `set()` over capacity, the oldest entry
 * is evicted.
 *
 * Use when the set of upstream JWKS URLs is larger or unbounded (a
 * federation gateway, a multi-cluster verifier). For single-issuer
 * cells, `InMemoryJwksCache` is simpler and equivalent.
 */
export class LruJwksCache implements SvcJwtJwksCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly nowFn: () => number;
  private readonly maxEntries: number;

  constructor(opts: LruJwksCacheOptions = {}) {
    this.nowFn = opts.now ?? (() => Date.now());
    const requested = opts.maxEntries ?? 16;
    if (!Number.isInteger(requested) || requested < 1) {
      throw new Error(
        `LruJwksCache: maxEntries must be a positive integer (got ${requested})`,
      );
    }
    this.maxEntries = requested;
  }

  async get(url: string): Promise<JWK[] | null> {
    const entry = this.entries.get(url);
    if (!entry) return null;
    if (entry.expiresAt <= this.nowFn()) {
      this.entries.delete(url);
      return null;
    }
    this.entries.delete(url);
    this.entries.set(url, entry);
    // Shallow-copy so callers cannot mutate the cached array (see
    // InMemoryJwksCache.get for the same rationale).
    return entry.keys.slice();
  }

  async set(url: string, keys: JWK[], ttlSec: number): Promise<void> {
    this.entries.delete(url);
    // Defensive store-side copy (mirrors InMemoryJwksCache.set).
    this.entries.set(url, { keys: keys.slice(), expiresAt: this.nowFn() + ttlSec * 1000 });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }
}
