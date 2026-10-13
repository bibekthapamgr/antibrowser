/**
 * Snapshot smoke test for a deployed test server (scripts/deploy/vps-setup.sh): through the running API, as the
 * fixture owner, it backs up a fresh profile (lease, init, signed part upload, commit, the worker's verification)
 * and restores it (restore plan, signed download, SHA-256). The uploaded object is a well-formed sealed header with
 * random bytes: the server never decrypts, it checks size, header and digest.
 *
 * Usage: node --env-file=<api.env> scripts/snapshot-smoke.ts [--save <file>] [--check <file>]
 *   --save  remember the snapshot (to check it is still restorable later, e.g. after a root key rotation)
 *   --check restore a remembered snapshot instead of making a new one
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { loadConfig } from '@pb/config/env';
import { SEAL_CHUNK, SEAL_MAGIC } from '../src/backup/sealed.ts';
import { FIXTURES } from '../src/fixtures.ts';
import { devToken } from './dev-token.ts';

const config = loadConfig();
if (!config.devAuth.enabled) throw new Error('development tokens are disabled on this server');
const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const base = `http://127.0.0.1:${config.port}/v1`;
const org = FIXTURES.orgs.acme.id;
const token = await devToken(config.devAuth.secret, FIXTURES.users.acmeOwner.id, '15m');
const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

async function call<T>(method: string, path: string, body?: unknown, idempotent = false): Promise<T> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(idempotent ? { 'idempotency-key': randomUUID() } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${text.slice(0, 300)}`);
  return (text ? JSON.parse(text) : null) as T;
}

async function restore(profile: string, digest: string): Promise<number> {
  const plan = await call<{ download: { url: string }; snapshot: { digest: string; version: number } }>(
    'POST',
    `/orgs/${org}/profiles/${profile}/restore-plans`,
    {},
  );
  const res = await fetch(plan.download.url);
  if (!res.ok) throw new Error(`download: ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  if (sha256(bytes) !== digest || plan.snapshot.digest !== digest) {
    throw new Error('the restored snapshot does not match what was uploaded');
  }
  return plan.snapshot.version;
}

const check = arg('--check');
if (check) {
  const saved = JSON.parse(readFileSync(check, 'utf8')) as { profile: string; digest: string };
  const version = await restore(saved.profile, saved.digest);
  console.log(`snapshot smoke: the saved snapshot (version ${version}) still restores and matches`);
  process.exit(0);
}

const profile = (
  await call<{ id: string }>('POST', `/orgs/${org}/profiles`, {
    name: `Snapshot smoke ${new Date().toISOString().slice(0, 19)}`,
  })
).id;
const lease = await call<{ fencing_token: string }>(
  'POST',
  `/orgs/${org}/profiles/${profile}/lease`,
  { device_id: FIXTURES.devices.acmeOwnerLaptop.id },
  true,
);
const init = await call<{
  operation: { id: string };
  key: { snapshot_id: string; key_version: string };
}>(
  'POST',
  `/orgs/${org}/profiles/${profile}/snapshots/init`,
  {
    base_version: 0,
    fencing_token: lease.fencing_token,
    platform: 'linux-x64',
    browser_version: '155.0.8059.39',
  },
  true,
);
const header = Buffer.from(
  JSON.stringify({
    scheme: 'aes-256-gcm-chunked-v1',
    kind: 'org-snapshot',
    org_id: org,
    profile_id: profile,
    object_id: init.key.snapshot_id,
    schema_version: 1,
    key_version: init.key.key_version,
    chunk_size: SEAL_CHUNK,
    nonce_prefix: randomBytes(7).toString('hex'),
  }),
);
const len = Buffer.alloc(4);
len.writeUInt32BE(header.length);
const object = Buffer.concat([SEAL_MAGIC, len, header, randomBytes(1024 * 1024)]);
const snapPath = `/orgs/${org}/profiles/${profile}/snapshots/${init.key.snapshot_id}`;
const urls = await call<{ parts: { part_number: number; url: string }[] }>('POST', `${snapPath}/parts`, {
  part_numbers: [1],
});
const put = await fetch(urls.parts[0]?.url ?? '', { method: 'PUT', body: object });
if (!put.ok) throw new Error(`part upload: ${put.status} ${(await put.text()).slice(0, 300)}`);
const digest = sha256(object);
await call('POST', `${snapPath}/commit`, {
  fencing_token: lease.fencing_token,
  digest,
  ciphertext_size: object.length,
  plaintext_size: object.length,
  parts: [{ part_number: 1, etag: put.headers.get('etag') ?? '' }],
});
let state = 'verifying';
for (let i = 0; i < 120 && state === 'verifying'; i++) {
  await new Promise((r) => setTimeout(r, 500));
  state = (await call<{ state: string }>('GET', `/orgs/${org}/sync-operations/${init.operation.id}`)).state;
}
await call('POST', `/orgs/${org}/profiles/${profile}/lease/release`, { fencing_token: lease.fencing_token });
if (state !== 'committed') throw new Error(`the worker did not commit the snapshot (state ${state})`);
const version = await restore(profile, digest);
const save = arg('--save');
if (save) writeFileSync(save, JSON.stringify({ profile, snapshot: init.key.snapshot_id, digest }));
console.log(
  `snapshot smoke: backed up and restored version ${version} (${object.length} bytes, verified by the worker)`,
);
