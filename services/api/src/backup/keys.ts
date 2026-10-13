/**
 * Key hierarchy for encrypted snapshots (ADR-0014; envelope encryption, NOT end-to-end):
 *
 *   root key (key provider)  --wraps-->  organization key version  --wraps-->  per-snapshot data key
 *
 * - Root keys live in the key provider. The `local` provider keeps AES-256 root keys in a root-only file on the
 *   server; a cloud KMS can implement the same interface later. They never leave the provider object.
 * - Organization key versions are random 256-bit keys stored only wrapped by a root key. One version is active per
 *   organization; rotation creates a new active version and the worker re-wraps data keys without re-uploading.
 * - Data keys are random 256-bit keys, one per snapshot, generated here and handed to the authorized device once
 *   (init: to seal; restore plan: to open). Only the wrapped form is stored, with the manifest.
 *
 * Every wrap is AES-256-GCM (Node's OpenSSL) with a fresh 96-bit random nonce and associated data naming exactly what
 * the key is for, so a wrapped key moved to another organization, profile or snapshot does not unwrap.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { LocalKmsConfig } from '@pb/config/env';
import { ApiError, newId } from '@pb/contracts';
import type pg from 'pg';

const BLOB_VERSION = 1;
const IV = 12;
const TAG = 16;

export class KeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KeyError';
  }
}

function aadOf(purpose: string, context: Record<string, string>): Buffer {
  const entries = Object.entries(context).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return Buffer.from(JSON.stringify([purpose, entries]), 'utf8');
}

/** AES-256-GCM: version byte | 12-byte nonce | ciphertext | 16-byte tag. */
export function sealBlob(key: Buffer, plaintext: Buffer, aad: Buffer): Buffer {
  if (key.length !== 32) throw new KeyError('wrapping key must be 32 bytes');
  const iv = randomBytes(IV);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aad);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([Buffer.from([BLOB_VERSION]), iv, ct, cipher.getAuthTag()]);
}

export function openBlob(key: Buffer, blob: Buffer, aad: Buffer): Buffer {
  if (key.length !== 32 || blob.length < 1 + IV + TAG || blob[0] !== BLOB_VERSION) {
    throw new KeyError('malformed wrapped key');
  }
  const iv = blob.subarray(1, 1 + IV);
  const tag = blob.subarray(blob.length - TAG);
  const ct = blob.subarray(1 + IV, blob.length - TAG);
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]);
  } catch {
    throw new KeyError('wrapped key does not authenticate');
  }
}

// ------------------------------------------------------------------ root key provider
export interface RootKeyProvider {
  readonly provider: string;
  activeKeyId(): string;
  wrap(plaintext: Buffer, context: Record<string, string>): Promise<{ keyId: string; blob: Buffer }>;
  unwrap(keyId: string, blob: Buffer, context: Record<string, string>): Promise<Buffer>;
}

/** The `local` provider: root keys from a root-only file on the server (KMS_LOCAL_KEY_FILE). */
export function localKeyProvider(cfg: LocalKmsConfig): RootKeyProvider {
  const keys = new Map(Object.entries(cfg.keys).map(([id, b64]) => [id, Buffer.from(b64, 'base64')]));
  const keyFor = (id: string): Buffer => {
    const k = keys.get(id);
    if (!k) throw new KeyError('root key not available');
    return k;
  };
  return {
    provider: 'local',
    activeKeyId: () => cfg.activeKeyId,
    async wrap(plaintext, context) {
      const keyId = cfg.activeKeyId;
      return { keyId, blob: sealBlob(keyFor(keyId), plaintext, aadOf('pb-root-wrap-v1', context)) };
    },
    async unwrap(keyId, blob, context) {
      return openBlob(keyFor(keyId), blob, aadOf('pb-root-wrap-v1', context));
    },
  };
}

// ------------------------------------------------------------------ organization key versions
export interface OrgKey {
  id: string;
  version: number;
  key: Buffer;
}

interface KeyRow {
  id: string;
  version: number;
  kms_key_id: string;
  wrapped_key: Buffer | null;
  status: string;
}

const orgKeyContext = (orgId: string, row: { id: string; version: number }) => ({
  org_id: orgId,
  key_version_id: row.id,
  version: String(row.version),
});

async function unwrapOrgKey(kms: RootKeyProvider, orgId: string, row: KeyRow): Promise<OrgKey> {
  if (!row.wrapped_key || row.status === 'destroyed') {
    throw new ApiError('SNAPSHOT_UNAVAILABLE', 'The key for this snapshot was destroyed');
  }
  try {
    const key = await kms.unwrap(row.kms_key_id, row.wrapped_key, orgKeyContext(orgId, row));
    return { id: row.id, version: row.version, key };
  } catch {
    // A missing root key or a key that does not authenticate: never fall back, never reveal more.
    throw new ApiError('UNAVAILABLE', 'Snapshot keys are unavailable');
  }
}

/** Inserts a new active version (callers hold the organization's key lock or rely on the one-active index). */
async function insertVersion(
  c: pg.PoolClient,
  kms: RootKeyProvider,
  orgId: string,
  version: number,
): Promise<OrgKey | null> {
  const id = newId('orgKeyVersion');
  const key = randomBytes(32);
  const { keyId, blob } = await kms.wrap(key, orgKeyContext(orgId, { id, version }));
  const res = await c.query(
    `insert into organization_key_versions (id, org_id, version, kms_provider, kms_key_id, wrapped_key, status)
     values ($1, $2, $3, $4, $5, $6, 'active')
     on conflict (org_id) where status = 'active' do nothing`,
    [id, orgId, version, kms.provider, keyId, blob],
  );
  if (res.rowCount === 0) {
    key.fill(0);
    return null;
  }
  return { id, version, key };
}

/** The organization's active key version (created on first use). */
export async function activeOrgKey(c: pg.PoolClient, kms: RootKeyProvider, orgId: string): Promise<OrgKey> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const { rows } = await c.query<KeyRow>(
      `select id, version, kms_key_id, wrapped_key, status from organization_key_versions
        where org_id = $1 and status = 'active'`,
      [orgId],
    );
    const row = rows[0];
    if (row) return unwrapOrgKey(kms, orgId, row);
    const created = await insertVersion(c, kms, orgId, 1);
    if (created) return created;
  }
  throw new ApiError('UNAVAILABLE', 'Snapshot keys are unavailable');
}

export async function orgKeyById(
  c: pg.PoolClient,
  kms: RootKeyProvider,
  orgId: string,
  keyVersionId: string,
): Promise<OrgKey> {
  const { rows } = await c.query<KeyRow>(
    `select id, version, kms_key_id, wrapped_key, status from organization_key_versions
      where org_id = $1 and id = $2`,
    [orgId, keyVersionId],
  );
  const row = rows[0];
  if (!row) throw new ApiError('SNAPSHOT_UNAVAILABLE', 'The key for this snapshot is not available');
  return unwrapOrgKey(kms, orgId, row);
}

/** Retires the active version and creates the next one. Returns the new active version (its key is not returned). */
export async function rotateOrgKey(
  c: pg.PoolClient,
  kms: RootKeyProvider,
  orgId: string,
): Promise<{ retired: string | null; active: { id: string; version: number } }> {
  const { rows } = await c.query<{ id: string; version: number }>(
    `select id, version from organization_key_versions where org_id = $1 and status = 'active' for update`,
    [orgId],
  );
  const current = rows[0];
  const { rows: max } = await c.query<{ v: number }>(
    'select coalesce(max(version), 0)::int as v from organization_key_versions where org_id = $1',
    [orgId],
  );
  if (current) {
    await c.query(
      `update organization_key_versions set status = 'retired', retired_at = now() where org_id = $1 and id = $2`,
      [orgId, current.id],
    );
  }
  const created = await insertVersion(c, kms, orgId, (max[0]?.v ?? 0) + 1);
  if (!created) throw new ApiError('VERSION_CONFLICT', 'The key was rotated by someone else; try again');
  created.key.fill(0);
  return { retired: current?.id ?? null, active: { id: created.id, version: created.version } };
}

// ------------------------------------------------------------------ data keys
export interface DataKeyBinding {
  orgId: string;
  profileId: string;
  snapshotId: string;
  keyVersionId: string;
}

const dataKeyAad = (b: DataKeyBinding) =>
  aadOf('pb-data-key-v1', {
    org_id: b.orgId,
    profile_id: b.profileId,
    snapshot_id: b.snapshotId,
    key_version_id: b.keyVersionId,
  });

export function newDataKey(): Buffer {
  return randomBytes(32);
}

export function wrapDataKey(orgKey: OrgKey, dataKey: Buffer, b: DataKeyBinding): Buffer {
  if (b.keyVersionId !== orgKey.id) throw new KeyError('key version mismatch');
  return sealBlob(orgKey.key, dataKey, dataKeyAad(b));
}

export function unwrapDataKey(orgKey: OrgKey, blob: Buffer, b: DataKeyBinding): Buffer {
  if (b.keyVersionId !== orgKey.id) throw new KeyError('key version mismatch');
  return openBlob(orgKey.key, blob, dataKeyAad(b));
}
