/**
 * Runs the API on 127.0.0.1 with the real database, S3-compatible storage (SeaweedFS in CI) and the local key
 * provider, plus the snapshot verification worker, for the desktop engine's end-to-end test
 * (crates/sync/tests/real_api.rs). It writes who may do what to `<out.json>` and keeps running until stopped.
 *
 * Test and development environments only: the actors use development tokens for fixture users.
 * Usage: node --env-file=../../infra/env/test.env.example scripts/e2e-server.ts <out.json>
 */
import { writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { loadConfig } from '@pb/config/env';
import pg from 'pg';
import { buildApp } from '../src/app.ts';
import { eraseObjects, type JobDeps, processSyncWork } from '../src/backup/jobs.ts';
import { localKeyProvider } from '../src/backup/keys.ts';
import { s3ObjectStore } from '../src/backup/objects.ts';
import { createPool } from '../src/db.ts';
import { FIXTURES } from '../src/fixtures.ts';
import { devToken } from './dev-token.ts';

const out = process.argv[2];
if (!out) throw new Error('usage: e2e-server.ts <out.json>');
const config = loadConfig();
if (config.appEnv !== 'test' && config.appEnv !== 'dev')
  throw new Error('test and development environments only');
if (!config.devAuth.enabled) throw new Error('development tokens are disabled in this environment');
if (!config.objectStore || !config.kms) throw new Error('OBJECT_STORE_* and KMS_LOCAL_* are required');

const pool = createPool(config.databaseUrl);
const objects = s3ObjectStore(config.objectStore);
const kms = localKeyProvider(config.kms);
const app = await buildApp({ ...config, logLevel: 'warn' }, pool, { objects, kms });
await app.listen({ host: '127.0.0.1', port: 0 });
const { port } = app.server.address() as AddressInfo;

// The verification worker, as services/worker runs it (sizes, header, SHA-256, fencing, version CAS).
const workerPool = new pg.Pool({
  connectionString: config.workerDatabaseUrl,
  options: '-c search_path=app',
  max: 2,
});
const jobs: JobDeps = { pool: workerPool, objects, kms };
let busy = false;
setInterval(() => {
  if (busy) return;
  busy = true;
  void processSyncWork(jobs, 50)
    .then(() => eraseObjects(jobs))
    .catch((e) => console.error('worker:', e))
    .finally(() => {
      busy = false;
    });
}, 250);

const secret = config.devAuth.secret;
const token = (user: keyof typeof FIXTURES.users) => devToken(secret, FIXTURES.users[user].id, '3h');
const { acme, beta } = FIXTURES.orgs;
const owner = await token('acmeOwner');
const operator = await token('acmeOperator');

// A fresh organization profile, shared with the operator (two people, two computers).
const created = await app.inject({
  method: 'POST',
  url: `/v1/orgs/${acme.id}/profiles`,
  headers: { authorization: `Bearer ${owner}` },
  payload: { name: `e2e ${new Date().toISOString()}` },
});
if (created.statusCode !== 201) throw new Error(`profile: ${created.statusCode} ${created.body}`);
const profile = (created.json() as { id: string }).id;
const grant = await app.inject({
  method: 'POST',
  url: `/v1/orgs/${acme.id}/grants`,
  headers: { authorization: `Bearer ${owner}` },
  payload: { user_id: FIXTURES.users.acmeOperator.id, profile_id: profile },
});
if (grant.statusCode !== 201) throw new Error(`grant: ${grant.statusCode} ${grant.body}`);

writeFileSync(
  out,
  JSON.stringify(
    {
      base_url: `http://127.0.0.1:${port}`,
      org: acme.id,
      profile,
      owner: { token: owner, device: FIXTURES.devices.acmeOwnerLaptop.id },
      operator: { token: operator, device: FIXTURES.devices.acmeOperatorMac.id },
      outsider: { token: await token('betaOwner'), org: beta.id },
    },
    null,
    2,
  ),
  { mode: 0o600 },
);
console.log(`e2e API on http://127.0.0.1:${port}, profile ${profile}`);

const stop = async () => {
  await app.close();
  await pool.end();
  await workerPool.end();
  process.exit(0);
};
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
