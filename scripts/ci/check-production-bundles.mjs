#!/usr/bin/env node
// R7 retirement gate: artifact inspection of the PRODUCTION frontend bundles. Demo backends, fixture data and test
// hooks exist only in demo builds (dist-demo); a production bundle that contains any of them fails the build.
// Usage: node scripts/ci/check-production-bundles.mjs   (after the normal `build` of each app)
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const bundles = [
  'apps/desktop/dist',
  'apps/web-customer/dist',
  'apps/web-admin/dist',
  'apps/web-public/dist',
];
// Markers that only demo/fixture code contains (names of demo workspaces and people, test hooks, fixture ids).
const markers = [
  '__pbDemo',
  'North shop admin',
  'demoBackend',
  'org_01J9ZSEED0ACME',
  'org_01J9ZSEED0BETA',
  'dev-only-insecure-fixture-secret',
  'pb-local-fixture-secret-key',
];

function* files(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* files(p);
    else if (/\.(js|mjs|html|css|json|map)$/.test(name)) yield p;
  }
}

let failed = 0;
for (const b of bundles) {
  const dir = join(root, b);
  if (!existsSync(join(dir, 'index.html'))) {
    console.error(`MISSING ${b}: build it first`);
    failed++;
    continue;
  }
  let count = 0;
  for (const f of files(dir)) {
    count++;
    const text = readFileSync(f, 'utf8');
    for (const m of markers) {
      if (text.includes(m)) {
        console.error(`FOUND "${m}" in ${f.slice(root.length + 1)}`);
        failed++;
      }
    }
  }
  console.log(`ok  ${b}: ${count} files, no demo or fixture code`);
}
if (failed) {
  console.error(`\n${failed} problem(s): demo or fixture code in a production bundle`);
  process.exit(1);
}
