import type { BoardTeam } from '@cfb/shared';
import { describe, expect, it } from 'vitest';
import {
  envelope,
  finalGame,
  liveGame,
  makeBoardTeam,
  makeGame,
  makeSnapshot,
  makeTeam,
  PROVIDER_DOWN,
} from '../../test/fixtures';
import { RAW_VALUE, renderInRouter, spokenText, visibleText } from '../../test/render';
import { TeamCard } from './TeamCard';

const FROM = { path: '/u/1', label: "Wilson's board" };

function render(entry: BoardTeam) {
  const markup = renderInRouter(<TeamCard entry={entry} from={FROM} />);
  return { markup, seen: visibleText(markup), heard: spokenText(markup) };
}

function card(
  overrides: Parameters<typeof makeSnapshot>[1] = {},
  state: 'fresh' | 'stale' = 'fresh',
) {
  const team = makeTeam();
  return makeBoardTeam(envelope(makeSnapshot(team, overrides), state), team);
}

describe('TeamCard: the ordinary card (§13, §14, §56)', () => {
  const { markup, seen, heard } = render(card());

  it('shows logo, name, conference, rank, and record', () => {
    expect(markup).toContain('alt="Alabama logo"');
    expect(seen).toContain('Alabama');
    expect(seen).toContain('SEC');
    expect(seen).toContain('#4');
    expect(seen).toContain('4-0');
  });

  it('shows the previous opponent and result, and the next opponent and date', () => {
    expect(seen).toContain('vs LSU');
    expect(seen).toContain('W 31–24');
    expect(seen).toContain('@ Tennessee');
    expect(markup).toContain('dateTime="2026-10-03T20:30:00.000Z"');
  });

  it('reads the rank, result, and home/away out in words', () => {
    expect(heard).toContain('Ranked 4 in the AP Top 25');
    expect(heard).toContain('Won 31–24');
    expect(heard).toContain('at Tennessee');
    expect(heard).toContain('versus LSU');
  });

  it('is one link to the team page, keyed by our own team id', () => {
    expect(markup.match(/<a /g)).toHaveLength(1);
    expect(markup).toMatch(/href="\/teams\/[0-9a-f-]{36}"/);
  });

  it('draws the team colour as a custom property for the left rule only', () => {
    expect(markup).toContain('--team-light:#9e1b32');
  });

  it('says nothing about freshness when the data is current', () => {
    expect(seen).not.toContain('out of date');
  });
});

describe('TeamCard: every state renders words, never a raw value (§37)', () => {
  const cases: Array<[string, BoardTeam, string[]]> = [
    ['unranked', card({ ranking: { kind: 'unranked' } }), ['NR']],
    ['ranking unavailable', card({ ranking: { kind: 'unavailable' } }), ['—']],
    ['no record yet', card({ record: null, previousGame: null }), ['—', 'No games played yet']],
    [
      'bye week with the next game',
      card({
        nextGame: {
          kind: 'bye',
          week: 5,
          following: makeGame({
            opponent: {
              providerTeamId: '38',
              name: 'Colorado',
              abbreviation: 'COLO',
              logoUrl: null,
            },
          }),
        },
      }),
      ['Bye week (week 5)', 'Then @ Colorado'],
    ],
    [
      'bye week, nothing after it',
      card({ nextGame: { kind: 'bye', week: null, following: null } }),
      ['Bye week'],
    ],
    [
      'season complete',
      card({ nextGame: { kind: 'none', reason: 'season_complete' } }),
      ['Season complete'],
    ],
    [
      'no upcoming game',
      card({ nextGame: { kind: 'none', reason: 'no_upcoming' } }),
      ['No upcoming game'],
    ],
    [
      'TBD kickoff',
      card({
        nextGame: {
          kind: 'game',
          game: makeGame({ kickoffUtc: '2026-10-10T04:00:00.000Z', kickoffTbd: true }),
        },
      }),
      ['Sat, Oct 10, time TBD'],
    ],
    [
      'postponed next game',
      card({
        nextGame: {
          kind: 'game',
          game: makeGame({ status: 'postponed', statusDetail: 'Postponed' }),
        },
      }),
      ['Postponed'],
    ],
    [
      'delayed next game',
      card({ nextGame: { kind: 'game', game: makeGame({ status: 'delayed' }) } }),
      ['Delayed'],
    ],
    [
      'unknown status',
      card({
        nextGame: { kind: 'game', game: makeGame({ status: 'unknown', statusDetail: null }) },
      }),
      ['Status unknown'],
    ],
    [
      'a tie',
      card({ previousGame: finalGame({ result: 'T', teamScore: 17, opponentScore: 17 }) }),
      ['T 17–17'],
    ],
    [
      'a loss',
      card({ previousGame: finalGame({ result: 'L', teamScore: 20, opponentScore: 24 }) }),
      ['L 20–24'],
    ],
    [
      'a neutral site',
      card({ nextGame: { kind: 'game', game: makeGame({ homeAway: 'neutral' }) } }),
      ['vs Tennessee (neutral site)'],
    ],
    [
      'no logo',
      makeBoardTeam(
        envelope(makeSnapshot(makeTeam({ logoUrl: null }))),
        makeTeam({ logoUrl: null }),
      ),
      ['ALA'],
    ],
    [
      'the longest seeded name',
      (() => {
        const team = makeTeam({
          name: 'Southern Miss Golden Eagles',
          displayName: 'Southern Miss',
          abbreviation: 'USM',
          conference: 'Sun Belt',
        });
        return makeBoardTeam(envelope(makeSnapshot(team)), team);
      })(),
      ['Southern Miss', 'Sun Belt'],
    ],
  ];

  it.each(cases)('%s', (_name, entry, expected) => {
    const { seen, heard } = render(entry);
    for (const text of expected) expect(seen).toContain(text);
    expect(seen).not.toMatch(RAW_VALUE);
    expect(heard).not.toMatch(RAW_VALUE);
    expect(seen).not.toContain('12:00 AM');
  });

  it('never shows the placeholder "NR" for a ranking it could not fetch (§7)', () => {
    const { seen, heard } = render(card({ ranking: { kind: 'unavailable' } }));
    expect(seen).not.toContain('NR');
    expect(heard).toContain('Ranking unavailable');
  });

  it('labels a missing logo like the image it replaces (§36)', () => {
    const team = makeTeam({ logoUrl: null });
    const { markup } = render(makeBoardTeam(envelope(makeSnapshot(team)), team));
    expect(markup).toContain('role="img"');
    expect(markup).toContain('aria-label="Alabama logo"');
    expect(markup).not.toContain('<img');
  });
});

describe('TeamCard: live (§11)', () => {
  it('leads with LIVE, the score, and the situation, without calling anything final', () => {
    const { markup, seen } = render(card({ liveGame: liveGame() }));
    expect(seen).toContain('LIVE');
    expect(seen).toContain('4:32 - 3rd Quarter');
    expect(seen).toMatch(/ALA ?24/);
    expect(seen).toMatch(/Tennessee ?21/);
    expect(seen).not.toMatch(/\bFinal\b/);
    // Only the score region is announced as it changes.
    expect(markup.match(/aria-live="polite"/g)).toHaveLength(1);
    // The live game never replaces the previous game (§9).
    expect(seen).toContain('W 31–24');
    // LIVE comes before the previous and next games on the card (§51).
    expect(seen.indexOf('LIVE')).toBeLessThan(seen.indexOf('Previous'));
  });

  it('says "score unavailable" instead of inventing 0–0 when the score is missing', () => {
    const { seen } = render(
      card({ liveGame: liveGame({ teamScore: null, opponentScore: null }) }, 'stale'),
    );
    expect(seen).toContain('score unavailable');
    expect(seen).not.toContain('0–0');
    expect(seen).toContain('May be out of date');
  });
});

describe('TeamCard: freshness and failure (§38, §39, §42)', () => {
  it('marks a stale card in words and keeps its original timestamp', () => {
    const team = makeTeam();
    const entry = makeBoardTeam(
      envelope(makeSnapshot(team), 'stale', null, '2026-09-30T14:05:00.000Z'),
      team,
    );
    const { markup, seen } = render(entry);
    expect(seen).toContain('May be out of date. Last updated:');
    expect(markup).toContain('dateTime="2026-09-30T14:05:00.000Z"');
    // The data itself is still shown: stale is labeled, not hidden.
    expect(seen).toContain('#4');
  });

  it('keeps the team’s identity when its sports data failed', () => {
    const team = makeTeam();
    const { markup, seen } = render(
      makeBoardTeam(envelope(null, 'unavailable', PROVIDER_DOWN), team),
    );
    expect(seen).toContain('Alabama');
    expect(seen).toContain('Sports data temporarily unavailable.');
    expect(markup).toMatch(/href="\/teams\//);
    expect(seen).not.toContain('#4');
    expect(seen).not.toContain('NR');
    expect(seen).not.toMatch(RAW_VALUE);
  });

  it('distinguishes unreadable data from an outage', () => {
    const { seen } = render(
      makeBoardTeam(
        envelope(null, 'unavailable', {
          kind: 'provider_invalid_response',
          message: 'x',
          requestId: null,
        }),
      ),
    );
    expect(seen).toContain('Sports data could not be read.');
  });
});
