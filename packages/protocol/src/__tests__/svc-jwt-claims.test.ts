/**
 * Tests for SvcJwtClaims + SvcJwtHeader Effect.Schema (W2.5 sprint-2 T-2.1).
 *
 * Substrate-grade tests for the cluster-shared svc-JWT claim/header
 * schemas (D-1.1 §1, `grimoires/svc-jwt-spec.md`). Covers the schema's
 * own responsibilities — round-trip parse + required-field presence +
 * primitive types + the two header invariants (`alg = "ES256"`,
 * `kid` startsWith `"svc-"`). Claim-value semantics (issuer
 * allowlist, exp-window arithmetic, role allowlist) live in the
 * verifier (D-1.1 §5) and are out of scope here.
 *
 * Sibling test reference: `./jwt-claims.test.ts` (W2 user-JWT, zod).
 */

import { describe, expect, it } from 'bun:test';
import { Schema as S } from '@effect/schema';
import {
  SvcJwtClaims,
  SvcJwtHeader,
  type SvcJwtClaims as SvcJwtClaimsT,
  type SvcJwtHeader as SvcJwtHeaderT,
} from '../svc-jwt-claims';

const decodeClaims = S.decodeUnknownSync(SvcJwtClaims);
const decodeHeader = S.decodeUnknownSync(SvcJwtHeader);

const validClaims: SvcJwtClaimsT = {
  iss: 'https://identity.0xhoneyjar.xyz',
  aud: 'mint-api',
  sub: 'activities-api',
  exp: Math.floor(Date.now() / 1000) + 3600,
  nbf: Math.floor(Date.now() / 1000),
  role: 'mint.invoke',
  jti: 'Yp3Q5w8aLm9N2bV4xT6sKg',
};

const validHeader: SvcJwtHeaderT = {
  alg: 'ES256',
  typ: 'JWT',
  kid: 'svc-2026-05-26-a',
};

describe('SvcJwtClaims (D-1.1 §1)', () => {
  it('round-trips a valid claim object', () => {
    const parsed = decodeClaims(validClaims);
    expect(parsed).toEqual(validClaims);
  });

  it('rejects missing required field (jti)', () => {
    const { jti: _jti, ...missingJti } = validClaims;
    void _jti;
    expect(() => decodeClaims(missingJti)).toThrow();
  });

  it('rejects missing required field (role)', () => {
    const { role: _role, ...missingRole } = validClaims;
    void _role;
    expect(() => decodeClaims(missingRole)).toThrow();
  });

  it('rejects wrong type (exp as string)', () => {
    const wrongExpType = { ...validClaims, exp: '1717000000' as unknown as number };
    expect(() => decodeClaims(wrongExpType)).toThrow();
  });

  it('rejects wrong type (sub as number)', () => {
    const wrongSubType = { ...validClaims, sub: 42 as unknown as string };
    expect(() => decodeClaims(wrongSubType)).toThrow();
  });

  it('rejects null where string required (aud)', () => {
    const nullAud = { ...validClaims, aud: null as unknown as string };
    expect(() => decodeClaims(nullAud)).toThrow();
  });
});

describe('SvcJwtHeader (D-1.1 §1 header constraint)', () => {
  it('round-trips a valid svc- header', () => {
    const parsed = decodeHeader(validHeader);
    expect(parsed).toEqual(validHeader);
  });

  it('rejects kid with user- prefix (kid-confusion attack class)', () => {
    const userKid = { ...validHeader, kid: 'user-2026-05-26-a' };
    expect(() => decodeHeader(userKid)).toThrow();
  });

  it('rejects kid with arbitrary prefix', () => {
    const wrongKid = { ...validHeader, kid: 'admin-2026-05-26-a' };
    expect(() => decodeHeader(wrongKid)).toThrow();
  });

  it('rejects alg = HS256 (only ES256 allowed)', () => {
    const wrongAlg = { ...validHeader, alg: 'HS256' as unknown as 'ES256' };
    expect(() => decodeHeader(wrongAlg)).toThrow();
  });

  it('rejects alg = RS256 (only ES256 allowed)', () => {
    const wrongAlg = { ...validHeader, alg: 'RS256' as unknown as 'ES256' };
    expect(() => decodeHeader(wrongAlg)).toThrow();
  });

  it('rejects typ != JWT', () => {
    const wrongTyp = { ...validHeader, typ: 'JWS' as unknown as 'JWT' };
    expect(() => decodeHeader(wrongTyp)).toThrow();
  });

  it('rejects missing kid', () => {
    const { kid: _kid, ...missingKid } = validHeader;
    void _kid;
    expect(() => decodeHeader(missingKid)).toThrow();
  });
});
