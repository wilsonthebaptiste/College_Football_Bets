import { espnSizedLogoUrl } from './espn/logos';

/**
 * Logo sizes the API hands out (§49, "reasonable image sizes"; plan §5.3).
 *
 * Twice the largest CSS size each logo is drawn at, for high-density screens:
 *   - a team's own logo: 72 px on the team page, 48 px on a card → 144
 *   - an opponent's logo: 24 px in a schedule row → 48
 *
 * Sizing happens here, on the way out of the API, and never in the browser:
 * resizing means knowing the provider's CDN, and the web app must not (§26).
 * Stored URLs stay canonical, so a different size later is a one-line change.
 */
export const TEAM_LOGO_PX = 144;
export const OPPONENT_LOGO_PX = 48;

/**
 * The URL of a smaller copy of this logo, when its host is a provider CDN that
 * can resize. Anything else is returned unchanged. Dispatch is by the URL
 * itself, not by `SPORTS_PROVIDER`: a logo stored in Postgres is an ESPN URL
 * whichever provider is serving scores.
 */
export function sizedLogoUrl(url: string | null, px: number): string | null {
  if (url === null) return null;
  return espnSizedLogoUrl(url, px) ?? url;
}
