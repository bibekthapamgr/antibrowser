/**
 * Milestone 08 exit gate at the API: session leases, heartbeats, uncertain sessions, handoff requests and notes, forced
 * takeover, revocation, stale uploads and recovery copies, grant capabilities. People sign in through the test
 * identity provider (device-bound sessions, like the desktop) and join an organization created for this file.
 * Time passing is simulated on the database clock (the server never consults device clocks).
 */
import { randomBytes } from 'node:crypto';
import { type GrantCapability, type Role, SESSION_LEASE } from '@pb/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Harness, harness, idemKey, internalPlan, type SignedIn } from './helpers.ts';
import {
  backup,
  commitSnapshot,
  initSnapshot,
  operation,
  runWorker,
  sealedObject,
  sha256,
  uploadObject,
} from './sync-helpers.ts';

const BROWSER = '155.0.8059.39';
/** This file's own organization and client (created in beforeAll, so other test files see no new members). */
const acme = { id: '' };
let north = '';

let h: Harness;
let owner: SignedIn;
let admin: SignedIn;

interface Person extends SignedIn {
  device: string;
  user: string;
  grant: string | null;
}

/** Signs a person in and makes them a member; operators and viewers get a grant on the client. */
async function member(role: Role, capabilities?: GrantCapability[]): Promise<Person> {
  const p = await h.signIn();
  await h.owner.query('insert into memberships (org_id, user_id, role) values ($1, $2, $3)', [
    acme.id,
    p.session.user.id,
    role,
  ]);
  let grant: string | null = null;
  if (role === 'operator' || role === 'viewer') {
    const res = await h.app.inject({
      method: 'POST',
      url: `/v1/orgs/${acme.id}/grants`,
      headers: owner.headers,
      payload: { user_id: p.session.user.id, client_id: north, ...(capabilities ? { capabilities } : {}) },
    });
    expect(res.statusCode, res.body).toBe(201);
    grant = res.json().id;
  }
  return { ...p, device: p.session.device.id, user: p.session.user.id, grant };
}

async function freshProfile(): Promise<string> {
  const res = await h.app.inject({
    method: 'POST',
    url: `/v1/orgs/${acme.id}/profiles`,
    headers: owner.headers,
    payload: { name: `team-${randomBytes(4).toString('hex')}`, client_id: north },
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().id;
}

const base = (profile: string) => `/v1/orgs/${acme.id}/profiles/${profile}`;

function open(p: Person, profile: string, opts: { key?: string; browser?: string; purpose?: string } = {}) {
  return h.app.inject({
    method: 'POST',
    url: `${base(profile)}/leases`,
    headers: { ...p.headers, 'idempotency-key': opts.key ?? idemKey() },
    payload: {
      device_id: p.device,
      platform: 'windows-x64',
      browser_version: opts.browser ?? BROWSER,
      ...(opts.purpose ? { purpose: opts.purpose } : {}),
    },
  });
}

interface Opened {
  id: string;
  token: string;
}
async function opened(p: Person, profile: string): Promise<Opened> {
  const res = await open(p, profile);
  expect(res.statusCode, res.body).toBe(201);
  return { id: res.json().lease.id, token: res.json().lease.fencing_token };
}

const beat = (p: Person, profile: string, l: Opened, runState?: string) =>
  h.app.inject({
    method: 'POST',
    url: `${base(profile)}/leases/${l.id}/heartbeat`,
    headers: p.headers,
    payload: { fencing_token: l.token, ...(runState ? { run_state: runState } : {}) },
  });

const release = (p: Person, profile: string, l: Opened, outcome = 'committed', note?: string) =>
  h.app.inject({
    method: 'POST',
    url: `${base(profile)}/leases/${l.id}/release`,
    headers: p.headers,
    payload: { fencing_token: l.token, outcome, ...(note === undefined ? {} : { handoff_note: note }) },
  });

const current = async (p: Person, profile: string) =>
  (await h.app.inject({ method: 'GET', url: `${base(profile)}/leases/current`, headers: p.headers })).json()
    .lease;

/** Moves the lease's expiry into the past on the database clock (a heartbeat that never arrived). */
const expire = (profile: string) =>
  h.owner.query(
    `update profile_leases set acquired_at = now() - interval '5 minutes', heartbeat_at = now() - interval '2 minutes',
            expires_at = now() - interval '1 second'
      where profile_id = $1`,
    [profile],
  );

const audits = async (profile: string) =>
  (
    await h.owner.query<{ action: string; details: Record<string, unknown>; actor_user_id: string | null }>(
      'select action, details, actor_user_id from audit_events where target_id = $1 order by created_at, id',
      [profile],
    )
  ).rows;

beforeAll(async () => {
  h = await harness();
  owner = await h.signIn();
  const org = await h.app.inject({
    method: 'POST',
    url: '/v1/organizations',
    headers: owner.headers,
    payload: { name: 'Team sessions (test)' },
  });
  expect(org.statusCode, org.body).toBe(201);
  acme.id = org.json().id;
  await internalPlan(h.owner, acme.id);
  const client = await h.app.inject({
    method: 'POST',
    url: `/v1/orgs/${acme.id}/clients`,
    headers: owner.headers,
    payload: { name: 'Client North' },
  });
  expect(client.statusCode, client.body).toBe(201);
  north = client.json().id;
  admin = await member('admin');
});
afterAll(async () => {
  await h.close();
});

describe('opening a shared profile', () => {
  it('issues a session lease with the protocol timings and a fresh fencing token; replays return it', async () => {
    const a = await member('operator');
    const profile = await freshProfile();
    const key = idemKey();
    const first = await open(a, profile, { key });
    expect(first.statusCode, first.body).toBe(201);
    const lease = first.json().lease;
    expect(lease).toMatchObject({
      purpose: 'session',
      state: 'active',
      holder_user_id: a.user,
      device_id: a.device,
      device_name: 'Test device',
      run_state: 'starting',
      ttl_seconds: SESSION_LEASE.ttlSeconds,
      heartbeat_seconds: SESSION_LEASE.heartbeatSeconds,
    });
    expect(lease.id).toMatch(/^lse_/);
    expect(first.json().head_version).toBe(0);
    const replay = await open(a, profile, { key });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().lease).toEqual(lease);
  });

  it('simultaneous acquisition: exactly one of twenty attempts from two people wins', async () => {
    const [a, b] = [await member('operator'), await member('operator')];
    const profile = await freshProfile();
    const attempts = await Promise.all(
      Array.from({ length: 20 }, (_, i) => open(i % 2 === 0 ? (a as Person) : (b as Person), profile)),
    );
    const winners = attempts.filter((r) => r.statusCode === 201);
    const losers = attempts.filter((r) => r.statusCode === 409);
    // The winner's own later attempts replace its lease (same device): only the other person is refused.
    const holders = new Set(winners.map((r) => r.json().lease.holder_user_id));
    expect(holders.size).toBe(1);
    expect(winners.length + losers.length).toBe(20);
    for (const l of losers) expect(['LEASE_HELD']).toContain(l.json().code);
    const loser = losers[0]?.json();
    expect(loser?.safe_details).toMatchObject({ device_name: 'Test device', purpose: 'session' });
    const tokens = new Set(winners.map((r) => r.json().lease.fencing_token));
    expect(tokens.size).toBe(winners.length);
  });

  it('needs the launch capability; viewers never open profiles', async () => {
    const viewer = await member('viewer');
    const editor = await member('operator', ['edit']);
    const profile = await freshProfile();
    expect((await open(viewer, profile)).json()).toMatchObject({ code: 'FORBIDDEN' });
    expect((await open(editor, profile)).json()).toMatchObject({
      code: 'FORBIDDEN',
      safe_details: { capability: 'launch' },
    });
  });

  it('refuses a browser older than the newest backup, and organizations without the entitlement', async () => {
    const a = await member('operator');
    const profile = await freshProfile();
    await backup(h, {
      headers: owner.headers,
      org: acme.id,
      profile,
      device: owner.session.device.id,
      base: 0,
    });
    const old = await open(a, profile, { browser: '154.0.1.1' });
    expect(old.json()).toMatchObject({ code: 'RUNTIME_TOO_OLD', safe_details: { required_major: 155 } });
    // Milestone 11: a plan feature, here switched off by an override (ADR-0018).
    await h.owner.query(
      `insert into entitlement_overrides (id, org_id, scope, value, reason, created_by, expires_at)
       values ('ovr_01J9ZSEEDTEAMSESS000000000', $1, 'feature.team_sessions', 'false',
               'test: plan without shared profiles', $2, now() + interval '1 day')`,
      [acme.id, owner.session.user.id],
    );
    try {
      expect((await open(a, profile)).json().code).toBe('ENTITLEMENT_REQUIRED');
    } finally {
      await h.owner.query("delete from entitlement_overrides where id = 'ovr_01J9ZSEEDTEAMSESS000000000'");
    }
    expect((await open(a, profile)).statusCode).toBe(201);
  });
});

describe('heartbeats, expiry and uncertain sessions', () => {
  it('heartbeats extend the lease on the database clock and report the run state (audited)', async () => {
    const a = await member('operator');
    const profile = await freshProfile();
    const l = await opened(a, profile);
    const r = await beat(a, profile, l, 'running');
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ revived: false, handoff_requests: [] });
    expect(r.json().lease).toMatchObject({ state: 'active', run_state: 'running' });
    const left = (Date.parse(r.json().lease.expires_at) - Date.parse(r.json().server_time)) / 1000;
    expect(left).toBeGreaterThan(SESSION_LEASE.ttlSeconds - 5);
    expect(left).toBeLessThanOrEqual(SESSION_LEASE.ttlSeconds + 1);
    expect((await current(owner as Person, profile)).run_state).toBe('running');
    expect((await audits(profile)).map((e) => e.action)).toEqual([
      'profile.created',
      'lease.acquired',
      'session.running',
    ]);
  });

  it('a session whose heartbeats stopped is uncertain: nobody else may open it until its holder confirms', async () => {
    const [a, b] = [await member('operator'), await member('operator')];
    const profile = await freshProfile();
    const l = await opened(a, profile);
    await expire(profile);
    expect((await current(b, profile)).state).toBe('uncertain');
    const refused = await open(b, profile);
    expect(refused.json()).toMatchObject({ code: 'LEASE_UNCERTAIN', retryable: false });
    expect(refused.json().safe_details).toMatchObject({ device_name: 'Test device' });
    // The holder comes back: its heartbeat revives the same lease (same token), still exclusive.
    const back = await beat(a, profile, l, 'running');
    expect(back.json()).toMatchObject({ revived: true, lease: { state: 'active', fencing_token: l.token } });
    expect((await open(b, profile)).json().code).toBe('LEASE_HELD');
    // ...or confirms closure after expiry by releasing: then the next person opens it.
    await expire(profile);
    expect((await release(a, profile, l, 'closed')).statusCode).toBe(204);
    expect((await open(b, profile)).statusCode).toBe(201);
    expect((await audits(profile)).map((e) => e.action)).toContain('lease.revived');
  });

  it('an expired upload lease (a backup of a closed profile) is simply free again', async () => {
    const [a, b] = [await member('operator'), await member('operator')];
    const profile = await freshProfile();
    const up = await open(a, profile, { purpose: 'upload' });
    expect(up.json().lease).toMatchObject({ purpose: 'upload', run_state: null, ttl_seconds: 600 });
    await expire(profile);
    expect(await current(b, profile)).toBeNull();
    expect((await open(b, profile)).statusCode).toBe(201);
    // Upload leases never replace an open session: B's session blocks A's upload lease.
    expect((await open(a, profile, { purpose: 'upload' })).json().code).toBe('LEASE_HELD');
  });

  it('the same device opening again (the app restarted) replaces its own lease and fences the old one', async () => {
    const a = await member('operator');
    const profile = await freshProfile();
    const first = await opened(a, profile);
    const second = await opened(a, profile);
    expect(BigInt(second.token)).toBeGreaterThan(BigInt(first.token));
    expect((await beat(a, profile, first)).json()).toMatchObject({
      code: 'FENCING_TOKEN_STALE',
      safe_details: { state: 'superseded' },
    });
    expect((await beat(a, profile, second)).statusCode).toBe(200);
  });
});

describe('release, handoff notes and access requests', () => {
  it('a handoff note goes to the next person; notes that look like secrets are refused', async () => {
    const [a, b] = [await member('operator'), await member('operator')];
    const profile = await freshProfile();
    const l = await opened(a, profile);
    const secret = await release(a, profile, l, 'committed', `password: ${randomBytes(6).toString('hex')}`);
    expect(secret.json()).toMatchObject({ code: 'NOTE_LOOKS_SECRET' });
    expect((await release(a, profile, l, 'committed', 'Refund for order 1042 is half done')).statusCode).toBe(
      204,
    );
    expect((await release(a, profile, l)).statusCode).toBe(204); // twice: no-op
    expect((await beat(a, profile, l)).json().safe_details).toEqual({ state: 'released' });
    const next = await open(b, profile);
    expect(next.json().handoff_note).toMatchObject({
      text: 'Refund for order 1042 is half done',
      by_user_id: a.user,
    });
    const after = await opened(a, await freshProfile());
    expect(after).toBeTruthy();
  });

  it('a request asks the holder without ending their session; declined, asked again, then fulfilled', async () => {
    const [a, b] = [await member('operator'), await member('operator')];
    const profile = await freshProfile();
    expect(
      (
        await h.app.inject({
          method: 'POST',
          url: `${base(profile)}/handoff-requests`,
          headers: b.headers,
          payload: {},
        })
      ).json().code,
    ).toBe('PROFILE_NOT_IN_USE');
    const l = await opened(a, profile);
    const ask = (note = 'Need to check the orders') =>
      h.app.inject({
        method: 'POST',
        url: `${base(profile)}/handoff-requests`,
        headers: b.headers,
        payload: { note },
      });
    const r1 = await ask();
    expect(r1.statusCode).toBe(201);
    expect(r1.json()).toMatchObject({
      status: 'open',
      requested_by: b.user,
      holder_user_id: a.user,
      mine: true,
    });
    expect((await ask()).statusCode).toBe(200); // one open request per person
    expect((await ask(`api key: ${randomBytes(20).toString('hex')}`)).json().code).toBe('NOTE_LOOKS_SECRET');
    // The holder sees it at the next heartbeat; their lease is untouched.
    const seen = await beat(a, profile, l, 'running');
    expect(seen.json().handoff_requests).toMatchObject([
      { id: r1.json().id, note: 'Need to check the orders' },
    ]);
    expect(seen.json().lease.state).toBe('active');
    // The holder cannot ask themselves; only the holder can decline.
    expect(
      (
        await h.app.inject({
          method: 'POST',
          url: `${base(profile)}/handoff-requests`,
          headers: a.headers,
          payload: {},
        })
      ).json().code,
    ).toBe('VALIDATION_FAILED');
    const declineUrl = `${base(profile)}/handoff-requests/${r1.json().id}/decline`;
    expect((await h.app.inject({ method: 'POST', url: declineUrl, headers: b.headers })).statusCode).toBe(
      403,
    );
    const declined = await h.app.inject({ method: 'POST', url: declineUrl, headers: a.headers });
    expect(declined.json().status).toBe('declined');
    const r2 = await ask();
    expect(r2.statusCode).toBe(201);
    expect((await release(a, profile, l, 'committed')).statusCode).toBe(204);
    const mine = await h.app.inject({
      method: 'GET',
      url: `/v1/orgs/${acme.id}/handoff-requests?mine=true`,
      headers: b.headers,
    });
    expect(mine.json().items.map((r: { status: string }) => r.status)).toEqual(['fulfilled', 'declined']);
    expect((await open(b, profile)).statusCode).toBe(201);
  });
});

describe('forced takeover', () => {
  it('admins end a session with a reason; the old holder is fenced out and nothing it sends is written', async () => {
    const [a, b, op] = [await member('operator'), await member('operator'), await member('operator')];
    const profile = await freshProfile();
    const l = await opened(a, profile);
    const url = `${base(profile)}/force-takeover`;
    expect(
      (
        await h.app.inject({
          method: 'POST',
          url,
          headers: op.headers,
          payload: { reason: 'stuck', confirm: true },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (await h.app.inject({ method: 'POST', url, headers: admin.headers, payload: { reason: 'stuck' } }))
        .statusCode,
    ).toBe(400);
    const pending = await h.app.inject({
      method: 'POST',
      url: `${base(profile)}/handoff-requests`,
      headers: b.headers,
      payload: {},
    });
    const taken = await h.app.inject({
      method: 'POST',
      url,
      headers: admin.headers,
      payload: { reason: 'Laptop left at the office', confirm: true },
    });
    expect(taken.statusCode, taken.body).toBe(200);
    expect(taken.json().previous).toMatchObject({ holder_user_id: a.user, fencing_token: l.token });
    expect(BigInt(taken.json().fencing_token)).toBeGreaterThan(BigInt(l.token));
    // The old holder: heartbeats and fenced writes are refused.
    expect((await beat(a, profile, l)).json()).toMatchObject({
      code: 'FENCING_TOKEN_STALE',
      safe_details: { state: 'taken_over' },
    });
    const init = await initSnapshot(h, a.headers, acme.id, profile, {
      base_version: 0,
      fencing_token: l.token,
    });
    // A stale token says how its lease ended, so the device stops instead of waiting.
    expect(init.json()).toMatchObject({ code: 'FENCING_TOKEN_STALE', safe_details: { state: 'taken_over' } });
    // The request was answered; anyone allowed can open it now.
    const answered = await h.app.inject({
      method: 'GET',
      url: `${base(profile)}/handoff-requests`,
      headers: b.headers,
    });
    expect(answered.json().items[0]).toMatchObject({ id: pending.json().id, status: 'fulfilled' });
    expect((await open(b, profile)).statusCode).toBe(201);
    const takeover = (await audits(profile)).find((e) => e.action === 'lease.taken_over');
    expect(takeover?.details).toMatchObject({ reason: 'Laptop left at the office', previous_holder: a.user });
    expect(takeover?.actor_user_id).toBe(admin.session.user.id);
  });

  it('also ends an uncertain session (its device never came back)', async () => {
    const [a, b] = [await member('operator'), await member('operator')];
    const profile = await freshProfile();
    await opened(a, profile);
    await expire(profile);
    expect((await open(b, profile)).json().code).toBe('LEASE_UNCERTAIN');
    const taken = await h.app.inject({
      method: 'POST',
      url: `${base(profile)}/force-takeover`,
      headers: admin.headers,
      payload: { reason: 'Computer lost', confirm: true },
    });
    expect(taken.json().previous.state).toBe('uncertain');
    expect((await open(b, profile)).statusCode).toBe(201);
  });
});

describe('stale uploads never overwrite newer state', () => {
  /** Init + upload + commit under `token`; returns the commit response and the operation id. */
  async function upload(p: Person, profile: string, token: string, baseVersion: number, recovery = false) {
    const init = await initSnapshot(h, p.headers, acme.id, profile, {
      base_version: baseVersion,
      fencing_token: token,
      ...(recovery ? { recovery: true } : {}),
    } as { base_version: number; fencing_token: string });
    expect(init.statusCode, init.body).toBe(201);
    const snapshotId = init.json().key.snapshot_id;
    const object = sealedObject({
      orgId: acme.id,
      profileId: profile,
      snapshotId,
      keyVersion: init.json().key.key_version,
    });
    const parts = await uploadObject(h, p.headers, acme.id, profile, snapshotId, object);
    const commit = await commitSnapshot(h, p.headers, acme.id, profile, snapshotId, {
      fencing_token: token,
      digest: sha256(object),
      ciphertext_size: object.length,
      parts,
    });
    return { commit, opId: init.json().operation.id as string, snapshotId };
  }

  it('a takeover between commit and verification fails the old upload; the new holder’s version wins', async () => {
    const [a, b] = [await member('operator'), await member('operator')];
    const profile = await freshProfile();
    const la = await opened(a, profile);
    const late = await upload(a, profile, la.token, 0);
    expect(late.commit.statusCode).toBe(202); // committed while A still held the lease...
    await h.app.inject({
      method: 'POST',
      url: `${base(profile)}/force-takeover`,
      headers: admin.headers,
      payload: { reason: 'Handing over', confirm: true },
    });
    await runWorker(h); // ...verified after the takeover: fenced out
    expect((await operation(h, a.headers, acme.id, late.opId)).error_code).toBe('FENCING_TOKEN_STALE');
    const lb = await opened(b, profile);
    const won = await upload(b, profile, lb.token, 0);
    expect(won.commit.statusCode).toBe(202);
    await runWorker(h);
    expect((await operation(h, b.headers, acme.id, won.opId)).state).toBe('committed');
    const head = await h.app.inject({ method: 'GET', url: base(profile), headers: b.headers });
    expect(head.json().snapshot_version).toBe(1);
    // A's next attempts with its old token are refused before anything is stored.
    expect(
      (
        await initSnapshot(h, a.headers, acme.id, profile, { base_version: 1, fencing_token: la.token })
      ).json().code,
    ).toBe('FENCING_TOKEN_STALE');
  });

  it('the old holder keeps its copy as a recovery copy: verified, never the head, restorable by admins only', async () => {
    const [a, b] = [await member('operator'), await member('operator')];
    const profile = await freshProfile();
    const la = await opened(a, profile);
    // While the lease is still A's, a recovery upload is refused (it would be a normal upload).
    const early = await initSnapshot(h, a.headers, acme.id, profile, {
      base_version: 0,
      fencing_token: la.token,
      recovery: true,
    } as { base_version: number; fencing_token: string });
    expect(early.json().code).toBe('VALIDATION_FAILED');
    await h.app.inject({
      method: 'POST',
      url: `${base(profile)}/force-takeover`,
      headers: admin.headers,
      payload: { reason: 'Handing over', confirm: true },
    });
    const lb = await opened(b, profile);
    await upload(b, profile, lb.token, 0);
    await runWorker(h);
    const kept = await upload(a, profile, la.token, 0, true);
    expect(kept.commit.statusCode).toBe(202);
    await runWorker(h);
    expect((await operation(h, a.headers, acme.id, kept.opId)).state).toBe('kept');
    const head = await h.app.inject({ method: 'GET', url: base(profile), headers: b.headers });
    expect(head.json().snapshot_version).toBe(1);
    // Someone who never held that lease cannot file a recovery copy with its token.
    const stranger = await initSnapshot(h, b.headers, acme.id, profile, {
      base_version: 0,
      fencing_token: la.token,
      recovery: true,
    } as { base_version: number; fencing_token: string });
    expect(stranger.json().code).toBe('LEASE_NOT_HELD');
    const list = await h.app.inject({
      method: 'GET',
      url: `/v1/orgs/${acme.id}/recovery-copies`,
      headers: admin.headers,
    });
    expect(list.json().items.find((r: { id: string }) => r.id === kept.snapshotId)).toMatchObject({
      profile_id: profile,
      created_by: a.user,
    });
    const history = await h.app.inject({
      method: 'GET',
      url: `${base(profile)}/snapshots`,
      headers: admin.headers,
    });
    expect(history.json().items.map((s: { id: string }) => s.id)).not.toContain(kept.snapshotId);
    const plan = (who: SignedIn) =>
      h.app.inject({
        method: 'POST',
        url: `${base(profile)}/restore-plans`,
        headers: who.headers,
        payload: { snapshot_id: kept.snapshotId },
      });
    expect((await plan(b)).statusCode).toBe(403);
    const ok = await plan(admin);
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().snapshot).toMatchObject({ status: 'recovery', version: null });
  });
});

describe('revocation', () => {
  it('removing the grant ends the session: fenced out, told at the next heartbeat, others may open it', async () => {
    const [a, b] = [await member('operator'), await member('operator')];
    const profile = await freshProfile();
    const l = await opened(a, profile);
    const removed = await h.app.inject({
      method: 'DELETE',
      url: `/v1/orgs/${acme.id}/grants/${a.grant}`,
      headers: owner.headers,
    });
    expect(removed.statusCode).toBe(204);
    expect((await beat(a, profile, l)).json().code).toBe('NOT_FOUND');
    expect(await current(b, profile)).toBeNull();
    expect((await open(b, profile)).statusCode).toBe(201);
    const ended = (await audits(profile)).find((e) => e.action === 'lease.revoked');
    expect(ended?.details).toMatchObject({ previous_holder: a.user, reason: 'access_removed' });
  });

  it('taking launch away, a role change and removal from the organization end sessions too', async () => {
    const cases: [string, (p: Person) => Promise<unknown>, string][] = [
      [
        'capability',
        (p) =>
          h.app.inject({
            method: 'PATCH',
            url: `/v1/orgs/${acme.id}/grants/${p.grant}`,
            headers: owner.headers,
            payload: { capabilities: ['backup_download'] },
          }),
        'FORBIDDEN',
      ],
      [
        'role',
        async (p) => {
          const m = await h.app.inject({
            method: 'GET',
            url: `/v1/orgs/${acme.id}/members?limit=100`,
            headers: owner.headers,
          });
          const v = m.json().items.find((x: { user_id: string }) => x.user_id === p.user).version;
          return h.app.inject({
            method: 'PATCH',
            url: `/v1/orgs/${acme.id}/members/${p.user}`,
            headers: owner.headers,
            payload: { role: 'viewer', expected_version: v },
          });
        },
        'FORBIDDEN',
      ],
      [
        'membership',
        (p) =>
          h.app.inject({
            method: 'DELETE',
            url: `/v1/orgs/${acme.id}/members/${p.user}`,
            headers: owner.headers,
          }),
        'NOT_FOUND',
      ],
    ];
    for (const [name, revoke, code] of cases) {
      const a = await member('operator');
      const profile = await freshProfile();
      const l = await opened(a, profile);
      await revoke(a);
      expect({ name, code: (await beat(a, profile, l)).json().code }).toEqual({ name, code });
      expect({ name, lease: await current(owner as Person, profile) }).toEqual({ name, lease: null });
    }
  });

  it('signing a device out everywhere releases the profiles it has open', async () => {
    const a = await member('operator');
    const profile = await freshProfile();
    await opened(a, profile);
    const out = await h.app.inject({
      method: 'POST',
      url: `/v1/devices/${a.device}/revoke`,
      headers: a.headers,
    });
    expect(out.statusCode).toBe(200);
    expect(await current(owner as Person, profile)).toBeNull();
    const ended = (await audits(profile)).find((e) => e.action === 'lease.revoked');
    expect(ended?.details).toMatchObject({ reason: 'device_signed_out' });
  });
});

describe('team view and capabilities', () => {
  it('lists show who has a profile open and what the caller may do', async () => {
    const [a, b] = [await member('operator'), await member('operator', ['launch'])];
    const profile = await freshProfile();
    await opened(a, profile);
    const list = await h.app.inject({
      method: 'GET',
      url: `/v1/orgs/${acme.id}/profiles?limit=100`,
      headers: b.headers,
    });
    expect(list.statusCode, list.body).toBe(200);
    const row = list.json().items.find((p: { id: string }) => p.id === profile);
    expect(row.in_use).toMatchObject({
      holder_user_id: a.user,
      device_name: 'Test device',
      state: 'active',
      mine: false,
    });
    expect(row.capabilities).toEqual(['launch']);
    const mine = await h.app.inject({ method: 'GET', url: base(profile), headers: a.headers });
    expect(mine.json().in_use.mine).toBe(true);
    expect(mine.json().capabilities).toEqual(['backup_download', 'launch']);
    const ownerView = await h.app.inject({ method: 'GET', url: base(profile), headers: owner.headers });
    expect(ownerView.json().capabilities).toEqual(['launch', 'edit', 'backup_download']);
  });

  it('edit is separate from launch; operators never move profiles, bulk-edit, export or grant', async () => {
    const editor = await member('operator', ['edit']);
    const launcher = await member('operator');
    const profile = await freshProfile();
    const v = (await h.app.inject({ method: 'GET', url: base(profile), headers: owner.headers })).json()
      .version;
    const patch = (p: Person, payload: object) =>
      h.app.inject({
        method: 'PATCH',
        url: base(profile),
        headers: p.headers,
        payload: { ...payload, expected_version: v },
      });
    expect((await patch(launcher, { notes: 'x' })).json()).toMatchObject({
      code: 'FORBIDDEN',
      safe_details: { capability: 'edit' },
    });
    expect((await patch(editor, { client_id: null })).json().code).toBe('FORBIDDEN');
    expect((await patch(editor, { notes: `token=${randomBytes(20).toString('hex')}` })).json().code).toBe(
      'NOTE_LOOKS_SECRET',
    );
    expect((await patch(editor, { notes: 'Use the EU storefront' })).statusCode).toBe(200);
    const bulk = await h.app.inject({
      method: 'POST',
      url: `/v1/orgs/${acme.id}/profiles/bulk`,
      headers: editor.headers,
      payload: { action: 'set_client', client_id: null, profile_ids: [profile] },
    });
    expect(bulk.json().results).toEqual([{ id: profile, outcome: 'forbidden' }]);
    const grant = await h.app.inject({
      method: 'POST',
      url: `/v1/orgs/${acme.id}/grants`,
      headers: editor.headers,
      payload: {
        user_id: editor.user,
        client_id: north,
        capabilities: ['launch', 'edit', 'backup_download'],
      },
    });
    expect(grant.statusCode).toBe(403);
    expect(
      (
        await h.app.inject({
          method: 'GET',
          url: `/v1/orgs/${acme.id}/profiles/export`,
          headers: editor.headers,
        })
      ).statusCode,
    ).toBe(403);
  });

  it('viewers’ grants carry no capabilities; the export needs a recent sign-in', async () => {
    const viewer = await member('viewer');
    const g = await h.app.inject({
      method: 'POST',
      url: `/v1/orgs/${acme.id}/grants`,
      headers: owner.headers,
      payload: { user_id: viewer.user, profile_id: await freshProfile(), capabilities: ['launch'] },
    });
    expect(g.json().code).toBe('VALIDATION_FAILED');
    const listed = await h.app.inject({
      method: 'GET',
      url: `/v1/orgs/${acme.id}/grants?user_id=${viewer.user}`,
      headers: owner.headers,
    });
    expect(listed.json().items.map((x: { capabilities: string[] }) => x.capabilities)).toEqual([[]]);
    // An admin who signed in an hour ago (the session's sign-in time travels in the access token).
    const stale = await member('admin');
    await h.owner.query(
      "update device_sessions set auth_time = now() - interval '1 hour' where device_id = $1",
      [stale.device],
    );
    const refreshed = await h.app.inject({
      method: 'POST',
      url: '/v1/auth/token',
      payload: { grant_type: 'refresh_token', refresh_token: stale.session.refresh_token },
    });
    expect(refreshed.statusCode, refreshed.body).toBe(200);
    const dev = { authorization: `Bearer ${refreshed.json().access_token}` };
    expect(
      (await h.app.inject({ method: 'GET', url: `/v1/orgs/${acme.id}/profiles/export`, headers: dev })).json()
        .code,
    ).toBe('REAUTHENTICATION_REQUIRED');
    expect(
      (
        await h.app.inject({
          method: 'GET',
          url: `/v1/orgs/${acme.id}/profiles/export`,
          headers: owner.headers,
        })
      ).statusCode,
    ).toBe(200);
  });
});
