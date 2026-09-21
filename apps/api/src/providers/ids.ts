/**
 * The shape a provider's id is allowed to have, checked before the id reaches
 * a provider URL or a cache key.
 *
 * Deliberately boring: ESPN's are short decimal strings, but a provider is
 * swappable (§5), so the rule is "a short, URL-safe token" rather than digits.
 * Used by the game routes (`:gameId`, `?team=`) and by the team route, where a
 * `:teamId` may be a provider team id instead of our own uuid.
 *
 * Note that a uuid also matches this pattern. Anything that accepts both must
 * test for a uuid FIRST — see `services/team.ts`.
 */
export const PROVIDER_ID_PATTERN = /^[A-Za-z0-9_-]{1,40}$/;

export function isProviderId(value: string): boolean {
  return PROVIDER_ID_PATTERN.test(value);
}
