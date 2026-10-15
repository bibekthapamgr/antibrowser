import { defineConfig, mergeConfig } from 'vitest/config';
import base from './vitest.config.ts';

/** R7: the API workload and soak measurements (test/perf/*.perf.ts), run on demand: `pnpm --filter @pb/api perf`. */
export default mergeConfig(
  base,
  defineConfig({
    test: { include: ['test/perf/**/*.perf.ts'], testTimeout: 6 * 3600_000, hookTimeout: 600_000 },
  }),
);
