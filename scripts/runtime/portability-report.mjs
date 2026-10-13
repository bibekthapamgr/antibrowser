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
const LABEL = { supported: 'supported', sign_in_required: 'sign-in required', unsupported: 'unsupported' };
/** The label must never promise more than was measured: "supported" needs sign-ins kept, "sign-in required"
 *  needs website data kept, "unsupported" promises nothing. */
const honest = (r) =>
  r.label === 'supported'
    ? r.cookie && r.local_storage && r.indexeddb
    : r.label === 'sign_in_required'
      ? r.local_storage && r.indexeddb
      : r.label === 'unsupported';
rows.sort((a, b) =>
  `${a.source}${a.target}${a.same_machine}`.localeCompare(`${b.source}${b.target}${b.same_machine}`),
);
const lines = [
  `# Profile portability matrix${version ? ` (Chrome for Testing ${version})` : ''}`,
  '',
  'Each row: a profile signed in to a test site on the source machine, closed cleanly, sealed as an encrypted',
  'snapshot (no caches or lock files, compressed, AES-256-GCM), then opened into a new profile directory on the',
  'target. "Other machine" is a fresh CI runner. "Label" is what the app tells the user after that restore.',
  '',
  '| Source | Target | Machine | Cookies (encrypted) | localStorage | IndexedDB | Label | Label honest |',
  '|---|---|---|---|---|---|---|---|',
  ...rows.map(
    (r) =>
      `| ${r.source} | ${r.target} | ${r.same_machine ? 'same, new folder' : 'other machine'} | ${mark(r.cookie)} | ${mark(r.local_storage)} | ${mark(r.indexeddb)} | ${LABEL[r.label] ?? '—'} | ${r.label ? (honest(r) ? 'yes' : '**NO**') : '—'} |`,
  ),
  '',
  `${rows.length} result(s); ${rows.filter((r) => r.label && !honest(r)).length} dishonest label(s).`,
];
console.log(lines.join('\n'));
