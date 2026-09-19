/**
 * Build-time configuration, read once.
 *
 * Viewers need none of it: with no `.env` the app calls `/api` on its own
 * origin, which the dev server proxies to the Worker. The Supabase pair is
 * used by the admin sign-in alone (plan §11.1).
 */

export interface SupabaseConfig {
  url: string;
  anonKey: string;
}

/** `https://api.example.dev/` → `https://api.example.dev`. Empty means same origin. */
export function normalizeApiBase(raw: string | undefined): string {
  return (raw ?? '').trim().replace(/\/+$/, '');
}

/**
 * The project URL, forgiving the two ways it tends to get pasted wrong: with a
 * trailing slash, or with the `/rest/v1` suffix from the Data API page. The
 * auth client needs the bare project URL.
 */
export function readSupabaseConfig(
  url: string | undefined,
  anonKey: string | undefined,
): SupabaseConfig | null {
  const key = (anonKey ?? '').trim();
  const base = (url ?? '')
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/rest\/v1$/, '');
  if (key === '' || !/^https?:\/\/[^/\s]+$/.test(base)) return null;
  return { url: base, anonKey: key };
}

export const API_BASE_URL = normalizeApiBase(import.meta.env.VITE_API_BASE_URL);

export const SUPABASE_CONFIG = readSupabaseConfig(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY,
);

export function apiUrl(path: string): string {
  return `${API_BASE_URL}${path}`;
}
