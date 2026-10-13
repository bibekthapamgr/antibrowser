/** Lease, fencing-token and idempotency contracts (milestone 01 data ownership + shared contracts). */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FIXTURES } from '../src/fixtures.ts';
import { type Harness, harness } from './helpers.ts';

const { acme } = FIXTURES.orgs;
const { acmeOwnerLaptop, acmeOperatorMac, acmeOwnerMac, betaOwnerLaptop } = FIXTURES.devices;

let h: Harness;
let owner: Record<string, string>;
let operator: Record<string, string>;
let profileId: string;
let n = 0;
const key = () => `test-key-${Date.now()}-${n++}`;

beforeAll(async () => {
  h = await harness();
  owner = { authorization: `Bearer ${await h.token('acmeOwner')}` };
  operator = { authorization: `Bearer ${await h.token('acmeOperator')}` };
});
afterAll(async () => {
  await h.close();
});

async function freshProfile(): Promise<string> {
  const res = await h.app.inject({
    method: 'POST',
    url: `/v1/orgs/${acme.id}/profiles`,
    headers: owner,
    // Client North is granted to the operator fixture, so both fixtures can reach these profiles.
    payload: { name: `lease-${n++}`, client_id: FIXTURES.clients.acmeNorth.id },
  });
  return res.json().id;
}
const leaseUrl = (id: string) => `/v1/orgs/${acme.id}/profiles/${id}/lease`;
const acquire = (
  headers: Record<string, string>,
  id: string,
  device: string,
  idemKey = key(),
  ttl?: number,
) =>
  h.app.inject({
    method: 'POST',
    url: leaseUrl(id),
    headers: { ...headers, 'idempotency-key': idemKey },
    payload: ttl ? { device_id: device, ttl_seconds: ttl } : { device_id: device },
  });
/** A fenced write: starting a snapshot upload needs the caller's live lease and its current fencing token. */
const snapshot = (headers: Record<string, string>, id: string, token: string, idemKey = key()) =>
  h.app.inject({
    method: 'POST',
    url: `/v1/orgs/${acme.id}/profiles/${id}/snapshots/init`,
    headers: { ...headers, 'idempotency-key': idemKey },
    payload: { base_version: 0, fencing_token: token, platform: 'windows-x64', browser_version: 'test-rev' },
  });

describe('idempotency keys', () => {
  it('are required for lease acquisition', async () => {
    profileId = await freshProfile();
    const res = await h.app.inject({
      method: 'POST',
      url: leaseUrl(profileId),
      headers: owner,
      payload: { device_id: acmeOwnerLaptop.id },
    });
    expect(res.statusCode).toBe(428);
  });

  it('replay the stored response for the same request and reject reuse for a different one', async () => {
    const k = key();
    const first = await acquire(owner, profileId, acmeOwnerLaptop.id, k);
    expect(first.statusCode).toBe(201);
    const replay = await acquire(owner, profileId, acmeOwnerLaptop.id, k);
    expect(replay.statusCode).toBe(200);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.json()).toEqual(first.json());

    const reused = await acquire(owner, profileId, acmeOwnerMac.id, k);
    expect(reused.statusCode).toBe(422);
    expect(reused.json().code).toBe('IDEMPOTENCY_KEY_REUSED');

    const events = await h.owner.query(
      "select count(*)::int as n from outbox_events where aggregate_id = $1 and event_type = 'lease.acquired'",
      [profileId],
    );
    expect(events.rows[0].n).toBe(1);
  });
});

describe('leases and fencing tokens', () => {
  it('blocks a second device while the lease is live', async () => {
    const res = await acquire(operator, profileId, acmeOperatorMac.id);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'LEASE_HELD', retryable: true });
  });

  it('refuses devices that do not belong to the caller', async () => {
    const id = await freshProfile();
    expect((await acquire(owner, id, acmeOperatorMac.id)).statusCode).toBe(403);
    expect((await acquire(owner, id, betaOwnerLaptop.id)).statusCode).toBe(403);
  });

  it('issues strictly increasing tokens and fences out the previous holder', async () => {
    const id = await freshProfile();
    const a = await acquire(owner, id, acmeOwnerLaptop.id);
    const t1 = a.json().fencing_token as string;
    expect((await snapshot(owner, id, t1)).statusCode).toBe(201);

    const released = await h.app.inject({
      method: 'POST',
      url: `${leaseUrl(id)}/release`,
      headers: owner,
      payload: { fencing_token: t1 },
    });
    expect(released.statusCode).toBe(204);
    const again = await h.app.inject({
      method: 'POST',
      url: `${leaseUrl(id)}/release`,
      headers: owner,
      payload: { fencing_token: t1 },
    });
    expect(again.statusCode).toBe(204); // idempotent

    const b = await acquire(operator, id, acmeOperatorMac.id);
    expect(b.statusCode).toBe(201);
    const t2 = b.json().fencing_token as string;
    expect(BigInt(t2)).toBeGreaterThan(BigInt(t1));

    const stale = await snapshot(owner, id, t1);
    expect(stale.statusCode).toBe(409);
    expect(stale.json().code).toBe('FENCING_TOKEN_STALE');

    const renewStale = await h.app.inject({
      method: 'POST',
      url: `${leaseUrl(id)}/renew`,
      headers: owner,
      payload: { fencing_token: t1 },
    });
    expect(renewStale.json().code).toBe('FENCING_TOKEN_STALE');

    const renew = await h.app.inject({
      method: 'POST',
      url: `${leaseUrl(id)}/renew`,
      headers: operator,
      payload: { fencing_token: t2, ttl_seconds: 300 },
    });
    expect(renew.statusCode).toBe(200);
    expect(renew.json().fencing_token).toBe(t2);
  });

  it('judges expiry by the database clock, after which another device may take over', async () => {
    const id = await freshProfile();
    const a = await acquire(owner, id, acmeOwnerLaptop.id, key(), 30);
    expect(a.statusCode).toBe(201);
    // Simulate time passing on the server (client clocks are never consulted).
    await h.owner.query(
      "update profile_leases set acquired_at = now() - interval '2 minutes', expires_at = now() - interval '1 second' where profile_id = $1",
      [id],
    );
    const lookup = await h.app.inject({ method: 'GET', url: leaseUrl(id), headers: owner });
    expect(lookup.json()).toEqual({ lease: null });

    const b = await acquire(operator, id, acmeOperatorMac.id);
    expect(b.statusCode).toBe(201);
    const late = await snapshot(owner, id, a.json().fencing_token);
    expect(late.json().code).toBe('FENCING_TOKEN_STALE');
  });

  it('grants exactly one holder under concurrent acquisition', async () => {
    const id = await freshProfile();
    const attempts = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        i % 2 === 0 ? acquire(owner, id, acmeOwnerLaptop.id) : acquire(operator, id, acmeOperatorMac.id),
      ),
    );
    const winners = attempts.filter((r) => r.statusCode === 201).map((r) => r.json().holder_device_id);
    const losers = attempts.filter((r) => r.statusCode === 409);
    expect(new Set(winners).size).toBe(1);
    expect(winners.length + losers.length).toBe(attempts.length);
  });
});
