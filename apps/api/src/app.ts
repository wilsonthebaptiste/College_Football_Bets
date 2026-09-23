import { Hono } from 'hono';
import type { AppBindings } from './env';
import { corsMiddleware } from './middleware/cors';
import { notFoundHandler, onError } from './middleware/errors';
import { readRateLimit } from './middleware/rate-limit';
import { requestId } from './middleware/request-id';
import { adminRoutes } from './routes/admin';
import { gameRoutes } from './routes/games';
import { healthRoutes } from './routes/health';
import { metaRoutes } from './routes/meta';
import { searchRoutes } from './routes/search';
import { teamRoutes } from './routes/teams';
import { userRoutes } from './routes/users';

/**
 * The router.
 *
 * The important structural fact is where `requireAdmin` is *not*: it is mounted
 * inside `adminRoutes`, so the public read path never parses a token, never
 * fetches a key set, and never waits on Supabase Auth (plan §11.1).
 *
 * Exported as a factory so tests can build a fresh app per case and pass their
 * own `Env` to `app.request()`.
 */
export function createApp(): Hono<AppBindings> {
  const app = new Hono<AppBindings>();

  app.use('*', requestId);
  app.use('*', corsMiddleware);
  // After CORS, so a 429 still carries the headers a browser needs to read it.
  app.use('/api/*', readRateLimit);

  app.onError(onError);
  app.notFound(notFoundHandler);

  // Public (§11.1)
  app.route('/api/health', healthRoutes);
  app.route('/api/meta', metaRoutes);
  app.route('/api/users', userRoutes);
  app.route('/api/teams', teamRoutes);
  app.route('/api/games', gameRoutes);
  // Mounted here, above the admin branch, so the read budget applies to it:
  // it is the one public route a keystroke can call (plan-search-engine §2).
  app.route('/api/search', searchRoutes);

  // Admin only — JWT verification + is_admin() live inside this branch.
  app.route('/api/admin', adminRoutes);

  return app;
}
