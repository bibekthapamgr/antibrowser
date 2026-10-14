/**
 * R4 (ADR-0023): what the public website and the customer portal rely on — the published catalog with verified
 * prices (never free because a price is missing), downloads from the signed stable channel only, the contact form,
 * one checkout per workspace (refresh, double click and web + desktop at once), the portal return, intervals,
 * downgrade below usage, and the person's own e-mail settings and deletion request.
 */
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { keyIdHex, publicKeyEntry } from '../../../scripts/release/minisign.mjs';
import { processBillingEvents, type ReconcileDeps, remindTrials } from '../src/billing/reconcile.ts';
import { createStripe } from '../src/billing/stripe.ts';
import { unsubscribeToken } from '../src/email.ts';
import { readDownloads } from '../src/release.ts';
import { type FakeStripe, fakeStripe, stripeEnv } from './fake-stripe.ts';
import { type Harness, harness, type SignedIn } from './helpers.ts';

const ORIGIN = 'http://127.0.0.1:8080';
const EMAIL_KEY = randomBytes(32);
let f: FakeStripe;
let h: Harness;
let deps: ReconcileDeps;

beforeAll(async () => {
  f = await fakeStripe();
  h = await harness({
    env: {
      ...stripeEnv(f),
      WEB_ORIGIN: ORIGIN,
      EMAIL_TASK_KEY: EMAIL_KEY.toString('base64'),
      SUPPORT_EMAIL: 'support@example.test',
    },
  });
  deps = {
    pool: h.worker,
    stripe: createStripe({ secretKey: f.secretKey, apiBase: f.url }),
    prices: JSON.parse(stripeEnv(f).BILLING_STRIPE_PRICES ?? '{}'),
    log: () => undefined,
    graceDays: 7,
    notify: { key: EMAIL_KEY, portalUrl: `${ORIGIN}/app/#/billing` },
  };
});
afterAll(async () => {
  await h?.close();
  await f?.close();
});

interface Org {
  id: string;
  owner: SignedIn;
}
async function newOrg(): Promise<Org> {
  const owner = await h.signIn();
  const res = await h.app.inject({
    method: 'POST',
    url: '/v1/organizations',
    headers: owner.headers,
    payload: { name: 'Portal (test)' },
  });
  expect(res.statusCode, res.body).toBe(201);
  return { id: res.json().id, owner };
}
const checkout = (o: Org, body: object) =>
  h.app.inject({
    method: 'POST',
    url: `/v1/orgs/${o.id}/billing/checkout-session`,
    headers: o.owner.headers,
    payload: body,
  });
const sessionsCreated = () =>
  f.requests.filter((r) => r.method === 'POST' && r.path === '/v1/checkout/sessions').length;
const sessionOf = (url: string) => new URL(url).pathname.split('/').pop() as string;
async function deliver(events: Record<string, unknown>[]) {
  for (const ev of events) {
    const { body, header } = f.sign(ev);
    const r = await h.app.inject({
      method: 'POST',
      url: '/v1/webhooks/billing',
      headers: { 'content-type': 'application/json', 'stripe-signature': header },
      payload: body,
    });
    expect(r.statusCode, r.body).toBe(200);
  }
  for (let i = 0; i < 10; i++) {
    const r = await processBillingEvents(deps, 50);
    if (r.processed + r.ignored + r.failed + r.retried === 0) break;
  }
}
async function subscription(o: Org) {
  const r = await h.app.inject({
    method: 'GET',
    url: `/v1/orgs/${o.id}/billing/subscription`,
    headers: o.owner.headers,
  });
  expect(r.statusCode, r.body).toBe(200);
  return r.json();
}

describe('public catalog', () => {
  it('lists purchasable plans with verified prices per interval, tax display and a version (ETag)', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/v1/public/plans' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['cache-control']).toContain('public');
    const body = res.json();
    expect(body.catalog_version).toMatch(/^[0-9a-f]{16}$/);
    expect(body.trial_days).toBe(14);
    expect(body.items.map((p: { id: string }) => p.id)).toEqual(['starter', 'team', 'agency']);
    const team = body.items.find((p: { id: string }) => p.id === 'team');
    expect(team.prices).toEqual([
      expect.objectContaining({ interval: 'month', amount_minor: 4900, currency: 'usd', tax: 'exclusive' }),
      expect.objectContaining({ interval: 'year', amount_minor: 49000, tax: 'exclusive' }),
    ]);
    expect(team.limits.seats).toBe(5);
    // Never trial, internal or beta plans; no fingerprint or "never banned" features exist in the catalog.
    expect(JSON.stringify(body)).not.toMatch(/internal|fingerprint|ban/i);
    const again = await h.app.inject({
      method: 'GET',
      url: '/v1/public/plans',
      headers: { 'if-none-match': res.headers.etag as string },
    });
    expect(again.statusCode).toBe(304);
  });

  it('a disabled or unreadable price is not offered and never shown as free; checkout refuses it', async () => {
    f.setPrice(f.prices.agency, { active: false });
    // The catalog keeps verified prices for an hour: a fresh server process reads the provider again.
    const fresh = await harness({ env: { ...stripeEnv(f), WEB_ORIGIN: ORIGIN } });
    try {
      const body = (await fresh.app.inject({ method: 'GET', url: '/v1/public/plans' })).json();
      const agency = body.items.find((p: { id: string }) => p.id === 'agency');
      expect(agency).toMatchObject({ prices: [], available: false });
      const owner = await fresh.signIn();
      const org = (
        await fresh.app.inject({
          method: 'POST',
          url: '/v1/organizations',
          headers: owner.headers,
          payload: { name: 'x' },
        })
      ).json();
      const refused = await fresh.app.inject({
        method: 'POST',
        url: `/v1/orgs/${org.id}/billing/checkout-session`,
        headers: owner.headers,
        payload: { plan_id: 'agency' },
      });
      expect(refused.json()).toMatchObject({ code: 'PLAN_NOT_AVAILABLE' });
      // A starter yearly price is not configured: not offered either.
      const yearly = await fresh.app.inject({
        method: 'POST',
        url: `/v1/orgs/${org.id}/billing/checkout-session`,
        headers: owner.headers,
        payload: { plan_id: 'starter', interval: 'year' },
      });
      expect(yearly.json()).toMatchObject({ code: 'PLAN_NOT_AVAILABLE', safe_details: { interval: 'year' } });
      // A provider outage: prices cannot be verified, nothing is offered, nothing is free.
      f.down = true;
      const outage = await harness({ env: { ...stripeEnv(f), WEB_ORIGIN: ORIGIN } });
      try {
        const o = (await outage.app.inject({ method: 'GET', url: '/v1/public/plans' })).json();
        expect(
          o.items.every((p: { prices: unknown[]; available: boolean }) => !p.available && !p.prices.length),
        ).toBe(true);
      } finally {
        f.down = false;
        await outage.close();
      }
    } finally {
      f.setPrice(f.prices.agency, { active: true });
      await fresh.close();
    }
  });
});

describe('one checkout per workspace', () => {
  it('a refresh or a second click reuses the open checkout; concurrent clicks create one; another plan replaces it', async () => {
    const o = await newOrg();
    const before = sessionsCreated();
    const first = await checkout(o, { plan_id: 'team' });
    expect(first.statusCode, first.body).toBe(201);
    const again = await checkout(o, { plan_id: 'team' });
    expect(again.json().url).toBe(first.json().url);
    // Five at once (web and desktop): all get the same page.
    const many = await Promise.all(Array.from({ length: 5 }, () => checkout(o, { plan_id: 'team' })));
    expect(new Set(many.map((r) => r.json().url))).toEqual(new Set([first.json().url]));
    expect(sessionsCreated() - before).toBe(1);
    // The yearly price is another choice: it replaces the open checkout (the old page stops working).
    const yearly = await checkout(o, { plan_id: 'team', interval: 'year' });
    expect(yearly.statusCode, yearly.body).toBe(201);
    expect(f.sessions.get(sessionOf(first.json().url))?.status).toBe('expired');
    const created = f.requests.filter((r) => r.method === 'POST' && r.path === '/v1/checkout/sessions').pop();
    expect(created?.params['line_items[0][price]']).toBe(f.prices.teamYear);
    expect((await subscription(o)).checkout).toMatchObject({
      state: 'open',
      plan_id: 'team',
      interval: 'year',
    });
    const { rows } = await h.owner.query(
      `select state, count(*)::int as n from checkout_attempts where org_id = $1 group by state order by state`,
      [o.id],
    );
    expect(rows).toEqual([
      { state: 'open', n: 1 },
      { state: 'replaced', n: 1 },
    ]);
  });

  it('pays through the portal return: pending until the provider confirms, then active; a declined card recovers', async () => {
    const o = await newOrg();
    const res = await checkout(o, { plan_id: 'team', return_to: 'portal' });
    expect(res.statusCode, res.body).toBe(201);
    const params = f.requests.filter((r) => r.path === '/v1/checkout/sessions').pop()?.params ?? {};
    expect(params.success_url).toBe(`${ORIGIN}/app/#/billing/return?result=success`);
    expect(params.cancel_url).toBe(`${ORIGIN}/app/#/billing/return?result=canceled`);
    // The card is declined: nothing changes, the checkout is still open and can be retried.
    const sid = sessionOf(res.json().url);
    await deliver(f.completeCheckout(sid, { fail: true }));
    expect((await subscription(o)).state).toBe('trial');
    // A new attempt (the old session is expired at the provider when a new one starts) and a successful payment.
    await h.owner.query(`update checkout_attempts set expires_at = now() where org_id = $1`, [o.id]);
    const retry = await checkout(o, { plan_id: 'team', return_to: 'portal' });
    expect(retry.statusCode, retry.body).toBe(201);
    const before = await subscription(o);
    expect(before).toMatchObject({ state: 'trial', checkout: { state: 'open' } });
    await deliver(f.completeCheckout(sessionOf(retry.json().url)));
    const after = await subscription(o);
    expect(after).toMatchObject({ state: 'active', plan: { id: 'team' }, checkout: { state: 'completed' } });
    // Subscribed: no second checkout, from any client.
    expect((await checkout(o, { plan_id: 'agency' })).json().code).toBe('ALREADY_SUBSCRIBED');
    // The owner hears about the result once (a replayed event changes nothing and sends nothing).
    const mails = async () =>
      (
        await h.owner.query(`select kind from email_tasks where org_id = $1 and kind like 'payment_%'`, [
          o.id,
        ])
      ).rows.map((r) => r.kind);
    expect(await mails()).toEqual(['payment_succeeded']);
    const sub = [...f.subscriptions.values()].find(
      (s) => (s.metadata as { org_id?: string }).org_id === o.id && s.status === 'active',
    );
    await deliver(f.failRenewal(sub?.id as string));
    expect((await subscription(o)).state).toBe('past_due');
    expect((await mails()).sort()).toEqual(['payment_failed', 'payment_succeeded']);
  });

  it('reminds the people who pay that a trial ends soon, once, unless they turned reminders off', async () => {
    const o = await newOrg();
    await h.owner.query(
      `update subscriptions set trial_ends_at = now() + interval '2 days' where org_id = $1`,
      [o.id],
    );
    const count = async () =>
      (
        await h.owner.query(
          `select count(*)::int as n from email_tasks where org_id = $1 and kind = 'trial_ending'`,
          [o.id],
        )
      ).rows[0].n;
    await remindTrials(h.worker, deps.notify);
    await remindTrials(h.worker, deps.notify);
    expect(await count()).toBe(1);
    const other = await newOrg();
    await h.app.inject({
      method: 'PUT',
      url: '/v1/me/notifications',
      headers: other.owner.headers,
      payload: { billing_reminders: false },
    });
    await h.owner.query(
      `update subscriptions set trial_ends_at = now() + interval '2 days' where org_id = $1`,
      [other.id],
    );
    await remindTrials(h.worker, deps.notify);
    expect(
      (
        await h.owner.query(`select 1 from email_tasks where org_id = $1 and kind = 'trial_ending'`, [
          other.id,
        ])
      ).rowCount,
    ).toBe(0);
  });

  it('a downgrade below current usage keeps everything and only stops new creation', async () => {
    const o = await newOrg();
    const res = await checkout(o, { plan_id: 'team' });
    await deliver(f.completeCheckout(sessionOf(res.json().url)));
    for (let i = 0; i < 2; i++) {
      const inv = await h.app.inject({
        method: 'POST',
        url: `/v1/orgs/${o.id}/invitations`,
        headers: o.owner.headers,
        payload: { email: `seat${i}-${randomBytes(3).toString('hex')}@example.test`, role: 'operator' },
      });
      expect(inv.statusCode, inv.body).toBe(201);
    }
    const sub = [...f.subscriptions.values()].find(
      (s) => (s.metadata as { org_id?: string }).org_id === o.id,
    );
    await deliver(f.changePrice(sub?.id as string, f.prices.starter));
    const view = await subscription(o);
    expect(view).toMatchObject({ plan: { id: 'starter' }, state: 'active' });
    expect(view.over_limits).toContain('seats');
    const { rows } = await h.owner.query(
      `select count(*)::int as n from invitations where org_id = $1 and revoked_at is null`,
      [o.id],
    );
    expect(rows[0].n).toBe(2);
  });
});

describe('downloads', () => {
  const KEYS_DIR = mkdtempSync(join(tmpdir(), 'pb-keys-'));
  const fixtures = resolve(import.meta.dirname, '../../../crates/update/tests/fixtures/tauri-cli');
  const NOW = Date.parse('2026-10-15T08:00:00Z');
  const keysFile = (entries: object[]) => {
    const p = join(KEYS_DIR, `${randomBytes(4).toString('hex')}.json`);
    writeFileSync(p, JSON.stringify({ keys: entries }));
    return p;
  };
  const serve =
    (files: Record<string, string>) =>
    async (url: string | URL | Request): Promise<Response> => {
      const body = files[String(url)];
      return body === undefined ? new Response('missing', { status: 404 }) : new Response(body);
    };
  const URL_ = 'https://github.com/bibekthapamgr/antibrowser/releases/download/channel-stable/stable.json';

  it('offers only a release verified with the app’s keys; nothing without keys or with a bad signature', async () => {
    const cli = keysFile([
      publicKeyEntry(readFileSync(join(fixtures, 'throwaway.key.pub'), 'utf8'), '2026-10-01', '2027-12-31'),
    ]);
    const files = {
      [URL_]: readFileSync(join(fixtures, 'stable.json'), 'utf8'),
      [`${URL_}.sig`]: readFileSync(join(fixtures, 'stable.json.sig'), 'utf8'),
    };
    const ok = await readDownloads({
      channelUrl: URL_,
      keysFile: cli,
      fetch: serve(files) as typeof fetch,
      now: () => NOW,
    });
    expect(ok).toMatchObject({ status: 'available', version: '0.12.1' });
    expect(ok.platforms).toEqual([
      expect.objectContaining({ platform: 'windows-x64', kind: 'installer', size_bytes: 100 }),
    ]);
    const none = await readDownloads({
      channelUrl: URL_,
      keysFile: keysFile([]),
      fetch: serve(files) as typeof fetch,
      now: () => NOW,
    });
    expect(none).toMatchObject({ status: 'not_available', platforms: [] });
    const tampered = await readDownloads({
      channelUrl: URL_,
      keysFile: cli,
      fetch: serve({ ...files, [URL_]: files[URL_]?.replace('0.12.1', '0.12.9') ?? '' }) as typeof fetch,
      now: () => NOW,
    });
    expect(tampered.status).toBe('not_available');
    const expired = await readDownloads({
      channelUrl: URL_,
      keysFile: cli,
      fetch: serve(files) as typeof fetch,
      now: () => Date.parse('2027-01-01T00:00:00Z'),
    });
    expect(expired.status).toBe('not_available');
  });

  it('the Mac disk image with its checksum from the release; a paused or revoked release is not offered', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const id = randomBytes(8);
    const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x as string, 'base64url');
    const pub = Buffer.from(
      `untrusted comment: minisign public key: ${keyIdHex(id)}\n${Buffer.concat([Buffer.from('Ed'), id, raw]).toString('base64')}\n`,
    ).toString('base64');
    const signText = (data: Buffer, comment: string) => {
      const sig = sign(null, createHash('blake2b512').update(data).digest(), privateKey);
      const global = sign(null, Buffer.concat([sig, Buffer.from(comment)]), privateKey);
      return Buffer.from(
        `untrusted comment: signature from tauri secret key\n${Buffer.concat([Buffer.from('ED'), id, sig]).toString('base64')}\ntrusted comment: ${comment}\n${global.toString('base64')}\n`,
      ).toString('base64');
    };
    const keys = keysFile([publicKeyEntry(pub, '2026-10-01', '2027-12-31')]);
    const base = 'https://github.com/bibekthapamgr/antibrowser/releases/download/';
    const manifest = (patch: object) => ({
      schema: 1,
      product: 'project-browser-manager',
      channel: 'stable',
      sequence: 5,
      issued_at: '2026-10-14T00:00:00Z',
      expires_at: '2026-11-13T00:00:00Z',
      paused: false,
      minimum_version: null,
      revoked_versions: [],
      revoked_runtime_sha256: [],
      release: {
        version: '0.13.0',
        published_at: '2026-10-14T00:00:00Z',
        notes_url: 'https://github.com/bibekthapamgr/antibrowser/releases/tag/desktop-v0.13.0',
        artifacts: [
          {
            platform: 'macos-arm64',
            kind: 'app-tar-gz',
            url: `${base}desktop-v0.13.0/Project.Browser_0.13.0_aarch64.app.tar.gz`,
            sha256: 'a'.repeat(64),
            size_bytes: 10,
            signature: 'x',
          },
        ],
      },
      ...patch,
    });
    const files = (patch: object) => {
      const text = JSON.stringify(manifest(patch));
      return {
        [URL_]: text,
        [`${URL_}.sig`]: signText(Buffer.from(text), `timestamp:1\tfile:stable.json`),
        [`${base}desktop-v0.13.0/SHA256SUMS`]: `${'b'.repeat(64)}  Project.Browser_0.13.0_aarch64.dmg\n`,
      };
    };
    const read = (patch: object) =>
      readDownloads({
        channelUrl: URL_,
        keysFile: keys,
        fetch: serve(files(patch)) as typeof fetch,
        now: () => NOW,
      });
    const mac = await read({});
    expect(mac).toMatchObject({ status: 'available', version: '0.13.0' });
    expect(mac.platforms).toEqual([
      {
        platform: 'macos-arm64',
        label: expect.stringContaining('Apple silicon'),
        kind: 'disk-image',
        url: `${base}desktop-v0.13.0/Project.Browser_0.13.0_aarch64.dmg`,
        sha256: 'b'.repeat(64),
        size_bytes: null,
      },
    ]);
    expect((await read({ paused: true })).status).toBe('paused');
    expect((await read({ revoked_versions: ['0.13.0'] })).status).toBe('not_available');
    // The site answers "not yet available" by default (no release key is trusted yet).
    const res = await h.app.inject({ method: 'GET', url: '/v1/public/downloads' });
    expect(res.json()).toMatchObject({ channel: 'stable', status: 'not_available', platforms: [] });
  });
});

describe('contact form', () => {
  it('stores a valid request, queues it for support, drops honeypot submissions and limits floods', async () => {
    const email = `visitor-${randomBytes(3).toString('hex')}@example.test`;
    const send = (payload: object, ip = '203.0.113.7') =>
      h.app.inject({ method: 'POST', url: '/v1/public/contact', payload, remoteAddress: ip });
    const ok = await send({
      topic: 'sales',
      name: 'Visitor',
      email,
      message: 'How does the team plan work?',
    });
    expect(ok.statusCode, ok.body).toBe(202);
    const stored = await h.owner.query('select topic, name from contact_requests where email = $1', [email]);
    expect(stored.rows).toEqual([{ topic: 'sales', name: 'Visitor' }]);
    const queued = await h.owner.query(
      `select to_email from email_tasks where kind = 'contact_request' and to_email = 'support@example.test'`,
    );
    expect(queued.rowCount).toBeGreaterThan(0);
    const bot = await send(
      { topic: 'other', name: 'Bot', email: `bot-${email}`, message: 'Buy now, buy now!', website: 'spam' },
      '203.0.113.8',
    );
    expect(bot.statusCode).toBe(202);
    expect(
      (await h.owner.query('select 1 from contact_requests where email = $1', [`bot-${email}`])).rowCount,
    ).toBe(0);
    const bad = await send(
      { topic: 'sales', name: 'x', email: 'not-an-email', message: 'short' },
      '203.0.113.9',
    );
    expect(bad.json().code).toBe('VALIDATION_FAILED');
    const flood = [];
    for (let i = 0; i < 6; i++)
      flood.push(
        (
          await send(
            { topic: 'support', name: 'Same', email: `f${i}-${email}`, message: 'Is anyone there please?' },
            '203.0.113.10',
          )
        ).statusCode,
      );
    expect(flood.slice(0, 5).every((s) => s === 202)).toBe(true);
    expect(flood[5]).toBe(429);
  });
});

describe('account settings', () => {
  it('product news needs consent and has a one-click unsubscribe; reminders can be turned off', async () => {
    const me = await h.signIn();
    const get = () => h.app.inject({ method: 'GET', url: '/v1/me/notifications', headers: me.headers });
    expect((await get()).json()).toEqual({ marketing: false, billing_reminders: true });
    const put = await h.app.inject({
      method: 'PUT',
      url: '/v1/me/notifications',
      headers: me.headers,
      payload: { marketing: true, billing_reminders: false },
    });
    expect(put.json()).toEqual({ marketing: true, billing_reminders: false });
    const token = unsubscribeToken(EMAIL_KEY, me.session.user.id);
    // Opening the link only shows a button (a link scanner changes nothing).
    const page = await h.app.inject({ method: 'GET', url: `/v1/public/unsubscribe?token=${token}` });
    expect(page.statusCode).toBe(200);
    expect((await get()).json().marketing).toBe(true);
    const click = await h.app.inject({
      method: 'POST',
      url: `/v1/public/unsubscribe?token=${token}`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'List-Unsubscribe=One-Click',
    });
    expect(click.statusCode).toBe(200);
    expect((await get()).json()).toEqual({ marketing: false, billing_reminders: false });
    const forged = await h.app.inject({
      method: 'POST',
      url: `/v1/public/unsubscribe?token=${me.session.user.id}.${'A'.repeat(43)}`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'List-Unsubscribe=One-Click',
    });
    expect(forged.statusCode).toBe(400);
  });

  it('a deletion request is recorded once, names workspaces needing another owner, and can be withdrawn', async () => {
    const o = await newOrg();
    const ask = () =>
      h.app.inject({
        method: 'POST',
        url: '/v1/me/deletion-request',
        headers: o.owner.headers,
        payload: { confirm: true },
      });
    const first = await ask();
    expect(first.statusCode, first.body).toBe(201);
    expect(first.json()).toMatchObject({
      request: { state: 'pending' },
      sole_owner_of: [{ org_id: o.id, name: 'Portal (test)' }],
    });
    expect((await ask()).json().request.state).toBe('pending');
    const { rows } = await h.owner.query(
      `select count(*)::int as n from account_deletion_requests where user_id = $1`,
      [o.owner.session.user.id],
    );
    expect(rows[0].n).toBe(1);
    const withdrawn = await h.app.inject({
      method: 'DELETE',
      url: '/v1/me/deletion-request',
      headers: o.owner.headers,
    });
    expect(withdrawn.json().request.state).toBe('withdrawn');
    const unconfirmed = await h.app.inject({
      method: 'POST',
      url: '/v1/me/deletion-request',
      headers: o.owner.headers,
      payload: {},
    });
    expect(unconfirmed.json().code).toBe('VALIDATION_FAILED');
  });
});
