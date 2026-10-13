/**
 * Encrypted snapshots and synchronization (milestone 07, ADR-0014).
 *
 * Upload (device):  init -> PREPARING (seal locally with the returned data key) -> UPLOADING (signed part URLs)
 *                   -> commit -> VERIFYING (worker: size, header, SHA-256, fencing, quota, version CAS) -> COMMITTED.
 * Restore (device): restore plan -> signed download URL + data key -> verify, decrypt and unpack into a fresh folder.
 *
 * Rules:
 *  - Every request re-checks tenant membership, the profile scope and the permission before any object access is
 *    issued; signed URLs name one part or one object of this organization and expire in minutes.
 *  - Uploads and commits need the caller's live lease (fencing token). The new version is accepted only if the
 *    profile's head is still the base version the device started from: concurrent commits give one winner and one
 *    VERSION_CONFLICT, never last-write-wins.
 *  - Data keys are generated here, returned only to the authorized device (init, restore plan) and stored only
 *    wrapped by the organization key. Every unwrap for a restore is audited.
 */
import {
  ApiError,
  newId,
  Page,
  PageQuery,
  PartUrls,
  PartUrlsRequest,
  RestorePlan,
  RestorePlanRequest,
  SNAPSHOT_SCHEMA_VERSION,
  SNAPSHOT_SCHEME,
  Snapshot,
  SnapshotCommit,
  SnapshotInit,
  SnapshotInitResult,
  SyncOperation,
  UploadedParts,
} from '@pb/contracts';
import type pg from 'pg';
import Type from 'typebox';
import { type App, type Deps, principalOf } from '../app.ts';
import { audit, changeEntry } from '../audit.ts';
import { activeOrgKey, newDataKey, orgKeyById, unwrapDataKey, wrapDataKey } from '../backup/keys.ts';
import { normalizeEtag } from '../backup/objects.ts';
import { ts, withTx } from '../db.ts';
import { requestDigest, requireIdempotencyKey } from '../idempotency.ts';
import { hit, LIMITS } from '../ratelimit.ts';
import { profileFor, requirePermission, resolveTenant, type TenantAccess } from '../tenancy.ts';
import { errors, ProfileParams, pageOf, pageWindow, SnapshotParams } from './common.ts';

/** Upload parts: 16 MiB each (S3 needs at least 5 MiB for every part but the last). */
export const PART_SIZE = 16 * 1024 * 1024;
export const MAX_PARTS = 10_000;
/** Signed part and download URLs stay valid this long. */
export const URL_TTL_SECONDS = 900;
/** An upload must be committed within this time, or the worker expires it. */
export const UPLOAD_DEADLINE_HOURS = 24;

const OperationParams = Type.Object(
  {
    orgId: Type.String({ pattern: '^org_[0-9A-HJKMNP-TV-Z]{26}$' }),
    operationId: Type.String({ pattern: '^syn_[0-9A-HJKMNP-TV-Z]{26}$' }),
  },
  { additionalProperties: false },
);

export const SNAPSHOT_COLUMNS = `s.id, s.profile_id, s.status, s.version, s.base_version as parent_version, s.sha256 as digest,
  s.size_bytes::float8 as ciphertext_size, s.plaintext_size::float8 as plaintext_size, s.platform,
  s.browser_revision as browser_version, coalesce(s.schema_version, 1) as schema_version,
  s.encryption_scheme, coalesce(s.key_version_id, s.key_id) as key_version, s.created_by, s.device_id,
  ${ts('s.created_at')} as created_at, ${ts('s.committed_at')} as committed_at`;

const OPERATION_COLUMNS = `o.id, o.profile_id, o.snapshot_id, o.state, o.base_version,
  (select s.version from snapshot_manifests s where s.id = o.snapshot_id) as version, o.error_code,
  ${ts('o.expires_at')} as expires_at, ${ts('o.created_at')} as created_at, ${ts('o.updated_at')} as updated_at`;

interface OpRow {
  id: string;
  profile_id: string;
  snapshot_id: string;
  state: string;
  base_version: number;
  user_id: string;
  device_id: string | null;
  request_digest: string | null;
  object_key: string;
  upload_id: string | null;
  fencing_token: string;
  sealed_key_version: string;
  key_version_id: string;
  wrapped_dek: Buffer;
  sha256: string | null;
  purpose: 'snapshot' | 'recovery';
}

function backupOf(deps: Deps) {
  if (!deps.backup)
    throw new ApiError('STORAGE_UNAVAILABLE', 'Snapshot storage is not configured on this server');
  return deps.backup;
}

const toB64 = (b: Buffer) => b.toString('base64');

/**
 * The caller must hold the profile's live lease with this fencing token (from this device when signed in). A token
 * that is not the current one is refused as FENCING_TOKEN_STALE with how its lease ended (taken_over, revoked,
 * released, superseded), so a device that lost a session stops instead of waiting (milestone 08).
 */
async function requireLease(c: pg.PoolClient, access: TenantAccess, profileId: string, token: string) {
  const lease = await c.query<{
    fencing_token: string;
    holder_user_id: string;
    holder_device_id: string;
    live: boolean;
  }>(
    `select fencing_token::text as fencing_token, holder_user_id, holder_device_id,
            (state = 'active' and expires_at > now()) as live
       from profile_leases where org_id = $1 and profile_id = $2`,
    [access.orgId, profileId],
  );
  const l = lease.rows[0];
  if (l && l.fencing_token !== token) {
    const ended = await c.query<{ end_state: string | null }>(
      `select end_state from lease_history
        where org_id = $1 and profile_id = $2 and fencing_token = $3::bigint`,
      [access.orgId, profileId, /^\d{1,19}$/.test(token) ? token : '0'],
    );
    throw new ApiError('FENCING_TOKEN_STALE', 'This device no longer holds the profile', {
      state: ended.rows[0]?.end_state ?? 'superseded',
    });
  }
  if (!l?.live) throw new ApiError('LEASE_NOT_HELD', 'Acquire the profile lease first');
  if (l.holder_user_id !== access.userId || (access.deviceId && l.holder_device_id !== access.deviceId)) {
    throw new ApiError('LEASE_NOT_HELD', 'The lease is held by another device');
  }
}

async function operationRow(c: pg.PoolClient, access: TenantAccess, snapshotId: string, lock = false) {
  const { rows } = await c.query<OpRow>(
    `select o.id, o.profile_id, o.snapshot_id, o.state, o.base_version, o.user_id, o.device_id, o.request_digest,
            s.object_key, s.upload_id, s.fencing_token::text as fencing_token, s.sealed_key_version,
            s.key_version_id, s.wrapped_dek, s.sha256, s.purpose
       from sync_operations o join snapshot_manifests s on s.id = o.snapshot_id
      where o.org_id = $1 and o.snapshot_id = $2 ${lock ? 'for update of o' : ''}`,
    [access.orgId, snapshotId],
  );
  return rows[0] ?? null;
}

/** The operation of a snapshot, only to the user (and device) that started it; anyone else gets NOT_FOUND. */
async function ownOperation(
  c: pg.PoolClient,
  access: TenantAccess,
  profileId: string,
  snapshotId: string,
  lock = false,
) {
  const op = await operationRow(c, access, snapshotId, lock);
  if (!op || op.profile_id !== profileId || op.user_id !== access.userId) {
    throw new ApiError('NOT_FOUND', 'Upload not found');
  }
  if (access.deviceId && op.device_id && op.device_id !== access.deviceId) {
    throw new ApiError('NOT_FOUND', 'Upload not found');
  }
  return op;
}

async function operationView(c: pg.PoolClient, orgId: string, opId: string): Promise<SyncOperation> {
  const { rows } = await c.query<SyncOperation>(
    `select ${OPERATION_COLUMNS} from sync_operations o where o.org_id = $1 and o.id = $2`,
    [orgId, opId],
  );
  const row = rows[0];
  if (!row) throw new ApiError('INTERNAL', 'Operation vanished');
  return row;
}

async function maxBytesIn(c: pg.PoolClient, orgId: string): Promise<number> {
  const { rows } = await c.query<{ max: number }>(
    'select max_snapshot_bytes::float8 as max from organizations where id = $1',
    [orgId],
  );
  return rows[0]?.max ?? 0;
}

export function snapshotRoutes(app: App, deps: Deps): void {
  // ---------------------------------------------------------------- init
  app.post(
    '/orgs/:orgId/profiles/:profileId/snapshots/init',
    {
      schema: {
        tags: ['snapshots'],
        description:
          'Starts an encrypted snapshot upload. Requires Idempotency-Key and the live lease. Returns a fresh data key ' +
          '(shown once to this device; a replay of the same request returns the same upload) and upload limits.',
        params: ProfileParams,
        body: SnapshotInit,
        response: { 201: SnapshotInitResult, 200: SnapshotInitResult, ...errors },
      },
    },
    async (req, reply) => {
      const access = await resolveTenant(deps.pool, req, req.params.orgId);
      const principal = principalOf(req);
      const backup = backupOf(deps);
      const key = requireIdempotencyKey(req.headers['idempotency-key']);
      const digest = requestDigest({ user: access.userId, profile: req.params.profileId, body: req.body });
      const profileId = req.params.profileId;

      const result = await withTx(deps.pool, access, async (c) => {
        const profile = await profileFor<{ snapshot_version: number }>(
          c,
          access,
          profileId,
          'snapshot.commit',
          'p.snapshot_version',
          true,
        );
        const maxBytes = await maxBytesIn(c, access.orgId);
        // Replays: same key, same request -> the same upload (data key unwrapped again; it is never stored).
        const existing = await c.query<{ request_digest: string; snapshot_id: string }>(
          `select request_digest, snapshot_id from sync_operations where org_id = $1 and idempotency_key = $2`,
          [access.orgId, key],
        );
        const prior = existing.rows[0];
        if (prior) {
          if (prior.request_digest !== digest) {
            throw new ApiError(
              'IDEMPOTENCY_KEY_REUSED',
              'Idempotency-Key was already used for a different request',
            );
          }
          const op = await ownOperation(c, access, profileId, prior.snapshot_id);
          const orgKey = await orgKeyById(c, backup.kms, access.orgId, op.key_version_id);
          try {
            const dataKey = unwrapDataKey(orgKey, op.wrapped_dek, {
              orgId: access.orgId,
              profileId,
              snapshotId: op.snapshot_id,
              keyVersionId: op.key_version_id,
            });
            const b64 = toB64(dataKey);
            dataKey.fill(0);
            return { status: 200, replayed: true, op, dataKey: b64, maxBytes };
          } finally {
            orgKey.key.fill(0);
          }
        }

        const recovery = req.body.recovery === true;
        let recoveryLease: string | null = null;
        if (recovery) {
          // A device that lost its session lease (taken over, revoked) may keep what it had as a recovery copy: it
          // must have held that lease (this person, this device), and the lease must be over.
          const held = await c.query<{ id: string; current: boolean }>(
            `select h.id, coalesce((select l.fencing_token = h.fencing_token and l.state = 'active'
                                      from profile_leases l where l.profile_id = h.profile_id), false) as current
               from lease_history h
              where h.org_id = $1 and h.profile_id = $2 and h.fencing_token = $3::bigint and h.purpose = 'session'
                and h.holder_user_id = $4 and ($5::text is null or h.holder_device_id = $5)`,
            [access.orgId, profileId, req.body.fencing_token, access.userId, principal.deviceId],
          );
          const h = held.rows[0];
          if (!h) throw new ApiError('LEASE_NOT_HELD', 'This device never held that lease');
          if (h.current) {
            throw new ApiError('VALIDATION_FAILED', 'The lease is still yours: upload a normal snapshot');
          }
          recoveryLease = h.id;
        } else {
          await requireLease(c, access, profileId, req.body.fencing_token);
          if (profile.snapshot_version !== req.body.base_version) {
            throw new ApiError('VERSION_CONFLICT', 'A newer snapshot was committed from another device', {
              head_version: profile.snapshot_version,
            });
          }
        }
        const policy = await c.query<{ used: number; quota: number }>(
          `select coalesce((select sum(size_bytes) from snapshot_manifests
                             where org_id = $1 and status in ('committed', 'deleted', 'recovery')
                               and object_deleted_at is null), 0)::float8 as used,
                  backup_quota_bytes::float8 as quota
             from organizations where id = $1`,
          [access.orgId],
        );
        const p = policy.rows[0];
        if (!p) throw new ApiError('NOT_FOUND', 'Organization not found');
        if (p.used >= p.quota) {
          throw new ApiError('QUOTA_EXCEEDED', 'The organization has used its backup storage', {
            used_bytes: p.used,
            quota_bytes: p.quota,
          });
        }

        const snapshotId = newId('snapshot');
        const opId = newId('syncOperation');
        // Storage keys name only the organization (a prefix for whole-organization operations) and the snapshot.
        const objectKey = `orgs/${access.orgId}/${snapshotId}.pbseal`;
        const orgKey = await activeOrgKey(c, backup.kms, access.orgId);
        const dataKey = newDataKey();
        try {
          const wrapped = wrapDataKey(orgKey, dataKey, {
            orgId: access.orgId,
            profileId,
            snapshotId,
            keyVersionId: orgKey.id,
          });
          const uploadId = await backup.objects.createUpload(objectKey);
          await c.query(
            `insert into snapshot_manifests (id, org_id, profile_id, fencing_token, object_key, platform,
               browser_revision, encryption_scheme, key_id, created_by, status, base_version, schema_version,
               key_version_id, sealed_key_version, wrapped_dek, upload_id, part_size, device_id, purpose, lease_id)
             values ($1, $2, $3, $4::bigint, $5, $6, $7, $8, $9, $10, 'pending', $11, $12, $9, $9, $13, $14, $15, $16,
                     $17, $18)`,
            [
              snapshotId,
              access.orgId,
              profileId,
              req.body.fencing_token,
              objectKey,
              req.body.platform,
              req.body.browser_version,
              SNAPSHOT_SCHEME,
              orgKey.id,
              access.userId,
              req.body.base_version,
              SNAPSHOT_SCHEMA_VERSION,
              wrapped,
              uploadId,
              PART_SIZE,
              principal.deviceId,
              recovery ? 'recovery' : 'snapshot',
              recoveryLease,
            ],
          );
          await c.query(
            `insert into sync_operations (id, org_id, profile_id, snapshot_id, idempotency_key, request_digest,
               base_version, state, user_id, device_id, expires_at)
             values ($1, $2, $3, $4, $5, $6, $7, 'uploading', $8, $9, now() + make_interval(hours => $10))`,
            [
              opId,
              access.orgId,
              profileId,
              snapshotId,
              key,
              digest,
              req.body.base_version,
              access.userId,
              principal.deviceId,
              UPLOAD_DEADLINE_HOURS,
            ],
          );
          await audit(
            c,
            changeEntry(access, 'snapshot.upload_started', 'snapshot', snapshotId, {
              profile_id: profileId,
              base_version: req.body.base_version,
              ...(recovery ? { recovery: true, lease_id: recoveryLease } : {}),
            }),
          );
          const op = await ownOperation(c, access, profileId, snapshotId);
          return { status: 201, replayed: false, op, dataKey: toB64(dataKey), maxBytes };
        } finally {
          orgKey.key.fill(0);
          dataKey.fill(0);
        }
      });

      const operation = await withTx(deps.pool, access, (c) => operationView(c, access.orgId, result.op.id));
      return reply
        .status(result.status)
        .header('idempotent-replayed', String(result.replayed))
        .send({
          operation,
          key: {
            scheme: SNAPSHOT_SCHEME,
            schema_version: SNAPSHOT_SCHEMA_VERSION,
            key_version: result.op.sealed_key_version,
            data_key: result.dataKey,
            org_id: access.orgId,
            profile_id: profileId,
            snapshot_id: result.op.snapshot_id,
          },
          upload: { part_size: PART_SIZE, max_parts: MAX_PARTS, max_bytes: result.maxBytes },
        });
    },
  );

  // ---------------------------------------------------------------- parts
  app.post(
    '/orgs/:orgId/profiles/:profileId/snapshots/:snapshotId/parts',
    {
      schema: {
        tags: ['snapshots'],
        description: `Signed URLs (valid ${URL_TTL_SECONDS} s) to upload the named parts of this device's upload. Needs the live lease.`,
        params: SnapshotParams,
        body: PartUrlsRequest,
        response: { 200: PartUrls, ...errors },
      },
    },
    async (req) => {
      const access = await resolveTenant(deps.pool, req, req.params.orgId);
      const backup = backupOf(deps);
      const op = await withTx(deps.pool, access, async (c) => {
        await profileFor(c, access, req.params.profileId, 'snapshot.commit', 'p.id');
        const o = await ownOperation(c, access, req.params.profileId, req.params.snapshotId);
        if (o.state !== 'uploading' || !o.upload_id) {
          throw new ApiError('SYNC_STATE_CONFLICT', 'This upload is no longer accepting parts', {
            state: o.state,
          });
        }
        if (o.purpose !== 'recovery') await requireLease(c, access, req.params.profileId, o.fencing_token);
        return o;
      });
      const expires = new Date(Date.now() + URL_TTL_SECONDS * 1000).toISOString();
      const parts = [];
      for (const n of req.body.part_numbers) {
        parts.push({
          part_number: n,
          url: await backup.objects.partUrl(op.object_key, op.upload_id ?? '', n, URL_TTL_SECONDS),
          expires_at: expires,
        });
      }
      return { parts };
    },
  );

  app.get(
    '/orgs/:orgId/profiles/:profileId/snapshots/:snapshotId/parts',
    {
      schema: {
        tags: ['snapshots'],
        description:
          'Parts the storage already holds for this device’s upload (to resume after an interruption).',
        params: SnapshotParams,
        response: { 200: UploadedParts, ...errors },
      },
    },
    async (req) => {
      const access = await resolveTenant(deps.pool, req, req.params.orgId);
      const backup = backupOf(deps);
      const op = await withTx(deps.pool, access, async (c) => {
        await profileFor(c, access, req.params.profileId, 'snapshot.commit', 'p.id');
        return ownOperation(c, access, req.params.profileId, req.params.snapshotId);
      });
      if (op.state !== 'uploading' || !op.upload_id) return { parts: [] };
      return { parts: await backup.objects.listParts(op.object_key, op.upload_id) };
    },
  );

  // ---------------------------------------------------------------- commit
  app.post(
    '/orgs/:orgId/profiles/:profileId/snapshots/:snapshotId/commit',
    {
      schema: {
        tags: ['snapshots'],
        description:
          'Declares the uploaded object (SHA-256, sizes, parts) and hands it to verification (202). Repeating a ' +
          'commit returns the operation as it is. 409 VERSION_CONFLICT when another device committed first.',
        params: SnapshotParams,
        body: SnapshotCommit,
        response: { 202: SyncOperation, 200: SyncOperation, ...errors },
      },
    },
    async (req, reply) => {
      const access = await resolveTenant(deps.pool, req, req.params.orgId);
      const backup = backupOf(deps);
      const body = req.body;
      const out = await withTx(deps.pool, access, async (c) => {
        const profile = await profileFor<{ snapshot_version: number }>(
          c,
          access,
          req.params.profileId,
          'snapshot.commit',
          'p.snapshot_version',
        );
        const op = await ownOperation(c, access, req.params.profileId, req.params.snapshotId, true);
        if (op.state !== 'uploading') {
          if (op.sha256 && op.sha256 !== body.digest) {
            throw new ApiError('SYNC_STATE_CONFLICT', 'This upload was already committed with other content');
          }
          return { status: 200, op, conflict: null as number | null };
        }
        if (body.fencing_token !== op.fencing_token) {
          throw new ApiError('FENCING_TOKEN_STALE', 'The upload was started under another lease');
        }
        // A recovery copy never becomes the head: no lease and no version check (milestone 08).
        if (op.purpose !== 'recovery') await requireLease(c, access, req.params.profileId, op.fencing_token);
        if (op.purpose !== 'recovery' && profile.snapshot_version !== op.base_version) {
          await c.query(
            `update sync_operations set state = 'failed', error_code = 'VERSION_CONFLICT', updated_at = now()
              where id = $1`,
            [op.id],
          );
          await c.query(
            `update snapshot_manifests set status = 'failed', error_code = 'VERSION_CONFLICT' where id = $1`,
            [op.snapshot_id],
          );
          await audit(c, {
            ...changeEntry(access, 'snapshot.commit', 'snapshot', op.snapshot_id, {
              profile_id: op.profile_id,
              error_code: 'VERSION_CONFLICT',
            }),
            outcome: 'failed',
          });
          return { status: 409, op, conflict: profile.snapshot_version };
        }
        const max = await maxBytesIn(c, access.orgId);
        if (body.ciphertext_size > max) {
          throw new ApiError('SNAPSHOT_TOO_LARGE', 'The snapshot is larger than the organization allows', {
            max_bytes: max,
          });
        }
        // The declared parts must be exactly 1..n, each the agreed size except the last, and match the storage.
        const declared = [...body.parts].sort((a, b) => a.part_number - b.part_number);
        const expectedParts = Math.ceil(body.ciphertext_size / PART_SIZE);
        if (declared.length !== expectedParts || declared.some((p, i) => p.part_number !== i + 1)) {
          throw new ApiError('UPLOAD_INCOMPLETE', 'Parts must be numbered 1..n for the declared size', {
            expected_parts: expectedParts,
          });
        }
        const stored = new Map(
          (await backup.objects.listParts(op.object_key, op.upload_id ?? '')).map((p) => [p.part_number, p]),
        );
        let total = 0;
        for (const [i, p] of declared.entries()) {
          const s = stored.get(p.part_number);
          const last = i === declared.length - 1;
          if (!s || s.etag !== normalizeEtag(p.etag) || (!last && s.size !== PART_SIZE)) {
            throw new ApiError('UPLOAD_INCOMPLETE', 'A part is missing or differs from what was uploaded', {
              part_number: p.part_number,
            });
          }
          total += s.size;
        }
        if (total !== body.ciphertext_size) {
          throw new ApiError('UPLOAD_INCOMPLETE', 'The uploaded size differs from the declared size');
        }
        await backup.objects.completeUpload(op.object_key, op.upload_id ?? '', declared);
        await c.query(
          `update snapshot_manifests set status = 'verifying', sha256 = $2, size_bytes = $3, plaintext_size = $4,
                  upload_id = null
            where id = $1`,
          [op.snapshot_id, body.digest, body.ciphertext_size, body.plaintext_size],
        );
        await c.query(
          `update sync_operations set state = 'verifying', updated_at = now(), locked_until = null where id = $1`,
          [op.id],
        );
        return { status: 202, op, conflict: null as number | null };
      });
      if (out.conflict !== null) {
        // The unused upload is aborted; the device keeps its local copy and decides what to do.
        if (out.op.upload_id) {
          await backup.objects.abortUpload(out.op.object_key, out.op.upload_id).catch(() => undefined);
        }
        throw new ApiError('VERSION_CONFLICT', 'A newer snapshot was committed from another device', {
          head_version: out.conflict,
        });
      }
      const operation = await withTx(deps.pool, access, (c) => operationView(c, access.orgId, out.op.id));
      return reply.status(out.status).send(operation);
    },
  );

  app.post(
    '/orgs/:orgId/profiles/:profileId/snapshots/:snapshotId/cancel',
    {
      schema: {
        tags: ['snapshots'],
        description:
          'Cancels this device’s unfinished upload (the profile keeps its last committed snapshot).',
        params: SnapshotParams,
        response: { 200: SyncOperation, ...errors },
      },
    },
    async (req) => {
      const access = await resolveTenant(deps.pool, req, req.params.orgId);
      const backup = backupOf(deps);
      const op = await withTx(deps.pool, access, async (c) => {
        await profileFor(c, access, req.params.profileId, 'snapshot.commit', 'p.id');
        const o = await ownOperation(c, access, req.params.profileId, req.params.snapshotId, true);
        if (o.state === 'uploading') {
          await c.query(
            `update sync_operations set state = 'canceled', error_code = 'CANCELED', updated_at = now() where id = $1`,
            [o.id],
          );
          await c.query(
            `update snapshot_manifests set status = 'canceled' where id = $1 and status = 'pending'`,
            [o.snapshot_id],
          );
        }
        return o;
      });
      if (op.state === 'uploading' && op.upload_id) {
        await backup.objects.abortUpload(op.object_key, op.upload_id).catch(() => undefined);
      }
      return withTx(deps.pool, access, (c) => operationView(c, access.orgId, op.id));
    },
  );

  app.get(
    '/orgs/:orgId/sync-operations/:operationId',
    {
      schema: {
        tags: ['snapshots'],
        description: 'State of one upload (uploading, verifying, committed, failed, canceled, expired).',
        params: OperationParams,
        response: { 200: SyncOperation, ...errors },
      },
    },
    async (req) => {
      const access = await resolveTenant(deps.pool, req, req.params.orgId);
      return withTx(deps.pool, access, async (c) => {
        const { rows } = await c.query<{ profile_id: string }>(
          'select profile_id from sync_operations where org_id = $1 and id = $2',
          [access.orgId, req.params.operationId],
        );
        const row = rows[0];
        if (!row) throw new ApiError('NOT_FOUND', 'Operation not found');
        await profileFor(c, access, row.profile_id, 'snapshot.read', 'p.id');
        return operationView(c, access.orgId, req.params.operationId);
      });
    },
  );

  // ---------------------------------------------------------------- history
  app.get(
    '/orgs/:orgId/profiles/:profileId/snapshots',
    {
      schema: {
        tags: ['snapshots'],
        description: 'Committed snapshots of one profile (version history), newest first.',
        params: ProfileParams,
        querystring: PageQuery,
        response: { 200: Page(Snapshot), ...errors },
      },
    },
    async (req) => {
      const access = await resolveTenant(deps.pool, req, req.params.orgId);
      const window = pageWindow(req.query);
      const rows = await withTx(deps.pool, access, async (c) => {
        await profileFor(c, access, req.params.profileId, 'snapshot.read', 'p.id');
        const result = await c.query<Snapshot>(
          `select ${SNAPSHOT_COLUMNS} from snapshot_manifests s
            where s.org_id = $1 and s.profile_id = $2 and s.status = 'committed'
              and ($3::timestamptz is null or (s.committed_at, s.id) < ($3::timestamptz, $4::text))
            order by s.committed_at desc, s.id desc limit $5`,
          [
            access.orgId,
            req.params.profileId,
            window.after?.k ?? null,
            window.after?.id ?? '',
            window.limit + 1,
          ],
        );
        return result.rows;
      });
      return pageOf(rows, window, (s) => ({ k: s.committed_at ?? s.created_at, id: s.id }));
    },
  );

  // ---------------------------------------------------------------- restore
  app.post(
    '/orgs/:orgId/profiles/:profileId/restore-plans',
    {
      schema: {
        tags: ['snapshots'],
        description:
          'Authorizes restoring one committed snapshot (default: the newest): a signed download URL and the data ' +
          'key, for this device only. Needs snapshot.restore; every plan is audited.',
        params: ProfileParams,
        body: RestorePlanRequest,
        response: { 200: RestorePlan, ...errors },
      },
    },
    async (req) => {
      const access = await resolveTenant(deps.pool, req, req.params.orgId);
      const backup = backupOf(deps);
      await hit(deps.pool, LIMITS.restorePerUser, access.userId);
      const plan = await withTx(deps.pool, access, async (c) => {
        const profile = await profileFor<{ snapshot_version: number; head_snapshot_id: string | null }>(
          c,
          access,
          req.params.profileId,
          'snapshot.restore',
          'p.snapshot_version, p.head_snapshot_id',
        );
        const snapshotId = req.body.snapshot_id ?? profile.head_snapshot_id;
        if (!snapshotId) throw new ApiError('NOT_FOUND', 'This profile has no snapshot yet');
        const { rows } = await c.query<
          Snapshot & {
            object_key: string;
            key_version_id: string;
            wrapped_dek: Buffer;
            sealed_key_version: string;
          }
        >(
          `select ${SNAPSHOT_COLUMNS}, s.object_key, s.key_version_id, s.wrapped_dek, s.sealed_key_version
             from snapshot_manifests s
            where s.org_id = $1 and s.profile_id = $2 and s.id = $3`,
          [access.orgId, req.params.profileId, snapshotId],
        );
        const row = rows[0];
        if (!row || !['committed', 'deleted', 'recovery'].includes(row.status)) {
          throw new ApiError('NOT_FOUND', 'Snapshot not found');
        }
        // Recovery copies (milestone 08) are restored only by owners and admins, as a separate copy.
        if (row.status === 'recovery') requirePermission(access, 'backups.manage');
        else if (row.status !== 'committed') {
          throw new ApiError('SNAPSHOT_UNAVAILABLE', 'This snapshot was removed by the retention policy');
        }
        const orgKey = await orgKeyById(c, backup.kms, access.orgId, row.key_version_id);
        let dataKey: Buffer;
        try {
          dataKey = unwrapDataKey(orgKey, row.wrapped_dek, {
            orgId: access.orgId,
            profileId: req.params.profileId,
            snapshotId: row.id,
            keyVersionId: row.key_version_id,
          });
        } catch {
          throw new ApiError('SNAPSHOT_UNAVAILABLE', 'The snapshot key does not match its manifest');
        } finally {
          orgKey.key.fill(0);
        }
        await audit(
          c,
          changeEntry(access, 'snapshot.restore_authorized', 'snapshot', row.id, {
            profile_id: req.params.profileId,
            version: row.version,
          }),
        );
        const { object_key, key_version_id: _k, wrapped_dek: _w, sealed_key_version, ...snapshot } = row;
        const b64 = toB64(dataKey);
        dataKey.fill(0);
        return { snapshot, object_key, sealed_key_version, head: profile.snapshot_version, dataKey: b64 };
      });
      return {
        snapshot: plan.snapshot,
        head_version: plan.head,
        download: {
          url: await backup.objects.downloadUrl(plan.object_key, URL_TTL_SECONDS),
          expires_at: new Date(Date.now() + URL_TTL_SECONDS * 1000).toISOString(),
        },
        key: {
          scheme: SNAPSHOT_SCHEME,
          schema_version: plan.snapshot.schema_version,
          key_version: plan.sealed_key_version,
          data_key: plan.dataKey,
          org_id: access.orgId,
          profile_id: req.params.profileId,
          snapshot_id: plan.snapshot.id,
        },
      };
    },
  );
}
