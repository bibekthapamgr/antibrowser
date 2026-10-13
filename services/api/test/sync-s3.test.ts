/**
 * Milestone 07 against real S3-compatible storage (SeaweedFS in CI): signed part URLs, multipart completion, the
 * worker's streamed verification, signed downloads and erasure. Runs when OBJECT_STORE_ENDPOINT answers; in CI it must.
 */
import { CreateBucketCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { loadConfig } from '@pb/config/env';
import type { RestorePlan } from '@pb/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eraseObjects } from '../src/backup/jobs.ts';
import { FIXTURES } from '../src/fixtures.ts';
import { PART_SIZE } from '../src/routes/snapshots.ts';
import { type Harness, harness } from './helpers.ts';
import {
  acquireLease,
  backup,
  commitSnapshot,
  initSnapshot,
  operation,
  releaseLease,
  runWorker,
  sealedObject,
  sha256,
  uploadObject,
} from './sync-helpers.ts';

const config = loadConfig();
const endpoint = config.objectStore?.endpoint ?? '';
const reachable = endpoint
  ? await fetch(endpoint, { signal: AbortSignal.timeout(2000) }).then(
      () => true,
      () => false,
    )
  : false;

it.runIf(process.env.GITHUB_ACTIONS === 'true')('S3-compatible storage is available in CI', () => {
  expect(reachable, `OBJECT_STORE_ENDPOINT ${endpoint}`).toBe(true);
});

describe.skipIf(!reachable)('snapshots on S3-compatible storage', () => {
  const { acme } = FIXTURES.orgs;
  const device = FIXTURES.devices.acmeOwnerLaptop.id;
  let h: Harness;
  let owner: Record<string, string>;
  let raw: S3Client;
  let n = 0;

  beforeAll(async () => {
    h = await harness({ storage: 's3' });
    owner = await h.auth('acmeOwner');
    const os = config.objectStore;
    if (!os?.accessKeyId || !os.secretAccessKey) throw new Error('test storage credentials missing');
    raw = new S3Client({
      endpoint: os.endpoint,
      region: os.region,
      forcePathStyle: os.forcePathStyle,
      credentials: { accessKeyId: os.accessKeyId, secretAccessKey: os.secretAccessKey },
      requestChecksumCalculation: 'WHEN_REQUIRED',
    });
    await raw.send(new CreateBucketCommand({ Bucket: os.bucket })).catch(() => undefined); // exists already: fine
  });
  afterAll(async () => {
    await h?.close();
  });

  const freshProfile = async () =>
    (
      await h.app.inject({
        method: 'POST',
        url: `/v1/orgs/${acme.id}/profiles`,
        headers: owner,
        payload: { name: `s3-${n++}` },
      })
    ).json().id as string;

  it('uploads a multi-part snapshot through signed URLs, verifies it and serves it back', async () => {
    const profile = await freshProfile();
    const done = await backup(h, {
      headers: owner,
      org: acme.id,
      profile,
      device,
      base: 0,
      payload: PART_SIZE + 1024 * 1024, // two parts
    });
    expect(done.operation).toMatchObject({ state: 'committed', version: 1 });
    const plan = (
      await h.app.inject({
        method: 'POST',
        url: `/v1/orgs/${acme.id}/profiles/${profile}/restore-plans`,
        headers: owner,
        payload: {},
      })
    ).json() as RestorePlan;
    const download = await fetch(plan.download.url);
    expect(download.status).toBe(200);
    const bytes = Buffer.from(await download.arrayBuffer());
    expect(bytes.length).toBe(done.object.length);
    expect(sha256(bytes)).toBe(plan.snapshot.digest);
    // A signed URL is for one object: another key with the same signature is refused.
    const forged = plan.download.url.replace(plan.snapshot.id, 'snp_01M4T7R0Q4FN6G53AWPJQ3ZZZZ');
    expect(forged).not.toBe(plan.download.url);
    expect((await fetch(forged)).status).toBeGreaterThanOrEqual(400);
  });

  it('an object replaced in storage after the upload fails verification and is erased', async () => {
    const profile = await freshProfile();
    const fencing = await acquireLease(h, owner, acme.id, profile, device);
    const init = (
      await initSnapshot(h, owner, acme.id, profile, { base_version: 0, fencing_token: fencing })
    ).json();
    const object = sealedObject({
      orgId: acme.id,
      profileId: profile,
      snapshotId: init.key.snapshot_id,
      keyVersion: init.key.key_version,
    });
    const parts = await uploadObject(h, owner, acme.id, profile, init.key.snapshot_id, object);
    const res = await commitSnapshot(h, owner, acme.id, profile, init.key.snapshot_id, {
      fencing_token: fencing,
      digest: sha256(object),
      ciphertext_size: object.length,
      parts,
    });
    expect(res.statusCode).toBe(202);
    const key = `orgs/${acme.id}/${init.key.snapshot_id}.pbseal`;
    const tampered = Buffer.from(object);
    tampered.writeUInt8(tampered.readUInt8(tampered.length - 1) ^ 1, tampered.length - 1);
    await raw.send(new PutObjectCommand({ Bucket: config.objectStore?.bucket, Key: key, Body: tampered }));
    await runWorker(h);
    expect(await operation(h, owner, acme.id, init.operation.id)).toMatchObject({
      state: 'failed',
      error_code: 'DIGEST_MISMATCH',
    });
    await eraseObjects(h.jobs);
    expect(await h.objects.head(key)).toBeNull();
    await releaseLease(h, owner, acme.id, profile, fencing);
  });
});
