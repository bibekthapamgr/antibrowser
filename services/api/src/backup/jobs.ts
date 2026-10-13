/**
 * Background work for encrypted snapshots (run by the worker; tests call the same functions directly):
 *
 * - verify:   VERIFYING -> COMMITTED | FAILED. The stored object's size, sealed header and SHA-256 must match the
 *             manifest; then, in one transaction: the lease's fencing token must still be the snapshot's, the
 *             organization's quota must hold, and the profile's head moves from base_version to base_version + 1 only
 *             if nobody committed in between (compare-and-set: one winner, never last-write-wins).
 * - expire:   uploads abandoned past their deadline are aborted.
 * - erase:    objects of failed/canceled/expired uploads, and of deleted snapshots after their grace period.
 * - retention, trash purge, key re-wrapping and destruction, and an orphan sweep for objects nothing refers to.
 *
 * Discovery across organizations goes through fixed-body database functions; every change runs in a transaction
 * scoped to one organization, so row-level security applies to the worker too.
 */
import { createHash } from 'node:crypto';
import { ApiError, newId, SNAPSHOT_SCHEME } from '@pb/contracts';
import type pg from 'pg';
import { audit } from '../audit.ts';
import { appendEvent } from '../outbox.ts';
import { activeOrgKey, orgKeyById, type RootKeyProvider, unwrapDataKey, wrapDataKey } from './keys.ts';
import type { ObjectStore } from './objects.ts';
import { parseSealedHeader, SEAL_CHUNK, SEAL_MAX_HEADER } from './sealed.ts';

export interface JobDeps {
  pool: pg.Pool;
  objects: ObjectStore;
  kms: RootKeyProvider;
  log?: (level: 'info' | 'warn' | 'error', msg: string, extra?: Record<string, unknown>) => void;
}

export const VERIFY_LOCK_SECONDS = 300;
export const MAX_VERIFY_ATTEMPTS = 8;
/** A retired key version with nothing left to unwrap is destroyed this long after it became unused. */
export const KEY_DESTROY_DELAY_DAYS = 30;
/** Objects older than this that no manifest names are deleted by the orphan sweep. */
export const ORPHAN_GRACE_HOURS = 24;

/** Error class and code only (database and storage messages can carry values; they are not logged). */
export function errorInfo(err: unknown): { error: string; code?: string } {
  const e = err as { name?: string; code?: string };
  return { error: e?.name ?? 'Error', ...(typeof e?.code === 'string' ? { code: e.code } : {}) };
}

async function inOrg<T>(pool: pg.Pool, orgId: string, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('begin');
    await c.query("select set_config('app.org_id', $1, true), set_config('app.user_id', '', true)", [orgId]);
    const out = await fn(c);
    await c.query('commit');
    return out;
  } catch (err) {
    await c.query('rollback').catch(() => undefined);
    throw err;
  } finally {
    c.release();
  }
}

const systemAudit = (orgId: string, action: string, targetType: string, targetId: string, details = {}) => ({
  orgId,
  actorUserId: null,
  actorDeviceId: null,
  action,
  targetType,
  targetId,
  outcome: 'success' as const,
  requestId: newId('request'),
  details,
});

// ------------------------------------------------------------------ verification
interface VerifyRow {
  id: string;
  state: string;
  base_version: number;
  attempts: number;
  user_id: string;
  device_id: string | null;
  profile_id: string;
  snapshot_id: string;
  object_key: string;
  sha256: string | null;
  size_bytes: number | null;
  fencing_token: string;
  sealed_key_version: string;
  schema_version: number;
  purpose: 'snapshot' | 'recovery';
}

export interface SyncWorkResult {
  committed: number;
  failed: number;
  expired: number;
  retried: number;
}

export async function processSyncWork(d: JobDeps, limit = 10): Promise<SyncWorkResult> {
  const result: SyncWorkResult = { committed: 0, failed: 0, expired: 0, retried: 0 };
  const { rows } = await d.pool.query<{ operation_id: string; org_id: string; state: string }>(
    'select operation_id, org_id, state from app.claim_sync_work($1, $2)',
    [limit, VERIFY_LOCK_SECONDS],
  );
  for (const r of rows) {
    try {
      if (r.state === 'verifying') {
        const outcome = await verifyOne(d, r.operation_id, r.org_id);
        result[outcome === 'committed' ? 'committed' : outcome === 'failed' ? 'failed' : 'retried']++;
      } else {
        await expireOne(d, r.operation_id, r.org_id);
        result.expired++;
      }
    } catch (err) {
      result.retried++;
      d.log?.('error', 'sync work failed', { operation_id: r.operation_id, ...errorInfo(err) });
    }
  }
  return result;
}

async function loadOperation(c: pg.PoolClient, opId: string, lock = false): Promise<VerifyRow | null> {
  const { rows } = await c.query<VerifyRow>(
    `select o.id, o.state, o.base_version, o.attempts, o.user_id, o.device_id, o.profile_id, s.id as snapshot_id,
            s.object_key, s.sha256, s.size_bytes::float8 as size_bytes, s.fencing_token::text as fencing_token,
            s.sealed_key_version, s.schema_version, s.purpose
       from sync_operations o join snapshot_manifests s on s.id = o.snapshot_id
      where o.id = $1 ${lock ? 'for update of o' : ''}`,
    [opId],
  );
  return rows[0] ?? null;
}

async function failOperation(c: pg.PoolClient, orgId: string, row: VerifyRow, code: string): Promise<void> {
  await c.query(
    `update snapshot_manifests set status = 'failed', error_code = $2 where id = $1 and status in ('pending', 'verifying')`,
    [row.snapshot_id, code],
  );
  await c.query(
    `update sync_operations set state = 'failed', error_code = $2, locked_until = null, updated_at = now()
      where id = $1`,
    [row.id, code],
  );
  await appendEvent(c, {
    orgId,
    actorId: row.user_id,
    aggregateId: row.snapshot_id,
    aggregateVersion: 1,
    eventType: 'snapshot.commit_failed',
    payload: { profile_id: row.profile_id, error_code: code },
  });
  await audit(c, {
    ...systemAudit(orgId, 'snapshot.commit', 'snapshot', row.snapshot_id, {
      profile_id: row.profile_id,
      error_code: code,
    }),
    actorUserId: row.user_id,
    actorDeviceId: row.device_id,
    outcome: 'failed',
  });
}

async function streamDigest(objects: ObjectStore, key: string): Promise<{ digest: string; bytes: number }> {
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of await objects.read(key)) {
    const b = chunk as Buffer;
    hash.update(b);
    bytes += b.length;
  }
  return { digest: hash.digest('hex'), bytes };
}

async function verifyOne(d: JobDeps, opId: string, orgId: string): Promise<'committed' | 'failed' | 'retry'> {
  const row = await inOrg(d.pool, orgId, (c) => loadOperation(c, opId));
  if (row?.state !== 'verifying' || !row.sha256 || !row.size_bytes) return 'retry';

  let failure: string | null = null;
  try {
    const head = await d.objects.head(row.object_key);
    if (!head) failure = 'OBJECT_MISSING';
    else if (head.size !== row.size_bytes) failure = 'SIZE_MISMATCH';
    else {
      const prefix = await d.objects.readRange(
        row.object_key,
        0,
        Math.min(row.size_bytes, 12 + SEAL_MAX_HEADER) - 1,
      );
      const h = parseSealedHeader(prefix);
      if (
        !h ||
        h.scheme !== SNAPSHOT_SCHEME ||
        h.kind !== 'org-snapshot' ||
        h.org_id !== orgId ||
        h.profile_id !== row.profile_id ||
        h.object_id !== row.snapshot_id ||
        h.schema_version !== row.schema_version ||
        h.key_version !== row.sealed_key_version ||
        h.chunk_size !== SEAL_CHUNK
      ) {
        failure = 'HEADER_MISMATCH';
      } else {
        const { digest, bytes } = await streamDigest(d.objects, row.object_key);
        if (bytes !== row.size_bytes) failure = 'SIZE_MISMATCH';
        else if (digest !== row.sha256) failure = 'DIGEST_MISMATCH';
      }
    }
  } catch (err) {
    if (row.attempts < MAX_VERIFY_ATTEMPTS) {
      d.log?.('warn', 'snapshot verification will be retried', {
        operation_id: opId,
        error: err instanceof ApiError ? err.code : (err as Error).name,
      });
      return 'retry';
    }
    failure = 'STORAGE_UNAVAILABLE';
  }

  return inOrg(d.pool, orgId, async (c) => {
    const current = await loadOperation(c, opId, true);
    if (current?.state !== 'verifying') return 'failed';
    if (failure) {
      await failOperation(c, orgId, current, failure);
      return 'failed';
    }
    if (current.purpose === 'recovery') return keepRecovery(c, orgId, current);
    const lease = await c.query<{ fencing_token: string }>(
      'select fencing_token::text as fencing_token from profile_leases where org_id = $1 and profile_id = $2',
      [orgId, current.profile_id],
    );
    if (lease.rows[0]?.fencing_token !== current.fencing_token) {
      await failOperation(c, orgId, current, 'FENCING_TOKEN_STALE');
      return 'failed';
    }
    const usage = await c.query<{ used: number; quota: number | null }>(
      `select coalesce((select sum(size_bytes) from snapshot_manifests
                         where org_id = $1 and status in ('committed', 'deleted', 'recovery')
                           and object_deleted_at is null), 0)::float8
                as used,
              app.org_backup_quota($1)::float8 as quota`,
      [orgId],
    );
    const u = usage.rows[0];
    if (!u || u.quota === null || u.used + (current.size_bytes ?? 0) > u.quota) {
      await failOperation(c, orgId, current, 'QUOTA_EXCEEDED');
      return 'failed';
    }
    const version = current.base_version + 1;
    const moved = await c.query(
      `update profiles set snapshot_version = $3, head_snapshot_id = $4, last_snapshot_at = now()
        where org_id = $1 and id = $2 and snapshot_version = $5 and deleted_at is null`,
      [orgId, current.profile_id, version, current.snapshot_id, current.base_version],
    );
    if (moved.rowCount !== 1) {
      await failOperation(c, orgId, current, 'VERSION_CONFLICT');
      return 'failed';
    }
    await c.query(
      `update snapshot_manifests set status = 'committed', version = $2, committed_at = now(), error_code = null
        where id = $1`,
      [current.snapshot_id, version],
    );
    await c.query(
      `update sync_operations set state = 'committed', error_code = null, locked_until = null, updated_at = now()
        where id = $1`,
      [opId],
    );
    await appendEvent(c, {
      orgId,
      actorId: current.user_id,
      aggregateId: current.snapshot_id,
      aggregateVersion: version,
      eventType: 'snapshot.committed',
      payload: { profile_id: current.profile_id, version, ciphertext_size: current.size_bytes },
    });
    await audit(c, {
      ...systemAudit(orgId, 'snapshot.committed', 'snapshot', current.snapshot_id, {
        profile_id: current.profile_id,
        version,
      }),
      actorUserId: current.user_id,
      actorDeviceId: current.device_id,
    });
    return 'committed';
  });
}

/**
 * Milestone 08: an upload from a device that lost its session lease is kept as a recovery copy once verified (the
 * same size, header and SHA-256 checks): never the head, no version, restorable as a copy by admins.
 */
async function keepRecovery(
  c: pg.PoolClient,
  orgId: string,
  current: VerifyRow,
): Promise<'committed' | 'failed'> {
  const usage = await c.query<{ used: number; quota: number | null }>(
    `select coalesce((select sum(size_bytes) from snapshot_manifests
                       where org_id = $1 and status in ('committed', 'deleted', 'recovery')
                         and object_deleted_at is null), 0)::float8 as used,
            app.org_backup_quota($1)::float8 as quota`,
    [orgId],
  );
  const u = usage.rows[0];
  if (!u || u.quota === null || u.used + (current.size_bytes ?? 0) > u.quota) {
    await failOperation(c, orgId, current, 'QUOTA_EXCEEDED');
    return 'failed';
  }
  await c.query(
    `update snapshot_manifests set status = 'recovery', committed_at = now(), error_code = null where id = $1`,
    [current.snapshot_id],
  );
  await c.query(
    `update sync_operations set state = 'kept', error_code = null, locked_until = null, updated_at = now()
      where id = $1`,
    [current.id],
  );
  await appendEvent(c, {
    orgId,
    actorId: current.user_id,
    aggregateId: current.snapshot_id,
    aggregateVersion: 1,
    eventType: 'snapshot.recovery_kept',
    payload: { profile_id: current.profile_id, ciphertext_size: current.size_bytes },
  });
  await audit(c, {
    ...systemAudit(orgId, 'snapshot.recovery_kept', 'snapshot', current.snapshot_id, {
      profile_id: current.profile_id,
    }),
    actorUserId: current.user_id,
    actorDeviceId: current.device_id,
  });
  return 'committed';
}

/** Recovery copies past the organization's trash period are marked deleted (then erased like any snapshot). */
export async function expireRecoveryCopies(d: JobDeps, limit = 500): Promise<number> {
  const { rows } = await d.pool.query<{ n: number }>('select app.expire_recovery_copies($1) as n', [limit]);
  return rows[0]?.n ?? 0;
}

async function expireOne(d: JobDeps, opId: string, orgId: string): Promise<void> {
  const row = await inOrg(d.pool, orgId, (c) =>
    c.query<{ object_key: string; upload_id: string | null; snapshot_id: string; state: string }>(
      `select s.object_key, s.upload_id, s.id as snapshot_id, o.state
         from sync_operations o join snapshot_manifests s on s.id = o.snapshot_id where o.id = $1`,
      [opId],
    ),
  );
  const r = row.rows[0];
  if (r?.state !== 'uploading') return;
  if (r.upload_id) await d.objects.abortUpload(r.object_key, r.upload_id);
  await inOrg(d.pool, orgId, async (c) => {
    await c.query(
      `update snapshot_manifests set status = 'expired', error_code = 'UPLOAD_EXPIRED' where id = $1 and status = 'pending'`,
      [r.snapshot_id],
    );
    await c.query(
      `update sync_operations set state = 'expired', error_code = 'UPLOAD_EXPIRED', locked_until = null,
              updated_at = now()
        where id = $1 and state = 'uploading'`,
      [opId],
    );
  });
}

// ------------------------------------------------------------------ erasing stored objects
export async function eraseObjects(d: JobDeps, limit = 100): Promise<number> {
  const { rows } = await d.pool.query<{ org_id: string; snapshot_id: string }>(
    'select org_id, snapshot_id from app.snapshot_objects_to_erase($1)',
    [limit],
  );
  let erased = 0;
  for (const r of rows) {
    const m = await inOrg(d.pool, r.org_id, (c) =>
      c.query<{ object_key: string; upload_id: string | null }>(
        'select object_key, upload_id from snapshot_manifests where id = $1',
        [r.snapshot_id],
      ),
    );
    const row = m.rows[0];
    if (!row) continue;
    if (row.upload_id) await d.objects.abortUpload(row.object_key, row.upload_id);
    await d.objects.remove(row.object_key);
    await inOrg(d.pool, r.org_id, (c) =>
      c.query('update snapshot_manifests set object_deleted_at = now() where id = $1', [r.snapshot_id]),
    );
    erased++;
  }
  return erased;
}

// ------------------------------------------------------------------ retention and trash
export async function applyRetention(d: JobDeps, limit = 500): Promise<number> {
  const { rows } = await d.pool.query<{ n: number }>('select app.apply_snapshot_retention($1) as n', [limit]);
  return rows[0]?.n ?? 0;
}

/** Profiles past their trash period: their snapshots are erased, then the profile is deleted for good. */
export async function purgeTrash(d: JobDeps, limit = 20): Promise<number> {
  const { rows } = await d.pool.query<{ org_id: string; profile_id: string }>(
    'select org_id, profile_id from app.profiles_to_purge($1)',
    [limit],
  );
  let purged = 0;
  for (const r of rows) {
    const objects = await inOrg(d.pool, r.org_id, async (c) => {
      await c.query(
        `update sync_operations set state = 'canceled', error_code = 'PROFILE_PURGED', updated_at = now()
          where org_id = $1 and profile_id = $2 and state in ('uploading', 'verifying')`,
        [r.org_id, r.profile_id],
      );
      await c.query(
        `update snapshot_manifests
            set status = case when status in ('committed', 'deleted', 'recovery') then 'deleted' else 'canceled' end,
                deleted_at = coalesce(deleted_at, now()), purge_after = now()
          where org_id = $1 and profile_id = $2
            and status in ('pending', 'verifying', 'committed', 'deleted', 'recovery')`,
        [r.org_id, r.profile_id],
      );
      const res = await c.query<{ object_key: string; upload_id: string | null }>(
        `select object_key, upload_id from snapshot_manifests
          where org_id = $1 and profile_id = $2 and object_deleted_at is null and status <> 'legacy'`,
        [r.org_id, r.profile_id],
      );
      return res.rows;
    });
    for (const o of objects) {
      if (o.upload_id) await d.objects.abortUpload(o.object_key, o.upload_id);
      await d.objects.remove(o.object_key);
    }
    await inOrg(d.pool, r.org_id, async (c) => {
      const p = await c.query<{ created_by: string }>(
        'select created_by from profiles where org_id = $1 and id = $2 and deleted_at is not null',
        [r.org_id, r.profile_id],
      );
      const owner = p.rows[0]?.created_by;
      if (!owner) return;
      await c.query('delete from profiles where org_id = $1 and id = $2', [r.org_id, r.profile_id]);
      await appendEvent(c, {
        orgId: r.org_id,
        actorId: owner,
        aggregateId: r.profile_id,
        aggregateVersion: 1,
        eventType: 'profile.purged',
        payload: { snapshots_erased: objects.length },
      });
      await audit(
        c,
        systemAudit(r.org_id, 'profile.purged', 'profile', r.profile_id, {
          snapshots_erased: objects.length,
        }),
      );
    });
    purged++;
  }
  return purged;
}

// ------------------------------------------------------------------ keys
/**
 * Per organization: re-wraps organization key versions held by an old root key; re-wraps data keys still wrapped by
 * a retired version to the active one (no re-upload); schedules unused retired versions for destruction and destroys
 * them after KEY_DESTROY_DELAY_DAYS (the wrapped key is erased: anything still under it becomes unrecoverable).
 */
export async function maintainKeys(
  d: JobDeps,
  batch = 200,
): Promise<{ rewrapped: number; destroyed: number }> {
  const out = { rewrapped: 0, destroyed: 0 };
  const { rows } = await d.pool.query<{ org_id: string }>(
    'select org_id from app.orgs_with_key_work($1, 100)',
    [d.kms.activeKeyId()],
  );
  for (const { org_id: orgId } of rows) {
    try {
      const r = await inOrg(d.pool, orgId, (c) => maintainOrgKeys(c, d, orgId, batch));
      out.rewrapped += r.rewrapped;
      out.destroyed += r.destroyed;
    } catch (err) {
      d.log?.('error', 'key maintenance failed', { org_id: orgId, error: (err as Error).name });
    }
  }
  return out;
}

async function maintainOrgKeys(
  c: pg.PoolClient,
  d: JobDeps,
  orgId: string,
  batch: number,
): Promise<{ rewrapped: number; destroyed: number }> {
  let rewrapped = 0;
  let destroyed = 0;
  // 1. Organization key versions still held by an older root key.
  const old = await c.query<{ id: string; version: number; kms_key_id: string; wrapped_key: Buffer }>(
    `select id, version, kms_key_id, wrapped_key from organization_key_versions
      where org_id = $1 and status <> 'destroyed' and kms_key_id <> $2 for update`,
    [orgId, d.kms.activeKeyId()],
  );
  for (const k of old.rows) {
    const context = { org_id: orgId, key_version_id: k.id, version: String(k.version) };
    const plain = await d.kms.unwrap(k.kms_key_id, k.wrapped_key, context);
    const { keyId, blob } = await d.kms.wrap(plain, context);
    plain.fill(0);
    await c.query('update organization_key_versions set kms_key_id = $3, wrapped_key = $2 where id = $1', [
      k.id,
      blob,
      keyId,
    ]);
    await audit(c, systemAudit(orgId, 'org_key.root_rewrapped', 'org_key', k.id, { root_key: keyId }));
  }
  // 2. Data keys wrapped by retired versions.
  const retired = await c.query<{ id: string; destroy_after: Date | null }>(
    `select id, destroy_after from organization_key_versions where org_id = $1 and status = 'retired'`,
    [orgId],
  );
  if (retired.rows.length === 0) return { rewrapped, destroyed };
  const active = await activeOrgKey(c, d.kms, orgId);
  try {
    for (const version of retired.rows) {
      const manifests = await c.query<{ id: string; profile_id: string; wrapped_dek: Buffer }>(
        `select id, profile_id, wrapped_dek from snapshot_manifests
          where org_id = $1 and key_version_id = $2 and wrapped_dek is not null and object_deleted_at is null
          limit $3 for update`,
        [orgId, version.id, batch],
      );
      if (manifests.rows.length > 0) {
        const oldKey = await orgKeyById(c, d.kms, orgId, version.id);
        try {
          for (const m of manifests.rows) {
            const binding = { orgId, profileId: m.profile_id, snapshotId: m.id };
            const dek = unwrapDataKey(oldKey, m.wrapped_dek, { ...binding, keyVersionId: version.id });
            const wrapped = wrapDataKey(active, dek, { ...binding, keyVersionId: active.id });
            dek.fill(0);
            await c.query(
              'update snapshot_manifests set wrapped_dek = $2, key_version_id = $3, key_id = $3 where id = $1',
              [m.id, wrapped, active.id],
            );
            rewrapped++;
          }
        } finally {
          oldKey.key.fill(0);
        }
        continue; // more may remain: the next run continues
      }
      if (!version.destroy_after) {
        await c.query(
          `update organization_key_versions set destroy_after = now() + make_interval(days => $2) where id = $1`,
          [version.id, KEY_DESTROY_DELAY_DAYS],
        );
        await audit(
          c,
          systemAudit(orgId, 'org_key.destruction_scheduled', 'org_key', version.id, {
            delay_days: KEY_DESTROY_DELAY_DAYS,
          }),
        );
      } else if (version.destroy_after.getTime() < Date.now()) {
        await c.query(
          `update organization_key_versions set status = 'destroyed', wrapped_key = null, destroyed_at = now()
            where id = $1 and status = 'retired'`,
          [version.id],
        );
        await audit(c, systemAudit(orgId, 'org_key.destroyed', 'org_key', version.id));
        destroyed++;
      }
    }
  } finally {
    active.key.fill(0);
  }
  return { rewrapped, destroyed };
}

// ------------------------------------------------------------------ orphans
/** Deletes stored objects under orgs/ that no manifest names and that are older than ORPHAN_GRACE_HOURS. */
export async function sweepOrphans(d: JobDeps, maxObjects = 2000): Promise<number> {
  let deleted = 0;
  let seen = 0;
  let after: string | null = null;
  const cutoff = Date.now() - ORPHAN_GRACE_HOURS * 3600_000;
  do {
    const page = await d.objects.list('orgs/', after);
    for (const o of page.objects) {
      seen++;
      if (o.lastModified.getTime() > cutoff) continue;
      const known = await d.pool.query<{ known: boolean }>('select app.snapshot_object_known($1) as known', [
        o.key,
      ]);
      if (!known.rows[0]?.known) {
        await d.objects.remove(o.key);
        deleted++;
      }
    }
    after = page.next;
  } while (after && seen < maxObjects);
  return deleted;
}
