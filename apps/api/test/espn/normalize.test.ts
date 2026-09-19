import type { Season } from '@cfb/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  easternSlateKey,
  toPrediction,
  toProviderGame,
  toRankings,
  toSchedule,
  toSeason,
  toTeamIdentity,
} from '../../src/providers/espn/normalize';
import { mapStatus, resetStatusLog } from '../../src/providers/espn/status-map';
import {
  readCalendar,
  readErrorBody,
  readRankings,
  readSchedule,
  readScoreboard,
  readStandalonePredictor,
  readSummary,
  readTeamList,
} from '../../src/providers/espn/validate';
import type { ProviderSchedule } from '../../src/providers/types';
import { deriveSlots, scheduleItems } from '../../src/services/derive';
import { toTeamGame } from '../../src/services/perspective';
import { rankingOf } from '../../src/services/snapshot';
import { CAPTURED_AT, fixture } from '../helpers/fixtures';

/**
 * Every Phase 1 capture, through the real validators and normalizers. These
 * are the rules docs/espn-notes.md says the adapter must follow, pinned to
 * the payloads that taught us them.
 */

const TEXAS = '251';
const PITT = '221';
const WEEK_3: Season = { year: 2026, type: 'regular', week: 3 };
const CAPTURE_NOW = Date.parse(CAPTURED_AT);

function schedule(name: string, season: Season = WEEK_3): ProviderSchedule {
  const raw = readSchedule(fixture(name));
  if (raw === null) throw new Error(`${name} failed validation`);
  return toSchedule([raw], season);
}

function summaryOf(name: string): NonNullable<ReturnType<typeof readSummary>> {
  const raw = readSummary(fixture(name));
  if (raw === null) throw new Error(`${name} failed validation`);
  return raw;
}

beforeEach(() => {
  resetStatusLog();
});

describe('calendar → season (§21)', () => {
  it('reads year, type, and week from the bare scoreboard', () => {
    const raw = readCalendar(fixture('calendar'));
    expect(raw).not.toBeNull();
    expect(toSeason(raw!)).toEqual({ year: 2026, type: 'regular', week: 3 });
  });

  it('maps the off season (type 4) to postseason with no week', () => {
    expect(toSeason({ seasonYear: 2027, seasonType: 4, week: 1 })).toEqual({
      year: 2027,
      type: 'postseason',
      week: null,
    });
  });

  it('refuses a season type it does not know', () => {
    expect(toSeason({ seasonYear: 2026, seasonType: 9, week: 1 })).toBeNull();
  });
});

describe('schedule — Texas, ranked, bye in week 5', () => {
  const texas = schedule('schedule-ranked');
  const byWeek = (week: number) => texas.games.find((game) => game.week === week);

  it('keeps all twelve games, in kickoff order, and drops nothing', () => {
    expect(texas.games).toHaveLength(12);
    expect(texas.droppedEvents).toBe(0);
    const kickoffs = texas.games.map((game) => game.kickoffUtc);
    expect([...kickoffs].sort()).toEqual(kickoffs);
  });

  it('normalizes minute-precision timestamps to full ISO 8601 UTC (§20)', () => {
    expect(byWeek(1)?.kickoffUtc).toBe('2026-09-05T19:30:00.000Z');
  });

  it('reads a final game from the schedule score shape ({ value, displayValue })', () => {
    const opener = toTeamGame(byWeek(1)!, TEXAS);
    expect(opener).toMatchObject({
      status: 'final',
      homeAway: 'home',
      teamScore: 59,
      opponentScore: 7,
      result: 'W',
      statusDetail: 'Final',
    });
    expect(opener?.opponent.name).toBe('Texas St');
  });

  it('gives upcoming games no score, no result, and no formatted time (§20)', () => {
    const upcoming = toTeamGame(byWeek(3)!, TEXAS);
    expect(upcoming).toMatchObject({
      status: 'scheduled',
      teamScore: null,
      opponentScore: null,
      result: null,
      // ESPN's detail here is "Sat, September 19th at 8:00 PM EDT".
      statusDetail: null,
    });
  });

  it('flags TBD kickoffs so the UI never shows a placeholder time as real (§4)', () => {
    expect(texas.games.filter((game) => game.kickoffTbd).map((game) => game.week)).toEqual([
      7, 8, 9, 10, 11, 12,
    ]);
    expect(byWeek(13)?.kickoffTbd).toBe(false);
  });

  it('takes home/away from the provider, and neutral overrides it (§19)', () => {
    expect(toTeamGame(byWeek(4)!, TEXAS)?.homeAway).toBe('away');
    // Red River at the Cotton Bowl: listed with a home team, played at neither.
    expect(byWeek(6)?.neutralSite).toBe(true);
    expect(toTeamGame(byWeek(6)!, TEXAS)?.homeAway).toBe('neutral');
  });

  it('derives previous, next, and record as they stood at capture time', () => {
    const slots = deriveSlots(texas.games, TEXAS, {
      now: CAPTURE_NOW,
      season: WEEK_3,
      complete: true,
    });
    expect(slots.liveGame).toBeNull();
    expect(slots.previousGame).toMatchObject({
      week: 2,
      result: 'W',
      teamScore: 24,
      opponentScore: 23,
    });
    expect(slots.previousGame?.opponent.name).toBe('Ohio State');
    expect(slots.nextGame).toMatchObject({ kind: 'game', game: { week: 3, homeAway: 'home' } });
    expect(slots.record).toEqual({
      wins: 2,
      losses: 0,
      ties: null,
      summary: '2-0',
      conference: { wins: 0, losses: 0 },
    });
  });

  it('reports the week-5 bye, with the next game after it (§10)', () => {
    const slots = deriveSlots(texas.games, TEXAS, {
      now: Date.parse('2026-10-01T15:00:00Z'),
      season: { year: 2026, type: 'regular', week: 5 },
      complete: true,
    });
    expect(slots.nextGame.kind).toBe('bye');
    if (slots.nextGame.kind !== 'bye') return;
    expect(slots.nextGame.week).toBe(5);
    expect(slots.nextGame.following?.opponent.name).toBe('Oklahoma');
  });

  it('lists the bye as a schedule row, between weeks 4 and 6 (§17)', () => {
    const items = scheduleItems(texas.games, TEXAS, true);
    expect(items).toHaveLength(13);
    const weeks = items.map((item) =>
      item.kind === 'bye' ? `bye ${String(item.week)}` : item.game.week,
    );
    expect(weeks.slice(3, 6)).toEqual([4, 'bye 5', 6]);
  });
});

describe('schedule — Pittsburgh, unranked, bye in week 10', () => {
  const pitt = schedule('schedule-unranked');

  it('finds the week-10 bye row', () => {
    const byes = scheduleItems(pitt.games, PITT, true).filter((item) => item.kind === 'bye');
    expect(byes).toEqual([{ kind: 'bye', week: 10 }]);
  });

  it('reads the record, conference record included, off the latest final game', () => {
    const slots = deriveSlots(pitt.games, PITT, {
      now: CAPTURE_NOW,
      season: WEEK_3,
      complete: true,
    });
    expect(slots.previousGame).toMatchObject({
      week: 3,
      result: 'W',
      teamScore: 27,
      opponentScore: 13,
    });
    expect(slots.record).toMatchObject({
      summary: '3-0',
      wins: 3,
      losses: 0,
      conference: { wins: 1, losses: 0 },
    });
  });
});

describe('rankings (§7)', () => {
  const raw = readRankings(fixture('rankings'));

  it('uses the AP poll in week 3, when no CFP poll exists, under its own name', () => {
    const rankings = toRankings(raw!, WEEK_3);
    expect(rankings).toMatchObject({ poll: 'AP Top 25', week: 3 });
    expect(rankings?.teams).toHaveLength(25);
    expect(rankingOf(TEXAS, rankings)).toEqual({
      kind: 'ranked',
      rank: 1,
      poll: 'AP Top 25',
      week: 3,
    });
  });

  it('says NR for a team the poll does not rank, "receiving votes" or not', () => {
    // Pitt is in AP `others[]` (current: 0) at capture. That is not a rank.
    expect(rankingOf(PITT, toRankings(raw!, WEEK_3))).toEqual({ kind: 'unranked' });
  });

  it('prefers the CFP poll once one is published', () => {
    const body = fixture('rankings') as { rankings: Record<string, unknown>[] };
    const ap = body.rankings[0]!;
    body.rankings.push({ ...ap, type: 'cfp', name: 'College Football Playoff Rankings' });
    expect(toRankings(readRankings(body)!, WEEK_3)?.poll).toBe('College Football Playoff Rankings');
  });

  it('refuses another season’s poll: unavailable, never NR (§21)', () => {
    const rankings = toRankings(raw!, { year: 2025, type: 'regular', week: 3 });
    expect(rankings).toBeNull();
    expect(rankingOf(TEXAS, rankings)).toEqual({ kind: 'unavailable' });
  });

  it('drops a poll with even one malformed entry rather than calling that team unranked', () => {
    const body = fixture('rankings') as {
      rankings: { type: string; ranks: Record<string, unknown>[] }[];
    };
    const ap = body.rankings.find((poll) => poll.type === 'ap')!;
    delete ap.ranks[4]!['team'];
    expect(toRankings(readRankings(body)!, WEEK_3)).toBeNull();
  });
});

describe('game summaries — the three score shapes and the finality trap', () => {
  it('final: the provider’s winner decides the result (§9)', () => {
    const game = toProviderGame(summaryOf('game-final').event);
    expect(game.status).toBe('final');
    expect(toTeamGame(game, PITT)).toMatchObject({ result: 'W', teamScore: 27, opponentScore: 13 });
    expect(toTeamGame(game, '183')).toMatchObject({
      result: 'L',
      teamScore: 13,
      opponentScore: 27,
    });
    expect(game.venue).toBe('Acrisure Stadium');
  });

  it('live: period and clock present, no result, never "Final" (§11)', () => {
    const game = toProviderGame(summaryOf('game-live').event);
    expect(game.status).toBe('live');
    expect(game.period).toBeGreaterThanOrEqual(1);
    expect(game.clock).not.toBeNull();
    expect(game.home.winner).toBeNull();
    expect(game.away.winner).toBeNull();
    expect(game.statusDetail).not.toMatch(/final/i);
    const pov = toTeamGame(game, game.home.team.providerTeamId);
    expect(pov?.result).toBeNull();
    expect(typeof pov?.teamScore).toBe('number');
  });

  it('upcoming: the score key is absent, and so is the score', () => {
    const game = toProviderGame(summaryOf('game-upcoming').event);
    expect(game).toMatchObject({
      status: 'scheduled',
      statusDetail: null,
      period: null,
      clock: null,
    });
    expect(game.home.score).toBeNull();
    expect(game.away.score).toBeNull();
  });

  it('postponed: state "post" and 0–0, which is NOT a final score (§4, §18)', () => {
    const game = toProviderGame(summaryOf('game-postponed').event);
    expect(game.status).toBe('postponed');
    expect(game.statusDetail).toBe('Postponed');
    expect(game.home.score).toBeNull();
    expect(game.away.score).toBeNull();
    expect(toTeamGame(game, '228')?.result).toBeNull();
    expect(game.season.year).toBe(2020);
  });
});

describe('scoreboards (live slates)', () => {
  it('turns an upcoming game’s "0" into no score', () => {
    const raw = readScoreboard(fixture('scoreboard-20260918'));
    const games = raw!.events.map((event) => toProviderGame(event));
    expect(games).toHaveLength(3);
    for (const game of games) {
      expect(game.status).toBe('scheduled');
      expect(game.home.score).toBeNull();
      expect(game.away.score).toBeNull();
    }
  });

  it('keeps seven postponements unscored and an overtime final’s wording verbatim', () => {
    const raw = readScoreboard(fixture('scoreboard-postponed-slate'));
    const games = raw!.events.map((event) => toProviderGame(event));
    const postponed = games.filter((game) => game.status === 'postponed');
    expect(postponed).toHaveLength(7);
    expect(postponed.every((game) => game.home.score === null && game.away.score === null)).toBe(
      true,
    );

    const overtime = games.find((game) => game.providerGameId === '401247324');
    expect(overtime).toMatchObject({ status: 'final', statusDetail: 'Final/3OT', period: null });
    expect(toTeamGame(overtime!, '130')).toMatchObject({
      result: 'W',
      teamScore: 48,
      opponentScore: 42,
    });
  });

  it('reads a real live slate: 0–0 in progress IS a score; 0–0 scheduled is not', () => {
    // Captured during Miami at Wake Forest, 2026-09-18T23:40Z.
    const raw = readScoreboard(fixture('scoreboard-live'));
    const games = raw!.events.map((event) => toProviderGame(event));
    const live = games.find((game) => game.status === 'live');
    expect(live).toMatchObject({ providerGameId: '401858226', period: 1, clock: '12:22' });
    expect(live?.statusDetail).toBe('12:22 - 1st Quarter');
    expect(toTeamGame(live!, '2390')).toMatchObject({
      homeAway: 'away',
      teamScore: 0,
      opponentScore: 0,
      result: null,
    });
    for (const game of games.filter((candidate) => candidate.status === 'scheduled')) {
      expect(game.home.score).toBeNull();
    }
  });

  it('reads the scoreboard’s records[] shape into the competitor record', () => {
    const raw = readScoreboard(fixture('scoreboard-20260917'));
    const game = toProviderGame(raw!.events[0]!);
    expect(toTeamGame(game, PITT)?.result).toBe('W');
    expect(game.home.record?.summary).toBe('3-0');
  });

  it('buckets a late kickoff into the Eastern date ESPN files it under', () => {
    // 10:30 PM EDT on the 18th is 02:30Z on the 19th, and ESPN lists it on the 18th.
    expect(easternSlateKey('2026-09-19T02:30:00.000Z')).toBe('20260918');
    expect(easternSlateKey('2026-09-18T23:30:00.000Z')).toBe('20260918');
    expect(easternSlateKey('2026-12-01T04:30:00.000Z')).toBe('20261130');
  });
});

describe('predictions (§12, §46)', () => {
  const at = '2026-09-18T12:00:00.000Z';

  it('reads the inline predictor from an upcoming game’s summary', () => {
    const prediction = toPrediction(summaryOf('game-upcoming'), null, at);
    expect(prediction).toMatchObject({
      source: 'espn_matchup_predictor',
      sourceLabel: 'ESPN Matchup Predictor',
      homeWinPct: 8.3,
      awayWinPct: 91.7,
      home: { providerTeamId: '154' },
      away: { providerTeamId: '2390' },
    });
  });

  it('falls back to the standalone predictor, cleaning float noise to ESPN’s precision', () => {
    const standalone = readStandalonePredictor(fixture('prediction-present'));
    const prediction = toPrediction(summaryOf('game-final'), standalone, at);
    expect(prediction).toMatchObject({ homeWinPct: 82.5, awayWinPct: 17.5 });
  });

  it('turns the 404 body into "no prediction", never 0%', () => {
    const body = fixture('prediction-absent');
    expect(readErrorBody(body)).toEqual({ code: 404 });
    expect(readStandalonePredictor(body)).toBeNull();
    expect(toPrediction(summaryOf('game-final'), null, at)).toBeNull();
  });

  it('discards an inline predictor that names different teams', () => {
    const body = fixture('game-upcoming') as { predictor: { homeTeam: { id: string } } };
    body.predictor.homeTeam.id = '999';
    expect(toPrediction(readSummary(body)!, null, at)).toBeNull();
  });

  it('refuses a percentage outside 0–100', () => {
    const body = fixture('game-upcoming') as {
      predictor: { homeTeam: { gameProjection: string } };
    };
    body.predictor.homeTeam.gameProjection = '140';
    expect(toPrediction(readSummary(body)!, null, at)).toBeNull();
  });

  it('never reads odds or pickcenter, even when they are the only numbers present', () => {
    const body = fixture('game-upcoming') as Record<string, unknown>;
    delete body['predictor'];
    expect(body['pickcenter']).toBeDefined();
    expect(toPrediction(readSummary(body)!, null, at)).toBeNull();
  });
});

describe('status map (§18, §40)', () => {
  const status = (name: string | null, completed: boolean | null, state = 'post') => ({
    name,
    state,
    completed,
    detail: null,
    shortDetail: null,
    period: null,
    displayClock: null,
  });

  it('maps an unrecognized status to unknown and logs it once', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(mapStatus(status('STATUS_ALIENS', false))).toBe('unknown');
    expect(mapStatus(status('STATUS_ALIENS', false))).toBe('unknown');
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('refuses to call a game final without completed === true', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(mapStatus(status('STATUS_FINAL', false))).toBe('unknown');
    expect(mapStatus(status('STATUS_FINAL', true))).toBe('final');
  });

  it('keeps a postponed game postponed despite state "post"', () => {
    expect(mapStatus(status('STATUS_POSTPONED', false, 'post'))).toBe('postponed');
  });

  it('keeps halftime live, so the board does not drop out of live polling', () => {
    expect(mapStatus(status('STATUS_HALFTIME', false, 'in'))).toBe('live');
  });

  it('degrades a final game with no verdict at all to unknown', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const raw = summaryOf('game-final').event;
    const stripped = {
      ...raw,
      home: { ...raw.home, winner: null, score: null },
      away: { ...raw.away, winner: null, score: null },
    };
    const game = toProviderGame(stripped);
    expect(game.status).toBe('unknown');
    expect(toTeamGame(game, PITT)?.result).toBeNull();
  });
});

describe('team list (§43)', () => {
  const teams = readTeamList(fixture('team-list'))!.map(toTeamIdentity);

  it('reads every team in every division', () => {
    expect(teams).toHaveLength(762);
  });

  it('normalizes identity: default logo, lowercase colours, no invented conference', () => {
    expect(teams.find((team) => team.providerTeamId === '333')).toEqual({
      provider: 'espn',
      providerTeamId: '333',
      name: 'Alabama Crimson Tide',
      displayName: 'Alabama',
      abbreviation: 'ALA',
      logoUrl: 'https://a.espncdn.com/i/teamlogos/ncaa/500/333.png',
      conference: null,
      primaryColor: '9e1b32',
      altColor: 'ffffff',
    });
  });

  it('leaves a team without logos with a null logo, not a broken one (§36)', () => {
    expect(teams.filter((team) => team.logoUrl === null).length).toBeGreaterThan(0);
    expect(
      teams.every((team) => team.logoUrl === null || team.logoUrl.startsWith('https://')),
    ).toBe(true);
  });
});
