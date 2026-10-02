import { describe, expect, it, vi } from 'vitest';
import { EspnClient } from '../../src/providers/espn/client';
import { toProjectionInputs } from '../../src/providers/espn/normalize';
import { EspnProvider } from '../../src/providers/espn/provider';
import { readFpiPage } from '../../src/providers/espn/validate';
import { ProviderError } from '../../src/providers/types';
import { fixture } from '../helpers/fixtures';

/**
 * ESPN's Football Power Index, against the real captured payload: the national
 * half of projected points (context/predicting_score.md, Phase 2).
 *
 * The thing worth protecting here is not that the numbers come out — it is
 * that they come out of the RIGHT COLUMN. The payload is a table, not a record:
 * each team's figures are a bare `values` array aligned with a `names` array,
 * and reading by index would substitute "projected losses" for a probability
 * while still producing a number that looks like one.
 */

/** Georgia, in the captured payload: FPI rank 1, and every column non-zero. */
const GEORGIA = '61';
const CAPTURED_TEAMS = 138;
const CAPTURED_LAST_UPDATED = '2026-10-01T08:00Z';

type Json = Record<string, unknown>;

function fpiFixture(): Json {
  return fixture('fpi') as Json;
}

/** The document-level `categories[name="fpi"]`, which carries the column order. */
function columnNames(page: Json): string[] {
  const categories = page['categories'] as Json[];
  const fpi = categories.find((category) => category['name'] === 'fpi');
  return fpi?.['names'] as string[];
}

function teamEntry(page: Json, teamId: string): Json {
  const teams = page['teams'] as Json[];
  const entry = teams.find((candidate) => (candidate['team'] as Json)['id'] === teamId);
  if (entry === undefined) throw new Error(`no team ${teamId} in the fixture`);
  return entry;
}

function fpiValues(entry: Json): number[] {
  const categories = entry['categories'] as Json[];
  const fpi = categories.find((category) => category['name'] === 'fpi');
  return fpi?.['values'] as number[];
}

/** A provider whose single fetch answers with `body`. */
function providerOver(body: unknown): EspnProvider {
  const stub = vi.fn(
    async () =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
  );
  return new EspnProvider(new EspnClient({ fetch: stub as unknown as typeof fetch }));
}

describe('readFpiPage: the real captured payload', () => {
  it('yields every rated team with the five fields, read by name', () => {
    const page = readFpiPage(fpiFixture());
    expect(page).not.toBeNull();
    expect(page?.teams).toHaveLength(CAPTURED_TEAMS);
    expect(page?.droppedTeams).toBe(0);
    expect(page?.count).toBe(CAPTURED_TEAMS);
    expect(page?.pages).toBe(1);
    expect(page?.lastUpdated).toBe(CAPTURED_LAST_UPDATED);

    const georgia = page?.teams.find((team) => team.teamId === GEORGIA);
    // Cross-checked against the raw `values` array by hand: the fixture's
    // Georgia row is [28.296, 1, 0, 10.991, 1.612, 22.8, 100, 0, 84, 27.5, 16,
    // 35.4, 4, 0, 0] against names [fpi, fpirank, rankchange7days, projectedw,
    // projectedl, probwinout, prob6wins, probwindiv, probmakeplayoffs,
    // probmaketitlegame, probwintitle, probwinconf, …]. So: 84 / 27.5 / 16 /
    // 35.4, and rank 1 — none of which is at the index a naive read would use.
    expect(georgia).toEqual({
      teamId: GEORGIA,
      winTitlePercent: 16,
      makeTitleGamePercent: 27.500000000000004,
      makePlayoffsPercent: 84,
      winConferencePercent: 35.4,
      fpiRank: 1,
    });
  });

  it('still reads correctly when ESPN reorders the names array', () => {
    const page = fpiFixture();
    const names = columnNames(page);
    const original = readFpiPage(page);

    // Reverse every column, in the document's `names` and in every team's
    // `values` together — the same payload, described in a different order.
    const reversedNames = [...names].reverse();
    (page['categories'] as Json[]).find((category) => category['name'] === 'fpi')!['names'] =
      reversedNames;
    for (const entry of page['teams'] as Json[]) {
      const categories = entry['categories'] as Json[];
      const fpi = categories.find((category) => category['name'] === 'fpi');
      if (fpi !== undefined) fpi['values'] = [...(fpi['values'] as number[])].reverse();
    }

    expect(readFpiPage(page)?.teams).toEqual(original?.teams);
  });

  it('fails validation when a column is renamed, rather than reading the wrong number', () => {
    const page = fpiFixture();
    const names = columnNames(page);
    const at = names.indexOf('probwintitle');
    const values = fpiValues(teamEntry(page, GEORGIA));
    const displaced = values[at + 1];

    names[at] = 'probwinnatty';

    // The honest answer is "this is not the payload we read". The dangerous
    // answer would have been the value next door, which is still a number.
    expect(readFpiPage(page)).toBeNull();
    expect(displaced).not.toBeUndefined();
  });

  it('drops a team with no fpi category rather than reporting it as zero', () => {
    const page = fpiFixture();
    const entry = teamEntry(page, GEORGIA);
    entry['categories'] = (entry['categories'] as Json[]).filter(
      (category) => category['name'] !== 'fpi',
    );

    const read = readFpiPage(page);
    expect(read?.teams).toHaveLength(CAPTURED_TEAMS - 1);
    expect(read?.droppedTeams).toBe(1);
    expect(read?.teams.some((team) => team.teamId === GEORGIA)).toBe(false);
  });
});

describe('toProjectionInputs', () => {
  it('divides by 100 exactly once, and carries the publisher’s own stamp', () => {
    const document = toProjectionInputs(readFpiPage(fpiFixture())!);

    const georgia = document.teams.find((team) => team.providerTeamId === GEORGIA);
    expect(georgia?.fpi.winTitle).toBeCloseTo(0.16, 10);
    expect(georgia?.fpi.makeTitleGame).toBeCloseTo(0.275, 10);
    expect(georgia?.fpi.makePlayoffs).toBeCloseTo(0.84, 10);
    expect(georgia?.winConference).toBeCloseTo(0.354, 10);
    expect(georgia?.fpi.fpiRank).toBe(1);
    expect(georgia?.fpi.source).toBe('espn_fpi');

    expect(document.computedLabel).toBe(CAPTURED_LAST_UPDATED);
  });

  it('leaves every probability inside 0–1, so nothing is clamped downstream', () => {
    const document = toProjectionInputs(readFpiPage(fpiFixture())!);
    for (const team of document.teams) {
      for (const value of [
        team.fpi.winTitle,
        team.fpi.makeTitleGame,
        team.fpi.makePlayoffs,
        team.winConference ?? 0,
      ]) {
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(1);
      }
    }
  });

  it('keeps the publishers’ nesting, so the runner-up differences stay positive', () => {
    const document = toProjectionInputs(readFpiPage(fpiFixture())!);
    // `a ≤ b ≤ c`. The rubric's runner-up term is `max(0, b − a)`; an inverted
    // pair would be floored and recorded as an anomaly on every board, so this
    // is worth knowing about the real payload rather than assuming.
    const inverted = document.teams.filter(
      (team) =>
        team.fpi.winTitle > team.fpi.makeTitleGame ||
        team.fpi.makeTitleGame > team.fpi.makePlayoffs,
    );
    expect(inverted).toEqual([]);
  });

  it('reports the four field sums, which the real payload satisfies', () => {
    const { fieldSums } = toProjectionInputs(readFpiPage(fpiFixture())!);
    // One champion, two finalists, twelve playoff places, ten FBS conference
    // titles. Measured on this capture: 99.8 / 200.1 / 1200.4 / 1000.9.
    expect(fieldSums.winTitle).toBeCloseTo(100, 0);
    expect(Math.abs(fieldSums.makeTitleGame - 200)).toBeLessThanOrEqual(3);
    expect(Math.abs(fieldSums.makePlayoffs - 1200)).toBeLessThanOrEqual(12);
    expect(Math.abs(fieldSums.winConference - 1000)).toBeLessThanOrEqual(10);
  });

  it('drops a team whose three national probabilities are all missing', () => {
    const page = readFpiPage(fpiFixture())!;
    const target = page.teams.find((team) => team.teamId === GEORGIA)!;
    target.winTitlePercent = null;
    target.makeTitleGamePercent = null;
    target.makePlayoffsPercent = null;

    const document = toProjectionInputs(page);
    // No row is better than a row of zeros: the projection's answer for "the
    // publisher has no figures" is `unavailable`, and that needs the team to
    // be absent rather than present and confidently nil.
    expect(document.teams.some((team) => team.providerTeamId === GEORGIA)).toBe(false);
  });

  it('keeps a team that lost only one column, with the rest intact', () => {
    const page = readFpiPage(fpiFixture())!;
    page.teams.find((team) => team.teamId === GEORGIA)!.winTitlePercent = null;

    const georgia = toProjectionInputs(page).teams.find((team) => team.providerTeamId === GEORGIA);
    // §42: one missing field must not cost the five that arrived.
    expect(georgia?.fpi.winTitle).toBe(0);
    expect(georgia?.fpi.makePlayoffs).toBeCloseTo(0.84, 10);
  });
});

describe('the ranks the shared worked table carries', () => {
  /**
   * `packages/shared/src/scoring.test.ts` pins the rubric against the eight
   * real teams of the plan's worked table, and three of its rows need an FPI
   * rank. Phase 1 could only solve those back from the published finish term,
   * which pins a rank inside the poll no further than "25 or better"; Phase 2
   * measured them here.
   *
   * `packages/shared` is zero-dependency and cannot read this directory's
   * fixtures, so the cross-check lives on this side. Its job is to tell
   * whoever re-captures the payload that the shared fixture's ranks have gone
   * stale, rather than letting the two drift apart in silence.
   */
  const MEASURED: Readonly<Record<string, number>> = {
    '245': 16, // Texas A&M
    '158': 14, // Nebraska
    '2305': 70, // Kansas
  };

  it('are the ranks in the captured payload', () => {
    const document = toProjectionInputs(readFpiPage(fpiFixture())!);
    for (const [providerTeamId, rank] of Object.entries(MEASURED)) {
      const team = document.teams.find((candidate) => candidate.providerTeamId === providerTeamId);
      expect(team?.fpi.fpiRank, providerTeamId).toBe(rank);
    }
  });

  it('settles Phase 1’s suspicion: a top-25 FPI rank and 3% playoff odds are coherent', () => {
    const document = toProjectionInputs(readFpiPage(fpiFixture())!);
    const texasAm = document.teams.find((team) => team.providerTeamId === '245');

    // Phase 1 recorded the plan's Texas A&M row as internally inconsistent: a
    // team FPI ranks inside its own top 25 "does not have 3% playoff odds".
    // The real payload says otherwise, on the same day the table was read.
    // FPI rank is how good a team is; playoff odds are the path in front of
    // it. A strong team that has already lost is plausibly both, so the plan's
    // table needed no correction.
    expect(texasAm?.fpi.fpiRank).toBeLessThanOrEqual(25);
    expect(texasAm?.fpi.makePlayoffs).toBeLessThan(0.05);
  });
});

describe('EspnProvider.getTeamProjections', () => {
  it('reads the captured payload through the client', async () => {
    const document = await providerOver(fpiFixture()).getTeamProjections();
    expect(document.teams).toHaveLength(CAPTURED_TEAMS);
    expect(document.computedLabel).toBe(CAPTURED_LAST_UPDATED);
  });

  it('refuses a truncated read rather than serving a partial table', async () => {
    const page = fpiFixture();
    // A second page means the limit no longer covers the league. Every team
    // past the cut would otherwise get no projection at all, silently.
    (page['pagination'] as Json)['pages'] = 2;

    await expect(providerOver(page).getTeamProjections()).rejects.toThrow(ProviderError);
    await expect(providerOver(page).getTeamProjections()).rejects.toThrow(/2 pages/);
  });

  it('warns about a broken field sum and keeps going', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const page = fpiFixture();
    // Half the league dropped, which is what a truncated `limit` looks like.
    page['teams'] = (page['teams'] as Json[]).slice(0, 69);

    const document = await providerOver(page).getTeamProjections();

    // A warning, not a throw. A publisher's rounding drift must not be able to
    // take the feature down, and a sum this wrong will have broken the two-way
    // join as well, which is where it is caught.
    expect(document.teams.length).toBeGreaterThan(0);
    const logged = warn.mock.calls.map(([line]) => String(line)).join('\n');
    expect(logged).toContain('fpi_field_sum_out_of_tolerance');

    // WHICH sums break is worth knowing, and it is not the obvious one. The
    // payload arrives sorted by FPI, so losing the tail loses almost no title
    // probability — the top 69 teams still hold ~100% of it between them — and
    // `winTitle` sails through. It is the identities the whole league
    // contributes to that give the game away: playoff places (1185 of 1200)
    // and conference titles (710 of 1000). Four checks, not one, for this
    // reason; any single one of them would have missed this.
    expect(logged).toContain('makePlayoffs');
    expect(logged).toContain('winConference');
    warn.mockRestore();
  });

  it('refuses a payload with no teams at all', async () => {
    const page = fpiFixture();
    page['teams'] = [];
    await expect(providerOver(page).getTeamProjections()).rejects.toThrow(/no teams/);
  });
});
