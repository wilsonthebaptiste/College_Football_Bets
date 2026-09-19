/// <reference types="vite/client" />

/**
 * Vite inlines every `VITE_*` value into the public bundle at build time, so
 * nothing secret may ever be named `VITE_*`. The two Supabase values are public
 * by design (§31: RLS is the boundary, not the key).
 */
interface ImportMetaEnv {
  readonly VITE_API_BASE_URL?: string;
  readonly VITE_SUPABASE_URL?: string;
  readonly VITE_SUPABASE_ANON_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
