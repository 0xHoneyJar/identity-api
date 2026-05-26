/**
 * argon2-params.ts — pinned argon2id parameters for cell_api_keys hashing
 * (W2.5 sprint-2 T-2.6, bead arrakis-ha0l).
 *
 * Materializes flatline IMP-008 (parameter pinning):
 *
 *   The cell_api_keys.key_hash column stores argon2id hashes of cell API
 *   keys. Hash-time parameters (memoryCost m, timeCost t, parallelism p)
 *   MUST be pinned at the application layer — NOT stored per-row — so
 *   every hash in the table was produced under the SAME parameter set.
 *
 *   The schema's CHECK constraint enforces the format prefix
 *   `$argon2id$v=19$` only; the argon2id encoded-hash format embeds m/t/p
 *   inline, so a verifier re-parses and CONFIRMS the pinned parameters at
 *   verify time (defense-in-depth). See migration 0003_cell_api_keys.up.sql
 *   §"IMP-008 parameter pinning" for the full reasoning.
 *
 * Pinned values:
 *   - memoryCost = 65536 KiB (64 MiB) — OWASP minimum for argon2id 2024.
 *   - timeCost = 3 — same OWASP recommendation; balances throughput vs cost.
 *   - parallelism = 1 — see §"Bun limitation" below. The T-2.6 task brief
 *     suggested p=4, but `Bun.password.hash` does NOT expose a parallelism
 *     option (Bun's libsodium wrapper hardcodes p=1). The verify path is
 *     also Bun-bound, so the pinned p=1 is the only value the cluster can
 *     internally produce + verify. If we ever migrate off Bun-bound hashing
 *     (e.g., to `argon2` npm), we MUST coordinate a hash-rotation migration
 *     before changing this value (forward-track arrakis-bbnu CRITICAL/950 +
 *     arrakis-1gqz).
 *
 * Bun limitation:
 *   `Bun.password.hash(secret, { algorithm: "argon2id", memoryCost, timeCost })`
 *   uses the libsodium-backed argon2id implementation which fixes parallelism
 *   at p=1. We cannot pass parallelism. The schema CHECK still accepts hashes
 *   with the canonical `$argon2id$v=19$m=...,t=...,p=1$...$...` prefix —
 *   verified empirically (`bun -e` round-trip).
 *
 * Rotation rule:
 *   Bumping any of these values requires:
 *     1. A migration that re-hashes every active cell_api_keys row under
 *        the new params (operator-driven; cells receive new keys via the
 *        side-channel revoke-then-issue flow).
 *     2. A coordinated cutover (NOT a flag flip) — the verify path uses
 *        these constants AND re-parses the stored hash; a hash produced
 *        under old params with new params in code would fail verify.
 *   This is out of T-2.6 scope; tracked at arrakis-bbnu CRITICAL/950 +
 *   arrakis-1gqz.
 */

/**
 * Pinned argon2id parameters for cell_api_keys hashing. Single source of
 * truth across hash + verify code paths. Frozen via `as const` so
 * downstream consumers cannot mutate values at runtime.
 */
export const ARGON2ID_PARAMS = {
  /** Memory cost in KiB. 65536 KiB = 64 MiB (OWASP argon2id 2024 minimum). */
  memoryCost: 65536,
  /** Iteration count. 3 = OWASP argon2id 2024 recommended baseline. */
  timeCost: 3,
  /**
   * Parallelism. Bun-bound to 1 (libsodium argon2id wrapper); see header
   * comment. The encoded-hash format records this as `p=1`.
   */
  parallelism: 1,
  /** Algorithm identifier expected by `Bun.password.hash`. */
  algorithm: 'argon2id' as const,
} as const;

/**
 * The format prefix every stored hash MUST start with. Matches migration
 * 0003_cell_api_keys.up.sql's `chk_cell_api_keys_argon2id` CHECK constraint.
 */
export const ARGON2ID_HASH_PREFIX = '$argon2id$v=19$';

/**
 * Options object suitable for direct pass-through to
 * `Bun.password.hash(secret, options)`. The shape matches Bun's argon2id
 * option surface: `{ algorithm, memoryCost, timeCost }`.
 */
export const BUN_PASSWORD_HASH_OPTIONS = {
  algorithm: ARGON2ID_PARAMS.algorithm,
  memoryCost: ARGON2ID_PARAMS.memoryCost,
  timeCost: ARGON2ID_PARAMS.timeCost,
} as const;
