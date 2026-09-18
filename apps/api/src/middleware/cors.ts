import { cors } from 'hono/cors';
import { createMiddleware } from 'hono/factory';
import type { AppBindings } from '../env';

export function parseAllowedOrigins(raw: string | undefined): string[] {
  if (raw === undefined) return [];
  return raw
    .split(',')
    .map((value) => value.trim().replace(/\/+$/, ''))
    .filter((value) => value.length > 0);
}

/**
 * CORS allowlist, read from `ALLOWED_ORIGINS` at request time because Worker env
 * is per-request, not module scope.
 *
 * Read routes are public (plan §11.1), so CORS is not a security control here —
 * it is hygiene. The control that matters is on writes, and it lives in the
 * database (§31).
 */
export const corsMiddleware = createMiddleware<AppBindings>((c, next) => {
  const allowed = parseAllowedOrigins(c.env.ALLOWED_ORIGINS);
  const allowAny = allowed.includes('*');

  return cors({
    origin: (origin) => {
      if (allowAny) return origin;
      return allowed.includes(origin.replace(/\/+$/, '')) ? origin : null;
    },
    allowMethods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Authorization', 'Content-Type', 'X-Request-Id'],
    exposeHeaders: ['X-Request-Id', 'X-Cache'],
    maxAge: 86400,
  })(c, next);
});
