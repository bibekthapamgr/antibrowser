#!/usr/bin/env node
/**
 * Builds the portability matrix (milestone 03 step 8) from the runtime pipeline's result files.
 * Usage: portability-report.mjs <results-dir> [version]   (prints Markdown)
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const [dir, version = ''] = process.argv.slice(2);
const rows = readdirSync(dir, { recursive: true })
  .map(String)
  .filter((f) => f.endsWith('.json') && f.split(/[\\/]/).pop().startsWith('portability-'))
  .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')));
const mark = (b) => (b ? 'kept' : '**lost**');
rows.sort((a, b) =>
  `${a.source}${a.target}${a.same_machine}`.localeCompare(`${b.source}${b.target}${b.same_machine}`),
);
const lines = [
  `# Profile portability matrix${version ? ` (Chrome for Testing ${version})` : ''}`,
  '',
  'Each row: a profile signed in to a test site on the source machine, closed cleanly, copied without caches or',
  'lock files, then restored into a new profile directory on the target. "Other machine" is a fresh CI runner.',
  '',
  '| Source | Target | Machine | Cookies (encrypted) | localStorage | IndexedDB |',
  '|---|---|---|---|---|---|',
  ...rows.map(
    (r) =>
      `| ${r.source} | ${r.target} | ${r.same_machine ? 'same, new folder' : 'other machine'} | ${mark(r.cookie)} | ${mark(r.local_storage)} | ${mark(r.indexeddb)} |`,
  ),
  '',
  `${rows.length} result(s).`,
];
console.log(lines.join('\n'));
