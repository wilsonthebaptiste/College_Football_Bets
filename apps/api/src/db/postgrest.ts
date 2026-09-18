import type { AppErrorKind } from '@cfb/shared';

/**
 * A ~100-line PostgREST client, deliberately hand-written.
 *
 * `@supabase/supabase-js` would also work, but it is not needed here: the Worker
 * makes a handful of queries, the only thing that genuinely matters is which
 * `Authorization` header goes on the wire (because that is what selects the
 * Postgres role RLS evaluates against), and this way that decision is visible in
 * twenty lines rather than buried in a client's option object. The web app still
 * uses `supabase-js` — for the admin *session* only (§26).
 */

export type DbRole = 'anon' | 'admin';

export class DbError extends Error {
  readonly kind: AppErrorKind;
  readonly status: number;
  readonly detail: string | null;

  constructor(kind: AppErrorKind, message: string, status: number, detail: string | null = null) {
    super(message);
    this.name = 'DbError';
    this.kind = kind;
    this.status = status;
    this.detail = detail;
  }
}

/** PostgREST's error body. Shape is stable enough to rely on for logging. */
interface PostgrestErrorBody {
  message?: unknown;
  code?: unknown;
  details?: unknown;
  hint?: unknown;
}

const REQUEST_TIMEOUT_MS = 8_000;

function kindForStatus(status: number): AppErrorKind {
  if (status === 401) return 'unauthorized';
  // 403 covers RLS `WITH CHECK` refusals and the 42501 raised by
  // `reorder_selections`. Both mean the same thing to a caller: not allowed.
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  return 'internal';
}

export interface PostgrestClientOptions {
  baseUrl: string;
  /** The anon/publishable key. Always sent as `apikey`. */
  apiKey: string;
  /**
   * The caller's Supabase access token, or `null`.
   *
   * `null`  → no `Authorization` header at all → PostgREST's anonymous role, `anon`
   * token   → `Authorization: Bearer <token>`  → role `authenticated`, and
   *           `auth.uid()` resolves, which is what `is_admin()` needs.
   *
   * Why no header rather than `Bearer <anon key>`: Supabase's newer
   * `sb_publishable_…` keys are not JWTs, and the gateway does not accept them
   * as a bearer token. Leaving the header off works with those AND with the
   * legacy JWT-shaped anon key, so the Worker does not care which one a project
   * was issued.
   */
  accessToken: string | null;
  role: DbRole;
}

export class PostgrestClient {
  readonly role: DbRole;
  private readonly restUrl: string;
  private readonly apiKey: string;
  private readonly accessToken: string | null;

  constructor(options: PostgrestClientOptions) {
    this.role = options.role;
    this.restUrl = `${options.baseUrl.replace(/\/+$/, '')}/rest/v1`;
    this.apiKey = options.apiKey;
    this.accessToken = options.accessToken;
  }

  private headers(extra?: Record<string, string>): Headers {
    const headers = new Headers({
      apikey: this.apiKey,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...extra,
    });
    // This one line decides which Postgres role RLS evaluates against.
    if (this.accessToken !== null) {
      headers.set('Authorization', `Bearer ${this.accessToken}`);
    }
    return headers;
  }

  private async send<T>(url: string, init: RequestInit): Promise<T> {
    let response: Response;
    try {
      response = await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch (cause) {
      throw new DbError(
        'internal',
        'The application database is temporarily unreachable.',
        503,
        cause instanceof Error ? cause.message : String(cause),
      );
    }

    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as PostgrestErrorBody;
      const detail = [body.code, body.message, body.details]
        .filter((part): part is string => typeof part === 'string')
        .join(' | ');
      throw new DbError(
        kindForStatus(response.status),
        response.status === 403 || response.status === 401
          ? 'Not permitted.'
          : 'The application database rejected the request.',
        response.status,
        detail === '' ? null : detail,
      );
    }

    if (response.status === 204) return undefined as T;
    return await response.json<T>();
  }

  /** `GET /rest/v1/<table>?<params>` */
  async select<T>(table: string, params: Record<string, string>): Promise<T[]> {
    const query = new URLSearchParams(params).toString();
    return this.send<T[]>(`${this.restUrl}/${table}?${query}`, {
      method: 'GET',
      headers: this.headers(),
    });
  }

  /** Inserts one row and returns it. */
  async insertOne<T>(table: string, row: Record<string, unknown>): Promise<T> {
    const rows = await this.send<T[]>(`${this.restUrl}/${table}`, {
      method: 'POST',
      headers: this.headers({ Prefer: 'return=representation' }),
      body: JSON.stringify(row),
    });
    const created = rows[0];
    if (created === undefined) {
      // RLS can silently filter the returned representation even when the
      // insert itself was allowed. Treat it as a failure rather than guessing.
      throw new DbError('forbidden', 'Not permitted.', 403, `insert into ${table} returned no row`);
    }
    return created;
  }

  async update<T>(
    table: string,
    filters: Record<string, string>,
    patch: Record<string, unknown>,
  ): Promise<T[]> {
    const query = new URLSearchParams(filters).toString();
    return this.send<T[]>(`${this.restUrl}/${table}?${query}`, {
      method: 'PATCH',
      headers: this.headers({ Prefer: 'return=representation' }),
      body: JSON.stringify(patch),
    });
  }

  async remove<T>(table: string, filters: Record<string, string>): Promise<T[]> {
    const query = new URLSearchParams(filters).toString();
    return this.send<T[]>(`${this.restUrl}/${table}?${query}`, {
      method: 'DELETE',
      headers: this.headers({ Prefer: 'return=representation' }),
    });
  }

  /** `POST /rest/v1/rpc/<fn>` — used for `is_admin()` and `reorder_selections()`. */
  async rpc<T>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
    return this.send<T>(`${this.restUrl}/rpc/${fn}`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(args),
    });
  }
}
