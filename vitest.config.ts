import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['packages/*/src/**/*.test.ts', 'apps/*/src/**/*.test.ts', 'apps/*/test/**/*.test.ts'],
    // Fixtures are data, not tests.
    exclude: ['**/node_modules/**', '**/dist/**', '**/test/fixtures/**'],
  },
});
