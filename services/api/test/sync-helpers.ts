/**
 * What a device does in a snapshot upload, for API tests: acquire the lease, init, upload parts to the signed URLs
 * (the in-memory store, or real S3 with fetch), commit, and let the worker verify. The object is a well-formed sealed
 * container header followed by opaque bytes: the server never decrypts, it checks size, header and SHA-256.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { SnapshotInitResult, SyncOperation } from '@pb/contracts';
import { expect } from 'vitest';
import { processSyncWork } from '../src/backup/jobs.ts';
import { SEAL_CHUNK, SEAL_MAGIC } from '../src/backup/sealed.ts';
import { PART_SIZE } from '../src/routes/snapshots.ts';
import { type Harness, idemKey } from './helpers.ts';

export interface SealedBinding {
  orgId: string;
  profileId: string;
  snapshotId: string;
  keyVersion: string;
  kind?: string;
  schemaVersion?: number;
}

/** A sealed-container header (as pb-seal writes it) followed by `payload` random bytes. */
export function sealedObject(b: SealedBinding, payload = 2048): Buffer {
  const header = Buffer.from(
    JSON.stringify({
      scheme: 'aes-256-gcm-chunked-v1',
      kind: b.kind ?? 'org-snapshot',
      org_id: b.orgId,
      profile_id: b.profileId,
      object_id: b.snapshotId,
      schema_version: b.schemaVersion ?? 1,
      key_version: b.keyVersion,
      chunk_size: SEAL_CHUNK,
      nonce_prefix: randomBytes(7).toString('hex'),
    }),
  );
  const len = Buffer.alloc(4);
  len.writeUInt32BE(header.length);
  return Buffer.concat([SEAL_MAGIC, len, header, randomBytes(payload)]);
}

export const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

export const leaseUrl = (org: string, profile: string) => `/v1/orgs/${org}/profiles/${profile}/lease`;
export const snapUrl = (org: string, profile: string) => `/v1/orgs/${org}/profiles/${profile}/snapshots`;

export async function acquireLease(
  h: Harness,
  headers: Record<string, string>,
  org: string,
  profile: string,
  device: string,
): Promise<string> {
  const res = await h.app.inject({
    method: 'POST',
    url: leaseUrl(org, profile),
    headers: { ...headers, 'idempotency-key': idemKey() },
    payload: { device_id: device },
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().fencing_token as string;
}

export async function releaseLease(
  h: Harness,
  headers: Record<string, string>,
  org: string,
  profile: string,
  token: string,
): Promise<void> {
  await h.app.inject({
    method: 'POST',
    url: `${leaseUrl(org, profile)}/release`,
    headers,
    payload: { fencing_token: token },
  });
}

export async function initSnapshot(
  h: Harness,
  headers: Record<string, string>,
  org: string,
  profile: string,
  body: { base_version: number; fencing_token: string },
  key = idemKey(),
) {
  return h.app.inject({
    method: 'POST',
    url: `${snapUrl(org, profile)}/init`,
    headers: { ...headers, 'idempotency-key': key },
    payload: { platform: 'linux-x64', browser_version: '155.0.8059.39', ...body },
  });
}

/** Uploads `bytes` in PART_SIZE parts through signed URLs; returns the parts to commit. */
export async function uploadObject(
  h: Harness,
  headers: Record<string, string>,
  org: string,
  profile: string,
  snapshotId: string,
  bytes: Buffer,
): Promise<{ part_number: number; etag: string }[]> {
  const count = Math.max(1, Math.ceil(bytes.length / PART_SIZE));
  const numbers = Array.from({ length: count }, (_, i) => i + 1);
  const res = await h.app.inject({
    method: 'POST',
    url: `${snapUrl(org, profile)}/${snapshotId}/parts`,
    headers,
    payload: { part_numbers: numbers },
  });
  expect(res.statusCode, res.body).toBe(200);
  const parts: { part_number: number; etag: string }[] = [];
  for (const p of res.json().parts as { part_number: number; url: string }[]) {
    const body = bytes.subarray((p.part_number - 1) * PART_SIZE, p.part_number * PART_SIZE);
    if (h.memory) {
      const upload = new URL(p.url.replace('memory://', 'memory://x/')).searchParams.get('upload') ?? '';
      parts.push({ part_number: p.part_number, etag: h.memory.putPart(upload, p.part_number, body) });
    } else {
      const put = await fetch(p.url, { method: 'PUT', body });
      expect(put.status, await put.clone().text()).toBe(200);
      parts.push({ part_number: p.part_number, etag: put.headers.get('etag') ?? '' });
    }
  }
  return parts;
}

export async function commitSnapshot(
  h: Harness,
  headers: Record<string, string>,
  org: string,
  profile: string,
  snapshotId: string,
  body: {
    fencing_token: string;
    digest: string;
    ciphertext_size: number;
    parts: { part_number: number; etag: string }[];
  },
) {
  return h.app.inject({
    method: 'POST',
    url: `${snapUrl(org, profile)}/${snapshotId}/commit`,
    headers,
    payload: { plaintext_size: body.ciphertext_size * 2, ...body },
  });
}

export async function operation(h: Harness, headers: Record<string, string>, org: string, opId: string) {
  const res = await h.app.inject({ method: 'GET', url: `/v1/orgs/${org}/sync-operations/${opId}`, headers });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as SyncOperation;
}

/** Runs the worker until nothing is left to verify. */
export async function runWorker(h: Harness): Promise<void> {
  for (let i = 0; i < 20; i++) {
    const r = await processSyncWork(h.jobs, 50);
    if (r.committed + r.failed + r.expired + r.retried === 0) return;
  }
}

export interface BackupResult {
  init: SnapshotInitResult;
  object: Buffer;
  operation: SyncOperation;
  fencing: string;
}

/** The whole device flow: lease, init, seal, upload, commit, verify (and release the lease unless keepLease). */
export async function backup(
  h: Harness,
  a: {
    headers: Record<string, string>;
    org: string;
    profile: string;
    device: string;
    base: number;
    payload?: number;
    keepLease?: boolean;
    fencing?: string;
  },
): Promise<BackupResult> {
  const fencing = a.fencing ?? (await acquireLease(h, a.headers, a.org, a.profile, a.device));
  const res = await initSnapshot(h, a.headers, a.org, a.profile, {
    base_version: a.base,
    fencing_token: fencing,
  });
  expect(res.statusCode, res.body).toBe(201);
  const init = res.json() as SnapshotInitResult;
  const object = sealedObject(
    {
      orgId: a.org,
      profileId: a.profile,
      snapshotId: init.key.snapshot_id,
      keyVersion: init.key.key_version,
    },
    a.payload ?? 4096,
  );
  const parts = await uploadObject(h, a.headers, a.org, a.profile, init.key.snapshot_id, object);
  const commit = await commitSnapshot(h, a.headers, a.org, a.profile, init.key.snapshot_id, {
    fencing_token: fencing,
    digest: sha256(object),
    ciphertext_size: object.length,
    parts,
  });
  expect(commit.statusCode, commit.body).toBe(202);
  await runWorker(h);
  const op = await operation(h, a.headers, a.org, init.operation.id);
  if (!a.keepLease) await releaseLease(h, a.headers, a.org, a.profile, fencing);
  return { init, object, operation: op, fencing };
}
