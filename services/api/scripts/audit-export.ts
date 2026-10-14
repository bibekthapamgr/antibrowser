/**
 * Exports the hash-chained platform audit (milestone 12) and checks the whole chain against its head. Keep the files
 * somewhere the server cannot change (your computer, another account): a later export must continue from the last
 * hash of the earlier one, which proves no entry was changed, reordered or removed in between.
 *
 *   node --env-file=/etc/project-browser/api.env scripts/audit-export.ts --out audit-<date>.ndjson
 *        [--after-seq <n> --prev-hash <hex>]   (continue an earlier export: its last seq and hash)
 *
 * Each line is one entry (the fields the hash covers, plus prev_hash and hash); the last line is the chain head.
 */
import { createWriteStream } from 'node:fs';
import pg from 'pg';
import { auditHead, exportAudit, verifyChain, verifyWholeChain } from '../src/audit-chain.ts';

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const url = process.env.MIGRATION_DATABASE_URL;
if (!url)
  throw new Error('MIGRATION_DATABASE_URL is required (run on the server with the API environment file)');
const out = arg('--out');
if (!out) throw new Error('--out <file>');
let after = BigInt(arg('--after-seq') ?? '0');
let prev = arg('--prev-hash') ?? '';
if ((after === 0n) !== (prev === '')) throw new Error('give both --after-seq and --prev-hash, or neither');

const client = new pg.Client({ connectionString: url, options: '-c TimeZone=UTC' });
await client.connect();
try {
  await client.query('begin isolation level repeatable read read only');
  const whole = await verifyWholeChain(client);
  const file = createWriteStream(out, { flags: 'wx', mode: 0o600 });
  let count = 0;
  for (;;) {
    const rows = await exportAudit(client, after, 5000);
    if (rows.length === 0) break;
    const check = verifyChain(rows, prev, after + 1n);
    if (!check.ok) throw new Error(`the chain is broken at entry ${check.broken_at}`);
    for (const r of rows) file.write(`${JSON.stringify(r)}\n`);
    count += rows.length;
    prev = check.last_hash;
    after = BigInt(check.last_seq ?? after.toString());
  }
  const head = await auditHead(client);
  file.write(`${JSON.stringify({ head })}\n`);
  await new Promise<void>((resolve, reject) => file.end((e?: Error | null) => (e ? reject(e) : resolve())));
  await client.query('commit');
  if (!whole.ok)
    throw new Error(`the stored chain does not verify from the start (entry ${whole.broken_at})`);
  console.log(
    `audit export: ${count} entries to ${out}; chain verified from the start through ${head.seq}, head ${head.hash}`,
  );
  console.log(`next time: --after-seq ${head.seq} --prev-hash ${head.hash}`);
} catch (e) {
  console.error(`audit export: ${(e as Error).message}`);
  process.exitCode = 1;
} finally {
  await client.end();
}
