import type { TeamDetailResponse, TeamScheduleResponse } from '@cfb/shared';
import { Hono } from 'hono';
import { supabasePublic } from '../db/client';
import { isUuid } from '../db/queries';
import type { AppBindings } from '../env';
import { setCacheHeaders } from '../http/cache-headers';
import { notFound } from '../http/errors';
import { servicesFor } from '../services/context';
import { getTeamDetail, getTeamSchedule } from '../services/team';

/**
 * Public team reads (§16, §17), keyed by our own team uuid. Identity always
 * comes back; the provider-owned half is an envelope that can be `stale` or
 * `unavailable` without failing the response (§42).
 */
export const teamRoutes = new Hono<AppBindings>();

teamRoutes.get('/:teamId', async (c) => {
  const teamId = c.req.param('teamId');
  if (!isUuid(teamId)) throw notFound('No such team.');

  const services = servicesFor(c);
  const { body, cacheStatus } = await getTeamDetail(services, supabasePublic(c.env), teamId);

  setCacheHeaders(c, body.snapshot.freshness, cacheStatus, services.now());
  return c.json(body satisfies TeamDetailResponse);
});

teamRoutes.get('/:teamId/schedule', async (c) => {
  const teamId = c.req.param('teamId');
  if (!isUuid(teamId)) throw notFound('No such team.');

  const services = servicesFor(c);
  const { body, cacheStatus } = await getTeamSchedule(services, supabasePublic(c.env), teamId);

  setCacheHeaders(c, body.schedule.freshness, cacheStatus, services.now());
  return c.json(body satisfies TeamScheduleResponse);
});
