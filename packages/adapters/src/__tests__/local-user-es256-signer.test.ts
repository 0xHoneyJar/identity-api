/**
 * LocalUserEs256Signer + dual-plane JWKS (D-JWT-001).
 */

import { afterEach, describe, expect, it } from 'bun:test';
import {
  __generateTestEs256KeyMaterial,
  buildJwksDocumentFromEnv,
  buildUserJwksDocumentFromEnv,
  createLocalUserEs256Signer,
  createLocalUserEs256SignerFromEnv,
  exportUserPublicJwk,
} from '../local-es256-signer';
import { decodeProtectedHeader, importJWK, jwtVerify, type JWK } from 'jose';

const ENV_KEYS = [
  'USER_JWT_SIGNING_KEY_PEM',
  'USER_JWT_SIGNING_KEY_KID',
  'USER_JWT_SIGNING_KEY_PEM_PREV',
  'USER_JWT_SIGNING_KEY_KID_PREV',
  'SVC_JWT_SIGNING_KEY_PEM',
  'SVC_JWT_SIGNING_KEY_KID',
] as const;

afterEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
});

describe('createLocalUserEs256Signer', () => {
  it('rejects kids that do not start with user-', async () => {
    const { pkcs8Pem } = await __generateTestEs256KeyMaterial();
    await expect(
      createLocalUserEs256Signer({ pkcs8Pem, kid: 'svc-not-allowed' }),
    ).rejects.toThrow(/must start with "user-"/);
  });

  it('signs ES256 with user- kid in protected header', async () => {
    const { pkcs8Pem } = await __generateTestEs256KeyMaterial();
    const kid = 'user-2026-07-19-a';
    const signer = await createLocalUserEs256Signer({ pkcs8Pem, kid });
    expect(signer.kid).toBe(kid);

    const now = Math.floor(Date.now() / 1000);
    const token = await signer.sign({
      sub: '00000000-0000-4000-8000-000000000001',
      iss: 'identity-api',
      aud: 'freeside',
      iat: now,
      exp: now + 3600,
      jti: crypto.randomUUID(),
      v: 1,
    });

    const header = decodeProtectedHeader(token);
    expect(header.alg).toBe('ES256');
    expect(header.kid).toBe(kid);

    const pub = (await exportUserPublicJwk(pkcs8Pem, kid)) as JWK;
    const key = await importJWK(pub, 'ES256');
    const { payload } = await jwtVerify(token, key, { algorithms: ['ES256'] });
    expect(payload.sub).toBe('00000000-0000-4000-8000-000000000001');
    expect(payload.iss).toBe('identity-api');
  });
});

describe('createLocalUserEs256SignerFromEnv', () => {
  it('throws when USER_JWT_SIGNING_KEY_* unset', async () => {
    await expect(createLocalUserEs256SignerFromEnv()).rejects.toThrow(
      /USER_JWT_SIGNING_KEY_PEM/,
    );
  });

  it('builds signer from env', async () => {
    const { pkcs8Pem } = await __generateTestEs256KeyMaterial();
    process.env.USER_JWT_SIGNING_KEY_PEM = pkcs8Pem;
    process.env.USER_JWT_SIGNING_KEY_KID = 'user-env-test';
    const signer = await createLocalUserEs256SignerFromEnv();
    expect(signer.kid).toBe('user-env-test');
  });
});

describe('buildJwksDocumentFromEnv dual-plane', () => {
  it('includes user + svc keys (user first)', async () => {
    const user = await __generateTestEs256KeyMaterial();
    const svc = await __generateTestEs256KeyMaterial();
    process.env.USER_JWT_SIGNING_KEY_PEM = user.pkcs8Pem;
    process.env.USER_JWT_SIGNING_KEY_KID = 'user-jwks-a';
    process.env.SVC_JWT_SIGNING_KEY_PEM = svc.pkcs8Pem;
    process.env.SVC_JWT_SIGNING_KEY_KID = 'svc-jwks-a';

    const doc = await buildJwksDocumentFromEnv();
    expect(doc.keys).toHaveLength(2);
    expect(doc.keys[0]?.kid).toBe('user-jwks-a');
    expect(doc.keys[1]?.kid).toBe('svc-jwks-a');
    expect(doc.keys[0]?.alg).toBe('ES256');
    expect(doc.keys[1]?.alg).toBe('ES256');
  });

  it('buildUserJwksDocumentFromEnv excludes svc keys', async () => {
    const user = await __generateTestEs256KeyMaterial();
    const svc = await __generateTestEs256KeyMaterial();
    process.env.USER_JWT_SIGNING_KEY_PEM = user.pkcs8Pem;
    process.env.USER_JWT_SIGNING_KEY_KID = 'user-only';
    process.env.SVC_JWT_SIGNING_KEY_PEM = svc.pkcs8Pem;
    process.env.SVC_JWT_SIGNING_KEY_KID = 'svc-hidden';

    const userDoc = await buildUserJwksDocumentFromEnv();
    expect(userDoc.keys).toHaveLength(1);
    expect(userDoc.keys[0]?.kid).toBe('user-only');
  });

  it('includes PREV user key during rotation overlap', async () => {
    const active = await __generateTestEs256KeyMaterial();
    const prev = await __generateTestEs256KeyMaterial();
    process.env.USER_JWT_SIGNING_KEY_PEM = active.pkcs8Pem;
    process.env.USER_JWT_SIGNING_KEY_KID = 'user-new';
    process.env.USER_JWT_SIGNING_KEY_PEM_PREV = prev.pkcs8Pem;
    process.env.USER_JWT_SIGNING_KEY_KID_PREV = 'user-prev';

    const doc = await buildUserJwksDocumentFromEnv();
    expect(doc.keys.map((k) => k.kid)).toEqual(['user-new', 'user-prev']);
  });
});
