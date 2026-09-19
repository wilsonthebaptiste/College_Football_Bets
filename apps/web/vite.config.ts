import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

/**
 * In development the app calls `/api/*` on its own origin and this proxy
 * forwards it to the Worker from `npm run dev` (port 8787), so local work needs
 * no CORS setup and no `.env` at all.
 *
 * - `API_PROXY_TARGET` points the proxy at a Worker on another port.
 * - `VITE_API_BASE_URL` skips the proxy and calls a Worker directly. That
 *   Worker's `ALLOWED_ORIGINS` must then include this page's origin, exactly as
 *   in production, where the site and the API live on different hosts.
 */
const DEFAULT_API_TARGET = 'http://127.0.0.1:8787';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const target = env['API_PROXY_TARGET'] || DEFAULT_API_TARGET;
  const proxy = { '/api': { target } };

  return {
    plugins: [react()],
    server: { port: 5173, proxy },
    preview: { port: 4173, proxy },
    build: { target: 'es2022', sourcemap: true },
  };
});
