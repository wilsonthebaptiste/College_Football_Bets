import type { TeamDetailResponse, TeamScheduleResponse } from '@cfb/shared';
import { Hono } from 'hono';
import { supabasePublic } from '../db/client';
import type { AppBindings } from '../env';
import { setCacheHeaders } from '../http/cache-headers';
import { servicesFor } from '../services/context';
import { getTeamDetail, getTeamSchedule } from '../services/team';

/**
 * Public team reads (§16, §17). `:teamId` is either our own team uuid or the
 * provider's team id, so a team nobody has put on a board still has a page.
 * Which is which — and the 404 for neither — is `resolveTeam`'s business:
 * these routes hold no knowledge of id shapes.
 *
 * Identity always comes back; the provider-owned half is an envelope that can
 * be `stale` or `unavailable` without failing the response (§42).
 */
export const teamRoutes = new Hono<AppBindings>();

teamRoutes.get('/:teamId', async (c) => {
  const teamId = c.req.param('teamId');
  const services = servicesFor(c);
  const { body, cacheStatus } = await getTeamDetail(services, () => supabasePublic(c.env), teamId);

  setCacheHeaders(c, body.snapshot.freshness, cacheStatus, services.now());
  return c.json(body satisfies TeamDetailResponse);
});

teamRoutes.get('/:teamId/schedule', async (c) => {
  const teamId = c.req.param('teamId');
  const services = servicesFor(c);
  const { body, cacheStatus } = await getTeamSchedule(
    services,
    () => supabasePublic(c.env),
    teamId,
  );

  setCacheHeaders(c, body.schedule.freshness, cacheStatus, services.now());
  return c.json(body satisfies TeamScheduleResponse);
});
