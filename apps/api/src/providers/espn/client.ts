import { ProviderError } from '../types';
import { readErrorBody } from './validate';

/**
 * The only code in the application that talks to ESPN.
 *
 * Posture, from what the Phase 1 spike observed (docs/espn-notes.md §1):
 *   - 6 s timeout on every request (`AbortSignal.timeout`).
 *   - An explicit User-Agent, overridable with `ESPN_USER_AGENT`. Phase 2
 *     found that ESPN's CDN judges the User-Agent together with the client's
 *     TLS fingerprint. Node's fetch passes with any value. Local workerd gets a
 *     403 for this default and passes only with a generic HTTP-library prefix
 *     such as `curl/…`. What production Workers egress will get is unknown
 *     until deployed (docs/espn-notes.md §1).
 *   - ONE retry, after a jittered pause, for failures that might clear on their
 *     own: network errors, timeouts, 5xx, 429, and 403. ESPN's CDN (Akamai)
 *     answers bursts with a 403 "Access Denied" HTML page. That is throttling,
 *     not authorization, so it is retryable and surfaces as `unavailable`,
 *     never as `forbidden`.
 *   - A body is checked for being JSON and for being an error document, not
 *     just for a 2xx status. ESPN sometimes answers 200 with an error body.
 */

export const ESPN_SITE_API =
  'https://site.api.espn.com/apis/site/v2/sports/football/college-football';
export const ESPN_CORE_API =
  'https://sports.core.api.espn.com/v2/sports/football/leagues/college-football';

const TIMEOUT_MS = 6_000;
const RETRY_BASE_MS = 250;
const RETRY_JITTER_MS = 500;
export const DEFAULT_USER_AGENT =
  'college-football-bets/0.2 (personal project; +cloudflare-worker)';
/** Printable ASCII only: anything else would make `fetch` throw on every call. */
const USABLE_USER_AGENT = /^[\x20-\x7E]{1,200}$/;

export interface EspnResponse {
  status: number;
  body: unknown;
}

export interface EspnClientOptions {
  /** `ESPN_USER_AGENT`. Blank or unusable values fall back to the default. */
  userAgent?: string | undefined;
  /** Test seams. Default to the real thing. */
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

interface GetOptions {
  /**
   * Return a 404 as data instead of throwing. The core predictor answers 404
   * for "no prediction for this game", which is an absence, not a failure (§12).
   */
  notFoundIsData?: boolean;
}

function isRetryableStatus(status: number): boolean {
  return status === 403 || status === 429 || status >= 500;
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

export class EspnClient {
  readonly userAgent: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;

  constructor(options: EspnClientOptions = {}) {
    const configured = options.userAgent?.trim() ?? '';
    this.userAgent = USABLE_USER_AGENT.test(configured) ? configured : DEFAULT_USER_AGENT;
    // Resolved at call time, so a test's stubbed global `fetch` is honoured.
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.random = options.random ?? Math.random;
  }

  async getJson(url: string, options: GetOptions = {}): Promise<EspnResponse> {
    try {
      return await this.attempt(url, options);
    } catch (error) {
      if (!(error instanceof ProviderError) || !error.retryable) throw error;
      await this.sleep(RETRY_BASE_MS + Math.floor(this.random() * RETRY_JITTER_MS));
      return await this.attempt(url, options);
    }
  }

  private async attempt(url: string, options: GetOptions): Promise<EspnResponse> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        headers: { 'User-Agent': this.userAgent, Accept: 'application/json' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (cause) {
      throw new ProviderError('unavailable', `ESPN request failed: ${describe(cause)}`, {
        retryable: true,
        cause,
      });
    }

    const { status } = response;
    if (isRetryableStatus(status)) {
      // Drain the body so the connection can be reused; its content (an HTML
      // "Access Denied" page, typically) is not interesting.
      await response.body?.cancel().catch(() => undefined);
      throw new ProviderError('unavailable', `ESPN answered HTTP ${String(status)}`, {
        retryable: true,
        status,
      });
    }

    if (status === 404) {
      if (options.notFoundIsData === true) {
        return { status, body: await this.parse(response).catch(() => null) };
      }
      await response.body?.cancel().catch(() => undefined);
      throw new ProviderError('not_found', 'ESPN has no such resource', { status });
    }
    if (status < 200 || status >= 300) {
      await response.body?.cancel().catch(() => undefined);
      throw new ProviderError('invalid_response', `ESPN answered HTTP ${String(status)}`, {
        status,
      });
    }

    const body = await this.parse(response);

    // HTTP 200 carrying an error document.
    const errorBody = readErrorBody(body);
    if (errorBody !== null) {
      if (errorBody.code === 404) {
        if (options.notFoundIsData === true) return { status: 404, body };
        throw new ProviderError('not_found', 'ESPN has no such resource', { status });
      }
      throw new ProviderError(
        'invalid_response',
        `ESPN answered 200 with an error body (code ${String(errorBody.code)})`,
        { status },
      );
    }

    return { status, body };
  }

  private async parse(response: Response): Promise<unknown> {
    let text: string;
    try {
      text = await response.text();
    } catch (cause) {
      throw new ProviderError('unavailable', `ESPN response body could not be read`, {
        retryable: true,
        status: response.status,
        cause,
      });
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new ProviderError('invalid_response', 'ESPN answered with something other than JSON', {
        status: response.status,
      });
    }
  }
}
