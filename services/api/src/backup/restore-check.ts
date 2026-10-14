/**
 * Restore verification (milestone 12, ADR-0019): run against a database restored from backups into an isolated
 * cluster, with the snapshot objects restored from the off-site copy. For two organizations it proves that the
 * restored rows, objects and keys still belong together, and that neither organization can reach the other's:
 *
 *   row ↔ object  the newest committed snapshot's object exists, with the size and SHA-256 its row records, and its
 *                 sealed header names the same organization, profile, snapshot and key version;
 *   row ↔ key     the organization key version unwraps with the root key, and unwraps that snapshot's data key under
 *                 the snapshot's own binding;
 *   no crossing   the other organization's key cannot unwrap the data key, an organization key cannot be unwrapped
 *                 in the other organization's context, and row-level security shows the app role only its own rows.
 *
 * It never decrypts a profile and never prints keys.
 */
import { createHash } from 'node:crypto';
import type pg from 'pg';
import { orgKeyById, type RootKeyProvider, unwrapDataKey } from './keys.ts';
import { parseSealedHeader, SEAL_MAX_HEADER } from './sealed.ts';

export interface RestoreCheckOptions {
  /** A connection as the schema owner (reads every organization; row-level security does not apply). */
  owner: pg.ClientBase;
  /** A connection as the application role (row-level security applies). */
  app: pg.ClientBase;
  kms: RootKeyProvider;
  /** The restored object, or null when it is missing. */
  readObject(key: string): Promise<Buffer | null>;
  /** Organizations to check (default: the two with the most recent committed snapshots). */
  orgs?: string[] | undefined;
}

export interface TenantResult {
  org_id: string;
  snapshot_id: string;
  object: 'ok' | string;
  key: 'ok' | string;
}

export interface RestoreCheckReport {
  ok: boolean;
  tenants: TenantResult[];
  isolation: { name: string; ok: boolean }[];
}

interface SnapshotRow {
  id: string;
  org_id: string;
  profile_id: string;
  object_key: string;
  sha256: string;
  size_bytes: string;
  key_version_id: string;
  sealed_key_version: string;
  wrapped_dek: Buffer;
}

export async function newestSnapshots(owner: pg.ClientBase, orgs?: string[]): Promise<SnapshotRow[]> {
  const { rows } = await owner.query<SnapshotRow>(
    `select distinct on (org_id) id, org_id, profile_id, object_key, sha256, size_bytes::text, key_version_id,
            sealed_key_version, wrapped_dek
       from app.snapshot_manifests
      where status = 'committed' and wrapped_dek is not null and ($1::text[] is null or org_id = any($1))
      order by org_id, committed_at desc, id desc`,
    [orgs ?? null],
  );
  return rows.sort((a, b) => (a.org_id < b.org_id ? -1 : 1)).slice(0, orgs ? orgs.length : rows.length);
}

const fails = async (f: () => Promise<unknown> | unknown): Promise<boolean> => {
  try {
    await f();
    return false;
  } catch {
    return true;
  }
};

export async function checkRestore(opts: RestoreCheckOptions): Promise<RestoreCheckReport> {
  let snaps = await newestSnapshots(opts.owner, opts.orgs);
  if (!opts.orgs) snaps = snaps.slice(0, 2);
  if (snaps.length < 2) {
    throw new Error(
      `the restore check needs committed snapshots of two organizations (found ${snaps.length}); ` +
        'make them first (the drill runs scripts/snapshot-smoke.ts for both fixture tenants)',
    );
  }
  const tenants: TenantResult[] = [];
  const keys = new Map<string, Awaited<ReturnType<typeof orgKeyById>>>();
  for (const s of snaps) {
    const result: TenantResult = { org_id: s.org_id, snapshot_id: s.id, object: 'ok', key: 'ok' };
    const bytes = await opts.readObject(s.object_key);
    if (!bytes) result.object = 'missing from the restored objects';
    else if (String(bytes.length) !== s.size_bytes)
      result.object = `size ${bytes.length}, row ${s.size_bytes}`;
    else if (createHash('sha256').update(bytes).digest('hex') !== s.sha256) result.object = 'SHA-256 differs';
    else {
      const h = parseSealedHeader(bytes.subarray(0, 12 + SEAL_MAX_HEADER));
      if (!h) result.object = 'not a sealed snapshot';
      else if (h.org_id !== s.org_id || h.profile_id !== s.profile_id || h.object_id !== s.id)
        result.object = 'the header names another organization, profile or snapshot';
      else if (h.key_version !== s.sealed_key_version) result.object = 'the header names another key version';
    }
    try {
      const orgKey = await orgKeyById(opts.owner as pg.PoolClient, opts.kms, s.org_id, s.key_version_id);
      keys.set(s.org_id, orgKey);
      const dek = unwrapDataKey(orgKey, s.wrapped_dek, {
        orgId: s.org_id,
        profileId: s.profile_id,
        snapshotId: s.id,
        keyVersionId: s.key_version_id,
      });
      if (dek.length !== 32) result.key = 'the data key has the wrong length';
      dek.fill(0);
    } catch (e) {
      result.key = `the keys do not unwrap (${e instanceof Error ? e.message : 'error'})`;
    }
    tenants.push(result);
  }

  const [a, b] = snaps as [SnapshotRow, SnapshotRow];
  const keyA = keys.get(a.org_id);
  const keyB = keys.get(b.org_id);
  const isolation: { name: string; ok: boolean }[] = [];
  isolation.push({
    name: `${b.org_id}'s key cannot unwrap ${a.org_id}'s data key`,
    ok:
      !!keyB &&
      (await fails(() =>
        unwrapDataKey(keyB, a.wrapped_dek, {
          orgId: a.org_id,
          profileId: a.profile_id,
          snapshotId: a.id,
          keyVersionId: keyB.id,
        }),
      )),
  });
  isolation.push({
    name: `${a.org_id}'s key cannot unwrap ${b.org_id}'s data key`,
    ok:
      !!keyA &&
      (await fails(() =>
        unwrapDataKey(keyA, b.wrapped_dek, {
          orgId: b.org_id,
          profileId: b.profile_id,
          snapshotId: b.id,
          keyVersionId: keyA.id,
        }),
      )),
  });
  const { rows: krow } = await opts.owner.query<{ kms_key_id: string; wrapped_key: Buffer; version: number }>(
    'select kms_key_id, wrapped_key, version from app.organization_key_versions where org_id = $1 and id = $2',
    [a.org_id, a.key_version_id],
  );
  const ka = krow[0];
  isolation.push({
    name: `${a.org_id}'s organization key does not unwrap in ${b.org_id}'s context`,
    ok:
      !!ka &&
      (await fails(() =>
        opts.kms.unwrap(ka.kms_key_id, ka.wrapped_key, {
          org_id: b.org_id,
          key_version_id: a.key_version_id,
          version: String(ka.version),
        }),
      )),
  });
  const visible = async (asOrg: string, snapshot: string) => {
    await opts.app.query('begin');
    try {
      await opts.app.query("select set_config('app.org_id', $1, true)", [asOrg]);
      const { rows } = await opts.app.query<{ n: number }>(
        'select count(*)::int as n from app.snapshot_manifests where id = $1',
        [snapshot],
      );
      return rows[0]?.n ?? 0;
    } finally {
      await opts.app.query('rollback');
    }
  };
  isolation.push({
    name: `row-level security: ${b.org_id} sees none of ${a.org_id}'s snapshot rows, ${a.org_id} sees its own`,
    ok: (await visible(b.org_id, a.id)) === 0 && (await visible(a.org_id, a.id)) === 1,
  });
  isolation.push({
    name: `row-level security: ${a.org_id} sees none of ${b.org_id}'s snapshot rows`,
    ok: (await visible(a.org_id, b.id)) === 0 && (await visible(b.org_id, b.id)) === 1,
  });
  for (const k of keys.values()) k.key.fill(0);
  const ok = tenants.every((t) => t.object === 'ok' && t.key === 'ok') && isolation.every((i) => i.ok);
  return { ok, tenants, isolation };
}
