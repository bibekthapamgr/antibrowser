import { defineConfig } from 'vitest/config';

// Unit and contract tests (Node). Browser end-to-end tests live in e2e/ with their own config.
export default defineConfig({
  test: { include: ['tests/**/*.test.ts'], environment: 'node' },
});
