/**
 * Milestone 12 (ADR-0019): restore verification (row ↔ object ↔ key linkage for two tenants, no crossing), the
 * append-only hash-chained platform audit and its export, and the recovery markers no application role can reach.
 */
import { randomBytes } from 'node:crypto';
import { newId } from '@pb/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditHead, exportAudit, verifyChain, verifyWholeChain } from '../src/audit-chain.ts';
import { localKeyProvider } from '../src/backup/keys.ts';
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
