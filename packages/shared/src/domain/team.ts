import type { ProviderName } from '../envelope';

/**
 * A team as the provider knows it (§43). Selections store this, so a board stays
 * tied to a real sports entity even if the provider's display name drifts.
 */
export interface TeamIdentity {
  provider: ProviderName;
  providerTeamId: string;
  /** The full provider name: "Alabama Crimson Tide". */
  name: string;
  /**
   * The short form a card should show: "Alabama" (§56's example board).
   * `null` when the provider offers only the long name — fall back to `name`.
   */
  displayName: string | null;
  abbreviation: string | null;
  logoUrl: string | null;
  conference: string | null;
  /** Hex without the leading `#`, as providers tend to supply it. */
  primaryColor: string | null;
  altColor: string | null;
}

/** A team as this application knows it: a provider identity plus our own uuid. */
export interface Team extends TeamIdentity {
  id: string;
}

/**
 * The slice of a team needed to render an opponent. Opponents are not
 * necessarily rows in our `teams` table — only selected teams are — so this
 * deliberately has no `id`.
 */
export interface TeamRef {
  providerTeamId: string;
  name: string;
  abbreviation: string | null;
  logoUrl: string | null;
}
