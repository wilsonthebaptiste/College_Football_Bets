/**
 * Real signing keys and real JWTs for the auth tests.
 *
 * Nothing here is mocked: `verifyJwt` runs against genuine WebCrypto signatures.
 * A test that stubs out the crypto proves only that the stub works, and the
 * whole point of `auth/jwt.ts` is the crypto.
 */

const encoder = new TextEncoder();

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function encodeJson(value: unknown): string {
  return base64UrlEncode(encoder.encode(JSON.stringify(value)));
}

export interface SigningKeyPair {
  kid: string;
  algorithm: 'ES256' | 'RS256';
  privateKey: CryptoKey;
  /** Public JWK, shaped the way a JWKS endpoint would return it. */
  jwk: JsonWebKey & { kid: string; use: string; alg: string };
}

export async function generateSigningKey(
  algorithm: 'ES256' | 'RS256',
  kid: string,
): Promise<SigningKeyPair> {
  const params =
    algorithm === 'ES256'
      ? { name: 'ECDSA', namedCurve: 'P-256' }
      : {
          name: 'RSASSA-PKCS1-v1_5',
          modulusLength: 2048,
          publicExponent: new Uint8Array([1, 0, 1]),
          hash: 'SHA-256',
        };

  const pair = (await crypto.subtle.generateKey(params, true, ['sign', 'verify'])) as CryptoKeyPair;
  // Workers' types return `ArrayBuffer | JsonWebKey` for every format; 'jwk' is
  // always the latter.
  const jwk = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as JsonWebKey;

  // Real JWKS entries carry these, and carrying them here is deliberate: it is
  // what proves `minimalJwk()` strips the fields WebCrypto would otherwise
  // reject on import.
  return {
    kid,
    algorithm,
    privateKey: pair.privateKey,
    jwk: { ...jwk, kid, use: 'sig', alg: algorithm },
  };
}

export interface TokenClaims {
  sub?: string;
  iss?: string;
  aud?: string | string[];
  exp?: number;
  iat?: number;
  nbf?: number;
  email?: string;
  role?: string;
}

export async function signToken(
  key: SigningKeyPair,
  claims: TokenClaims,
  headerOverrides: Record<string, unknown> = {},
): Promise<string> {
  const header = encodeJson({ alg: key.algorithm, kid: key.kid, typ: 'JWT', ...headerOverrides });
  const payload = encodeJson(claims);

  const signature = await crypto.subtle.sign(
    key.algorithm === 'ES256' ? { name: 'ECDSA', hash: 'SHA-256' } : { name: 'RSASSA-PKCS1-v1_5' },
    key.privateKey,
    encoder.encode(`${header}.${payload}`),
  );

  return `${header}.${payload}.${base64UrlEncode(new Uint8Array(signature))}`;
}

/** An unsigned token claiming `alg: none` — the oldest JWT attack there is. */
export function forgeAlgNoneToken(claims: TokenClaims): string {
  return `${encodeJson({ alg: 'none', typ: 'JWT' })}.${encodeJson(claims)}.`;
}

/**
 * An HS256 token whose "secret" is the public key material.
 *
 * This is the key-confusion attack: a verifier that trusts `header.alg` would
 * treat a public value as a shared secret, and anyone holding the JWKS (i.e.
 * anyone) could mint valid tokens.
 */
export async function forgeHs256Token(claims: TokenClaims, secret: string): Promise<string> {
  const header = encodeJson({ alg: 'HS256', typ: 'JWT' });
  const payload = encodeJson(claims);
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(`${header}.${payload}`));
  return `${header}.${payload}.${base64UrlEncode(new Uint8Array(signature))}`;
}

export const nowSeconds = (): number => Math.floor(Date.now() / 1000);
