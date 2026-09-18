import type { ApiErrorBody, AppErrorKind } from '@cfb/shared';
import { appError } from '@cfb/shared';
import type { Context, ErrorHandler, NotFoundHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { DbError } from '../db/postgrest';
import type { AppBindings } from '../env';
import { HttpError, statusForKind } from '../http/errors';

/**
 * One exit point for every failure, so no route can invent its own error shape.
 * Body is always `{ error: { kind, message, requestId } }` (§38).
 */

interface Classified {
  kind: AppErrorKind;
  message: string;
  detail: string | null;
}

function classify(error: unknown): Classified {
  if (error instanceof HttpError) {
    return { kind: error.kind, message: error.message, detail: error.detail };
  }
  if (error instanceof DbError) {
    return { kind: error.kind, message: error.message, detail: error.detail };
  }
  if (error instanceof HTTPException) {
    // Raised by Hono itself, e.g. a malformed JSON body.
    return {
      kind: error.status === 404 ? 'not_found' : 'internal',
      message: error.status === 404 ? 'Not found.' : 'The request could not be processed.',
      detail: error.message,
    };
  }
  return {
    kind: 'internal',
    message: 'Something went wrong.',
    detail: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
  };
}

function render(c: Context<AppBindings>, classified: Classified): Response {
  const requestId = c.get('requestId') ?? null;
  const status = statusForKind(classified.kind) as ContentfulStatusCode;

  if (classified.detail !== null) {
    // Detail goes to the log, never to the client — it can carry query text,
    // Postgres error codes, and auth subject ids.
    console.warn(
      JSON.stringify({
        level: 'warn',
        requestId,
        kind: classified.kind,
        status,
        path: c.req.path,
        detail: classified.detail,
      }),
    );
  }

  const body: ApiErrorBody = { error: appError(classified.kind, classified.message, requestId) };
  return c.json(body, status);
}

export const onError: ErrorHandler<AppBindings> = (error, c) => render(c, classify(error));

export const notFoundHandler: NotFoundHandler<AppBindings> = (c) =>
  render(c, { kind: 'not_found', message: 'Not found.', detail: null });
