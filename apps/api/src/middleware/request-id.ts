import { createMiddleware } from 'hono/factory';
import type { AppBindings } from '../env';

/** A client-supplied id is only honoured if it is short and boringly shaped. */
const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * Every response carries `X-Request-Id`, and every error body repeats it, so a
 * user can quote one string and have it be findable in the logs.
 */
export const requestId = createMiddleware<AppBindings>(async (c, next) => {
  const supplied = c.req.header('x-request-id');
  const id =
    supplied !== undefined && SAFE_REQUEST_ID.test(supplied) ? supplied : crypto.randomUUID();

  c.set('requestId', id);
  c.header('X-Request-Id', id);

  await next();
});
