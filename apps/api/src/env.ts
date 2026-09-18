import type { ProviderName } from '@cfb/shared';

/** Bindings declared in `wrangler.toml` plus the two secrets. */
export interface Env {
  // Secrets (wrangler secret put / .dev.vars)
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;

  // Vars
  SPORTS_PROVIDER?: string | undefined;
  ALLOWED_ORIGINS?: string | undefined;
  SEASON_OVERRIDE?: string | undefined;
  LOG_LEVEL?: string | undefined;

  // KV namespace — cache tier L3. Optional at the type level because unit tests
  // run without it and because the Worker must not hard-fail if it is unbound.
  SPORTS_KV?: KVNamespace | undefined;
}

export interface AdminIdentity {
  authUserId: string;
  /** The caller's own access token, passed through to PostgREST so RLS sees them. */
  accessToken: string;
}

export interface Variables {
  requestId: string;
  admin: AdminIdentity;
}

export type AppBindings = { Bindings: Env; Variables: Variables };

export const APP_VERSION = '0.1.0';

/** `SPORTS_PROVIDER` is a string binding; narrow it rather than trusting it. */
export function providerName(env: Env): ProviderName {
  return env.SPORTS_PROVIDER === 'espn' ? 'espn' : 'mock';
}

/** Supabase issues tokens with this `iss` and this `aud`. */
export function supabaseIssuer(env: Env): string {
  return `${env.SUPABASE_URL.replace(/\/+$/, '')}/auth/v1`;
}

export const SUPABASE_AUDIENCE = 'authenticated';
