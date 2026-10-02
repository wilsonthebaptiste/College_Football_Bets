/**
 * The four conferences the rubric pays for, and where their odds are published.
 *
 * The rubric's conference lines are power-four only (3 for the title, 2 for the
 * runner-up). Everyone else scores a structural zero on both, which is a fact
 * about the team and not a gap in our data — Notre Dame cannot win a power-four
 * conference, and `ConferenceStanding`'s `not_eligible` says exactly that.
 */

/**
 * ESPN's own short names for the four, verified against the captured
 * conference map. These are the strings `getConferences` returns, so they are
 * the strings a lookup must match — a renamed conference would silently make
 * every one of its teams ineligible and zero the conference half of the rubric
 * for sixty-odd teams, which is why the set is pinned by a test rather than
 * read from a page.
 */
export const POWER_FOUR = ['ACC', 'Big Ten', 'Big 12', 'SEC'] as const;

export type PowerFourConference = (typeof POWER_FOUR)[number];

export function isPowerFour(conference: string | null | undefined): boolean {
  return conference != null && (POWER_FOUR as readonly string[]).includes(conference);
}

export const PLAYOFFSTATUS_ORIGIN = 'https://www.playoffstatus.com';

/**
 * One page per conference.
 *
 * Note `big10`, not `bigten`: `bigten` is a 404. Every path here was verified
 * to answer 200.
 */
export const CONFERENCE_PAGES: Readonly<Record<PowerFourConference, string>> = {
  SEC: '/secfootball/secfootballpostseasonprob.html',
  'Big Ten': '/big10football/big10footballpostseasonprob.html',
  'Big 12': '/big12football/big12footballpostseasonprob.html',
  ACC: '/accfootball/accfootballpostseasonprob.html',
};

export function conferencePageUrl(conference: PowerFourConference): string {
  return `${PLAYOFFSTATUS_ORIGIN}${CONFERENCE_PAGES[conference]}`;
}
