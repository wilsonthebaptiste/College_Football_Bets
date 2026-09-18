/**
 * Freshness, errors, and the envelope that carries them.
 *
 * §23 and §39 are the reason this module exists: the application must always be
 * able to distinguish fresh / cached / stale / unavailable data, and must never
 * make stale data look current. So freshness is not optional metadata bolted on
 * at the edges — it travels with every piece of provider-owned data, all the way
 * to the component that renders it.
 */

export type ProviderName = 'espn' | 'mock';

/**
 * - `fresh`       — fetched from the provider within its TTL.
 * - `cached`      — served from cache, still inside its TTL.
 * - `stale`       — served from cache past its TTL because revalidation failed.
 * - `unavailable` — no data at all.
 */
export type FreshnessState = 'fresh' | 'cached' | 'stale' | 'unavailable';

export type FreshnessSource = 'provider' | 'cache' | 'none';

export interface Freshness {
  state: FreshnessState;
  /**
   * When the provider actually produced this data. ISO 8601 UTC.
   *
   * HARD RULE (§39): on a failed revalidate this keeps the ORIGINAL value. It is
   * never bumped to "now" just because we tried again. This timestamp is the
   * user's only defence against believing old data is current.
   *
   * `null` only when `state === 'unavailable'`.
   */
  fetchedAt: string | null;
  ttlSeconds: number;
  /** `fetchedAt + ttlSeconds`, precomputed so the client need not do date maths. */
  expiresAt: string | null;
  source: FreshnessSource;
  provider: ProviderName;
}

/**
 * §38 requires distinguishing temporary provider failure, missing data, invalid
 * data, authorization failure, and application error. One kind per case.
 *
 * `invalid_request` is this list's one addition to the plan's §5 enumeration: a
 * malformed request body is a client error (400), and without it the only honest
 * mapping left is `internal` (500), which would blame the server for the
 * caller's typo and make a genuine 500 impossible to spot in the logs.
 */
export type AppErrorKind =
  | 'provider_unavailable'
  | 'provider_invalid_response'
  | 'invalid_request'
  | 'not_found'
  | 'unauthorized'
  | 'forbidden'
  | 'internal';

export interface AppError {
  kind: AppErrorKind;
  /** Safe to show a user. Never contains provider URLs, tokens, or stack traces. */
  message: string;
  requestId: string | null;
}

/** For validation failures that are scoped to one field rather than a whole section. */
export interface FieldError {
  field: string;
  kind: AppErrorKind;
  message: string;
}

/**
 * §42 — a section can fail without failing its siblings. A board is six
 * envelopes; one of them being `{ data: null, error: {...} }` is a normal 200
 * response, not a 500.
 */
export interface Envelope<T> {
  data: T | null;
  freshness: Freshness;
  error: AppError | null;
}

// ─── Constructors ────────────────────────────────────────────────────────────
// Hand-building a Freshness object at each call site is how `fetchedAt` ends up
// getting refreshed by accident. Use these.

export interface FreshnessInit {
  provider: ProviderName;
  ttlSeconds: number;
  /** When the PROVIDER produced the data — not when the cache was read. */
  fetchedAt: Date | string;
}

function toIso(value: Date | string): string {
  return typeof value === 'string' ? value : value.toISOString();
}

function expiryOf(fetchedAt: string, ttlSeconds: number): string | null {
  const base = Date.parse(fetchedAt);
  if (Number.isNaN(base)) return null;
  return new Date(base + ttlSeconds * 1000).toISOString();
}

function freshnessOf(
  state: Exclude<FreshnessState, 'unavailable'>,
  source: Exclude<FreshnessSource, 'none'>,
  init: FreshnessInit,
): Freshness {
  const fetchedAt = toIso(init.fetchedAt);
  return {
    state,
    fetchedAt,
    ttlSeconds: init.ttlSeconds,
    expiresAt: expiryOf(fetchedAt, init.ttlSeconds),
    source,
    provider: init.provider,
  };
}

export function unavailableFreshness(provider: ProviderName, ttlSeconds: number): Freshness {
  return {
    state: 'unavailable',
    fetchedAt: null,
    ttlSeconds,
    expiresAt: null,
    source: 'none',
    provider,
  };
}

/** Straight from the provider, inside its TTL. */
export function fresh<T>(data: T, init: FreshnessInit): Envelope<T> {
  return { data, freshness: freshnessOf('fresh', 'provider', init), error: null };
}

/** From cache, still inside its TTL. */
export function cached<T>(data: T, init: FreshnessInit): Envelope<T> {
  return { data, freshness: freshnessOf('cached', 'cache', init), error: null };
}

/**
 * From cache, past its TTL, because revalidation failed (§39).
 *
 * `init.fetchedAt` must be the timestamp the cached entry was stored with. Pass
 * `Date.now()` here and you have just lied to the user about how current the
 * data is, which is the exact failure §39 forbids.
 */
export function stale<T>(data: T, init: FreshnessInit): Envelope<T> {
  return { data, freshness: freshnessOf('stale', 'cache', init), error: null };
}

/**
 * Nothing to show, and nothing went wrong — the provider legitimately has no
 * value for this (e.g. no predictor published for a game). Distinct from
 * `failed()` so the UI can say "Prediction unavailable" rather than "Error".
 */
export function unavailable<T>(provider: ProviderName, ttlSeconds = 0): Envelope<T> {
  return { data: null, freshness: unavailableFreshness(provider, ttlSeconds), error: null };
}

/** Nothing to show because something broke. Carries the reason (§38). */
export function failed<T>(error: AppError, provider: ProviderName, ttlSeconds = 0): Envelope<T> {
  return { data: null, freshness: unavailableFreshness(provider, ttlSeconds), error };
}

export function appError(
  kind: AppErrorKind,
  message: string,
  requestId: string | null = null,
): AppError {
  return { kind, message, requestId };
}

/** True when the envelope holds data the UI can render. */
export function hasData<T>(envelope: Envelope<T>): envelope is Envelope<T> & { data: T } {
  return envelope.data !== null;
}

/** True when the UI must visibly mark the data as possibly out of date (§23, §39). */
export function isStale<T>(envelope: Envelope<T>): boolean {
  return envelope.freshness.state === 'stale';
}
