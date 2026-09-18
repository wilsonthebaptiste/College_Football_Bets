import type { AppErrorKind } from '@cfb/shared';

/**
 * §38 — the API distinguishes temporary provider failure, missing data, invalid
 * data, authorization failure, and application error. One `AppErrorKind` per
 * case, one HTTP status per kind, decided here and nowhere else.
 */
export class HttpError extends Error {
  readonly kind: AppErrorKind;
  /** Extra context for logs. Never sent to the client. */
  readonly detail: string | null;

  constructor(kind: AppErrorKind, message: string, detail: string | null = null) {
    super(message);
    this.name = 'HttpError';
    this.kind = kind;
    this.detail = detail;
  }
}

export function statusForKind(kind: AppErrorKind): number {
  switch (kind) {
    case 'invalid_request':
      return 400;
    case 'unauthorized':
      return 401;
    case 'forbidden':
      return 403;
    case 'not_found':
      return 404;
    case 'provider_invalid_response':
      return 502;
    case 'provider_unavailable':
      return 503;
    case 'internal':
      return 500;
  }
}

export const invalidRequest = (message: string, detail?: string): HttpError =>
  new HttpError('invalid_request', message, detail ?? null);

export const unauthorized = (message: string, detail?: string): HttpError =>
  new HttpError('unauthorized', message, detail ?? null);

export const forbidden = (message: string, detail?: string): HttpError =>
  new HttpError('forbidden', message, detail ?? null);

export const notFound = (message: string, detail?: string): HttpError =>
  new HttpError('not_found', message, detail ?? null);

export const badGateway = (message: string, detail?: string): HttpError =>
  new HttpError('provider_invalid_response', message, detail ?? null);

export const unavailableError = (message: string, detail?: string): HttpError =>
  new HttpError('provider_unavailable', message, detail ?? null);

export const internalError = (message: string, detail?: string): HttpError =>
  new HttpError('internal', message, detail ?? null);
