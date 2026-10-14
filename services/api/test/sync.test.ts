/**
 * Milestone 07: encrypted snapshot upload, verification, version control, restore authorization, failure handling,
 * retention, trash and key rotation, through the HTTP API and the worker jobs (in-memory object store; the same flow
 * against real S3-compatible storage is in sync-s3.test.ts).
 */
import { randomBytes } from 'node:crypto';
import type { RestorePlan, SnapshotInitResult } from '@pb/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  applyRetention,
  eraseObjects,
  maintainKeys,
  processSyncWork,
  purgeTrash,
  sweepOrphans,
} from '../src/backup/jobs.ts';
import { localKeyProvider, orgKeyById, unwrapDataKey } from '../src/backup/keys.ts';
import type { MemoryObjectStore } from '../src/backup/objects.ts';
import { FIXTURES } from '../src/fixtures.ts';
import { PART_SIZE } from '../src/routes/snapshots.ts';
import { type Harness, harness, idemKey } from './helpers.ts';
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
  snapUrl,
  uploadObject,
} from './sync-helpers.ts';

const { acme, beta } = FIXTURES.orgs;
const ownerDevice = FIXTURES.devices.acmeOwnerLaptop.id;
const operatorDevice = FIXTURES.devices.acmeOperatorMac.id;

let h: Harness;
let mem: MemoryObjectStore;
let owner: Record<string, string>;
let operator: Record<string, string>;
let n = 0;

beforeAll(async () => {
  h = await harness();
  if (!h.memory) throw new Error('in-memory store expected');
  mem = h.memory;
  owner = await h.auth('acmeOwner');
  operator = await h.auth('acmeOperator');
});
afterAll(async () => {
  await h.close();
});

async function freshProfile(): Promise<string> {
  const res = await h.app.inject({
    method: 'POST',
    url: `/v1/orgs/${acme.id}/profiles`,
    headers: owner,
    payload: { name: `sync-${n++}`, client_id: FIXTURES.clients.acmeNorth.id },
  });
  expect(res.statusCode).toBe(201);
  return res.json().id;
}

const objectKey = (_profile: string, snapshot: string) => `orgs/${acme.id}/${snapshot}.pbseal`;

async function restorePlan(profile: string, snapshotId?: string, headers = owner) {
  return h.app.inject({
    method: 'POST',
    url: `/v1/orgs/${acme.id}/profiles/${profile}/restore-plans`,
    headers,
    payload: snapshotId ? { snapshot_id: snapshotId } : {},
  });
}

/**
 * Runs `f` as a person who just signed in (a recent sign-in), made an owner of the fixture organization for the
 * duration only (other test files count the fixture organization's members).
 */
async function asRecentOwner<T>(f: (headers: Record<string, string>) => Promise<T>): Promise<T> {
  const me = await h.signIn();
  await h.owner.query("insert into memberships (org_id, user_id, role) values ($1, $2, 'owner')", [
    acme.id,
    me.session.user.id,
  ]);
  try {
    return await f(me.headers);
  } finally {
    await h.owner.query('delete from memberships where org_id = $1 and user_id = $2', [
      acme.id,
      me.session.user.id,
    ]);
  }
}

async function profileHead(profile: string) {
  const res = await h.app.inject({
    method: 'GET',
    url: `/v1/orgs/${acme.id}/profiles/${profile}`,
    headers: owner,
  });
  return res.json() as { snapshot_version: number; last_snapshot_at: string | null };
}

/** Starts an upload and stores the object, without committing. */
async function staged(profile: string, base: number, fencing: string) {
  const res = await initSnapshot(h, owner, acme.id, profile, { base_version: base, fencing_token: fencing });
  expect(res.statusCode, res.body).toBe(201);
  const init = res.json() as SnapshotInitResult;
  const object = sealedObject({
    orgId: acme.id,
    profileId: profile,
    snapshotId: init.key.snapshot_id,
    keyVersion: init.key.key_version,
  });
  const parts = await uploadObject(h, owner, acme.id, profile, init.key.snapshot_id, object);
  return { init, object, parts };
}

async function auditActions(target: string): Promise<string[]> {
  const { rows } = await h.owner.query(
    'select action, outcome from audit_events where target_id = $1 order by created_at, id',
    [target],
  );
  return rows.map((r) => `${r.action}:${r.outcome}`);
}

describe('upload, verification and restore', () => {
  it('commits a verified snapshot as the next version and authorizes its restore with the same data key', async () => {
    const profile = await freshProfile();
    const done = await backup(h, { headers: owner, org: acme.id, profile, device: ownerDevice, base: 0 });
    expect(done.operation).toMatchObject({
      state: 'committed',
      version: 1,
      base_version: 0,
      error_code: null,
    });
    expect(done.init.key).toMatchObject({
      scheme: 'aes-256-gcm-chunked-v1',
      schema_version: 1,
      org_id: acme.id,
    });
    expect(Buffer.from(done.init.key.data_key, 'base64')).toHaveLength(32);
    expect(done.init.upload).toMatchObject({ part_size: PART_SIZE, max_parts: 10_000 });
    expect(await profileHead(profile)).toMatchObject({ snapshot_version: 1 });

    const history = await h.app.inject({ method: 'GET', url: snapUrl(acme.id, profile), headers: owner });
    expect(history.json().items).toEqual([
      expect.objectContaining({
        id: done.init.key.snapshot_id,
        status: 'committed',
        version: 1,
        parent_version: 0,
        digest: sha256(done.object),
        ciphertext_size: done.object.length,
        key_version: done.init.key.key_version,
        platform: 'linux-x64',
        browser_version: '155.0.8059.39',
      }),
    ]);
    expect(JSON.stringify(history.json())).not.toContain('pbseal'); // object locations stay private

    const plan = await restorePlan(profile);
    expect(plan.statusCode, plan.body).toBe(200);
    const p = plan.json() as RestorePlan;
    expect(p.head_version).toBe(1);
    expect(p.snapshot.id).toBe(done.init.key.snapshot_id);
    expect(p.key).toEqual(done.init.key); // the device opens with exactly the key it sealed with
    expect(p.download.url).toContain(encodeURIComponent(`orgs/${acme.id}/${p.snapshot.id}.pbseal`));
    expect(await auditActions(done.init.key.snapshot_id)).toEqual([
      'snapshot.upload_started:success',
      'snapshot.committed:success',
      'snapshot.restore_authorized:success',
    ]);
    // Data keys never reach the audit log or the outbox.
    const key = done.init.key.data_key;
    const { rows } = await h.owner.query(
      `select (select count(*) from audit_events where details::text like '%' || $1 || '%')::int as audit,
              (select count(*) from outbox_events where redacted_payload::text like '%' || $1 || '%')::int as outbox,
              (select count(*) from idempotency_keys where response_body::text like '%' || $1 || '%')::int as idem`,
      [key],
    );
    expect(rows[0]).toEqual({ audit: 0, outbox: 0, idem: 0 });
    const stored = await h.owner.query('select wrapped_dek from snapshot_manifests where id = $1', [
      done.init.key.snapshot_id,
    ]);
    expect(stored.rows[0].wrapped_dek.includes(Buffer.from(key, 'base64'))).toBe(false);
  });

  it('replays init for the same key and request, and refuses the key for another request', async () => {
    const profile = await freshProfile();
    const fencing = await acquireLease(h, owner, acme.id, profile, ownerDevice);
    const key = idemKey();
    const a = await initSnapshot(
      h,
      owner,
      acme.id,
      profile,
      { base_version: 0, fencing_token: fencing },
      key,
    );
    const b = await initSnapshot(
      h,
      owner,
      acme.id,
      profile,
      { base_version: 0, fencing_token: fencing },
      key,
    );
    expect([a.statusCode, b.statusCode]).toEqual([201, 200]);
    expect(b.headers['idempotent-replayed']).toBe('true');
    expect(b.json().key).toEqual(a.json().key);
    expect(b.json().operation.id).toBe(a.json().operation.id);
    const other = await h.app.inject({
      method: 'POST',
      url: `${snapUrl(acme.id, profile)}/init`,
      headers: { ...owner, 'idempotency-key': key },
      payload: { base_version: 0, fencing_token: fencing, platform: 'macos-arm64', browser_version: '1' },
    });
    expect(other.json().code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('needs the live lease and the current fencing token', async () => {
    const profile = await freshProfile();
    const none = await initSnapshot(h, owner, acme.id, profile, { base_version: 0, fencing_token: '1' });
    expect(none.json().code).toBe('LEASE_NOT_HELD');
    const t1 = await acquireLease(h, owner, acme.id, profile, ownerDevice);
    const { init, object, parts } = await staged(profile, 0, t1);
    // The operator takes over (the owner released); the owner's upload can no longer be committed.
    await releaseLease(h, owner, acme.id, profile, t1);
    const t2 = await acquireLease(h, operator, acme.id, profile, operatorDevice);
    const late = await commitSnapshot(h, owner, acme.id, profile, init.key.snapshot_id, {
      fencing_token: t1,
      digest: sha256(object),
      ciphertext_size: object.length,
      parts,
    });
    expect(late.json().code).toBe('FENCING_TOKEN_STALE');
    // Another user's upload is invisible to the operator.
    const foreign = await h.app.inject({
      method: 'POST',
      url: `${snapUrl(acme.id, profile)}/${init.key.snapshot_id}/parts`,
      headers: operator,
      payload: { part_numbers: [1] },
    });
    expect(foreign.statusCode).toBe(404);
    await releaseLease(h, operator, acme.id, profile, t2);
  });

  it('a lease taken over during verification fails the commit with FENCING_TOKEN_STALE', async () => {
    const profile = await freshProfile();
    const t1 = await acquireLease(h, owner, acme.id, profile, ownerDevice);
    const { init, object, parts } = await staged(profile, 0, t1);
    const commit = await commitSnapshot(h, owner, acme.id, profile, init.key.snapshot_id, {
      fencing_token: t1,
      digest: sha256(object),
      ciphertext_size: object.length,
      parts,
    });
    expect(commit.statusCode).toBe(202);
    await releaseLease(h, owner, acme.id, profile, t1);
    await acquireLease(h, operator, acme.id, profile, operatorDevice);
    await runWorker(h);
    expect(await operation(h, owner, acme.id, init.operation.id)).toMatchObject({
      state: 'failed',
      error_code: 'FENCING_TOKEN_STALE',
    });
    expect((await profileHead(profile)).snapshot_version).toBe(0);
  });
});

describe('versions and conflicts', () => {
  it('refuses to start from a stale base version', async () => {
    const profile = await freshProfile();
    await backup(h, { headers: owner, org: acme.id, profile, device: ownerDevice, base: 0 });
    const fencing = await acquireLease(h, owner, acme.id, profile, ownerDevice);
    const stale = await initSnapshot(h, owner, acme.id, profile, { base_version: 0, fencing_token: fencing });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ code: 'VERSION_CONFLICT', safe_details: { head_version: 1 } });
    await releaseLease(h, owner, acme.id, profile, fencing);
  });

  it('two uploads from the same base: exactly one becomes the next version, the other a conflict', async () => {
    const profile = await freshProfile();
    const fencing = await acquireLease(h, owner, acme.id, profile, ownerDevice);
    const [a, b] = await Promise.all([staged(profile, 0, fencing), staged(profile, 0, fencing)]);
    const commits = await Promise.all(
      [a, b].map((s) =>
        commitSnapshot(h, owner, acme.id, profile, s.init.key.snapshot_id, {
          fencing_token: fencing,
          digest: sha256(s.object),
          ciphertext_size: s.object.length,
          parts: s.parts,
        }),
      ),
    );
    expect(commits.map((c) => c.statusCode)).toEqual([202, 202]);
    // The worker runs both verifications concurrently.
    await Promise.all([processSyncWork(h.jobs, 1), processSyncWork(h.jobs, 1)]);
    await runWorker(h);
    const ops = await Promise.all([a, b].map((s) => operation(h, owner, acme.id, s.init.operation.id)));
    expect(ops.map((o) => o.state).sort()).toEqual(['committed', 'failed']);
    expect(ops.find((o) => o.state === 'failed')?.error_code).toBe('VERSION_CONFLICT');
    expect((await profileHead(profile)).snapshot_version).toBe(1);
    // A commit request arriving after the other upload won answers 409 right away.
    const c = await staged(profile, 0, fencing).catch(() => null);
    expect(c).toBeNull(); // init itself already refuses the stale base
    await releaseLease(h, owner, acme.id, profile, fencing);
  });

  it('a commit whose base was overtaken before the request answers 409 and keeps the head', async () => {
    const profile = await freshProfile();
    const fencing = await acquireLease(h, owner, acme.id, profile, ownerDevice);
    const late = await staged(profile, 0, fencing);
    await backup(h, {
      headers: owner,
      org: acme.id,
      profile,
      device: ownerDevice,
      base: 0,
      fencing,
      keepLease: true,
    });
    const res = await commitSnapshot(h, owner, acme.id, profile, late.init.key.snapshot_id, {
      fencing_token: fencing,
      digest: sha256(late.object),
      ciphertext_size: late.object.length,
      parts: late.parts,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'VERSION_CONFLICT', safe_details: { head_version: 1 } });
    expect(await operation(h, owner, acme.id, late.init.operation.id)).toMatchObject({
      state: 'failed',
      error_code: 'VERSION_CONFLICT',
    });
    await releaseLease(h, owner, acme.id, profile, fencing);
  });

  it('repeating a commit returns the operation as it is (no second commit)', async () => {
    const profile = await freshProfile();
    const fencing = await acquireLease(h, owner, acme.id, profile, ownerDevice);
    const s = await staged(profile, 0, fencing);
    const body = {
      fencing_token: fencing,
      digest: sha256(s.object),
      ciphertext_size: s.object.length,
      parts: s.parts,
    };
    const first = await commitSnapshot(h, owner, acme.id, profile, s.init.key.snapshot_id, body);
    const again = await commitSnapshot(h, owner, acme.id, profile, s.init.key.snapshot_id, body);
    expect([first.statusCode, again.statusCode]).toEqual([202, 200]);
    const other = await commitSnapshot(h, owner, acme.id, profile, s.init.key.snapshot_id, {
      ...body,
      digest: 'e'.repeat(64),
    });
    expect(other.json().code).toBe('SYNC_STATE_CONFLICT');
    await runWorker(h);
    expect((await operation(h, owner, acme.id, s.init.operation.id)).state).toBe('committed');
    await releaseLease(h, owner, acme.id, profile, fencing);
  });
});

describe('verification refuses what was not declared', () => {
  async function verifyWith(tamper: (key: string, other: Buffer) => void): Promise<string | null> {
    const profile = await freshProfile();
    const fencing = await acquireLease(h, owner, acme.id, profile, ownerDevice);
    const s = await staged(profile, 0, fencing);
    const res = await commitSnapshot(h, owner, acme.id, profile, s.init.key.snapshot_id, {
      fencing_token: fencing,
      digest: sha256(s.object),
      ciphertext_size: s.object.length,
      parts: s.parts,
    });
    expect(res.statusCode).toBe(202);
    const key = objectKey(profile, s.init.key.snapshot_id);
    tamper(key, s.object);
    await runWorker(h);
    const op = await operation(h, owner, acme.id, s.init.operation.id);
    await releaseLease(h, owner, acme.id, profile, fencing);
    expect((await profileHead(profile)).snapshot_version).toBe(op.state === 'committed' ? 1 : 0);
    return op.error_code;
  }

  it('object substitution, modification, truncation and removal fail closed', async () => {
    // Another snapshot's object (same organization) put in place of this one.
    const donor = await freshProfile();
    const other = await backup(h, {
      headers: owner,
      org: acme.id,
      profile: donor,
      device: ownerDevice,
      base: 0,
    });
    expect(
      await verifyWith((key) => mem.objects.set(key, { bytes: other.object, lastModified: new Date() })),
    ).toBe('SIZE_MISMATCH');
    const sameSize = (key: string, original: Buffer) => {
      const swapped = sealedObject(
        {
          orgId: acme.id,
          profileId: donor,
          snapshotId: other.init.key.snapshot_id,
          keyVersion: other.init.key.key_version,
        },
        original.length - other.object.length + 4096,
      );
      mem.objects.set(key, { bytes: swapped.subarray(0, original.length), lastModified: new Date() });
    };
    expect(await verifyWith(sameSize)).toBe('HEADER_MISMATCH');
    expect(
      await verifyWith((key) => {
        const o = mem.objects.get(key);
        if (o) o.bytes.writeUInt8(o.bytes.readUInt8(o.bytes.length - 1) ^ 1, o.bytes.length - 1);
      }),
    ).toBe('DIGEST_MISMATCH');
    expect(
      await verifyWith((key) => {
        const o = mem.objects.get(key);
        if (o)
          mem.objects.set(key, { bytes: o.bytes.subarray(0, o.bytes.length - 10), lastModified: new Date() });
      }),
    ).toBe('SIZE_MISMATCH');
    expect(await verifyWith((key) => mem.objects.delete(key))).toBe('OBJECT_MISSING');
    expect(await verifyWith(() => undefined)).toBeNull();
  });

  it('a header naming another kind, schema or key version is refused', async () => {
    for (const change of [
      { kind: 'local-backup' },
      { schemaVersion: 2 },
      { keyVersion: 'okv_01M4T7R0Q4FN6G53AWPJQ3CBMA' },
    ]) {
      const profile = await freshProfile();
      const fencing = await acquireLease(h, owner, acme.id, profile, ownerDevice);
      const res = await initSnapshot(h, owner, acme.id, profile, { base_version: 0, fencing_token: fencing });
      const init = res.json() as SnapshotInitResult;
      const object = sealedObject({
        orgId: acme.id,
        profileId: profile,
        snapshotId: init.key.snapshot_id,
        keyVersion: init.key.key_version,
        ...change,
      });
      const parts = await uploadObject(h, owner, acme.id, profile, init.key.snapshot_id, object);
      await commitSnapshot(h, owner, acme.id, profile, init.key.snapshot_id, {
        fencing_token: fencing,
        digest: sha256(object),
        ciphertext_size: object.length,
        parts,
      });
      await runWorker(h);
      expect((await operation(h, owner, acme.id, init.operation.id)).error_code).toBe('HEADER_MISMATCH');
      await releaseLease(h, owner, acme.id, profile, fencing);
    }
  });

  it('commit checks the declared parts against the storage', async () => {
    const profile = await freshProfile();
    const fencing = await acquireLease(h, owner, acme.id, profile, ownerDevice);
    const s = await staged(profile, 0, fencing);
    const base = { fencing_token: fencing, digest: sha256(s.object), ciphertext_size: s.object.length };
    const cases = [
      { ...base, parts: [{ part_number: 1, etag: 'nope' }] },
      { ...base, parts: [{ part_number: 2, etag: s.parts[0]?.etag ?? '' }] },
      { ...base, ciphertext_size: s.object.length + 1, parts: s.parts },
      { ...base, ciphertext_size: PART_SIZE + 5, parts: s.parts },
    ];
    for (const body of cases) {
      const res = await commitSnapshot(h, owner, acme.id, profile, s.init.key.snapshot_id, body);
      expect(res.json().code).toBe('UPLOAD_INCOMPLETE');
    }
    await releaseLease(h, owner, acme.id, profile, fencing);
  });
});

describe('interruptions leave the previous snapshot restorable', () => {
  it('abandoned, canceled, unverified and failed uploads never move the head', async () => {
    const profile = await freshProfile();
    const first = await backup(h, { headers: owner, org: acme.id, profile, device: ownerDevice, base: 0 });
    const fencing = await acquireLease(h, owner, acme.id, profile, ownerDevice);

    // 1. Initialized, nothing uploaded, never committed: the worker expires it after the deadline.
    const abandoned = await initSnapshot(h, owner, acme.id, profile, {
      base_version: 1,
      fencing_token: fencing,
    });
    const abandonedOp = abandoned.json().operation.id;
    await h.owner.query("update sync_operations set expires_at = now() - interval '1 second' where id = $1", [
      abandonedOp,
    ]);
    await runWorker(h);
    expect((await operation(h, owner, acme.id, abandonedOp)).state).toBe('expired');

    // 2. Half uploaded (resume lists what is stored), then canceled.
    const partial = await staged(profile, 1, fencing);
    const listed = await h.app.inject({
      method: 'GET',
      url: `${snapUrl(acme.id, profile)}/${partial.init.key.snapshot_id}/parts`,
      headers: owner,
    });
    expect(listed.json().parts).toEqual([
      expect.objectContaining({ part_number: 1, size: partial.object.length, etag: partial.parts[0]?.etag }),
    ]);
    const cancel = await h.app.inject({
      method: 'POST',
      url: `${snapUrl(acme.id, profile)}/${partial.init.key.snapshot_id}/cancel`,
      headers: owner,
    });
    expect(cancel.json().state).toBe('canceled');

    // 3. Committed, storage down while verifying: retried, the head stays until verification succeeds.
    const slow = await staged(profile, 1, fencing);
    await commitSnapshot(h, owner, acme.id, profile, slow.init.key.snapshot_id, {
      fencing_token: fencing,
      digest: sha256(slow.object),
      ciphertext_size: slow.object.length,
      parts: slow.parts,
    });
    mem.failNext = 'head';
    const r = await processSyncWork(h.jobs, 10);
    expect(r.retried).toBe(1);
    expect((await profileHead(profile)).snapshot_version).toBe(1);
    const stillOld = await restorePlan(profile);
    expect(stillOld.json().snapshot.id).toBe(first.init.key.snapshot_id);
    await h.owner.query('update sync_operations set locked_until = null where id = $1', [
      slow.init.operation.id,
    ]);
    await runWorker(h);
    expect((await operation(h, owner, acme.id, slow.init.operation.id)).state).toBe('committed');
    expect((await profileHead(profile)).snapshot_version).toBe(2);

    // The first snapshot is still restorable by id; going back to an older version needs a recent sign-in (12).
    const stale = await restorePlan(profile, first.init.key.snapshot_id);
    expect(stale.json().code).toBe('REAUTHENTICATION_REQUIRED');
    const old = await asRecentOwner((headers) => restorePlan(profile, first.init.key.snapshot_id, headers));
    expect(old.statusCode).toBe(200);
    expect(old.json().key.data_key).toBe(first.init.key.data_key);
    await releaseLease(h, owner, acme.id, profile, fencing);

    // Objects of abandoned or canceled uploads are erased; committed ones are kept.
    await eraseObjects(h.jobs);
    expect(mem.objects.has(objectKey(profile, partial.init.key.snapshot_id))).toBe(false);
    expect(mem.objects.has(objectKey(profile, first.init.key.snapshot_id))).toBe(true);
    expect(mem.objects.has(objectKey(profile, slow.init.key.snapshot_id))).toBe(true);
  });

  it('orphaned objects (no manifest) are swept after the grace period; known ones are kept', async () => {
    const profile = await freshProfile();
    const kept = await backup(h, { headers: owner, org: acme.id, profile, device: ownerDevice, base: 0 });
    const orphan = `orgs/${acme.id}/snp_01M4T7R0Q4FN6G53AWPJQ3ZZZZ.pbseal`;
    const old = new Date(Date.now() - 48 * 3600_000);
    mem.objects.set(orphan, { bytes: randomBytes(10), lastModified: old });
    const fresh = `${orphan}.new`;
    mem.objects.set(fresh, { bytes: randomBytes(10), lastModified: new Date() });
    const known = mem.objects.get(objectKey(profile, kept.init.key.snapshot_id));
    if (known) known.lastModified = old;
    expect(await sweepOrphans(h.jobs)).toBeGreaterThanOrEqual(1);
    expect(mem.objects.has(orphan)).toBe(false);
    expect(mem.objects.has(fresh)).toBe(true);
    expect(mem.objects.has(objectKey(profile, kept.init.key.snapshot_id))).toBe(true);
    mem.objects.delete(fresh);
  });
});

describe('restore authorization and manifest tampering', () => {
  it('a modified wrapped key, a manifest moved to another profile, or a destroyed key fail closed', async () => {
    const profile = await freshProfile();
    const done = await backup(h, { headers: owner, org: acme.id, profile, device: ownerDevice, base: 0 });
    const id = done.init.key.snapshot_id;
    const original = await h.owner.query('select wrapped_dek from snapshot_manifests where id = $1', [id]);
    const flipped = Buffer.from(original.rows[0].wrapped_dek as Buffer);
    flipped.writeUInt8(flipped.readUInt8(20) ^ 1, 20);
    await h.owner.query('update snapshot_manifests set wrapped_dek = $2 where id = $1', [id, flipped]);
    expect((await restorePlan(profile)).json().code).toBe('SNAPSHOT_UNAVAILABLE');
    await h.owner.query('update snapshot_manifests set wrapped_dek = $2 where id = $1', [
      id,
      original.rows[0].wrapped_dek,
    ]);
    expect((await restorePlan(profile)).statusCode).toBe(200);

    // The manifest re-pointed at another profile of the same organization: the data key is bound to the profile.
    const other = await freshProfile();
    await h.owner.query('update snapshot_manifests set profile_id = $2 where id = $1', [id, other]);
    await h.owner.query('update profiles set head_snapshot_id = $2, snapshot_version = 1 where id = $1', [
      other,
      id,
    ]);
    expect((await restorePlan(other)).json().code).toBe('SNAPSHOT_UNAVAILABLE');
    await h.owner.query('update snapshot_manifests set profile_id = $2 where id = $1', [id, profile]);
  });

  it('operators restore granted profiles; deleted-by-retention snapshots are unavailable', async () => {
    const profile = await freshProfile(); // Client North: granted to the operator
    const done = await backup(h, {
      headers: operator,
      org: acme.id,
      profile,
      device: operatorDevice,
      base: 0,
    });
    expect(done.operation.state).toBe('committed');
    expect((await restorePlan(profile, undefined, operator)).statusCode).toBe(200);
    const notGranted = (
      await h.app.inject({
        method: 'POST',
        url: `/v1/orgs/${acme.id}/profiles`,
        headers: owner,
        payload: { name: `other-${n++}` },
      })
    ).json().id;
    expect((await restorePlan(notGranted, undefined, operator)).statusCode).toBe(404);
    await h.owner.query(
      "update snapshot_manifests set status = 'deleted', deleted_at = now(), purge_after = now() where id = $1",
      [done.init.key.snapshot_id],
    );
    expect((await restorePlan(profile, done.init.key.snapshot_id)).json().code).toBe('SNAPSHOT_UNAVAILABLE');
  });
});

describe('retention, quota and trash', () => {
  it('keeps the newest, the last 24 hours and the newest of each retained day; erases the rest later', async () => {
    const profile = await freshProfile();
    const ids: string[] = [];
    for (let v = 0; v < 6; v++) {
      const done = await backup(h, { headers: owner, org: acme.id, profile, device: ownerDevice, base: v });
      ids.push(done.init.key.snapshot_id);
    }
    // Committed: v1 and v2 on the same UTC day 10 days ago, v3 and v4 on the same day 2 days ago, v5 three hours ago,
    // v6 now (the head).
    const at = [
      "date_trunc('day', now(), 'UTC') - interval '10 days' + interval '11 hours'",
      "date_trunc('day', now(), 'UTC') - interval '10 days' + interval '12 hours'",
      "date_trunc('day', now(), 'UTC') - interval '2 days' + interval '12 hours'",
      "date_trunc('day', now(), 'UTC') - interval '2 days' + interval '11 hours'",
      "now() - interval '3 hours'",
      'now()',
    ];
    for (const [i, when] of at.entries()) {
      await h.owner.query(`update snapshot_manifests set committed_at = ${when} where id = $1`, [ids[i]]);
    }
    await h.owner.query('update organizations set backup_retention_days = 7 where id = $1', [acme.id]);
    await applyRetention(h.jobs);
    const { rows } = await h.owner.query(
      'select id, status from snapshot_manifests where profile_id = $1 order by version',
      [profile],
    );
    // 10 days ago is outside 7 days; of the two snapshots two days ago, the newer one (v3) is kept.
    expect(rows.map((r) => r.status)).toEqual([
      'deleted',
      'deleted',
      'committed',
      'deleted',
      'committed',
      'committed',
    ]);
    expect(await auditActions(ids[0] ?? '')).toContain('snapshot.expired:success');
    // Erased from storage after the grace period.
    await eraseObjects(h.jobs);
    expect(mem.objects.has(objectKey(profile, ids[0] ?? ''))).toBe(true);
    await h.owner.query(
      "update snapshot_manifests set purge_after = now() - interval '1 second' where profile_id = $1 and status = 'deleted'",
      [profile],
    );
    await eraseObjects(h.jobs);
    expect(mem.objects.has(objectKey(profile, ids[0] ?? ''))).toBe(false);
    expect(mem.objects.has(objectKey(profile, ids[5] ?? ''))).toBe(true);
  });

  it('policy: organizations change retention and trash; quota and size limits hold', async () => {
    const before = await h.app.inject({
      method: 'GET',
      url: `/v1/orgs/${acme.id}/backup-policy`,
      headers: owner,
    });
    // Fixture organizations are internal (no plan storage limit): the operator's ceiling applies (milestone 11).
    expect(before.json()).toMatchObject({ retention_days: 7, trash_days: 30, quota_bytes: 1099511627776 });
    expect(before.json().used_bytes).toBeGreaterThan(0);
    const patched = await h.app.inject({
      method: 'PATCH',
      url: `/v1/orgs/${acme.id}/backup-policy`,
      headers: owner,
      payload: { retention_days: 14, trash_days: 10 },
    });
    expect(patched.json()).toMatchObject({ retention_days: 14, trash_days: 10 });
    const bad = await h.app.inject({
      method: 'PATCH',
      url: `/v1/orgs/${acme.id}/backup-policy`,
      headers: owner,
      payload: { quota_bytes: 1 },
    });
    expect(bad.statusCode).toBe(400);
    await h.app.inject({
      method: 'PATCH',
      url: `/v1/orgs/${acme.id}/backup-policy`,
      headers: owner,
      payload: { retention_days: 7, trash_days: 30 },
    });

    const profile = await freshProfile();
    const fencing = await acquireLease(h, owner, acme.id, profile, ownerDevice);
    await h.owner.query('update organizations set max_snapshot_bytes = 100 where id = $1', [acme.id]);
    const s = await staged(profile, 0, fencing);
    const big = await commitSnapshot(h, owner, acme.id, profile, s.init.key.snapshot_id, {
      fencing_token: fencing,
      digest: sha256(s.object),
      ciphertext_size: s.object.length,
      parts: s.parts,
    });
    expect(big.json().code).toBe('SNAPSHOT_TOO_LARGE');
    await h.owner.query(
      'update organizations set max_snapshot_bytes = 4294967296, backup_quota_bytes = 1 where id = $1',
      [acme.id],
    );
    const full = await initSnapshot(h, owner, acme.id, profile, { base_version: 0, fencing_token: fencing });
    expect(full.json().code).toBe('QUOTA_EXCEEDED');
    await h.owner.query('update organizations set backup_quota_bytes = 1099511627776 where id = $1', [
      acme.id,
    ]);
    await releaseLease(h, owner, acme.id, profile, fencing);
  });

  it('deleted profiles stay restorable for the trash period, then are purged with their snapshots', async () => {
    const profile = await freshProfile();
    const done = await backup(h, { headers: owner, org: acme.id, profile, device: ownerDevice, base: 0 });
    const current = await h.app.inject({
      method: 'GET',
      url: `/v1/orgs/${acme.id}/profiles/${profile}`,
      headers: owner,
    });
    const del = await h.app.inject({
      method: 'DELETE',
      url: `/v1/orgs/${acme.id}/profiles/${profile}`,
      headers: { ...owner, 'if-match': `"${current.json().version}"` },
    });
    expect(del.statusCode).toBe(204);
    const trash = await h.app.inject({
      method: 'GET',
      url: `/v1/orgs/${acme.id}/trash?limit=100`,
      headers: owner,
    });
    const entry = trash.json().items.find((t: { profile: { id: string } }) => t.profile.id === profile);
    expect(entry).toBeDefined();
    expect(Date.parse(entry.purge_after) - Date.parse(entry.deleted_at)).toBe(30 * 86400_000);
    expect((await restorePlan(profile)).statusCode).toBe(404); // deleted profiles are not restored from

    const undoUrl = `/v1/orgs/${acme.id}/profiles/${profile}/undelete`;
    // Restoring from the trash needs a recent sign-in (milestone 12).
    const stale = await h.app.inject({ method: 'POST', url: undoUrl, headers: owner });
    expect(stale.json().code).toBe('REAUTHENTICATION_REQUIRED');
    const undo = await asRecentOwner((headers) => h.app.inject({ method: 'POST', url: undoUrl, headers }));
    expect(undo.statusCode).toBe(200);
    expect((await restorePlan(profile)).statusCode).toBe(200);

    const again = await h.app.inject({
      method: 'GET',
      url: `/v1/orgs/${acme.id}/profiles/${profile}`,
      headers: owner,
    });
    await h.app.inject({
      method: 'DELETE',
      url: `/v1/orgs/${acme.id}/profiles/${profile}`,
      headers: { ...owner, 'if-match': `"${again.json().version}"` },
    });
    await h.owner.query("update profiles set deleted_at = now() - interval '31 days' where id = $1", [
      profile,
    ]);
    expect(await purgeTrash(h.jobs)).toBeGreaterThanOrEqual(1);
    expect((await h.owner.query('select 1 from profiles where id = $1', [profile])).rowCount).toBe(0);
    expect(mem.objects.has(objectKey(profile, done.init.key.snapshot_id))).toBe(false);
    expect(await auditActions(profile)).toContain('profile.purged:success');
  });
});

describe('organization keys', () => {
  it('rotation: new snapshots use the new version, old data keys are re-wrapped, the old version is destroyed', async () => {
    // A recent sign-in (session principal) is required; the signed-in person becomes an owner of a new organization.
    const me = await h.signIn();
    const created = await h.app.inject({
      method: 'POST',
      url: '/v1/organizations',
      headers: me.headers,
      payload: { name: `Keys ${n++}` },
    });
    const org = created.json().id as string;
    const device = me.session.device.id;
    const prof = (
      await h.app.inject({
        method: 'POST',
        url: `/v1/orgs/${org}/profiles`,
        headers: me.headers,
        payload: { name: 'k' },
      })
    ).json().id as string;
    const first = await backup(h, { headers: me.headers, org, profile: prof, device, base: 0 });
    const v1 = first.init.key.key_version;

    const rotated = await h.app.inject({
      method: 'POST',
      url: `/v1/orgs/${org}/keys/rotate`,
      headers: me.headers,
    });
    expect(rotated.statusCode, rotated.body).toBe(200);
    const keys = rotated.json().keys as { id: string; version: number; status: string; snapshots: number }[];
    expect(keys.map((k) => [k.version, k.status, k.snapshots])).toEqual([
      [2, 'active', 0],
      [1, 'retired', 1],
    ]);
    const second = await backup(h, { headers: me.headers, org, profile: prof, device, base: 1 });
    expect(second.init.key.key_version).not.toBe(v1);

    await maintainKeys(h.jobs);
    const after = (
      await h.app.inject({ method: 'GET', url: `/v1/orgs/${org}/keys`, headers: me.headers })
    ).json();
    expect(after.keys.map((k: { snapshots: number }) => k.snapshots)).toEqual([2, 0]);
    // The re-wrapped snapshot still opens with the key it was sealed with (header binding unchanged).
    const plan = await h.app.inject({
      method: 'POST',
      url: `/v1/orgs/${org}/profiles/${prof}/restore-plans`,
      headers: me.headers,
      payload: { snapshot_id: first.init.key.snapshot_id },
    });
    expect(plan.json().key).toEqual(first.init.key);

    await maintainKeys(h.jobs); // schedules destruction of the unused version
    const scheduled = await h.owner.query(
      'select destroy_after from organization_key_versions where id = $1',
      [v1],
    );
    expect(scheduled.rows[0].destroy_after).not.toBeNull();
    await h.owner.query(
      "update organization_key_versions set destroy_after = now() - interval '1 second' where id = $1",
      [v1],
    );
    const destroyed = await maintainKeys(h.jobs);
    expect(destroyed.destroyed).toBeGreaterThanOrEqual(1);
    const row = await h.owner.query(
      'select status, wrapped_key from organization_key_versions where id = $1',
      [v1],
    );
    expect(row.rows[0]).toEqual({ status: 'destroyed', wrapped_key: null });
    const actions = (
      await h.owner.query('select action from audit_events where org_id = $1 order by created_at, id', [org])
    ).rows.map((r) => r.action);
    expect(actions).toEqual(
      expect.arrayContaining(['org_key.rotated', 'org_key.destruction_scheduled', 'org_key.destroyed']),
    );

    // A snapshot whose key version was destroyed cannot be restored (crypto-erasure).
    await h.owner.query('update snapshot_manifests set key_version_id = $2 where id = $1', [
      first.init.key.snapshot_id,
      v1,
    ]);
    const gone = await h.app.inject({
      method: 'POST',
      url: `/v1/orgs/${org}/profiles/${prof}/restore-plans`,
      headers: me.headers,
      payload: { snapshot_id: first.init.key.snapshot_id },
    });
    expect(gone.json().code).toBe('SNAPSHOT_UNAVAILABLE');
  });

  it('root key rotation re-wraps organization keys; the old root key can then be retired', async () => {
    const me = await h.signIn();
    const org = (
      await h.app.inject({
        method: 'POST',
        url: '/v1/organizations',
        headers: me.headers,
        payload: { name: `Root ${n++}` },
      })
    ).json().id as string;
    const prof = (
      await h.app.inject({
        method: 'POST',
        url: `/v1/orgs/${org}/profiles`,
        headers: me.headers,
        payload: { name: 'r' },
      })
    ).json().id as string;
    const done = await backup(h, {
      headers: me.headers,
      org,
      profile: prof,
      device: me.session.device.id,
      base: 0,
    });

    const fixture = JSON.parse(process.env.KMS_LOCAL_KEYS ?? '{}') as {
      active: string;
      keys: Record<string, string>;
    };
    const oldRoot = fixture.active;
    const newRoot = randomBytes(32).toString('base64');
    const both = localKeyProvider({
      provider: 'local',
      activeKeyId: 'root-2',
      keys: { ...fixture.keys, 'root-2': newRoot },
    });
    try {
      await maintainKeys({ ...h.jobs, kms: both });
      const k = await h.owner.query('select kms_key_id from organization_key_versions where org_id = $1', [
        org,
      ]);
      expect(k.rows.map((r) => r.kms_key_id)).toEqual(['root-2']);
      // The organization key now unwraps with the new root key alone.
      const onlyNew = localKeyProvider({
        provider: 'local',
        activeKeyId: 'root-2',
        keys: { 'root-2': newRoot },
      });
      const c = await h.owner.connect();
      try {
        const m = await c.query(
          'select key_version_id, wrapped_dek from app.snapshot_manifests where id = $1',
          [done.init.key.snapshot_id],
        );
        const ok = await orgKeyById(c, onlyNew, org, m.rows[0].key_version_id);
        const dek = unwrapDataKey(ok, m.rows[0].wrapped_dek, {
          orgId: org,
          profileId: prof,
          snapshotId: done.init.key.snapshot_id,
          keyVersionId: m.rows[0].key_version_id,
        });
        expect(dek.toString('base64')).toBe(done.init.key.data_key);
      } finally {
        c.release();
      }
    } finally {
      // Back to the fixture root key, so the other tests (same database) keep working.
      await maintainKeys({
        ...h.jobs,
        kms: localKeyProvider({
          provider: 'local',
          activeKeyId: oldRoot,
          keys: { ...fixture.keys, 'root-2': newRoot },
        }),
      });
    }
    const rewrapped = await h.owner.query(
      "select count(*)::int as n from audit_events where org_id = $1 and action = 'org_key.root_rewrapped'",
      [org],
    );
    expect(rewrapped.rows[0].n).toBe(2); // to the new root key and back
  });
});

describe('other organizations', () => {
  it('the worker and the API never mix tenants: a beta snapshot stays beta', async () => {
    const betaOwner = await h.auth('betaOwner');
    const profile = FIXTURES.profiles.betaSupport.id;
    const head = (
      await h.app.inject({
        method: 'GET',
        url: `/v1/orgs/${beta.id}/profiles/${profile}`,
        headers: betaOwner,
      })
    ).json().snapshot_version;
    const done = await backup(h, {
      headers: betaOwner,
      org: beta.id,
      profile,
      device: FIXTURES.devices.betaOwnerLaptop.id,
      base: head,
    });
    expect(done.operation.state).toBe('committed');
    const fromAcme = await h.app.inject({
      method: 'POST',
      url: `/v1/orgs/${acme.id}/profiles/${profile}/restore-plans`,
      headers: owner,
      payload: { snapshot_id: done.init.key.snapshot_id },
    });
    expect(fromAcme.statusCode).toBe(404);
    const keyRows = await h.owner.query('select org_id from organization_key_versions where id = $1', [
      done.init.key.key_version,
    ]);
    expect(keyRows.rows[0].org_id).toBe(beta.id);
  });
});

describe('secrets stay out of logs, audit and events', () => {
  it('data keys and signed URLs never appear in request logs, audit entries or outbox events', async () => {
    const lines: string[] = [];
    const logged = await harness({ logLines: lines });
    try {
      const headers = await logged.auth('acmeOwner');
      const created = await logged.app.inject({
        method: 'POST',
        url: `/v1/orgs/${acme.id}/profiles`,
        headers,
        payload: { name: `logs-${randomBytes(3).toString('hex')}` },
      });
      const profile = created.json().id as string;
      const done = await backup(logged, { headers, org: acme.id, profile, device: ownerDevice, base: 0 });
      expect(done.operation.state).toBe('committed');
      const plan = (
        await logged.app.inject({
          method: 'POST',
          url: `/v1/orgs/${acme.id}/profiles/${profile}/restore-plans`,
          headers,
          payload: {},
        })
      ).json() as RestorePlan;
      const secrets = [done.init.key.data_key, plan.key.data_key, plan.download.url];
      const audit = await logged.owner.query<{ t: string }>(
        'select details::text as t from audit_events where org_id = $1',
        [acme.id],
      );
      const events = await logged.owner.query<{ t: string }>(
        'select redacted_payload::text as t from outbox_events where org_id = $1',
        [acme.id],
      );
      const haystack = [...lines, ...audit.rows.map((r) => r.t), ...events.rows.map((r) => r.t)].join('\n');
      expect(lines.length).toBeGreaterThan(0);
      for (const s of secrets) expect(haystack).not.toContain(s);
    } finally {
      await logged.close();
    }
  });
});
