import { defineConfig } from 'vitest/config';

// Browser tests against the built site (dist/), served with the site's production CSP and stand-in API answers.
export default defineConfig({
  test: {
    include: ['e2e/**/*.e2e.test.ts'],
    environment: 'node',
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
