import type { TeamOwnersResponse } from '@cfb/shared';
import { Hono } from 'hono';
import { supabasePublic } from '../db/client';
import { listTeamOwners } from '../db/queries';
import type { AppBindings } from '../env';
import { servicesFor } from '../services/context';

/**
 * The pick index (plan-search-engine, Part Two, Phase 5): every board's picks,
 * inverted to provider team id → who has that team.
 *
 * It is one endpoint rather than a field on `/api/search/teams` because that
 * route is one keystroke away, and Phase 2 pins "no PostgREST request at all"
 * on it — which is what keeps typing free of Postgres latency and of a Postgres
 * outage. The whole index is ~54 rows, so the browser fetches it once per page
 * session and joins it onto results itself. The team page needs the same answer
 * anyway; a search-only field would be read twice.
 *
 * Named for the table it reads. Everything downstream is named for the answer
 * it gives (`TeamOwnersResponse`, `useTeamOwners`, `PickedBy`).
 *
 * Application-owned data, so there is no provider call, no freshness envelope
 * (§45), and no server-side cache: `/api/users` has none either. If this ever
 * becomes the constraint the pattern is an L1 entry plus `tiers.evictL1` on the
 * admin write, as the board composite does — not KV, which is for provider data.
 */
export const selectionRoutes = new Hono<AppBindings>();

/**
 * Five minutes, the same lifetime `/api/users` gives the list of boards. Board
 * membership changes only when an administrator changes it, and the admin's own
 * browser is primed by `refreshPublic` after a write.
 */
const OWNERS_MAX_AGE_SECONDS = 300;

selectionRoutes.get('/', async (c) => {
  // The namespace the `teams` rows were stored under, as `routes/admin.ts`
  // reads it for `storedTeam`. Building services costs nothing here: no
  // provider call is made, and this route must answer with the provider down.
  const namespace = servicesFor(c).provider.teamNamespace;
  const owners = await listTeamOwners(supabasePublic(c.env), namespace);

  // After the await, never before. A header set on the context is merged into
  // whatever response finally comes out, including the error handler's, so
  // setting it up front would pin a failed read in every browser for five
  // minutes (the Phase 2 finding, which has its own test on the search route).
  const body: TeamOwnersResponse = { owners };
  c.header('Cache-Control', `public, max-age=${String(OWNERS_MAX_AGE_SECONDS)}`);
  return c.json(body);
});
