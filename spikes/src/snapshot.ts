/**
 * Spike — milestone 01, step 6:
 * "Closed-profile snapshot/restore on the same OS/device and across a second device. Record browser
 *  encryption/platform constraints; do not assume copying a directory preserves usable logins."
 *
 * Modes
 *   node src/snapshot.ts                       same-device round trip (close -> snapshot -> restore to a NEW path -> verify)
 *   node src/snapshot.ts export --file s.tgz   device 1: create a profile, close it, write snapshot + expected values
 *   node src/snapshot.ts import --file s.tgz   device 2: restore and verify against the embedded expectations
 * Common flags: --browser <path> --headless new|shell|false --port 47311 --out-dir <dir>
 *
 * The origin must be identical on both devices, so export/import default to the fixed port 47311.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  environmentFacts,
  launch,
  type Options,
  type ProbeValues,
  parseOptions,
  readValues,
  setValues,
  startOrigin,
} from './harness.ts';

/** Never part of a snapshot: caches (rebuildable), lock/singleton files, crash dumps, metrics. */
export const EXCLUDES = [
  'Singleton*',
  'lockfile',
  'LOCK',
  '*/Cache',
  '*/Code Cache',
  '*/GPUCache',
  '*/DawnCache',
  '*/DawnGraphiteCache',
  '*/DawnWebGPUCache',
  'GrShaderCache',
  'GraphiteDawnCache',
  'ShaderCache',
  'Crashpad',
  'BrowserMetrics*',
  'component_crx_cache',
  '*/Service Worker/CacheStorage',
];

const mode = process.argv.includes('export')
  ? 'export'
  : process.argv.includes('import')
    ? 'import'
    : 'local';
const opts = parseOptions(process.argv.slice(2), { port: mode === 'local' ? 0 : 47311 });
const fileArg = (() => {
  const i = process.argv.indexOf('--file');
  return i >= 0 ? process.argv[i + 1] : undefined;
})();

interface SnapshotManifest {
  schema: 1;
  origin: string;
  expected: ProbeValues;
  source: Record<string, unknown>;
  user_data_sha256: string;
  files: number;
  bytes: number;
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(p));
    else if (entry.isFile()) out.push(p);
  }
  return out;
}

function tar(args: string[]): void {
  const r = spawnSync('tar', args, { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`tar ${args[0]} failed: ${r.stderr}`);
}

/** Creates <file> containing user-data/ (minus EXCLUDES) and pb-manifest.json. */
function createSnapshot(
  userData: string,
  file: string,
  manifest: Omit<SnapshotManifest, 'user_data_sha256' | 'files' | 'bytes'>,
) {
  const staging = mkdtempSync(join(tmpdir(), 'pb-snap-stage-'));
  tar(['-cf', join(staging, 'ud.tar'), ...EXCLUDES.flatMap((e) => ['--exclude', e]), '-C', userData, '.']);
  mkdirSync(join(staging, 'user-data'));
  tar(['-xf', join(staging, 'ud.tar'), '-C', join(staging, 'user-data')]);
  rmSync(join(staging, 'ud.tar'));
  const files = walk(join(staging, 'user-data')).sort();
  const hash = createHash('sha256');
  let bytes = 0;
  for (const f of files) {
    const data = readFileSync(f);
    bytes += data.length;
    hash
      .update(relative(join(staging, 'user-data'), f).split(sep).join('/'))
      .update('\0')
      .update(data);
  }
  const full: SnapshotManifest = {
    ...manifest,
    user_data_sha256: hash.digest('hex'),
    files: files.length,
    bytes,
  };
  writeFileSync(join(staging, 'pb-manifest.json'), JSON.stringify(full, null, 2));
  tar(['-czf', file, '-C', staging, 'user-data', 'pb-manifest.json']);
  rmSync(staging, { recursive: true, force: true });
  return full;
}

/** Restores into a NEW directory after refusing absolute paths, '..' segments and links in the archive. */
function restoreSnapshot(file: string, dest: string): SnapshotManifest {
  const list = spawnSync('tar', ['-tvzf', file], { encoding: 'utf8' });
  if (list.status !== 0) throw new Error('cannot list snapshot');
  for (const line of list.stdout.split('\n').filter(Boolean)) {
    const name = line.split(/\s+/).slice(5).join(' ');
    if (
      line.startsWith('l') ||
      line.startsWith('h') ||
      name.startsWith('/') ||
      name.split('/').includes('..')
    ) {
      throw new Error(`unsafe archive entry refused: ${name}`);
    }
  }
  mkdirSync(dest, { recursive: true });
  tar(['-xzf', file, '-C', dest, '--no-same-owner']);
  return JSON.parse(readFileSync(join(dest, 'pb-manifest.json'), 'utf8')) as SnapshotManifest;
}

/** Records how this browser protects cookies at rest — the core portability constraint. */
function cookieEncryption(userData: string): Record<string, unknown> {
  const cookiesDb = ['Default/Cookies', 'Default/Network/Cookies']
    .map((p) => join(userData, p))
    .find(existsSync);
  const facts: Record<string, unknown> = { cookies_db: cookiesDb ? relative(userData, cookiesDb) : null };
  if (cookiesDb) {
    const db = new DatabaseSync(cookiesDb, { readOnly: true });
    const row = db
      .prepare("select value, encrypted_value from cookies where name = 'pb_cookie' limit 1")
      .get() as { value: string; encrypted_value: Uint8Array } | undefined;
    db.close();
    if (row) {
      const prefix = Buffer.from(row.encrypted_value.subarray(0, 3)).toString('latin1');
      facts.plaintext_value_column_empty = row.value === '';
      facts.encrypted_value_prefix = /^v\d\d$/.test(prefix) ? prefix : 'none (stored in plaintext)';
    }
  }
  const localState = join(userData, 'Local State');
  if (existsSync(localState)) {
    const ls = JSON.parse(readFileSync(localState, 'utf8')) as { os_crypt?: Record<string, unknown> };
    facts.local_state_os_crypt_keys = Object.keys(ls.os_crypt ?? {});
  }
  return facts;
}

async function createProfileWithValues(o: Options, userData: string, value: string) {
  const { server, origin } = await startOrigin(o.port);
  try {
    const b = await launch(o, userData);
    const version = await b.version();
    await setValues(b, origin, value);
    const before = await readValues(b, origin);
    await b.close(); // graceful close flushes cookies/LevelDB; snapshots are only taken of CLOSED profiles
    return { origin, version, before };
  } finally {
    server.close();
  }
}

/** Storage is per origin (scheme+host+port), so verification must use the exact origin used at creation. */
async function verifyRestored(o: Options, userData: string, expected: ProbeValues, originUrl: string) {
  const { server, origin } = await startOrigin(Number(new URL(originUrl).port));
  try {
    const b = await launch(o, userData);
    const after = await readValues(b, origin);
    await b.close();
    return { origin, after, match: JSON.stringify(after) === JSON.stringify(expected) };
  } finally {
    server.close();
  }
}

const work = mkdtempSync(join(tmpdir(), 'pb-snapshot-'));
mkdirSync(opts.outDir, { recursive: true });
let report: Record<string, unknown>;

if (mode === 'local' || mode === 'export') {
  const source = join(work, 'prf_SOURCE', 'user-data');
  const value = `snap-${crypto.randomUUID()}`;
  const t0 = performance.now();
  const { origin, version, before } = await createProfileWithValues(opts, source, value);
  const file =
    mode === 'export' ? (fileArg ?? join(opts.outDir, 'profile-snapshot.tgz')) : join(work, 'snapshot.tgz');
  const t1 = performance.now();
  const manifest = createSnapshot(source, file, {
    schema: 1,
    origin,
    expected: before,
    source: environmentFacts(opts, version),
  });
  const t2 = performance.now();
  const archiveBytes = statSync(file).size;
  const encryption = cookieEncryption(source);

  if (mode === 'export') {
    report = { spike: '01-step-6-snapshot-export', file, manifest, archive_bytes: archiveBytes, encryption };
  } else {
    // Restore to a different absolute path to prove the snapshot does not depend on its original location.
    const restoredRoot = join(work, 'prf_RESTORED');
    const restoredManifest = restoreSnapshot(file, restoredRoot);
    const t3 = performance.now();
    const verify = await verifyRestored(
      opts,
      join(restoredRoot, 'user-data'),
      restoredManifest.expected,
      restoredManifest.origin,
    );
    report = {
      spike: '01-step-6-snapshot-same-device',
      passed: verify.match && before.cookie === value,
      expected: before,
      restored: verify.after,
      snapshot: {
        files: manifest.files,
        user_data_bytes: manifest.bytes,
        archive_bytes: archiveBytes,
        excluded: EXCLUDES,
      },
      timings_ms: {
        snapshot: Math.round(t2 - t1),
        restore: Math.round(t3 - t2),
        create_profile: Math.round(t1 - t0),
      },
      encryption,
      environment: manifest.source,
    };
  }
} else {
  if (!fileArg) throw new Error('import requires --file <snapshot.tgz>');
  const restoredRoot = join(work, 'prf_IMPORTED');
  const manifest = restoreSnapshot(fileArg, restoredRoot);
  const verify = await verifyRestored(
    opts,
    join(restoredRoot, 'user-data'),
    manifest.expected,
    manifest.origin,
  );
  const facts = environmentFacts(opts, '');
  report = {
    spike: '01-step-6-snapshot-cross-device-import',
    passed: verify.match,
    expected: manifest.expected,
    restored: verify.after,
    exported_on: manifest.source,
    imported_on: facts,
    encryption_after_restore: cookieEncryption(join(restoredRoot, 'user-data')),
    interpretation: verify.match
      ? 'Stored data survived this device/OS combination. Re-run for every supported pair before relying on it.'
      : 'Stored data did NOT survive. Per the 01 stop gate: same-device backup plus re-authentication on new devices.',
  };
}

const out = join(opts.outDir, `snapshot-${mode}-report.json`);
writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
rmSync(work, { recursive: true, force: true });
console.log(JSON.stringify(report, null, 2));
console.log(`report: ${out}`);
process.exit(report.passed === false ? 1 : 0);
