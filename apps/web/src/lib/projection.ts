import type {
  OutcomeKind,
  ProjectedTerm,
  ProjectionInputName,
  ProjectionInputStatus,
  ProjectionSource,
} from '@cfb/shared';
import { UNRANKED_FINISH_POINTS } from '@cfb/shared';
import { formatPercent, formatPoints, formatStamp } from './format';

/**
 * Projected points, in words (predicting_score.md, Phase 4).
 *
 * The vocabulary all three screens share, fixed in one place so they cannot
 * drift: a projection is "Projected points", never a score and never "live";
 * every screen says it is not a result, names both publishers with their own
 * stamps, and says which one number is ours. Pure, so every sentence a screen
 * can show is tested here rather than discovered on one.
 */

/** Said once per screen: what the number is, before anyone reads it as a result. */
export const PROJECTION_MEANING =
  'Expected points from the published odds, using the board’s scoring rules. Not a result.';

/** The one number we model, named as ours wherever it appears (§4, §46). */
export const ESTIMATE_NOTE = 'Top-25 finish estimated from the current poll.';

/**
 * Why a board's printed total can sit a cent from its printed rows: the API
 * sums the unrounded values and rounds once. Saying so is the honest version
 * of "the rows add up" — which, rounded, they cannot always do.
 */
export const ROUNDING_NOTE =
  'Totals are added up before rounding, so the figures above can differ from them by a cent.';

/** One rubric line's name. The points it pays come from the term, never from here. */
export const OUTCOME_LABELS: Record<OutcomeKind, string> = {
  national_champion: 'National champion',
  national_runner_up: 'National runner-up',
  playoff: 'Makes the playoff',
  conference_champion: 'Conference champion',
  conference_runner_up: 'Conference runner-up',
  final_ranking: 'Final Top 25',
};

/** Who a figure came from, as a viewer reads it. */
export const SOURCE_NAMES: Record<ProjectionSource, string> = {
  espn_fpi: 'ESPN FPI',
  playoffstatus: 'playoffstatus.com',
  // Deliberately not ESPN's name: the poll is ESPN's, the estimate is ours.
  espn_poll_estimate: 'Our estimate, from the current poll',
  mock_projection: 'Mock data',
};

/** The reads a projection depends on, as a sentence names them. */
const INPUT_NAMES: Record<ProjectionInputName, string> = {
  fpi: 'ESPN FPI',
  conference_odds: 'the conference odds',
  rankings: 'the poll',
  conferences: 'the conference list',
  teams: 'the team list',
};

/** Why a line is `—`. Each is true whether the cause is an outage or no coverage. */
const MISSING_REASONS: Record<OutcomeKind, string> = {
  national_champion: 'No FPI figure for this team',
  national_runner_up: 'No FPI figure for this team',
  playoff: 'No FPI figure for this team',
  conference_champion: 'No conference odds for this team',
  conference_runner_up: 'No conference odds for this team',
  final_ranking: 'No poll or FPI rank to estimate from',
};

export type LineTone = 'gain' | 'loss' | 'zero' | 'missing';

/** One rubric line, ready to print: the number, then what it means, then who said so. */
export interface LineView {
  kind: OutcomeKind;
  /** The number column: `0.73`, `+0.44`, `−0.19`, `0.00`, or `—`. */
  value: string;
  /** What a screen reader says in place of a dash, which most read as nothing. */
  spokenValue: string;
  label: string;
  detail: string;
  /** `null` for a structural zero (nobody said anything) and for a missing line. */
  source: string | null;
  tone: LineTone;
}

/**
 * A probability as a viewer reads it. Never `0%` for a chance that is not zero,
 * and never `100%` for one that is not certain: those would be claims the
 * publisher did not make.
 */
export function formatChance(probability: number): string {
  const percent = probability * 100;
  if (percent > 0 && percent < 0.05) return '<0.1%';
  if (percent < 100 && percent > 99.95) return '>99.9%';
  return formatPercent(percent);
}

/** `5 pts`, `1 pt`. */
function pts(points: number): string {
  return `${String(points)} ${Math.abs(points) === 1 ? 'pt' : 'pts'}`;
}

function signedPoints(points: number): string {
  return points > 0 ? `+${String(points)}` : `−${String(Math.abs(points))}`;
}

/**
 * One line. The three states stay three (§7): a known figure prints its
 * contribution; a structural zero prints `0.00` and says why; an unknown prints
 * `—` and says so. A zero and a dash are different claims and must never look
 * alike.
 */
export function lineView(term: ProjectedTerm): LineView {
  const label = OUTCOME_LABELS[term.kind];
  const base = { kind: term.kind, label };

  if (term.state === 'not_eligible') {
    return {
      ...base,
      value: '0.00',
      spokenValue: '0.00',
      detail: 'Not in a power-four conference',
      source: null,
      tone: 'zero',
    };
  }

  if (term.state === 'unavailable' || term.contribution === null || term.probability === null) {
    return {
      ...base,
      value: '—',
      spokenValue: 'Unavailable',
      detail: MISSING_REASONS[term.kind],
      source: null,
      tone: 'missing',
    };
  }

  const source = term.source === null ? null : SOURCE_NAMES[term.source];
  const contribution = term.contribution;

  // The finish line is the whole expectation over two paid states, `2p − 1`,
  // so it is the one line that can be negative, and it is printed signed.
  if (term.kind === 'final_ranking') {
    const value = formatPoints(contribution, { signed: true });
    return {
      ...base,
      value,
      spokenValue: value,
      detail:
        `${formatChance(term.probability)} chance to finish ranked: ` +
        `${signedPoints(term.points)} if it does, ${signedPoints(UNRANKED_FINISH_POINTS)} if not`,
      source,
      tone: contribution.value < 0 ? 'loss' : contribution.value > 0 ? 'gain' : 'zero',
    };
  }

  // ESPN FPI standing in for the scrape publishes no runner-up figure, so this
  // line is a quoted zero meaning "this publisher does not say" — not "no
  // chance of finishing second" (Phase 2's warning).
  if (term.kind === 'conference_runner_up' && term.source === 'espn_fpi') {
    return {
      ...base,
      value: formatPoints(contribution),
      spokenValue: formatPoints(contribution),
      detail: 'ESPN FPI publishes no runner-up odds, so this line counts nothing',
      source,
      tone: 'zero',
    };
  }

  const value = formatPoints(contribution);
  return {
    ...base,
    value,
    spokenValue: value,
    detail: `${formatChance(term.probability)} chance × ${pts(term.points)}`,
    source,
    tone: contribution.value > 0 ? 'gain' : 'zero',
  };
}

/** How many of a team's six lines are behind its total: known or a structural zero. */
export function linesCounted(terms: readonly ProjectedTerm[]): number {
  return terms.filter((term) => term.state !== 'unavailable').length;
}

// ─── Where the numbers came from, and how old they are ──────────────────────

export interface Provenance {
  /** `Projection · as of …`, naming both publishers with their own stamps. */
  asOf: string;
  /** Inputs that failed or are out of date, in a sentence each. Empty when all is well. */
  problems: string[];
  /**
   * The reference a failed input was logged under, to quote when reporting it
   * (§38). `null` when nothing failed — a stale copy has none to give. One per
   * screen: the inputs fail together far more often than apart, and they
   * share a request when they do.
   */
  reference: string | null;
}

function byInput(
  sources: readonly ProjectionInputStatus[],
  input: ProjectionInputName,
): ProjectionInputStatus | undefined {
  return sources.find((entry) => entry.input === input);
}

/** "SEC", "SEC and Big 12", "SEC, Big 12 and ACC". */
function listOf(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1] ?? ''}`;
}

/** A synthetic figure's stamp says "mock", which is not a date, so it gets words instead. */
const MOCK_PART = 'mock data';

function fpiPart(entry: ProjectionInputStatus | undefined): string {
  if (entry === undefined || entry.freshness.state === 'unavailable') return 'ESPN FPI unavailable';
  if (entry.source === 'mock_projection') return `${MOCK_PART} (national odds)`;
  const name = entry.source === null ? 'ESPN FPI' : SOURCE_NAMES[entry.source];
  return entry.computedLabel === null ? name : `${formatStamp(entry.computedLabel)} (${name})`;
}

/**
 * The odds publisher's stamp. Per conference page, because the four pages are
 * recomputed in batches and do not agree (Phase 2): two said "Sat Sep 26 11:30
 * pm" and two "Sun Sep 27 2:45 am", and nothing can order two such strings
 * without inventing a year and a zone. So a team is dated by its own
 * conference's page, and a board lists each stamp with the conferences it
 * covers. `null` when the stamp has nothing to do with what is on screen — a
 * team outside the four pages.
 */
function oddsPart(
  entry: ProjectionInputStatus | undefined,
  conference?: string | null,
): string | null {
  if (entry === undefined || entry.freshness.state === 'unavailable') {
    return 'conference odds unavailable';
  }
  // Production today: real FPI beside the MOCK odds publisher, until Phase 5
  // flips `CONFERENCE_ODDS_PROVIDER`. Its pages' stamps read "Mock projection
  // (synthetic data)", which must not be printed as though it were a date.
  if (entry.source === 'mock_projection') return `${MOCK_PART} (conference odds)`;
  const name = entry.source === null ? 'the conference odds' : SOURCE_NAMES[entry.source];

  if (conference !== undefined) {
    const page = entry.pages.find((candidate) => candidate.conference === conference);
    if (page === undefined) return null;
    return page.computedLabel === null ? name : `${page.computedLabel} (${name})`;
  }

  if (entry.computedLabel !== null) return `${entry.computedLabel} (${name})`;
  const groups = new Map<string, string[]>();
  for (const page of entry.pages) {
    if (page.computedLabel === null) continue;
    groups.set(page.computedLabel, [...(groups.get(page.computedLabel) ?? []), page.conference]);
  }
  if (groups.size === 0) return name;
  const stamps = [...groups].map(([label, conferences]) => `${label} for ${listOf(conferences)}`);
  return `${stamps.join(', ')} (${name})`;
}

/**
 * Where a projection's numbers came from and how old each is (§23, §39). The
 * stamps are the PUBLISHERS' own, never our read time: a figure four days old
 * read a second ago is four days old.
 *
 * `conference` is given on a team page — that team's conference, or `null`
 * when it has none — and left out where a screen covers many teams.
 */
export function provenance(
  sources: readonly ProjectionInputStatus[],
  conference?: string | null,
): Provenance {
  const fpi = byInput(sources, 'fpi');
  const odds = byInput(sources, 'conference_odds');

  let asOf: string;
  if (fpi?.source === 'mock_projection' && odds?.source === 'mock_projection') {
    // Synthetic figures carry a stamp that says "mock", which is not a date.
    asOf = 'Projection · mock data: synthetic figures, not from any publisher';
  } else {
    const parts = [fpiPart(fpi), oddsPart(odds, conference)].filter(
      (part): part is string => part !== null,
    );
    asOf = `Projection · as of ${parts.join(' and ')}`;
  }

  const failed = sources.filter((entry) => entry.freshness.state === 'unavailable');
  const stale = sources.filter((entry) => entry.freshness.state === 'stale');
  const problems: string[] = [];
  if (failed.length > 0) {
    problems.push(
      `Couldn’t load ${listOf(failed.map((entry) => INPUT_NAMES[entry.input]))}. ` +
        'The lines that depend on it say so.',
    );
  }
  if (stale.length > 0) {
    problems.push(
      `${capitalize(listOf(stale.map((entry) => INPUT_NAMES[entry.input])))} may be out of date.`,
    );
  }
  const reference =
    failed.find((entry) => entry.error?.requestId != null)?.error?.requestId ?? null;
  return { asOf, problems, reference };
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** `from 5 of 6 teams`, or `null` when every team is counted and saying so is noise. */
export function coverageNote(teamsCounted: number, teamsTotal: number): string | null {
  if (teamsTotal === 0 || teamsCounted === teamsTotal) return null;
  return `from ${String(teamsCounted)} of ${String(teamsTotal)} teams`;
}
