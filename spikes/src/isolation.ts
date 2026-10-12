/**
 * Spike — milestone 01, step 4:
 * "Launch two sandboxed Chromium instances with distinct directories. Set a test cookie/localStorage/IndexedDB
 *  value in A and prove B cannot read it on a controlled origin."
 *
 * Usage: node src/isolation.ts [--browser <path>] [--headless new|shell|false] [--out-dir <dir>]
 * Exit code 0 = all checks passed. A JSON report is written to <out-dir>/isolation-report.json.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { environmentFacts, launch, parseOptions, readValues, setValues, startOrigin } from './harness.ts';

const opts = parseOptions(process.argv.slice(2));
const work = mkdtempSync(join(tmpdir(), 'pb-isolation-'));
const dirA = join(work, 'prf_A', 'user-data');
const dirB = join(work, 'prf_B', 'user-data');
const checks: { name: string; pass: boolean; detail: unknown }[] = [];
const observations: { name: string; result: string; consequence: string }[] = [];
const check = (name: string, pass: boolean, detail: unknown) => {
  checks.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}`);
};

const { server, origin, cookieLog } = await startOrigin(opts.port);
const secretA = `A-${crypto.randomUUID()}`;
const secretB = `B-${crypto.randomUUID()}`;
let version = '';

try {
  // 1. Two instances running at the same time, each with its own user-data directory.
  const [a, b] = await Promise.all([launch(opts, dirA), launch(opts, dirB)]);
  version = await a.version();
  const pidA = a.process()?.pid;
  const pidB = b.process()?.pid;
  check('two concurrent browser processes', !!pidA && !!pidB && pidA !== pidB, { pidA, pidB });

  // 2. A writes cookie (HttpOnly, persistent), localStorage and IndexedDB on the controlled origin.
  await setValues(a, origin, secretA);
  const readA = await readValues(a, origin);
  check(
    'A can read its own cookie/localStorage/IndexedDB',
    JSON.stringify(readA) === JSON.stringify({ cookie: secretA, localStorage: secretA, indexedDB: secretA }),
    readA,
  );

  // 3. B, on the same origin at the same time, sees none of A's data — not even in the Cookie header it sends.
  const logStart = cookieLog.length;
  const readB = await readValues(b, origin);
  const headersFromB = cookieLog.slice(logStart);
  check(
    'B cannot read A values (cookie, localStorage, IndexedDB)',
    readB.cookie === null && readB.localStorage === null && readB.indexedDB === null,
    readB,
  );
  check(
    'B never sends A cookie to the origin',
    headersFromB.every((h) => !h.includes(secretA)),
    headersFromB,
  );

  // 4. Reverse direction.
  await setValues(b, origin, secretB);
  const readA2 = await readValues(a, origin);
  check(
    'A still sees only its own values after B writes',
    readA2.cookie === secretA && readA2.localStorage === secretA && readA2.indexedDB === secretA,
    readA2,
  );

  // 5. Observation (not an isolation criterion): does the browser itself stop a second process from opening a
  //    directory that is already in use? If not, the manager must enforce one process per profile.
  let secondOnSameDir: string;
  try {
    const dup = await launch(opts, dirA);
    secondOnSameDir = 'a second process started on the same directory';
    await dup.close();
  } catch (e) {
    secondOnSameDir = `refused by browser: ${(e as Error).message.split('\n')[0]?.slice(0, 160)}`;
  }
  observations.push({
    name: 'second process on a directory already in use',
    result: secondOnSameDir,
    consequence: secondOnSameDir.startsWith('refused')
      ? 'Browser hands off or refuses; the manager must still track ownership to avoid confusing hand-offs.'
      : 'The browser does not protect the directory. The manager must hold an exclusive per-profile lock before launch (milestone 03).',
  });
  console.log(`NOTE  ${observations.at(-1)?.name}: ${secondOnSameDir}`);

  await Promise.all([a.close(), b.close()]);

  // 6. Data is persisted in each directory (the isolation boundary is the directory, not the process).
  const a2 = await launch(opts, dirA);
  const persistedA = await readValues(a2, origin);
  await a2.close();
  const b2 = await launch(opts, dirB);
  const persistedB = await readValues(b2, origin);
  await b2.close();
  check(
    'values persist per directory across restarts',
    persistedA.cookie === secretA &&
      persistedA.indexedDB === secretA &&
      persistedB.cookie === secretB &&
      persistedB.localStorage === secretB,
    { persistedA, persistedB },
  );
} finally {
  server.close();
}

const report = {
  spike: '01-step-4-storage-isolation',
  origin,
  environment: environmentFacts(opts, version),
  checks,
  observations,
  passed: checks.every((c) => c.pass),
  scope_note:
    'Proves separation of stored browser data (cookies, localStorage, IndexedDB) between user-data directories. ' +
    'It does not test, and the product must not claim, that profiles appear as different devices or networks.',
};
mkdirSync(opts.outDir, { recursive: true });
writeFileSync(join(opts.outDir, 'isolation-report.json'), `${JSON.stringify(report, null, 2)}\n`);
rmSync(work, { recursive: true, force: true });
console.log(
  `\n${report.passed ? 'ALL CHECKS PASSED' : 'SOME CHECKS FAILED'} — report: ${join(opts.outDir, 'isolation-report.json')}`,
);
process.exit(report.passed ? 0 : 1);
