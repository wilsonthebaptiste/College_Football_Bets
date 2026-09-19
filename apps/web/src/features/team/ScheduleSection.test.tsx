import type { Game, ScheduleItem } from '@cfb/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { finalGame, liveGame, makeGame, seasonItems } from '../../test/fixtures';
import { RAW_VALUE, spokenText, visibleText } from '../../test/render';
import { ScheduleList, ScheduleTable } from './ScheduleSection';

/**
 * §17 — the full schedule, in both of its renderings. The page shows one or
 * the other by width (CSS), so each is checked on its own here.
 */

const NEXT = '401000001';

function table(items: ScheduleItem[] = seasonItems(), nextGameId: string | null = NEXT) {
  const markup = renderToStaticMarkup(
    <ScheduleTable items={items} teamName="Alabama" year={2026} nextGameId={nextGameId} />,
  );
  return { markup, seen: visibleText(markup), heard: spokenText(markup) };
}

function list(items: ScheduleItem[] = seasonItems(), nextGameId: string | null = NEXT) {
  const markup = renderToStaticMarkup(
    <ScheduleList items={items} teamName="Alabama" year={2026} nextGameId={nextGameId} />,
  );
  return { markup, seen: visibleText(markup), heard: spokenText(markup) };
}

const only = (game: Game): ScheduleItem[] => [{ kind: 'game', game }];

/** The text of the one table row that mentions `needle`. */
function rowWith(markup: string, needle: string): string {
  const row = markup.match(/<tr[^>]*>.*?<\/tr>/g)?.find((candidate) => candidate.includes(needle));
  if (row === undefined) throw new Error(`no row with ${needle}`);
  return visibleText(row);
}

describe('ScheduleTable: a real table (§17, §48)', () => {
  const { markup, seen, heard } = table();

  it('has a caption, column headers, and a row header per game', () => {
    expect(markup).toContain('<caption');
    expect(heard).toContain('Alabama’s 2026 schedule');
    expect(markup.match(/<th scope="col"/g)).toHaveLength(6);
    for (const header of ['Week', 'Date', 'Opponent', 'Status', 'Result']) {
      expect(seen).toContain(header);
    }
    expect(heard).toContain('Home or away');
    // Seven games, each named by its opponent in a row header.
    expect(markup.match(/<th scope="row"/g)).toHaveLength(7);
  });

  it('lists every game in order, with the bye week as a row of its own (§10, §17)', () => {
    const opponents = [
      'Auburn',
      'Florida',
      'Ole Miss',
      'Vanderbilt',
      'Tennessee',
      'LSU',
      'Oklahoma',
    ];
    const positions = opponents.map((name) => seen.indexOf(name));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);

    expect(markup.match(/<tr/g)).toHaveLength(1 + 8); // header + 7 games + 1 bye
    expect(rowWith(markup, 'Bye week')).toBe('6 Bye week');
    expect(markup).toMatch(/colspan="5"/i);
    expect(seen.indexOf('Bye week')).toBeGreaterThan(seen.indexOf('Tennessee'));
    expect(seen.indexOf('Bye week')).toBeLessThan(seen.indexOf('LSU'));
  });

  it('tells a result by letter, word, and shape, never colour alone (§17, §48)', () => {
    expect(rowWith(markup, 'Auburn')).toContain('W 34–17');
    expect(rowWith(markup, 'Florida')).toContain('L 20–24');
    expect(rowWith(markup, 'Ole Miss')).toContain('T 17–17');
    expect(heard).toContain('Won 34–17');
    expect(heard).toContain('Lost 20–24');
    expect(heard).toContain('Tied 17–17');
    // One shape class per result: solid, outlined, dashed.
    const marks = markup.match(/class="[^"]*mark[^"]*"/g) ?? [];
    expect(new Set(marks).size).toBe(3);
  });

  it('shows the provider’s own final wording, verbatim', () => {
    expect(rowWith(markup, 'Auburn')).toContain('Final/OT');
    expect(rowWith(markup, 'Florida')).toContain('Final');
  });

  it('says where each game is played: home, away, or neutral (§19)', () => {
    expect(rowWith(markup, 'Auburn')).toContain('Home');
    expect(rowWith(markup, 'Florida')).toContain('Away');
    expect(rowWith(markup, 'Ole Miss')).toContain('Neutral');
    expect(rowWith(markup, 'Florida')).toContain('Ben Hill Griffin Stadium');
  });

  it('gives canceled and postponed games a status and no score (§4, §18)', () => {
    const canceled = rowWith(markup, 'Vanderbilt');
    expect(canceled).toContain('Canceled');
    expect(canceled).not.toMatch(/\d+–\d+/);
    const postponed = rowWith(markup, 'LSU');
    expect(postponed).toContain('Postponed');
    expect(postponed).not.toMatch(/\d+–\d+/);
    expect(heard).toContain('No score');
  });

  it('marks the next game, and shows an unannounced kickoff as TBD (§4, §20)', () => {
    expect(rowWith(markup, 'Tennessee')).toContain('Upcoming Next');
    expect(rowWith(markup, 'Oklahoma')).toContain('TBD');
    expect(rowWith(markup, 'Oklahoma')).toContain('Sat, Oct 24');
    expect(seen).not.toContain('12:00 AM');
  });

  it('draws opponent logos as decoration beside the name, not as a second label', () => {
    expect(markup).not.toContain('role="img"');
    expect(heard).not.toContain('logo');
  });

  it('never renders a raw value', () => {
    expect(seen).not.toMatch(RAW_VALUE);
    expect(heard).not.toMatch(RAW_VALUE);
  });
});

describe('ScheduleTable: live and unusual rows (§11, §18)', () => {
  it('shows a live game as LIVE with its score and situation, and never as Final', () => {
    const { markup } = table(only(liveGame()));
    const row = rowWith(markup, 'Tennessee');
    expect(row).toContain('LIVE');
    expect(row).toContain('4:32 - 3rd Quarter');
    expect(row).toContain('24–21');
    expect(row).not.toMatch(/final/i);
    expect(row).not.toMatch(/\b[WLT] \d/);
  });

  it('says "Score unavailable" for a live game with no score, never 0–0', () => {
    const { markup } = table(only(liveGame({ teamScore: null, opponentScore: null })));
    const row = rowWith(markup, 'Tennessee');
    expect(row).toContain('Score unavailable');
    expect(row).not.toContain('0–0');
  });

  it('keeps a mid-game delay’s score, without a verdict', () => {
    const { markup } = table(
      only(
        liveGame({ status: 'delayed', statusDetail: 'Delayed', teamScore: 7, opponentScore: 3 }),
      ),
    );
    const row = rowWith(markup, 'Tennessee');
    expect(row).toContain('Delayed');
    expect(row).toContain('7–3');
  });

  it('shows an unknown status in neutral words (§18, §40)', () => {
    const { markup } = table(only(makeGame({ status: 'unknown', statusDetail: 'Forfeit' })));
    expect(rowWith(markup, 'Tennessee')).toContain('Forfeit');
  });

  it('labels a postseason game by phase, not by a week number', () => {
    const bowl = finalGame({
      week: 1,
      season: { year: 2026, type: 'postseason', week: 1 },
      opponent: { providerTeamId: '52', name: 'Florida State', abbreviation: 'FSU', logoUrl: null },
    });
    expect(rowWith(table(only(bowl)).markup, 'Florida State')).toMatch(/^Postseason/);
  });
});

describe('ScheduleList: stacked entries for phones (§17, §34)', () => {
  const { markup, seen, heard } = list();

  it('is an ordered, labelled list with one entry per row, bye included', () => {
    expect(markup).toMatch(/<ol[^>]*aria-label="Alabama’s 2026 schedule"/);
    expect(markup.match(/<li/g)).toHaveLength(8);
    expect(markup).not.toContain('<table');
  });

  it('carries the same information as the table', () => {
    expect(seen).toContain('Week 1 · Sat, Sep 5');
    expect(seen).toContain('vs Auburn');
    expect(seen).toContain('W 34–17');
    expect(seen).toContain('@ Florida');
    expect(seen).toContain('vs Ole Miss (neutral site)');
    expect(seen).toContain('Week 6 Bye week');
    expect(seen).toContain('Canceled');
    expect(seen).toContain('Postponed');
    expect(seen).toContain('Upcoming Next');
    expect(seen).toContain('Sat, Oct 24 · TBD');
    expect(heard).toContain('Won 34–17');
    expect(heard).toContain('at Florida');
  });

  it('never renders a raw value or a placeholder time', () => {
    expect(seen).not.toMatch(RAW_VALUE);
    expect(heard).not.toMatch(RAW_VALUE);
    expect(seen).not.toContain('12:00 AM');
  });
});
