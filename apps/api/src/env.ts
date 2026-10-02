import type { ProviderName, SportsProviderName } from '@cfb/shared';
import type { Services } from './services/context';

/** Bindings declared in `wrangler.toml` plus the two secrets. */
export interface Env {
  // Secrets (wrangler secret put / .dev.vars)
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;

  // Vars
  SPORTS_PROVIDER?: string | undefined;
  /**
   * "playoffstatus" | "mock". Who supplies the conference championship odds the
   * projection's conference terms are quoted from (`providers/playoffstatus/`).
   * Separate from `SPORTS_PROVIDER` so the two sources fail, drill, and mock
   * independently: FPI can be up while the scrape is down, and the reverse.
   */
  CONFERENCE_ODDS_PROVIDER?: string | undefined;
  ALLOWED_ORIGINS?: string | undefined;
  SEASON_OVERRIDE?: string | undefined;
  LOG_LEVEL?: string | undefined;
  /**
   * Development and test only: makes chosen provider calls fail, to exercise
   * the stale and unavailable paths (§39, §42) against either provider.
   * See `providers/faults.ts` for the syntax. Leave unset in production.
   *
   * It covers the odds publisher too (`projections`, `odds`), because a drill
   * wants one switch, not two.
   */
  SPORTS_PROVIDER_FAULT?: string | undefined;
  /** The User-Agent sent to ESPN. Unset means the default in `providers/espn/client.ts`. */
  ESPN_USER_AGENT?: string | undefined;
  /**
   * Public reads allowed per client address per minute, per isolate (plan
   * §5.3). Unset means 120; `off` disables it. See `middleware/rate-limit.ts`.
   */
  READ_RATE_LIMIT_PER_MINUTE?: string | undefined;

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
  /** Built on first use by `services/context.ts`. */
  services: Services;
}

export type AppBindings = { Bindings: Env; Variables: Variables };

export const APP_VERSION = '0.5.0';

/** `SPORTS_PROVIDER` is a string binding; narrow it rather than trusting it. */
export function providerName(env: Env): SportsProviderName {
  return env.SPORTS_PROVIDER === 'espn' ? 'espn' : 'mock';
}

/**
 * `CONFERENCE_ODDS_PROVIDER`, narrowed the same way. Unset means mock, so
 * nothing scrapes anybody's site until it is asked to.
 */
export function oddsProviderName(env: Env): ProviderName {
  return env.CONFERENCE_ODDS_PROVIDER === 'playoffstatus' ? 'playoffstatus' : 'mock';
}

/** Supabase issues tokens with this `iss` and this `aud`. */
export function supabaseIssuer(env: Env): string {
  return `${env.SUPABASE_URL.replace(/\/+$/, '')}/auth/v1`;
}

export const SUPABASE_AUDIENCE = 'authenticated';
