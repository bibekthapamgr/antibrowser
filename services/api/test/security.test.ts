/**
 * Milestone 12 (ADR-0019): restore verification (row ↔ object ↔ key linkage for two tenants, no crossing), the
 * append-only hash-chained platform audit and its export, and the recovery markers no application role can reach.
 */
import { randomBytes } from 'node:crypto';
import { copyFileSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newId } from '@pb/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../scripts/migrate.ts';
import { auditHead, exportAudit, verifyChain, verifyWholeChain } from '../src/audit-chain.ts';
import { localKeyProvider, type RootKeyProvider } from '../src/backup/keys.ts';
import { checkRestore } from '../src/backup/restore-check.ts';
import { FIXTURES } from '../src/fixtures.ts';
import { type Harness, harness } from './helpers.ts';
import { backup } from './sync-helpers.ts';

const { acme, beta } = FIXTURES.orgs;
let h: Harness;

beforeAll(async () => {
  h = await harness();
});
afterAll(async () => {
  await h.close();
});

async function profileIn(org: string, headers: Record<string, string>, client?: string): Promise<string> {
  const res = await h.app.inject({
    method: 'POST',
    url: `/v1/orgs/${org}/profiles`,
    headers,
    payload: {
      name: `restore-check-${randomBytes(3).toString('hex')}`,
      ...(client ? { client_id: client } : {}),
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().id;
}

describe('restore verification (two tenants)', () => {
  it('links rows, objects and keys per tenant, and neither tenant reaches the other', async () => {
    const acmeOwner = await h.auth('acmeOwner');
    const betaOwner = await h.auth('betaOwner');
    const pa = await profileIn(acme.id, acmeOwner, FIXTURES.clients.acmeNorth.id);
    const pb = await profileIn(beta.id, betaOwner);
    await backup(h, {
      headers: acmeOwner,
      org: acme.id,
      profile: pa,
      device: FIXTURES.devices.acmeOwnerLaptop.id,
      base: 0,
    });
    await backup(h, {
      headers: betaOwner,
      org: beta.id,
      profile: pb,
      device: FIXTURES.devices.betaOwnerLaptop.id,
      base: 0,
    });
    const memory = h.memory;
    if (!memory) throw new Error('in-memory store expected');
    const owner = await h.owner.connect();
    const app = await h.pool.connect();
    try {
      const objects = new Map([...memory.objects].map(([k, v]) => [k, v.bytes]));
      const run = (over: Partial<Parameters<typeof checkRestore>[0]> = {}) =>
        checkRestore({
          owner,
          app,
          kms: h.kms,
          orgs: [acme.id, beta.id],
          readObject: async (k) => objects.get(k) ?? null,
          ...over,
        });
      const good = await run();
      expect(good.ok, JSON.stringify(good, null, 2)).toBe(true);
      expect(good.tenants.map((t) => t.org_id).sort()).toEqual([acme.id, beta.id].sort());
      expect(good.isolation).toHaveLength(5);

      // A missing or changed object, or keys that do not unwrap, fail the check (and name the tenant).
      const keyA = [...objects.keys()].find((k) => k.includes(good.tenants[0]?.snapshot_id ?? '-')) ?? '';
      const missing = await run({ readObject: async (k) => (k === keyA ? null : (objects.get(k) ?? null)) });
      expect(missing.ok).toBe(false);
      expect(missing.tenants[0]?.object).toMatch(/missing/);
      const changed = await run({
        readObject: async (k) => {
          const b = objects.get(k);
          if (!b || k !== keyA) return b ?? null;
          const copy = Buffer.from(b);
          copy.writeUInt8(copy.readUInt8(copy.length - 1) ^ 1, copy.length - 1);
          return copy;
        },
      });
      expect(changed.tenants[0]?.object).toBe('SHA-256 differs');
      const otherRoot = localKeyProvider({
        provider: 'local',
        activeKeyId: 'other',
        keys: { other: randomBytes(32).toString('base64') },
      });
      const wrongKeys = await run({ kms: otherRoot });
      expect(wrongKeys.ok).toBe(false);
      expect(wrongKeys.tenants.every((t) => t.key !== 'ok')).toBe(true);
    } finally {
      owner.release();
      app.release();
    }
  });
});

describe('platform audit (append-only, hash-chained)', () => {
  const insert = (action: string, details: object) =>
    h.pool.query(`insert into platform_audit (id, action, target, details) values ($1, $2, $3, $4)`, [
      newId('audit'),
      action,
      'test',
      JSON.stringify(details),
    ]);

  it('chains every entry, refuses changes and deletion, and an export proves what was there', async () => {
    const before = await auditHead(h.owner);
    await insert('security.test_first', { n: 1, text: 'ünïcode ✓' });
    await insert('security.test_second', { b: [1, 2], a: { z: true } });
    const after = await auditHead(h.owner);
    expect(BigInt(after.seq)).toBe(BigInt(before.seq) + 2n);

    const rows = await exportAudit(h.owner, BigInt(before.seq));
    expect(rows.map((r) => r.action)).toEqual(['security.test_first', 'security.test_second']);
    expect(verifyChain(rows, before.hash, BigInt(before.seq) + 1n).ok).toBe(true);
    expect((await verifyWholeChain(h.owner)).ok).toBe(true);

    // The app role, the worker and even the schema owner cannot change or remove entries.
    for (const pool of [h.pool, h.worker, h.owner]) {
      await expect(
        pool.query("update platform_audit set details = '{}' where seq = $1", [rows[0]?.seq]),
      ).rejects.toThrow(/append-only|permission denied/);
      await expect(pool.query('delete from platform_audit where seq = $1', [rows[0]?.seq])).rejects.toThrow(
        /append-only|permission denied/,
      );
    }
    await expect(h.owner.query('truncate platform_audit')).rejects.toThrow(
      /append-only|foreign key|permission/,
    );
    // An entry cannot be backdated or given another place in the chain.
    await h.pool.query(
      `insert into platform_audit (id, at, action, details) values ($1, '2001-01-01', 'security.test_backdated', '{}')`,
      [newId('audit')],
    );
    const last = (await exportAudit(h.owner, BigInt(after.seq)))[0];
    expect(last?.at.startsWith('2001')).toBe(false);

    // Tampering (here by someone who switched the protection off) is detected by the chain and by an earlier export.
    const target = rows[1];
    if (!target) throw new Error('no entry');
    await h.owner.query('alter table platform_audit disable trigger platform_audit_no_update');
    try {
      await h.owner.query(
        `update platform_audit set details = '{"b":[1,2],"a":{"z":false}}' where seq = $1`,
        [target.seq],
      );
      const now = await exportAudit(h.owner, BigInt(before.seq));
      const check = verifyChain(now, before.hash, BigInt(before.seq) + 1n);
      expect(check.ok).toBe(false);
      expect(check.broken_at).toBe(target.seq);
      expect((await verifyWholeChain(h.owner)).ok).toBe(false);
    } finally {
      await h.owner.query('update platform_audit set details = $2 where seq = $1', [
        target.seq,
        target.details_text,
      ]);
      await h.owner.query('alter table platform_audit enable trigger platform_audit_no_update');
    }
    expect((await verifyWholeChain(h.owner)).ok).toBe(true);
    // A removed entry breaks the next one's link.
    const gap = verifyChain([rows[1] as (typeof rows)[number]], before.hash);
    expect(gap.ok).toBe(false);
  });

  it('recovery markers and the chain head are out of the application roles’ reach', async () => {
    for (const pool of [h.pool, h.worker]) {
      await expect(pool.query('select * from recovery_markers')).rejects.toThrow(/permission denied/);
      await expect(pool.query('update platform_audit_head set seq = 0')).rejects.toThrow(/permission denied/);
    }
    const { rows } = await h.owner.query<{ id: string }>(
      "insert into recovery_markers (note) values ('test') returning id::text",
    );
    expect(rows[0]?.id).toMatch(/^\d+$/);
  });
});

describe('production controls (milestone 12)', () => {
  it('no documentation, debug or metrics endpoints; health says only that it is up', async () => {
    for (const url of [
      '/documentation',
      '/docs',
      '/openapi.json',
      '/v1/openapi.json',
      '/v1/docs',
      '/debug',
      '/v1/debug',
      '/metrics',
      '/v1/metrics',
      '/v1/debug/pprof',
    ]) {
      const r = await h.app.inject({ method: 'GET', url });
      expect(r.statusCode, url).toBe(404);
    }
    const health = await h.app.inject({ method: 'GET', url: '/v1/health' });
    expect(health.json()).toEqual({ status: 'ok' });
    const ready = await h.app.inject({ method: 'GET', url: '/v1/ready' });
    expect(ready.json()).toEqual({ status: 'ready' });
    for (const r of [health, ready]) {
      expect(r.body).not.toMatch(/postgres|version|bucket|secret|key|host/i);
      expect(r.headers.server).toBeUndefined();
    }
  });

  it('desktop apps below the minimum version are told to update; other clients are not affected', async () => {
    const strict = await harness({ env: { MIN_DESKTOP_VERSION: '0.12.0' } });
    try {
      const auth = await strict.auth('acmeOwner');
      const call = (headers: Record<string, string>) =>
        strict.app.inject({ method: 'GET', url: '/v1/me', headers: { ...auth, ...headers } });
      const ua = { 'user-agent': 'project-browser-manager/0.1.0' };
      // A desktop from before 0.12 does not say its version.
      expect((await call(ua)).json()).toMatchObject({
        code: 'CLIENT_UPDATE_REQUIRED',
        safe_details: { minimum_version: '0.12.0' },
      });
      expect((await call({ ...ua, 'x-pb-client-version': '0.11.9' })).statusCode).toBe(426);
      expect((await call({ ...ua, 'x-pb-client-version': '0.12.0-beta.1' })).statusCode).toBe(426);
      expect((await call({ ...ua, 'x-pb-client-version': '0.12.0' })).statusCode).toBe(200);
      expect((await call({ ...ua, 'x-pb-client-version': '0.13.0-dev.1' })).statusCode).toBe(200);
      expect((await call({})).statusCode).toBe(200); // scripts and the SDK
      const health = await strict.app.inject({ method: 'GET', url: '/v1/health', headers: ua });
      expect(health.statusCode).toBe(200);
    } finally {
      await strict.close();
    }
  });

  it('an unavailable key service stops only what needs snapshot keys', async () => {
    let down = false;
    const outage = () => {
      if (down) throw new Error('key service unavailable');
    };
    const kms: RootKeyProvider = {
      provider: 'local',
      activeKeyId: () => h.kms.activeKeyId(),
      wrap: async (p, c) => {
        outage();
        return h.kms.wrap(p, c);
      },
      unwrap: async (id, b, c) => {
        outage();
        return h.kms.unwrap(id, b, c);
      },
    };
    const k = await harness({ kms });
    try {
      const owner = await k.auth('acmeOwner');
      const profile = (
        await k.app.inject({
          method: 'POST',
          url: `/v1/orgs/${acme.id}/profiles`,
          headers: owner,
          payload: { name: 'kms outage', client_id: FIXTURES.clients.acmeNorth.id },
        })
      ).json().id as string;
      await backup(k, {
        headers: owner,
        org: acme.id,
        profile,
        device: FIXTURES.devices.acmeOwnerLaptop.id,
        base: 0,
      });
      const plan = () =>
        k.app.inject({
          method: 'POST',
          url: `/v1/orgs/${acme.id}/profiles/${profile}/restore-plans`,
          headers: owner,
          payload: {},
        });
      expect((await plan()).statusCode).toBe(200);
      down = true;
      const refused = await plan();
      expect(refused.statusCode).toBe(503);
      expect(refused.json()).toMatchObject({ code: 'UNAVAILABLE', retryable: true });
      expect(refused.body).not.toMatch(/key service|root key/i);
      // Everything else works: listing, reading, the session, health.
      expect(
        (await k.app.inject({ method: 'GET', url: `/v1/orgs/${acme.id}/profiles`, headers: owner }))
          .statusCode,
      ).toBe(200);
      expect((await k.app.inject({ method: 'GET', url: '/v1/me', headers: owner })).statusCode).toBe(200);
      expect((await k.app.inject({ method: 'GET', url: '/v1/health' })).statusCode).toBe(200);
      down = false;
      expect((await plan()).statusCode).toBe(200);
    } finally {
      await k.close();
    }
  });

  it('a failing migration changes nothing; the service keeps working on its schema', async () => {
    const source = join(import.meta.dirname, '../../../infra/db/migrations');
    const dir = mkdtempSync(join(tmpdir(), 'pb-migrations-'));
    for (const f of readdirSync(source)) copyFileSync(join(source, f), join(dir, f));
    writeFileSync(
      join(dir, '0999_broken.sql'),
      "create table app.zz_half_done (x integer);\ninsert into app.organizations (id, name) values ('not-an-id', 'x');\n",
    );
    const url = process.env.MIGRATION_DATABASE_URL ?? '';
    await expect(migrate(url, { dir, log: false })).rejects.toThrow(/0999_broken\.sql failed/);
    expect((await h.owner.query("select to_regclass('app.zz_half_done') as t")).rows[0]?.t).toBeNull();
    expect(
      (await h.owner.query("select 1 from public.schema_migrations where name = '0999_broken.sql'")).rowCount,
    ).toBe(0);
    const auth = await h.auth('acmeOwner');
    expect((await h.app.inject({ method: 'GET', url: '/v1/me', headers: auth })).statusCode).toBe(200);
  });
});
