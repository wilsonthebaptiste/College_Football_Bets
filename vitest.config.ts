import { defineConfig } from 'vitest/config';

export default defineConfig({
  // The web app's component tests render TSX with React's automatic runtime,
  // matching apps/web/tsconfig.json ("jsx": "react-jsx").
  esbuild: { jsx: 'automatic' },
  test: {
    environment: 'node',
    include: [
      'packages/*/src/**/*.test.ts',
      'apps/*/src/**/*.test.{ts,tsx}',
      'apps/*/test/**/*.test.ts',
    ],
    // Fixtures are data, not tests.
    exclude: ['**/node_modules/**', '**/dist/**', '**/test/fixtures/**'],
  },
});
