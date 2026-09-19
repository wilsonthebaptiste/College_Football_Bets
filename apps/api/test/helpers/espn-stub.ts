import { fixtureText } from './fixtures';

/**
 * A fake ESPN, serving the Phase 1 captures by URL. Anything it has no
 * fixture for is a 404, so a test that forgets to stub something fails loudly
 * instead of reaching the real ESPN.
 */

export interface EspnStubOptions {
  /** providerTeamId → schedule fixture. Default: Texas and Pitt. */
  schedules?: Record<string, string>;
  /** Eastern date → scoreboard fixture. */
  slates?: Record<string, string>;
  /** game id → summary fixture. */
  summaries?: Record<string, string>;
  /** game ids with a standalone predictor (served from prediction-present). */
  predictors?: string[];
  /** Override a response entirely: return one to short-circuit. */
  override?: (url: URL) => Response | null;
}

export interface EspnStub {
  fetch: typeof fetch;
  urls: string[];
}

const DEFAULT_SCHEDULES: Record<string, string> = {
  '251': 'schedule-ranked',
  '221': 'schedule-unranked',
};
const DEFAULT_SLATES: Record<string, string> = {
  '20260917': 'scoreboard-20260917',
  '20260918': 'scoreboard-live',
};
const DEFAULT_SUMMARIES: Record<string, string> = {
  '401858225': 'game-final',
  '401858226': 'game-upcoming',
  '401234644': 'game-postponed',
};

function json(text: string, status = 200): Response {
  return new Response(text, { status, headers: { 'Content-Type': 'application/json' } });
}

function notFound(): Response {
  return json(fixtureText('prediction-absent'), 404);
}

/** Routes one ESPN URL to a fixture, or `null` if the stub does not know it. */
export function espnResponse(url: URL, options: EspnStubOptions = {}): Response | null {
  const override = options.override?.(url);
  if (override !== undefined && override !== null) return override;

  const path = url.pathname;
  const site = '/apis/site/v2/sports/football/college-football';

  if (url.hostname === 'site.api.espn.com') {
    if (path === `${site}/scoreboard`) {
      const date = url.searchParams.get('dates');
      if (date === null) return json(fixtureText('calendar'));
      const name = (options.slates ?? DEFAULT_SLATES)[date];
      return name === undefined ? json('{"events":[]}') : json(fixtureText(name));
    }
    if (path === `${site}/teams`) return json(fixtureText('team-list'));
    if (path === `${site}/rankings`) return json(fixtureText('rankings'));
    if (path === `${site}/summary`) {
      const name = (options.summaries ?? DEFAULT_SUMMARIES)[url.searchParams.get('event') ?? ''];
      return name === undefined ? notFound() : json(fixtureText(name));
    }
    const schedule = /\/teams\/([^/]+)\/schedule$/.exec(path);
    if (schedule !== null) {
      const name = (options.schedules ?? DEFAULT_SCHEDULES)[schedule[1] ?? ''];
      return name === undefined ? notFound() : json(fixtureText(name));
    }
    return notFound();
  }

  if (url.hostname === 'sports.core.api.espn.com') {
    const predictor = /\/events\/([^/]+)\/competitions\/[^/]+\/predictor$/.exec(path);
    if (predictor !== null && (options.predictors ?? ['401858225']).includes(predictor[1] ?? '')) {
      return json(fixtureText('prediction-present'));
    }
    return notFound();
  }

  return null;
}

export function espnStub(options: EspnStubOptions = {}): EspnStub {
  const urls: string[] = [];
  const stubbed = async (input: RequestInfo | URL): Promise<Response> => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    urls.push(href);
    return espnResponse(new URL(href), options) ?? notFound();
  };
  return { fetch: stubbed, urls };
}
