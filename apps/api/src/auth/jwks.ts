import type { Env } from '../env';

/**
 * Supabase's public signing keys, cached so that admin requests do not pay for a
 * network round trip each time.
 *
 * Two tiers, matching §7's cache design:
 *   L1 — module scope, lives as long as the isolate. Free, and the common case.
 *   L3 — Workers KV, 24 h. Survives isolate churn. Well above the 300 s floor
 *        that `cache/tiers.ts` will enforce in Phase 2, so it is a legal write.
 *
 * Public keys, so caching them is not a secrecy question — only a freshness one,
 * and key rotation is handled by `forceRefresh` on an unknown `kid`.
 */

export interface JsonWebKeySet {
  keys: JsonWebKey[];
}

interface CachedKeySet {
  keys: JsonWebKey[];
  storedAtMs: number;
}

const L1_TTL_MS = 10 * 60 * 1000;
const L3_TTL_SECONDS = 24 * 60 * 60;
const KV_KEY_PREFIX = 'jwks:v1:';
const FETCH_TIMEOUT_MS = 5_000;

/** Keyed by issuer so a config change cannot serve the wrong project's keys. */
const l1 = new Map<string, CachedKeySet>();

export function jwksUrl(supabaseUrl: string): string {
  return `${supabaseUrl.replace(/\/+$/, '')}/auth/v1/.well-known/jwks.json`;
}

function isJsonWebKeySet(value: unknown): value is JsonWebKeySet {
  if (typeof value !== 'object' || value === null) return false;
  const keys = (value as { keys?: unknown }).keys;
  return Array.isArray(keys) && keys.every((key) => typeof key === 'object' && key !== null);
}

async function fetchKeySet(supabaseUrl: string): Promise<JsonWebKey[]> {
  const response = await fetch(jwksUrl(supabaseUrl), {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`JWKS endpoint returned ${String(response.status)}`);
  }

  const body: unknown = await response.json();
  if (!isJsonWebKeySet(body)) {
    throw new Error('JWKS endpoint returned an unexpected shape');
  }
  if (body.keys.length === 0) {
    // A Supabase project still on the legacy shared HS256 secret publishes an
    // empty key set. That is a configuration problem, not a transient one, and
    // it should be loud. See docs/supabase-setup.md.
    throw new Error(
      'JWKS endpoint returned no keys — the Supabase project is probably still using a legacy HS256 JWT secret. Migrate it to an asymmetric signing key (ECC/P-256).',
    );
  }
  return body.keys;
}

export interface GetJwksOptions {
  /** Set when a token's `kid` was not found, to pick up a rotated key. */
  forceRefresh?: boolean;
}

export async function getSigningKeys(
  env: Env,
  options: GetJwksOptions = {},
): Promise<readonly JsonWebKey[]> {
  const issuerKey = env.SUPABASE_URL.replace(/\/+$/, '');
  const kvKey = `${KV_KEY_PREFIX}${issuerKey}`;
  const now = Date.now();

  if (options.forceRefresh !== true) {
    const memo = l1.get(issuerKey);
    if (memo !== undefined && now - memo.storedAtMs < L1_TTL_MS) {
      return memo.keys;
    }

    if (env.SPORTS_KV !== undefined) {
      const stored = await env.SPORTS_KV.get(kvKey, 'json').catch(() => null);
      if (isJsonWebKeySet(stored) && stored.keys.length > 0) {
        l1.set(issuerKey, { keys: stored.keys, storedAtMs: now });
        return stored.keys;
      }
    }
  }

  const keys = await fetchKeySet(env.SUPABASE_URL);
  l1.set(issuerKey, { keys, storedAtMs: now });

  if (env.SPORTS_KV !== undefined) {
    await env.SPORTS_KV.put(kvKey, JSON.stringify({ keys }), {
      expirationTtl: L3_TTL_SECONDS,
    }).catch(() => undefined);
  }

  return keys;
}

/** Test seam — the L1 memo is module scope and would otherwise leak across tests. */
export function resetJwksCache(): void {
  l1.clear();
}
