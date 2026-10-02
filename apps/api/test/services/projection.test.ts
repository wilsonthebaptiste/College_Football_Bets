import type { TeamIdentity } from '@cfb/shared';
import { projectTeam } from '@cfb/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cacheKey } from '../../src/cache/policy';
import { SwrCache, resetInflight } from '../../src/cache/swr';
import { TieredCache, kvWriteReport, resetCacheTiers } from '../../src/cache/tiers';
import type { Env } from '../../src/env';
import { toProjectionInputs, toTeamIdentity } from '../../src/providers/espn/normalize';
import { readFpiPage, readTeamList } from '../../src/providers/espn/validate';
import { POWER_FOUR, isPowerFour } from '../../src/providers/playoffstatus/conferences';
import { parseConferencePage } from '../../src/providers/playoffstatus/parse';
import {
  CHAMPION_SUM,
  MIN_ROWS,
  PARTICIPATE_SUM,
} from '../../src/providers/playoffstatus/provider';
import { createConferenceOddsProvider, createProvider } from '../../src/providers/registry';
import type { ConferenceOddsDocument, ConferenceOddsRow } from '../../src/providers/types';
import type { Services } from '../../src/services/context';
import {
  conferenceStandingFor,
  fpiInputsFor,
  joinConferenceOdds,
  readConferenceOdds,
  readProjectionInputs,
} from '../../src/services/projection';
import { TEAM_NAME_ALIASES, normalizeTeamName, teamNameKey } from '../../src/services/teamNames';
import {
  CONFERENCE_FIXTURES,
  conferenceMapFixture,
  conferencePageFixture,
  fixture,
} from '../helpers/fixtures';
import { FakeKv } from '../helpers/kv';
import { testEnv } from '../helpers/supabase-stub';

/**
 * The join between two publishers, and the cache in front of each
 * (context/predicting_score.md, Phase 2).
 *
 * The pieces are tested apart from each other elsewhere. What is here is what
 * only exists where they meet: resolving one publisher's team names to the
 * other's ids, deciding which of three states a conference term is in, and
 * doing both without spending more than a couple of KV writes a day.
 */

const SEASON = { year: 2026, type: 'regular' as const, week: 5 };

/**
 * The labels the two real publishers' figures wear.
 *
 * Passed in rather than hard-coded inside `conferenceStandingFor` since Phase 3:
 * a hard-coded `playoffstatus` would have labelled the MOCK publisher's
 * synthetic odds with a real publisher's name (§46). `services/projection.ts`
 * derives them from the configured publishers, and a route test asserts mock
 * mode labels every conference term `mock_projection`.
 */
const REAL_LABELS = { oddsSource: 'playoffstatus', fpiSource: 'espn_fpi' } as const;

function teamList(): TeamIdentity[] {
  return readTeamList(fixture('team-list'))!.map(toTeamIdentity);
}

/** Every power-four row the four captured pages carry: 67 of them. */
function capturedRows(): ConferenceOddsRow[] {
  return Object.keys(CONFERENCE_FIXTURES).flatMap(
    (conference) => parseConferencePage(conferencePageFixture(conference), conference).rows,
  );
}

function documentOf(rows: ConferenceOddsRow[]): ConferenceOddsDocument {
  return { rows, pages: [], computedLabel: null };
}

describe('normalizing team names', () => {
  it('removes punctuation rather than replacing it with a space', () => {
    // The whole difference between matching ESPN's "NC State" and matching
    // nothing. Replacing punctuation with a space gives "n c state"; removing
    // it gives "nc state", which is what ESPN's own spelling normalizes to.
    expect(normalizeTeamName('N.C. State')).toBe('nc state');
    expect(normalizeTeamName('NC State')).toBe('nc state');
  });

  it('spells out "&" before the punctuation goes', () => {
    // Otherwise "Texas A&M" collapses to "texas am", which matches nothing.
    expect(normalizeTeamName('Texas A&M')).toBe('texas a and m');
    expect(normalizeTeamName('Texas A&M Aggies')).toBe('texas a and m aggies');
  });

  it('reads "St." as "State" on both sides', () => {
    expect(normalizeTeamName('Mississippi St.')).toBe('mississippi state');
    expect(normalizeTeamName('Mississippi State')).toBe('mississippi state');
    expect(normalizeTeamName('Ohio St.')).toBe('ohio state');
  });

  it('ignores case and accents', () => {
    expect(normalizeTeamName('San José State')).toBe(normalizeTeamName('san jose state'));
  });

  it('has exactly one alias, and it is a nickname no rule reconciles', () => {
    // Pittsburgh is what the university is called; Pitt is what ESPN calls the
    // team. A table of sixty aliases would mean the normalization was wrong.
    expect(Object.keys(TEAM_NAME_ALIASES)).toEqual(['pittsburgh']);
    expect(teamNameKey('Pittsburgh')).toBe('pitt');
    expect(teamNameKey('Pitt')).toBe('pitt');
  });
});

describe('the two-way join, against real membership', () => {
  it('matches every scraped row to a team', () => {
    const join = joinConferenceOdds(documentOf(capturedRows()), teamList(), conferenceMapFixture());
    // 66 of 67 resolve by normalization alone; Pittsburgh needs the one alias.
    expect(join.unmatchedRows).toEqual([]);
    expect(join.byTeamId.size).toBe(67);
  });

  it('covers every power-four team in the conference map', () => {
    const join = joinConferenceOdds(documentOf(capturedRows()), teamList(), conferenceMapFixture());
    // The other direction, and it fails differently: an unmatched row is a
    // name we could not resolve, an unmatched team is a row that was never
    // there. ACC 17 + Big 12 16 + Big Ten 18 + SEC 16 = 67, exactly.
    expect(join.unmatchedTeams).toEqual([]);
    const powerFour = Object.values(conferenceMapFixture()).filter(isPowerFour);
    expect(powerFour).toHaveLength(67);
  });

  it('names the team a deleted row left uncovered', () => {
    const rows = capturedRows().filter((row) => row.teamName !== 'Georgia');
    const join = joinConferenceOdds(documentOf(rows), teamList(), conferenceMapFixture());

    // This is the direction the column sums alone would not always catch, and
    // the failure the first version of the parser caused on every page.
    expect(join.unmatchedRows).toEqual([]);
    expect(join.unmatchedTeams).toEqual(['61']);
  });

  it('names a row whose spelling no longer resolves', () => {
    const rows = capturedRows().map((row) =>
      row.teamName === 'Pittsburgh' ? { ...row, teamName: 'University of Pittsburgh' } : row,
    );
    const join = joinConferenceOdds(documentOf(rows), teamList(), conferenceMapFixture());

    expect(join.unmatchedRows).toEqual(['University of Pittsburgh']);
    // And the team it should have covered is reported too — one upstream
    // rename shows up in both directions, which is how it gets noticed.
    expect(join.unmatchedTeams).toEqual(['221']);
  });

  it('resolves the names that needed the work', () => {
    const join = joinConferenceOdds(documentOf(capturedRows()), teamList(), conferenceMapFixture());
    // Pitt (alias), NC State (punctuation), Mississippi State and Texas A&M.
    for (const id of ['221', '152', '344', '245']) {
      expect(join.byTeamId.has(id), id).toBe(true);
    }
  });
});

describe('a conference standing is one of three states, never two', () => {
  const join = joinConferenceOdds(documentOf(capturedRows()), teamList(), conferenceMapFixture());

  it('is a structural zero outside the power four', () => {
    // Notre Dame. Not a gap in our data — a fact about the team.
    const standing = conferenceStandingFor({
      providerTeamId: '87',
      conference: 'FBS Indep.',
      join,
      fpiWinConference: 0.4,
      ...REAL_LABELS,
    });
    expect(standing).toEqual({ kind: 'not_eligible' });

    // And it reaches the rubric as a contribution of 0 with no source, which
    // is what renders "0.00 — not a power-four conference" rather than "—".
    const projection = projectTeam(
      {
        providerTeamId: '87',
        fpi: {
          winTitle: 0.1,
          makeTitleGame: 0.2,
          makePlayoffs: 0.5,
          fpiRank: 3,
          source: 'espn_fpi',
        },
        conference: standing,
        ranking: { kind: 'ranked', rank: 3, poll: 'AP Top 25', week: 5 },
        estimateSource: 'espn_poll_estimate',
      },
      SEASON,
    );
    const conferenceTerms = projection.terms.filter((term) => term.kind.startsWith('conference_'));
    expect(conferenceTerms.map((term) => term.state)).toEqual(['not_eligible', 'not_eligible']);
    expect(conferenceTerms.map((term) => term.contribution)).toEqual([0, 0]);
  });

  it('quotes playoffstatus when the scrape resolved the team', () => {
    expect(
      conferenceStandingFor({
        providerTeamId: '61',
        conference: 'SEC',
        join,
        fpiWinConference: 0.354,
        ...REAL_LABELS,
      }),
    ).toEqual({
      kind: 'odds',
      winConference: 0.11,
      reachConferenceGame: 0.23,
      source: 'playoffstatus',
    });
  });

  it('falls back to FPI’s own figure, labelled, with no runner-up invented', () => {
    const standing = conferenceStandingFor({
      providerTeamId: '61',
      conference: 'SEC',
      join: null,
      fpiWinConference: 0.354,
      ...REAL_LABELS,
    });
    expect(standing).toEqual({
      kind: 'odds',
      winConference: 0.354,
      reachConferenceGame: 0.354,
      source: 'espn_fpi',
    });

    // FPI publishes no runner-up probability at all. Setting the two equal
    // makes `max(0, e − d)` come out at exactly zero, which is the honest
    // answer; the alternative would be inventing the one number the chosen
    // publisher exists to supply. The two sources disagree by up to about 0.75
    // points per team, so this is a labelled substitute and never an average:
    // playoffstatus says Georgia 11%, FPI says 35.4%.
    if (standing.kind !== 'odds') throw new Error('expected odds');
    expect(standing.reachConferenceGame - standing.winConference).toBe(0);
    expect(standing.source).not.toBe('playoffstatus');
  });

  it('is unavailable when both sources are gone — never a zero', () => {
    expect(
      conferenceStandingFor({
        providerTeamId: '61',
        conference: 'SEC',
        join: null,
        fpiWinConference: null,
        ...REAL_LABELS,
      }),
    ).toEqual({ kind: 'unavailable' });
  });

  it('is unavailable, not ineligible, when the conference itself is unknown', () => {
    // Not knowing a team's conference is not the same as knowing it is not in
    // the power four. The conference map failing must not pay out a zero.
    expect(
      conferenceStandingFor({
        providerTeamId: '61',
        conference: null,
        join: null,
        fpiWinConference: null,
        ...REAL_LABELS,
      }),
    ).toEqual({ kind: 'unavailable' });
  });

  it('keeps the two zeros distinguishable in the rubric’s output', () => {
    const inputs = {
      providerTeamId: '61',
      fpi: null,
      ranking: { kind: 'unavailable' } as const,
      estimateSource: 'espn_poll_estimate' as const,
    };
    const ineligible = projectTeam({ ...inputs, conference: { kind: 'not_eligible' } }, SEASON);
    const unavailable = projectTeam({ ...inputs, conference: { kind: 'unavailable' } }, SEASON);

    // The oldest guard in this application, applied to a new pair of states
    // (§7). Both totals are null — no term is known either way — but the terms
    // say different things, which is what lets one render "0.00" with a reason
    // and the other render "—".
    expect(ineligible.total).toBeNull();
    expect(unavailable.total).toBeNull();
    expect(ineligible.terms[3]?.contribution).toBe(0);
    expect(unavailable.terms[3]?.contribution).toBeNull();
    expect(ineligible.terms[3]?.state).not.toBe(unavailable.terms[3]?.state);
  });
});

describe('fpiInputsFor', () => {
  const document = toProjectionInputs(readFpiPage(fixture('fpi'))!);

  it('finds a rated team', () => {
    expect(fpiInputsFor(document, '61')?.fpi.fpiRank).toBe(1);
  });

  it('is null for a team the publisher does not cover', () => {
    // FPI rates 138 of the provider's ~762 teams, so most of them are this
    // case. An FCS team has no projection at all, which is an `unavailable`.
    expect(document.teams).toHaveLength(138);
    expect(fpiInputsFor(document, '99999')).toBeNull();
    expect(fpiInputsFor(null, '61')).toBeNull();
  });
});

// ─── Reading both documents through the cache ───────────────────────────────

function servicesWith(env: Env, kv: FakeKv = new FakeKv()): { services: Services; kv: FakeKv } {
  const now = (): number => Date.parse('2026-10-01T12:00:00.000Z');
  const provider = createProvider(env, now);
  const oddsProvider = createConferenceOddsProvider(env);
  const tiers = new TieredCache({
    kv: { get: (key: string) => kv.get(key, 'json'), put: kv.put.bind(kv) },
    edge: null,
    now,
    defer: null,
  });
  return {
    services: {
      env,
      provider,
      cache: new SwrCache({ tiers, provider: provider.name, now, requestId: 'req' }),
      oddsProvider,
      oddsCache: new SwrCache({ tiers, provider: oddsProvider.name, now, requestId: 'req' }),
      now,
      requestId: 'req',
    },
    kv,
  };
}

/** Mock mode, which is the default: no network for either publisher. */
function mockEnv(overrides: Partial<Env> = {}): Env {
  return { ...testEnv(), ...overrides };
}

beforeEach(() => {
  resetCacheTiers();
  resetInflight();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

describe('mock mode needs no network for either publisher', () => {
  it('produces projections labelled mock, and nothing else', async () => {
    const { services } = servicesWith(mockEnv());
    const read = await readProjectionInputs(services);

    const document = read.envelope.data;
    expect(document).not.toBeNull();
    expect(document?.teams.length).toBeGreaterThan(0);
    // §46: a synthetic figure must not wear a publisher's name. This is why
    // `ProjectionInputs` carries three source fields rather than one.
    for (const team of document?.teams ?? []) {
      expect(team.fpi.source).toBe('mock_projection');
    }
    expect(read.envelope.freshness.provider).toBe('mock');
  });

  it('leaves at least one roster team with no projection at all', async () => {
    const { services } = servicesWith(mockEnv());
    const document = (await readProjectionInputs(services)).envelope.data;
    const teams = await services.provider.listTeams();

    // The same principle the generated season follows: every state the UI must
    // handle is always on screen somewhere. This is the one a non-FBS team on
    // a board produces against real data.
    const rated = new Set(document?.teams.map((team) => team.providerTeamId));
    const unrated = teams.filter((team) => !rated.has(team.providerTeamId));
    expect(unrated.length).toBeGreaterThan(0);
  });

  it('produces conference odds labelled mock, for the power four only', async () => {
    const { services } = servicesWith(mockEnv());
    const read = await readConferenceOdds(services);

    const document = read.envelope.data;
    expect(document?.rows.length).toBeGreaterThan(0);
    expect(document?.computedLabel).toContain('Mock');
    expect(read.envelope.freshness.provider).toBe('mock');
    for (const row of document?.rows ?? []) {
      expect(isPowerFour(row.conference), row.conference).toBe(true);
    }
  });

  it('passes the same integrity windows the real pages are held to', async () => {
    const { services } = servicesWith(mockEnv());
    const document = (await readConferenceOdds(services)).envelope.data;

    // Not "exactly 100" — the mock rounds each share to four places, so its
    // sums drift by a couple of hundredths in the same way whole-percent
    // publishing drifts by a couple of points. What matters is that mock mode
    // lands inside the windows the REAL provider refuses outside of, so a
    // local run exercises the integrity arithmetic instead of skipping it.
    expect(document?.pages.length).toBeGreaterThan(0);
    for (const page of document?.pages ?? []) {
      expect(page.rows, page.conference).toBeGreaterThanOrEqual(MIN_ROWS);
      expect(
        Math.abs(page.championPercent - CHAMPION_SUM.expected),
        page.conference,
      ).toBeLessThanOrEqual(CHAMPION_SUM.tolerance);
      expect(
        Math.abs(page.participatePercent - PARTICIPATE_SUM.expected),
        page.conference,
      ).toBeLessThanOrEqual(PARTICIPATE_SUM.tolerance);
    }
  });

  it('joins its own rows to its own team list', async () => {
    const { services } = servicesWith(mockEnv());
    const document = (await readConferenceOdds(services)).envelope.data;
    const teams = await services.provider.listTeams();
    const conferences = await services.provider.getConferences(SEASON);

    // The mock has to satisfy the same two-way join the real sources do, or it
    // would not be exercising the code a board actually runs.
    const join = joinConferenceOdds(document!, teams, conferences);
    expect(join.unmatchedRows).toEqual([]);
    expect(join.unmatchedTeams).toEqual([]);
  });
});

describe('the KV budget for both documents', () => {
  it('writes once per document on a cold read, and nothing inside the TTL', async () => {
    const { services, kv } = servicesWith(mockEnv());

    await readProjectionInputs(services);
    await readConferenceOdds(services);
    const afterCold = kvWriteReport(services.now());

    // One write per document. At 6 h TTLs that is at most eight a day between
    // them, against a ledger that warns at 700 (project-notes §4).
    expect(afterCold.byCategory['projection_inputs']).toBe(1);
    expect(afterCold.byCategory['conference_odds']).toBe(1);

    // The third write is the season calendar, which `readConferenceOdds` needs
    // for its cache key and which every other read in the application already
    // shares. It is not a cost this feature adds: the cron warms it every six
    // hours regardless, and in production the key is already there.
    expect(afterCold.byCategory['season_calendar']).toBe(1);
    expect(afterCold.total).toBe(3);

    await readProjectionInputs(services);
    await readConferenceOdds(services);
    await readProjectionInputs(services);

    const afterWarm = kvWriteReport(services.now());
    expect(afterWarm.total).toBe(afterCold.total);
    expect(kv.writes).toHaveLength(3);
  });

  it('keys each document by the publisher that produced it', async () => {
    const { services } = servicesWith(mockEnv());
    await readProjectionInputs(services);
    await readConferenceOdds(services);

    // The provider is part of every key, so switching a publisher can never
    // serve one's data labelled as the other's.
    expect(cacheKey('projection_inputs', 'mock')).toContain('|mock|');
    expect(cacheKey('conference_odds', 'playoffstatus', '2026')).toContain('|playoffstatus|');
  });

  it('survives a round trip through KV, which means playoffstatus is a known provider', async () => {
    // The subtle one. `isCacheEntry` narrows a stored entry's `provider`
    // against the `ProviderName` union; a publisher missing from that RUNTIME
    // set is not a type error but a permanent cache miss, refetching and
    // rewriting the key on every single read. Only a second isolate reading
    // the first's KV copy catches it, which is what this does.
    const kv = new FakeKv();
    const oddsEnv = mockEnv({ CONFERENCE_ODDS_PROVIDER: 'playoffstatus' });

    // Write the entry as the odds publisher, through the mock's data so that
    // nothing reaches the network.
    const seeding = servicesWith(mockEnv(), kv);
    await readConferenceOdds(seeding.services);
    const stored = [...kv.store.keys()].find((key) => key.includes('conference_odds'));
    expect(stored).toBeDefined();
    kv.store.set(
      stored!.replace('|mock|', '|playoffstatus|'),
      (kv.store.get(stored!) ?? '').replace('"provider":"mock"', '"provider":"playoffstatus"'),
    );

    // A fresh isolate: empty L1, the same KV.
    resetCacheTiers();
    resetInflight();
    const second = servicesWith(oddsEnv, kv);
    const read = await readConferenceOdds(second.services);

    // A hit, not a miss. A miss here would mean a network attempt in
    // production and a KV rewrite every time.
    expect(read.status).toBe('hit');
    expect(read.envelope.freshness.provider).toBe('playoffstatus');
    expect(read.envelope.data?.rows.length).toBeGreaterThan(0);
  });
});

describe('the two publishers fail independently', () => {
  it('leaves the conference odds standing when FPI is down', async () => {
    const { services } = servicesWith(mockEnv({ SPORTS_PROVIDER_FAULT: 'projections' }));

    const projections = await readProjectionInputs(services);
    expect(projections.envelope.data).toBeNull();
    expect(projections.envelope.error?.kind).toBe('provider_unavailable');

    const odds = await readConferenceOdds(services);
    expect(odds.envelope.data?.rows.length).toBeGreaterThan(0);
  });

  it('leaves FPI standing when the odds publisher is down', async () => {
    const { services } = servicesWith(mockEnv({ SPORTS_PROVIDER_FAULT: 'odds' }));

    const odds = await readConferenceOdds(services);
    expect(odds.envelope.data).toBeNull();
    expect(odds.envelope.error?.kind).toBe('provider_unavailable');

    const projections = await readProjectionInputs(services);
    expect(projections.envelope.data?.teams.length).toBeGreaterThan(0);
  });

  it('takes both down with one token, for the "both down" drill', async () => {
    const { services } = servicesWith(mockEnv({ SPORTS_PROVIDER_FAULT: 'all' }));
    expect((await readProjectionInputs(services)).envelope.data).toBeNull();
    expect((await readConferenceOdds(services)).envelope.data).toBeNull();
  });

  it('does not take the odds down for an unrelated fault', async () => {
    // `team:` and `schedule` are about one board's cards. A projection has no
    // business failing because somebody's schedule did (§42).
    const { services } = servicesWith(mockEnv({ SPORTS_PROVIDER_FAULT: 'schedule,team:61' }));
    expect((await readProjectionInputs(services)).envelope.data).not.toBeNull();
    expect((await readConferenceOdds(services)).envelope.data).not.toBeNull();
  });
});

describe('the power four', () => {
  it('matches ESPN’s own short names in the captured conference map', () => {
    // A renamed conference would silently make every one of its teams
    // ineligible and zero the conference half of the rubric for sixty-odd
    // teams, with nothing on screen to say so. Hence a pinned set and this.
    const named = new Set(Object.values(conferenceMapFixture()));
    for (const conference of POWER_FOUR) {
      expect(named.has(conference), conference).toBe(true);
    }
  });

  it('is exactly the four the rubric pays for', () => {
    expect([...POWER_FOUR]).toEqual(['ACC', 'Big Ten', 'Big 12', 'SEC']);
    expect(isPowerFour('Mountain West')).toBe(false);
    expect(isPowerFour('FBS Indep.')).toBe(false);
    expect(isPowerFour(null)).toBe(false);
    expect(isPowerFour('Pac-12')).toBe(false);
  });
});
