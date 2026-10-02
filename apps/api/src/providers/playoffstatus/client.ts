import { ProviderError } from '../types';

/**
 * The only code in the application that fetches playoffstatus.com.
 *
 * Same posture as `providers/espn/client.ts`, and for the same reasons: a
 * timeout, one retry for failures that might clear on their own, and an
 * explicit User-Agent that says who we are. Two differences, both because this
 * is a web page rather than an API:
 *
 *   - it returns text, not JSON, so there is nothing to parse here;
 *   - the request is courteous by design. `robots.txt` is
 *     `User-agent: * / Disallow:` — everything allowed — and the four pages
 *     total about 100 KB, read at most four times a day behind a 6 h cache and
 *     a cron warmer. That cadence is a policy choice, and it lives in
 *     `cache/policy.ts` where it can be changed in one line.
 */

const TIMEOUT_MS = 8_000;
const RETRY_BASE_MS = 300;
const RETRY_JITTER_MS = 500;
/** A document this large is not the table; something is wrong upstream. */
const MAX_BYTES = 2_000_000;

/**
 * Identifies the project rather than imitating a browser. This is a scrape of
 * someone's site on a schedule, so it says so; if the owner ever asks us to
 * stop, this is the string in their logs.
 */
export const DEFAULT_USER_AGENT =
  'curl/8.9.1 college-football-bets/0.5 (personal project; +cloudflare-worker)';
const USABLE_USER_AGENT = /^[\x20-\x7E]{1,200}$/;

export interface PlayoffStatusClientOptions {
  userAgent?: string | undefined;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

function isRetryableStatus(status: number): boolean {
  return status === 403 || status === 429 || status >= 500;
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

export class PlayoffStatusClient {
  readonly userAgent: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;

  constructor(options: PlayoffStatusClientOptions = {}) {
    const configured = options.userAgent?.trim() ?? '';
    this.userAgent = USABLE_USER_AGENT.test(configured) ? configured : DEFAULT_USER_AGENT;
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.random = options.random ?? Math.random;
  }

  async getHtml(url: string): Promise<string> {
    try {
      return await this.attempt(url);
    } catch (error) {
      if (!(error instanceof ProviderError) || !error.retryable) throw error;
      await this.sleep(RETRY_BASE_MS + Math.floor(this.random() * RETRY_JITTER_MS));
      return await this.attempt(url);
    }
  }

  private async attempt(url: string): Promise<string> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        headers: { 'User-Agent': this.userAgent, Accept: 'text/html' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (cause) {
      throw new ProviderError('unavailable', `playoffstatus request failed: ${describe(cause)}`, {
        retryable: true,
        cause,
      });
    }

    const { status } = response;
    if (isRetryableStatus(status)) {
      await response.body?.cancel().catch(() => undefined);
      throw new ProviderError('unavailable', `playoffstatus answered HTTP ${String(status)}`, {
        retryable: true,
        status,
      });
    }
    if (status === 404) {
      await response.body?.cancel().catch(() => undefined);
      // A moved page is a redesign, not a missing team. It must reach the logs
      // as an invalid response so somebody goes and looks at the site.
      throw new ProviderError('invalid_response', 'playoffstatus has no such page', { status });
    }
    if (status < 200 || status >= 300) {
      await response.body?.cancel().catch(() => undefined);
      throw new ProviderError('invalid_response', `playoffstatus answered HTTP ${String(status)}`, {
        status,
      });
    }

    let html: string;
    try {
      html = await response.text();
    } catch (cause) {
      throw new ProviderError('unavailable', 'playoffstatus response body could not be read', {
        retryable: true,
        status,
        cause,
      });
    }

    if (html.length > MAX_BYTES) {
      throw new ProviderError('invalid_response', 'playoffstatus page is implausibly large', {
        status,
      });
    }
    return html;
  }
}
