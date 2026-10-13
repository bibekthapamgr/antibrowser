/**
 * Milestone 06 role matrix, exercised through the HTTP API with one fixture member per role.
 * Expected outcomes are derived from the contract matrix (ROLE_PERMISSIONS, ROLE_SCOPE), so the API and the published
 * matrix cannot drift apart:
 *  - a resource outside the member's scope answers 404 (exactly like a nonexistent one);
 *  - inside the scope, a role without the permission answers 403 (and the denial is audited);
 *  - otherwise the operation proceeds (writes use a stale version where possible, so they answer 409 without changing
 *    anything).
 */
import { type Permission, ROLE_SCOPE, type Role, roleAllows } from '@pb/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FIXTURES } from '../src/fixtures.ts';
import { type Harness, harness, idemKey } from './helpers.ts';

const { acme } = FIXTURES.orgs;
const shop = FIXTURES.profiles.acmeShop.id; // granted: operator (via Client North), viewer (directly)
const north = FIXTURES.clients.acmeNorth.id;
const viewerUser = FIXTURES.users.acmeViewer.id;

const MEMBERS: Record<Role, keyof typeof FIXTURES.users> = {
  owner: 'acmeOwner',
  admin: 'acmeAdmin',
  operator: 'acmeOperator',
  viewer: 'acmeViewer',
  billing: 'acmeBilling',
};

interface Op {
  name: string;
  permission: Permission;
  /** The operation targets the granted client/profile (scope applies before the permission). */
  scoped: boolean;
  /** Status when allowed. */
  ok: number;
  request: (role: Role) => {
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
    url: string;
    payload?: unknown;
    headers?: Record<string, string>;
  };
}

let n = 0;
const OPS: Op[] = [
  {
    name: 'read organization',
    permission: 'org.read',
    scoped: false,
    ok: 200,
    request: () => ({ method: 'GET', url: `/v1/orgs/${acme.id}` }),
  },
  {
    name: 'rename organization (stale version)',
    permission: 'org.update',
    scoped: false,
    ok: 409,
    request: () => ({
      method: 'PATCH',
      url: `/v1/orgs/${acme.id}`,
      payload: { name: 'x', expected_version: 999 },
    }),
  },
  {
    name: 'list members',
    permission: 'members.read',
    scoped: false,
    ok: 200,
    request: () => ({ method: 'GET', url: `/v1/orgs/${acme.id}/members` }),
  },
  {
    name: 'change a member role (stale version)',
    permission: 'members.manage',
    scoped: false,
    ok: 409,
    request: () => ({
      method: 'PATCH',
      url: `/v1/orgs/${acme.id}/members/${viewerUser}`,
      payload: { role: 'viewer', expected_version: 999 },
    }),
  },
  {
    name: 'invite',
    permission: 'members.manage',
    scoped: false,
    ok: 201,
    request: (role) => ({
      method: 'POST',
      url: `/v1/orgs/${acme.id}/invitations`,
      payload: { email: `matrix-${role}-${n++}@people.test`, role: 'viewer' },
    }),
  },
  {
    name: 'list invitations',
    permission: 'members.manage',
    scoped: false,
    ok: 200,
    request: () => ({ method: 'GET', url: `/v1/orgs/${acme.id}/invitations` }),
  },
  {
    name: 'list clients',
    permission: 'clients.read',
    scoped: false,
    ok: 200,
    request: () => ({ method: 'GET', url: `/v1/orgs/${acme.id}/clients` }),
  },
  {
    name: 'read a granted client',
    permission: 'clients.read',
    scoped: true,
    ok: 200,
    request: () => ({ method: 'GET', url: `/v1/orgs/${acme.id}/clients/${north}` }),
  },
  {
    name: 'create a client',
    permission: 'clients.manage',
    scoped: false,
    ok: 201,
    request: (role) => ({
      method: 'POST',
      url: `/v1/orgs/${acme.id}/clients`,
      payload: { name: `Matrix ${role} ${n++}` },
    }),
  },
  {
    name: 'edit a granted client (stale version)',
    permission: 'clients.manage',
    scoped: true,
    ok: 409,
    request: () => ({
      method: 'PATCH',
      url: `/v1/orgs/${acme.id}/clients/${north}`,
      payload: { name: 'x', expected_version: 999 },
    }),
  },
  {
    name: 'list grants',
    permission: 'grants.manage',
    scoped: false,
    ok: 200,
    request: () => ({ method: 'GET', url: `/v1/orgs/${acme.id}/grants` }),
  },
  {
    name: 'list profiles',
    permission: 'profile.read',
    scoped: false,
    ok: 200,
    request: () => ({ method: 'GET', url: `/v1/orgs/${acme.id}/profiles` }),
  },
  {
    name: 'read a granted profile',
    permission: 'profile.read',
    scoped: true,
    ok: 200,
    request: () => ({ method: 'GET', url: `/v1/orgs/${acme.id}/profiles/${shop}` }),
  },
  {
    name: 'create a profile',
    permission: 'profile.create',
    scoped: false,
    ok: 201,
    request: (role) => ({
      method: 'POST',
      url: `/v1/orgs/${acme.id}/profiles`,
      payload: { name: `matrix ${role}` },
    }),
  },
  {
    name: 'edit a granted profile (stale version)',
    permission: 'profile.update',
    scoped: true,
    ok: 409,
    request: () => ({
      method: 'PATCH',
      url: `/v1/orgs/${acme.id}/profiles/${shop}`,
      payload: { notes: 'x', expected_version: 999 },
    }),
  },
  {
    name: 'delete a granted profile (stale version)',
    permission: 'profile.delete',
    scoped: true,
    ok: 409,
    request: () => ({
      method: 'DELETE',
      url: `/v1/orgs/${acme.id}/profiles/${shop}`,
      headers: { 'if-match': '"999"' },
    }),
  },
  {
    name: 'export profiles',
    permission: 'profile.export',
    scoped: false,
    ok: 200,
    request: () => ({ method: 'GET', url: `/v1/orgs/${acme.id}/profiles/export` }),
  },
  {
    name: 'read the lease of a granted profile',
    permission: 'profile.read',
    scoped: true,
    ok: 200,
    request: () => ({ method: 'GET', url: `/v1/orgs/${acme.id}/profiles/${shop}/lease` }),
  },
  {
    name: 'renew a lease on a granted profile (none held)',
    permission: 'profile.launch',
    scoped: true,
    ok: 409,
    request: () => ({
      method: 'POST',
      url: `/v1/orgs/${acme.id}/profiles/${shop}/lease/renew`,
      payload: { fencing_token: '999999' },
    }),
  },
  {
    name: 'commit a snapshot of a granted profile (no lease)',
    permission: 'snapshot.commit',
    scoped: true,
    ok: 409,
    request: () => ({
      method: 'POST',
      url: `/v1/orgs/${acme.id}/profiles/${shop}/snapshots`,
      headers: { 'idempotency-key': idemKey() },
      payload: {
        fencing_token: '999999',
        sha256: 'b'.repeat(64),
        size_bytes: 1,
        platform: 'linux-x64',
        browser_revision: 'r',
        encryption: { scheme: 'aes-256-gcm-chunked-v1', key_id: 'k' },
      },
    }),
  },
  {
    name: 'list snapshots of a granted profile',
    permission: 'snapshot.read',
    scoped: true,
    ok: 200,
    request: () => ({ method: 'GET', url: `/v1/orgs/${acme.id}/profiles/${shop}/snapshots` }),
  },
  {
    name: 'read the audit log',
    permission: 'audit.read',
    scoped: false,
    ok: 200,
    request: () => ({ method: 'GET', url: `/v1/orgs/${acme.id}/audit-events` }),
  },
];

let h: Harness;
const headers = {} as Record<Role, Record<string, string>>;
beforeAll(async () => {
  h = await harness();
  for (const [role, user] of Object.entries(MEMBERS)) headers[role as Role] = await h.auth(user);
});
afterAll(async () => {
  await h.close();
});

const expected = (role: Role, op: Op): number => {
  if (op.scoped && ROLE_SCOPE[role] === 'none') return 404;
  return roleAllows(role, op.permission) ? op.ok : 403;
};

describe.each(Object.keys(MEMBERS) as Role[])('%s', (role) => {
  it.each(OPS.map((op) => [op.name, op] as const))('%s', async (_name, op) => {
    const req = op.request(role);
    const res = await h.app.inject({
      method: req.method,
      url: req.url,
      headers: { ...headers[role], ...(req.headers ?? {}) },
      ...(req.payload === undefined ? {} : { payload: req.payload as object }),
    });
    expect({ status: res.statusCode, code: res.statusCode >= 400 ? res.json().code : 'ok' }).toMatchObject({
      status: expected(role, op),
    });
    if (res.statusCode === 403) {
      const { rows } = await h.owner.query(
        `select action, outcome, actor_user_id from audit_events where request_id = $1`,
        [res.json().request_id],
      );
      expect(rows).toEqual([
        { action: 'access.denied', outcome: 'denied', actor_user_id: FIXTURES.users[MEMBERS[role]].id },
      ]);
    }
  });
});

describe('ownership transfer', () => {
  it('is refused without a recent sign-in, and to every role but owner', async () => {
    for (const role of Object.keys(MEMBERS) as Role[]) {
      const res = await h.app.inject({
        method: 'POST',
        url: `/v1/orgs/${acme.id}/ownership-transfer`,
        headers: headers[role],
        payload: { user_id: FIXTURES.users.acmeAdmin.id, expected_version: 1 },
      });
      // Development tokens never count as a recent sign-in.
      expect(res.json().code).toBe(role === 'owner' ? 'REAUTHENTICATION_REQUIRED' : 'FORBIDDEN');
    }
  });
});

describe('scope', () => {
  it('operators and viewers list only what they were granted', async () => {
    const list = async (role: Role) =>
      (
        await h.app.inject({
          method: 'GET',
          url: `/v1/orgs/${acme.id}/profiles?limit=100`,
          headers: headers[role],
        })
      )
        .json()
        .items.map((p: { id: string }) => p.id) as string[];
    const operator = await list('operator');
    expect(operator).toContain(shop);
    expect(operator).not.toContain(FIXTURES.profiles.acmeAds.id);
    expect(await list('viewer')).toEqual([shop]);
    expect((await list('owner')).length).toBeGreaterThan(operator.length);

    const ads = await h.app.inject({
      method: 'GET',
      url: `/v1/orgs/${acme.id}/profiles/${FIXTURES.profiles.acmeAds.id}`,
      headers: headers.operator,
    });
    const missing = await h.app.inject({
      method: 'GET',
      url: `/v1/orgs/${acme.id}/profiles/prf_01J9ZSEED0ZZZZ000000000000`,
      headers: headers.operator,
    });
    expect(ads.statusCode).toBe(404);
    expect({ ...ads.json(), request_id: '' }).toEqual({ ...missing.json(), request_id: '' });

    const clients = (
      await h.app.inject({ method: 'GET', url: `/v1/orgs/${acme.id}/clients`, headers: headers.viewer })
    )
      .json()
      .items.map((c: { id: string }) => c.id);
    expect(clients).toEqual([north]);
  });

  it('a client grant covers profiles added to that client later', async () => {
    const created = await h.app.inject({
      method: 'POST',
      url: `/v1/orgs/${acme.id}/profiles`,
      headers: headers.owner,
      payload: { name: 'later north profile', client_id: north },
    });
    const res = await h.app.inject({
      method: 'GET',
      url: `/v1/orgs/${acme.id}/profiles/${created.json().id}`,
      headers: headers.operator,
    });
    expect(res.statusCode).toBe(200);
    const viewer = await h.app.inject({
      method: 'GET',
      url: `/v1/orgs/${acme.id}/profiles/${created.json().id}`,
      headers: headers.viewer,
    });
    expect(viewer.statusCode).toBe(404);
  });

  it('workspace counts follow the same scope', async () => {
    const count = async (role: Role) =>
      (await h.app.inject({ method: 'GET', url: '/v1/me/workspaces', headers: headers[role] })).json()
        .items[0];
    expect(await count('viewer')).toMatchObject({ org_id: acme.id, role: 'viewer', profiles: 1 });
    expect(await count('billing')).toMatchObject({ org_id: acme.id, role: 'billing', profiles: 0 });
  });
});
