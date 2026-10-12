import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { defineConfig } from 'vitest/config';

/** Tests always use the separate test database defined in infra/env/test.env.example. */
function loadEnvFile(path: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m?.[1]) env[m[1]] = m[2] ?? '';
  }
  return env;
}

const testEnv = loadEnvFile(join(import.meta.dirname, '../../infra/env/test.env.example'));
// CI may point at its own service container.
for (const key of ['DATABASE_URL', 'WORKER_DATABASE_URL', 'MIGRATION_DATABASE_URL']) {
  const override = process.env[`TEST_${key}`];
  if (override) testEnv[key] = override;
}

// globalSetup runs in the main process, so it needs the same environment.
Object.assign(process.env, testEnv);

export default defineConfig({
  test: {
    env: testEnv,
    globalSetup: ['./test/global-setup.ts'],
    fileParallelism: false,
    testTimeout: 20_000,
  },
});
