import { defineConfig } from 'vitest/config';

// Browser end-to-end tests against the console's demo build (dist-demo/). Requires a Chromium binary in
// PB_CHROME_PATH (CI installs chrome-headless-shell; see docs/os-setup.md).
export default defineConfig({
  test: {
    include: ['e2e/**/*.e2e.test.ts'],
    environment: 'node',
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
