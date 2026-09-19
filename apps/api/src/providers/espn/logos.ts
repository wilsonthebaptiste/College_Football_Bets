/**
 * ESPN's logo CDN, and how to ask it for a smaller image.
 *
 * Team logos are published at 500 × 500 (`/i/teamlogos/ncaa/500/333.png`, about
 * 30 KB). The app shows them at 24–72 CSS px (§49, "reasonable image sizes").
 * ESPN's own image combiner resizes on its CDN:
 *
 *   https://a.espncdn.com/combiner/i?img=/i/teamlogos/ncaa/500/333.png&w=144&h=144
 *
 * That is about 7 KB at 144 px (measured in Phase 5). If the combiner ever stops
 * answering, the `<img>` fails and `TeamLogo` falls back to the team's
 * initials (§36): a degraded logo, never a broken card.
 *
 * Only this file knows the URL shapes (§5, §26). `providers/logos.ts` asks it.
 */

const ESPN_CDN_HOST = 'a.espncdn.com';
const LOGO_PATH = /^\/i\/teamlogos\/[A-Za-z0-9_/-]+\.png$/;
const COMBINER_PATH = '/combiner/i';

/**
 * A resized ESPN logo URL, or `null` when `url` is not an ESPN team logo (so
 * the caller leaves it alone). Accepts either the plain 500 px URL or an
 * already-combined one, so resizing twice never nests two combiner URLs.
 */
export function espnSizedLogoUrl(url: string, px: number): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' || parsed.hostname !== ESPN_CDN_HOST) return null;

  const imagePath =
    parsed.pathname === COMBINER_PATH ? parsed.searchParams.get('img') : parsed.pathname;
  if (imagePath === null || !LOGO_PATH.test(imagePath)) return null;

  const size = String(Math.round(px));
  return `https://${ESPN_CDN_HOST}${COMBINER_PATH}?img=${imagePath}&w=${size}&h=${size}`;
}
