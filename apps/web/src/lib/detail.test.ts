import { describe, expect, it } from 'vitest';
import {
  finalGameDetail,
  LIVE_SITUATION,
  liveGameDetail,
  liveMatchup,
  makeMatchup,
} from '../test/fixtures';
import {
  leadersTitle,
  liveWinProbability,
  orderedScoringPlays,
  periodShort,
  periodSpoken,
  pointsText,
  possessionSide,
  probabilityText,
  scoreAfter,
  situationLine,
  statsTitle,
  statText,
  trendPoints,
  trendSummary,
} from './detail';

describe('the situation line (Phase 3)', () => {
  it('names the side with the ball in words, then the provider’s down and distance', () => {
    const row = liveMatchup({ situation: LIVE_SITUATION });
    expect(situationLine(row)).toBe('OSU ball, 2nd & 7 at IOWA 34');
    expect(possessionSide(row)).toBe('away');
  });

  it('says what it has: no possession, or no down and distance', () => {
    expect(
      situationLine(liveMatchup({ situation: { ...LIVE_SITUATION, possessionTeamId: null } })),
    ).toBe('2nd & 7 at IOWA 34');
    expect(
      situationLine(liveMatchup({ situation: { ...LIVE_SITUATION, downDistance: null } })),
    ).toBe('OSU ball');
    expect(
      situationLine(
        liveMatchup({
          situation: { possessionTeamId: null, downDistance: null, lastPlay: 'Timeout' },
        }),
      ),
    ).toBeNull();
  });

  it('a team id that is neither side marks nobody', () => {
    const row = liveMatchup({ situation: { ...LIVE_SITUATION, possessionTeamId: '9999' } });
    expect(possessionSide(row)).toBeNull();
    expect(situationLine(row)).toBe('2nd & 7 at IOWA 34');
  });

  it('nothing at all when the game is not in progress or the row carries no situation', () => {
    expect(situationLine(makeMatchup({ situation: LIVE_SITUATION }))).toBeNull();
    expect(possessionSide(makeMatchup({ situation: LIVE_SITUATION }))).toBeNull();
    expect(situationLine(liveMatchup())).toBeNull();
  });
});

describe('values as printed', () => {
  it('a missing stat or score is a dash, never 0', () => {
    expect(statText({ display: null, value: null })).toBe('—');
    expect(statText({ display: '0', value: 0 })).toBe('0');
    expect(statText({ display: '5-14', value: null })).toBe('5-14');
    expect(pointsText(null)).toBe('—');
    expect(pointsText(0)).toBe('0');
  });

  it('a probability prints to one decimal at most', () => {
    expect(probabilityText(0.9229)).toBe('92.3%');
    expect(probabilityText(0.5)).toBe('50%');
    expect(probabilityText(0)).toBe('0%');
  });

  it('the two kinds of stats have two titles', () => {
    expect(statsTitle('game')).toBe('Team stats');
    expect(statsTitle('season_average')).toBe('Season averages');
    expect(leadersTitle('game')).toBe('Leaders');
    expect(leadersTitle('season_average')).toBe('Season leaders');
  });

  it('periods, short and spoken, overtime included', () => {
    expect([1, 4, 5, 6].map(periodShort)).toEqual(['Q1', 'Q4', 'OT', '2OT']);
    expect([1, 4, 5, 6].map(periodSpoken)).toEqual([
      '1st quarter',
      '4th quarter',
      'overtime',
      '2nd overtime',
    ]);
    expect(periodShort(null)).toBeNull();
  });
});

describe('scoring plays', () => {
  const plays = liveGameDetail().scoringPlays;

  it('newest first while live, in game order once over', () => {
    expect(orderedScoringPlays(plays, liveMatchup()).map((play) => play.id)).toEqual([
      'sp3',
      'sp2',
      'sp1',
    ]);
    expect(orderedScoringPlays(plays, makeMatchup({ status: 'final' })).map((p) => p.id)).toEqual([
      'sp1',
      'sp2',
      'sp3',
    ]);
  });

  it('the score after a play reads away first, and says nothing without one', () => {
    const row = liveMatchup();
    expect(scoreAfter(row, plays[2]!)).toBe('OSU 14, IOWA 7');
    expect(scoreAfter(row, { ...plays[2]!, homeScore: null })).toBeNull();
  });
});

describe('the live win probability', () => {
  it('only while both the header and the detail say the game is on', () => {
    const live = liveGameDetail();
    expect(liveWinProbability(liveMatchup(), live)).not.toBeNull();
    // The header has gone final; the detail lags a poll behind. Neither is shown.
    expect(liveWinProbability(makeMatchup({ status: 'final' }), live)).toBeNull();
    expect(liveWinProbability(liveMatchup(), { ...live, status: 'final' })).toBeNull();
    expect(liveWinProbability(liveMatchup(), finalGameDetail())).toBeNull();
  });

  it('the trend in words: the first point and now, for the home side', () => {
    const probability = liveGameDetail().winProbability!;
    expect(trendSummary(liveMatchup(), probability)).toBe(
      'IOWA: 38% after the first play, 21.4% now',
    );
    expect(trendSummary(liveMatchup(), { ...probability, homeSeries: [0.4] })).toBeNull();
  });

  it('the trend line is geometry in a 100 × 40 box, home up', () => {
    expect(trendPoints([1, 0.5, 0])).toBe('0,0 50,20 100,40');
    expect(trendPoints([0.5])).toBe('');
  });
});
