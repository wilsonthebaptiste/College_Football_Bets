import { beforeAll, describe, expect, it } from 'vitest';
import { JwtError, peekKeyId, verifyJwt } from '../src/auth/jwt';
import {
  forgeAlgNoneToken,
  forgeHs256Token,
  generateSigningKey,
  nowSeconds,
  signToken,
  type SigningKeyPair,
} from './helpers/tokens';

const ISSUER = 'https://test-project.supabase.co/auth/v1';
const AUDIENCE = 'authenticated';

let ec: SigningKeyPair;
let rsa: SigningKeyPair;
let otherEc: SigningKeyPair;

beforeAll(async () => {
  [ec, rsa, otherEc] = await Promise.all([
    generateSigningKey('ES256', 'ec-key-1'),
    generateSigningKey('RS256', 'rsa-key-1'),
    generateSigningKey('ES256', 'ec-key-2'),
  ]);
});

function validClaims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sub: 'user-uuid-1',
    iss: ISSUER,
    aud: AUDIENCE,
    role: 'authenticated',
    email: 'admin@example.com',
    iat: nowSeconds() - 10,
    exp: nowSeconds() + 3600,
    ...overrides,
  };
}

const verifyWith = (token: string, keys: JsonWebKey[]): Promise<unknown> =>
  verifyJwt(token, { keys, issuer: ISSUER, audience: AUDIENCE });

async function expectRejection(token: string, keys: JsonWebKey[], reason: string): Promise<void> {
  await expect(verifyWith(token, keys)).rejects.toSatisfy(
    (error: unknown) => error instanceof JwtError && error.reason === reason,
    `expected a JwtError with reason "${reason}"`,
  );
}

describe('happy paths', () => {
  it('verifies an ES256 token — the algorithm Supabase issues by default', async () => {
    const token = await signToken(ec, validClaims());
    const verified = await verifyJwt(token, {
      keys: [ec.jwk],
      issuer: ISSUER,
      audience: AUDIENCE,
    });

    expect(verified.sub).toBe('user-uuid-1');
    expect(verified.email).toBe('admin@example.com');
    expect(verified.role).toBe('authenticated');
  });

  it('verifies an RS256 token', async () => {
    const token = await signToken(rsa, validClaims());
    const verified = await verifyJwt(token, {
      keys: [rsa.jwk],
      issuer: ISSUER,
      audience: AUDIENCE,
    });
    expect(verified.sub).toBe('user-uuid-1');
  });

  it('picks the right key out of a multi-key set by kid', async () => {
    const token = await signToken(ec, validClaims());
    const verified = await verifyJwt(token, {
      keys: [otherEc.jwk, rsa.jwk, ec.jwk],
      issuer: ISSUER,
      audience: AUDIENCE,
    });
    expect(verified.sub).toBe('user-uuid-1');
  });

  it('accepts an array audience that contains the expected value', async () => {
    const token = await signToken(ec, validClaims({ aud: ['authenticated', 'other'] }));
    await expect(verifyWith(token, [ec.jwk])).resolves.toBeDefined();
  });

  it('tolerates small clock skew', async () => {
    // Expired 10 seconds ago; default leeway is 30.
    const token = await signToken(ec, validClaims({ exp: nowSeconds() - 10 }));
    await expect(verifyWith(token, [ec.jwk])).resolves.toBeDefined();
  });
});

describe('algorithm confusion — the attacks the allowlist exists to stop', () => {
  it('rejects alg:none outright', async () => {
    await expectRejection(forgeAlgNoneToken(validClaims()), [ec.jwk], 'unsupported_algorithm');
  });

  it('rejects HS256 even when the "secret" is the published public key', async () => {
    // The classic key-confusion forgery: a verifier that trusts header.alg would
    // HMAC-verify against a value everyone can read from the JWKS endpoint.
    const publicMaterial = JSON.stringify(ec.jwk);
    const forged = await forgeHs256Token(validClaims(), publicMaterial);
    await expectRejection(forged, [ec.jwk], 'unsupported_algorithm');
  });

  it('rejects a token with no alg at all', async () => {
    const token = await signToken(ec, validClaims(), { alg: undefined });
    await expectRejection(token, [ec.jwk], 'unsupported_algorithm');
  });

  it('rejects an unexpected-but-real algorithm (ES512)', async () => {
    const token = await signToken(ec, validClaims(), { alg: 'ES512' });
    await expectRejection(token, [ec.jwk], 'unsupported_algorithm');
  });
});

describe('signature', () => {
  it('rejects a token signed by a key that is not in the set', async () => {
    const token = await signToken(otherEc, validClaims());
    await expectRejection(token, [ec.jwk, rsa.jwk], 'unknown_key');
  });

  it('rejects a payload tampered with after signing', async () => {
    const token = await signToken(ec, validClaims({ sub: 'harmless-user' }));
    const [header, , signature] = token.split('.');
    const tamperedPayload = btoa(JSON.stringify(validClaims({ sub: 'admin-user' })))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    await expectRejection(
      `${header ?? ''}.${tamperedPayload}.${signature ?? ''}`,
      [ec.jwk],
      'bad_signature',
    );
  });

  it('rejects a token whose kid points at the wrong key', async () => {
    // Signed by otherEc but claiming ec's kid: the key is found, and fails.
    const token = await signToken({ ...otherEc, kid: ec.kid }, validClaims());
    await expectRejection(token, [ec.jwk], 'bad_signature');
  });

  it('refuses to guess when a kid is absent and the key set is ambiguous', async () => {
    const token = await signToken(ec, validClaims(), { kid: undefined });
    await expectRejection(token, [ec.jwk, otherEc.jwk], 'unknown_key');
  });

  it('accepts a kid-less token when the key set holds exactly one usable key', async () => {
    const token = await signToken(ec, validClaims(), { kid: undefined });
    await expect(verifyWith(token, [ec.jwk])).resolves.toBeDefined();
  });
});

describe('claims', () => {
  it('rejects an expired token', async () => {
    await expectRejection(
      await signToken(ec, validClaims({ exp: nowSeconds() - 3600 })),
      [ec.jwk],
      'expired',
    );
  });

  it('rejects a token with no exp — a token that never expires is not acceptable', async () => {
    await expectRejection(
      await signToken(ec, validClaims({ exp: undefined })),
      [ec.jwk],
      'expired',
    );
  });

  it('rejects a token from a different Supabase project', async () => {
    await expectRejection(
      await signToken(ec, validClaims({ iss: 'https://someone-elses.supabase.co/auth/v1' })),
      [ec.jwk],
      'wrong_issuer',
    );
  });

  it('rejects a wrong audience', async () => {
    await expectRejection(
      await signToken(ec, validClaims({ aud: 'service_role' })),
      [ec.jwk],
      'wrong_audience',
    );
  });

  it('rejects a not-yet-valid token', async () => {
    await expectRejection(
      await signToken(ec, validClaims({ nbf: nowSeconds() + 3600 })),
      [ec.jwk],
      'not_yet_valid',
    );
  });

  it('rejects a token issued in the future', async () => {
    await expectRejection(
      await signToken(ec, validClaims({ iat: nowSeconds() + 3600 })),
      [ec.jwk],
      'not_yet_valid',
    );
  });

  it('rejects a token with no subject', async () => {
    await expectRejection(
      await signToken(ec, validClaims({ sub: undefined })),
      [ec.jwk],
      'missing_subject',
    );
  });
});

describe('malformed input never throws something unexpected', () => {
  it.each([
    ['', 'empty string'],
    ['not-a-jwt', 'no dots'],
    ['a.b', 'two segments'],
    ['a.b.c.d', 'four segments'],
    ['..', 'empty segments'],
    ['!!!.###.$$$', 'illegal base64url'],
    ['eyJhbGciOiJFUzI1NiJ9.bm90LWpzb24.sig', 'payload is not JSON'],
  ])('rejects %j (%s) as a JwtError', async (token) => {
    await expect(verifyWith(token, [ec.jwk])).rejects.toBeInstanceOf(JwtError);
  });
});

describe('peekKeyId', () => {
  it('reads the kid without verifying anything', async () => {
    expect(peekKeyId(await signToken(ec, validClaims()))).toBe('ec-key-1');
  });

  it('returns null for garbage rather than throwing', () => {
    expect(peekKeyId('garbage')).toBeNull();
    expect(peekKeyId('')).toBeNull();
    expect(peekKeyId(forgeAlgNoneToken({ sub: 'x' }))).toBeNull();
  });
});
