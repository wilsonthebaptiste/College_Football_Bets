import type { TeamSearchResponse } from '@cfb/shared';
import { Hono } from 'hono';
import type { AppBindings } from '../env';
import { servicesFor } from '../services/context';
import { parseQuery, searchTeams } from '../services/search';

/**
 * Public team search (plan-search-engine, Phase 2), so any visitor can look up
 * any team the provider lists — not only the 54 that sit on somebody's board.
 *
 * It is `/api/search/teams` rather than `/api/teams/search` because since
 * Phase 1 that second segment IS the provider's team id namespace
 * (`/api/teams/:teamId`). Hono matches the static segment first, so the other
 * spelling would work by luck while making a team whose provider id was
 * literally `search` permanently unreachable.
 *
 * The ranking, the list, the 20-result ceiling and the 2–60 character bounds
 * are `services/search.ts`, shared verbatim with the admin console's own
 * search. Nothing here is admin-specific, and nothing here is public-specific
 * either: the two routes differ only in who may ask and how long the answer
 * lives.
 */
export const searchRoutes = new Hono<AppBindings>();

/**
 * Five minutes. Unlike a board or a team page this response carries no
 * `Freshness` of its own to derive a lifetime from — it is identity, from a
 * list with a one-day TTL — and five minutes is what makes a person's
 * backtracking over a prefix free in their own browser cache rather than a
 * fresh Worker request per keystroke (plan-search-engine, Risks).
 */
const SEARCH_MAX_AGE_SECONDS = 300;

searchRoutes.get('/teams', async (c) => {
  const query = parseQuery(c.req.query('q'));
  const teams = await searchTeams(servicesFor(c), query);

  // After the await, never before. A header set on the context is merged into
  // whatever response finally comes out, including the error handler's, so
  // setting it up front would tell browsers and the edge to keep a 503 for
  // five minutes — pinning an outage long after it ended.
  const body: TeamSearchResponse = { teams };
  c.header('Cache-Control', `public, max-age=${String(SEARCH_MAX_AGE_SECONDS)}`);
  return c.json(body);
});
