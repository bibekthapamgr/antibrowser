/** Shared contracts: validation, pagination, optimistic concurrency, permissions, outbox atomicity. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FIXTURES } from '../src/fixtures.ts';
import { ERROR_KEYS, type Harness, harness } from './helpers.ts';

const { acme } = FIXTURES.orgs;
let h: Harness;
let ownerHeaders: Record<string, string>;

beforeAll(async () => {
  h = await harness();
  ownerHeaders = { authorization: `Bearer ${await h.token('acmeOwner')}` };
});
afterAll(async () => {
  await h.close();
});

const create = (name: string) =>
  h.app.inject({
    method: 'POST',
    url: `/v1/orgs/${acme.id}/profiles`,
    headers: ownerHeaders,
    payload: { name },
  });

describe('validation', () => {
  it('rejects unknown properties instead of stripping them', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: `/v1/orgs/${acme.id}/profiles`,
      headers: ownerHeaders,
      payload: { name: 'ok', org_id: FIXTURES.orgs.beta.id },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(Object.keys(body).sort()).toEqual(ERROR_KEYS);
    expect(body.code).toBe('VALIDATION_FAILED');
    expect(JSON.stringify(body)).not.toMatch(/at .*\.ts:\d+/); // no stack traces
  });

  it('rejects malformed ids before touching the database', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: `/v1/orgs/${acme.id}/profiles/..%2F..%2Fetc`,
      headers: ownerHeaders,
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns NOT_FOUND envelopes for unknown routes', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/v2/anything' });
    expect(res.statusCode).toBe(404);
    expect(Object.keys(res.json()).sort()).toEqual(ERROR_KEYS);
  });
});

describe('cursor pagination', () => {
  it('pages through all rows without duplicates and caps page size at 100', async () => {
    for (let i = 0; i < 7; i++) expect((await create(`page-${i}`)).statusCode).toBe(201);

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const url: string = `/v1/orgs/${acme.id}/profiles?limit=3${cursor ? `&cursor=${cursor}` : ''}`;
      const res = await h.app.inject({ method: 'GET', url, headers: ownerHeaders });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.items.length).toBeLessThanOrEqual(3);
      seen.push(...body.items.map((p: { id: string }) => p.id));
      cursor = body.next_cursor;
      pages++;
    } while (cursor && pages < 20);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.length).toBeGreaterThanOrEqual(9);

    const tooBig = await h.app.inject({
      method: 'GET',
      url: `/v1/orgs/${acme.id}/profiles?limit=101`,
      headers: ownerHeaders,
    });
    expect(tooBig.statusCode).toBe(400);
    const badCursor = await h.app.inject({
      method: 'GET',
      url: `/v1/orgs/${acme.id}/profiles?cursor=garbage`,
      headers: ownerHeaders,
    });
    expect(badCursor.statusCode).toBe(400);
  });
});

describe('optimistic concurrency', () => {
  it('requires a version, rejects stale versions with 409 and advances the ETag', async () => {
    const created = (await create('versioned')).json();
    const url = `/v1/orgs/${acme.id}/profiles/${created.id}`;

    const missing = await h.app.inject({
      method: 'PATCH',
      url,
      headers: ownerHeaders,
      payload: { name: 'a' },
    });
    expect(missing.statusCode).toBe(428);

    const ok = await h.app.inject({
      method: 'PATCH',
      url,
      headers: { ...ownerHeaders, 'if-match': '"1"' },
      payload: { name: 'renamed', client_label: null },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers.etag).toBe('"2"');
    expect(ok.json()).toMatchObject({ name: 'renamed', version: 2, client_label: null });

    const stale = await h.app.inject({
      method: 'PATCH',
      url,
      headers: ownerHeaders,
      payload: { expected_version: 1, notes: 'late writer' },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ code: 'VERSION_CONFLICT', safe_details: { current_version: 2 } });
  });
});

describe('permissions', () => {
  it('a viewer can read but not create', async () => {
    const viewer = { authorization: `Bearer ${await h.token('acmeViewer')}` };
    const read = await h.app.inject({ method: 'GET', url: `/v1/orgs/${acme.id}/profiles`, headers: viewer });
    expect(read.statusCode).toBe(200);
    const write = await h.app.inject({
      method: 'POST',
      url: `/v1/orgs/${acme.id}/profiles`,
      headers: viewer,
      payload: { name: 'nope' },
    });
    expect(write.statusCode).toBe(403);
    expect(write.json().code).toBe('FORBIDDEN');
  });
});

describe('transactional outbox', () => {
  it('writes exactly one event with the state change and redacts payloads', async () => {
    const created = (await create('evented')).json();
    const { rows } = await h.owner.query(
      'select event_type, aggregate_version, org_id, actor_id, redacted_payload from outbox_events where aggregate_id = $1',
      [created.id],
    );
    expect(rows).toEqual([
      {
        event_type: 'profile.created',
        aggregate_version: 1,
        org_id: acme.id,
        actor_id: FIXTURES.users.acmeOwner.id,
        redacted_payload: { name: 'evented', client_label: null },
      },
    ]);
  });

  it('writes no event when the operation fails', async () => {
    const before = await h.owner.query('select count(*)::int as n from outbox_events');
    const res = await h.app.inject({
      method: 'PATCH',
      url: `/v1/orgs/${acme.id}/profiles/${FIXTURES.profiles.acmeAds.id}`,
      headers: { ...ownerHeaders, 'if-match': '"99"' },
      payload: { name: 'x' },
    });
    expect(res.statusCode).toBe(409);
    const after = await h.owner.query('select count(*)::int as n from outbox_events');
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });
});
