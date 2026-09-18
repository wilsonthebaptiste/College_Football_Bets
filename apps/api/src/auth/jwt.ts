/**
 * JWS verification against a JWKS, using WebCrypto only.
 *
 * Hand-written rather than pulled from a library because the set of decisions
 * that matter here is small, security-critical, and worth being able to read in
 * one sitting:
 *
 *   1. The algorithm comes from OUR allowlist, never from the token's header.
 *      `alg: none` and HMAC algorithms are refused outright — accepting HS256
 *      while holding an RSA public key is the classic key-confusion forgery.
 *   2. Signature is verified BEFORE any claim is read.
 *   3. `exp` is required. A token without one does not expire, which is not a
 *      thing we are willing to accept.
 *   4. `iss` must match the project exactly, so a token minted by some other
 *      Supabase project is not a valid token here.
 */

export type JwtFailureReason =
  | 'malformed'
  | 'unsupported_algorithm'
  | 'unknown_key'
  | 'bad_signature'
  | 'expired'
  | 'not_yet_valid'
  | 'wrong_issuer'
  | 'wrong_audience'
  | 'missing_subject';

export class JwtError extends Error {
  readonly reason: JwtFailureReason;

  constructor(reason: JwtFailureReason, message: string) {
    super(message);
    this.name = 'JwtError';
    this.reason = reason;
  }
}

/** The only signature algorithms this application will verify. */
const ALLOWED_ALGORITHMS = ['RS256', 'ES256'] as const;
type AllowedAlgorithm = (typeof ALLOWED_ALGORITHMS)[number];

function isAllowedAlgorithm(value: unknown): value is AllowedAlgorithm {
  return typeof value === 'string' && (ALLOWED_ALGORITHMS as readonly string[]).includes(value);
}

interface JwtHeader {
  alg?: unknown;
  kid?: unknown;
  typ?: unknown;
}

export interface JwtClaims {
  sub?: unknown;
  iss?: unknown;
  aud?: unknown;
  exp?: unknown;
  nbf?: unknown;
  iat?: unknown;
  email?: unknown;
  role?: unknown;
}

export interface VerifiedJwt {
  sub: string;
  email: string | null;
  role: string | null;
  expiresAt: Date;
  claims: JwtClaims;
}

export interface VerifyOptions {
  keys: readonly JsonWebKey[];
  issuer: string;
  audience: string;
  now?: Date;
  /** Clock skew tolerance, both directions. */
  leewaySeconds?: number;
}

// ─── base64url ───────────────────────────────────────────────────────────────

const BASE64URL_RE = /^[A-Za-z0-9_-]*$/;

function base64UrlToBytes(input: string): Uint8Array {
  if (!BASE64URL_RE.test(input)) {
    throw new JwtError('malformed', 'Token contains non-base64url characters.');
  }
  const base64 = input.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);

  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    throw new JwtError('malformed', 'Token segment is not valid base64url.');
  }

  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function base64UrlToJson<T>(input: string): T {
  const text = new TextDecoder().decode(base64UrlToBytes(input));
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new JwtError('malformed', 'Token segment is not valid JSON.');
  }
}

// ─── Key import ──────────────────────────────────────────────────────────────

/**
 * Rebuilds a minimal JWK from the JWKS entry.
 *
 * Copying the whole entry would drag `use`, `alg`, and `key_ops` along, and
 * WebCrypto rejects the import if any of them disagrees with the usage we ask
 * for. Taking only the key material sidesteps a class of "works with one
 * provider, fails with the next" bugs.
 */
function minimalJwk(jwk: JsonWebKey, algorithm: AllowedAlgorithm): JsonWebKey {
  const minimal: JsonWebKey = { kty: jwk.kty };
  if (algorithm === 'ES256') {
    if (jwk.crv !== undefined) minimal.crv = jwk.crv;
    if (jwk.x !== undefined) minimal.x = jwk.x;
    if (jwk.y !== undefined) minimal.y = jwk.y;
  } else {
    if (jwk.n !== undefined) minimal.n = jwk.n;
    if (jwk.e !== undefined) minimal.e = jwk.e;
  }
  return minimal;
}

// Derived from the runtime's own signatures rather than named outright, because
// the WebCrypto algorithm types are spelled differently in @cloudflare/workers-types
// and lib.dom, and this module has to compile against both.
type ImportAlgorithm = Parameters<SubtleCrypto['importKey']>[2];
type VerifyAlgorithm = Parameters<SubtleCrypto['verify']>[0];

function importParams(algorithm: AllowedAlgorithm): ImportAlgorithm {
  return algorithm === 'ES256'
    ? { name: 'ECDSA', namedCurve: 'P-256' }
    : { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' };
}

function verifyParams(algorithm: AllowedAlgorithm): VerifyAlgorithm {
  return algorithm === 'ES256' ? { name: 'ECDSA', hash: 'SHA-256' } : { name: 'RSASSA-PKCS1-v1_5' };
}

function expectedKty(algorithm: AllowedAlgorithm): string {
  return algorithm === 'ES256' ? 'EC' : 'RSA';
}

interface JwkWithId extends JsonWebKey {
  kid?: string;
}

function findKey(
  keys: readonly JsonWebKey[],
  kid: string | null,
  algorithm: AllowedAlgorithm,
): JsonWebKey {
  const candidates = keys.filter((key) => key.kty === expectedKty(algorithm));

  if (kid !== null) {
    const match = candidates.find((key) => (key as JwkWithId).kid === kid);
    if (match !== undefined) return match;
    throw new JwtError('unknown_key', 'Token was signed with an unrecognized key.');
  }

  // No `kid`: only unambiguous if the key set holds exactly one usable key.
  const only = candidates[0];
  if (candidates.length === 1 && only !== undefined) return only;
  throw new JwtError('unknown_key', 'Token has no key id and the key set is ambiguous.');
}

// ─── Claim checks ────────────────────────────────────────────────────────────

function asFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function audienceMatches(aud: unknown, expected: string): boolean {
  if (typeof aud === 'string') return aud === expected;
  if (Array.isArray(aud)) return aud.some((entry) => entry === expected);
  return false;
}

// ─── Verification ────────────────────────────────────────────────────────────

export async function verifyJwt(token: string, options: VerifyOptions): Promise<VerifiedJwt> {
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new JwtError('malformed', 'Token is not a three-part JWS.');
  }
  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  if (
    encodedHeader === undefined ||
    encodedPayload === undefined ||
    encodedSignature === undefined ||
    encodedHeader === '' ||
    encodedPayload === ''
  ) {
    throw new JwtError('malformed', 'Token has an empty segment.');
  }

  const header = base64UrlToJson<JwtHeader>(encodedHeader);

  // (1) Algorithm allowlist. This check is what makes `alg: none` and HS256
  // key-confusion attempts fail closed. It runs before the empty-signature check
  // below so that an `alg: none` token — which by definition has an empty
  // signature — is logged as the attack it is rather than as a typo.
  if (!isAllowedAlgorithm(header.alg)) {
    throw new JwtError(
      'unsupported_algorithm',
      `Unsupported token algorithm: ${typeof header.alg === 'string' ? header.alg : 'missing'}.`,
    );
  }
  if (encodedSignature === '') {
    throw new JwtError('malformed', 'Token has no signature.');
  }
  const algorithm: AllowedAlgorithm = header.alg;
  const kid = typeof header.kid === 'string' ? header.kid : null;

  const jwk = findKey(options.keys, kid, algorithm);

  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey(
      'jwk',
      minimalJwk(jwk, algorithm),
      importParams(algorithm),
      false,
      ['verify'],
    );
  } catch (cause) {
    throw new JwtError(
      'unknown_key',
      `Key from the key set could not be imported: ${cause instanceof Error ? cause.message : 'unknown'}`,
    );
  }

  // (2) Signature first. Nothing below this line trusts the payload until it passes.
  const signingInput = new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`);
  const signature = base64UrlToBytes(encodedSignature);
  const signatureValid = await crypto.subtle.verify(
    verifyParams(algorithm),
    key,
    signature,
    signingInput,
  );
  if (!signatureValid) {
    throw new JwtError('bad_signature', 'Token signature is not valid.');
  }

  const claims = base64UrlToJson<JwtClaims>(encodedPayload);
  const nowSeconds = Math.floor((options.now?.getTime() ?? Date.now()) / 1000);
  const leeway = options.leewaySeconds ?? 30;

  // (3) Expiry is mandatory.
  const exp = asFiniteNumber(claims.exp);
  if (exp === null) {
    throw new JwtError('expired', 'Token has no expiry.');
  }
  if (nowSeconds > exp + leeway) {
    throw new JwtError('expired', 'Session has expired.');
  }

  const nbf = asFiniteNumber(claims.nbf);
  if (nbf !== null && nowSeconds < nbf - leeway) {
    throw new JwtError('not_yet_valid', 'Token is not valid yet.');
  }

  const iat = asFiniteNumber(claims.iat);
  if (iat !== null && nowSeconds < iat - leeway) {
    throw new JwtError('not_yet_valid', 'Token was issued in the future.');
  }

  // (4) Issuer must be this exact project.
  if (claims.iss !== options.issuer) {
    throw new JwtError('wrong_issuer', 'Token was issued by a different project.');
  }

  if (!audienceMatches(claims.aud, options.audience)) {
    throw new JwtError('wrong_audience', 'Token audience does not match.');
  }

  if (typeof claims.sub !== 'string' || claims.sub === '') {
    throw new JwtError('missing_subject', 'Token has no subject.');
  }

  return {
    sub: claims.sub,
    email: typeof claims.email === 'string' ? claims.email : null,
    role: typeof claims.role === 'string' ? claims.role : null,
    expiresAt: new Date(exp * 1000),
    claims,
  };
}

/** Reads the `kid` without verifying anything. Used only to decide on a JWKS refresh. */
export function peekKeyId(token: string): string | null {
  const encodedHeader = token.split('.')[0];
  if (encodedHeader === undefined || encodedHeader === '') return null;
  try {
    const header = base64UrlToJson<JwtHeader>(encodedHeader);
    return typeof header.kid === 'string' ? header.kid : null;
  } catch {
    return null;
  }
}
