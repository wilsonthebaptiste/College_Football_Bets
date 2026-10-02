/**
 * Matching one publisher's team names to another's team ids.
 *
 * playoffstatus.com publishes rows keyed by its own spelling — "Mississippi
 * St.", "N.C. State", "Texas A&M" — and the rubric needs those joined to
 * ESPN's team ids. Nothing in either provider directory may know about the
 * other, so the join lives up here, and this module is its one rule.
 *
 * ## Why this is smaller than it looks
 *
 * Measured against the captured team list: normalizing both sides resolves 66
 * of the 67 power-four rows. The alias table therefore starts at ONE entry,
 * and the test that matters is not "the aliases work" but "every scraped row
 * matched a team, and every power-four team had a row" — asserted in both
 * directions in `test/services/projection.test.ts`. A table of sixty aliases
 * would be a sign the normalization was wrong, not a sign of thoroughness.
 */

/**
 * Punctuation is REMOVED, not replaced with a space.
 *
 * That is the difference between "N.C. State" → `nc state`, which matches
 * ESPN's "NC State", and `n c state`, which matches nothing. It cost a second
 * alias to get wrong.
 *
 * `&` becomes "and" first, before the punctuation goes, so "Texas A&M" keeps
 * its three words instead of collapsing to "texas am".
 */
export function normalizeTeamName(raw: string): string {
  return (
    raw
      .normalize('NFD')
      .replace(/\p{M}/gu, '')
      .toLowerCase()
      .replace(/&/g, ' and ')
      .replace(/[^\p{L}\p{N}\s]+/gu, '')
      .replace(/\s+/gu, ' ')
      .trim()
      .split(' ')
      .filter((word) => word !== '')
      // "St." is "State" on one side and spelled out on the other, everywhere.
      .map((word) => (word === 'st' ? 'state' : word))
      .join(' ')
  );
}

/**
 * Normalized spelling → normalized spelling, for the names no rule reconciles.
 *
 * One entry, and it is a nickname rather than an abbreviation: the odds
 * publisher writes the university's name and ESPN writes what the team is
 * called. No amount of punctuation handling turns one into the other.
 */
export const TEAM_NAME_ALIASES: Readonly<Record<string, string>> = {
  pittsburgh: 'pitt',
};

/** The key both sides of the join are compared on. */
export function teamNameKey(raw: string): string {
  const normalized = normalizeTeamName(raw);
  return TEAM_NAME_ALIASES[normalized] ?? normalized;
}
