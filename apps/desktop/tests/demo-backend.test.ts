/** The demo backend backs the UI tests, so it must keep the same validation behaviour as the Rust commands. */
import { describe, expect, it } from 'vitest';
import { demoBackend } from '../src/backend/demo.ts';
import type { Backend, ProfileView } from '../src/backend/types.ts';
import { nameKey, sanitizeNotes, secretHint } from '../src/notes.ts';
import { parseProxyLine } from '../src/proxy-line.ts';

const code = async (p: Promise<unknown>) =>
  p.then(
    () => 'OK',
    (e: { code: string }) => e.code,
  );
const all = async (b: Backend, filter = {}) => (await b.profiles.query({ filter, limit: 500 })).rows;
const first = async (b: Backend, pred: (p: ProfileView) => boolean = () => true) => {
  const p = (await all(b)).find(pred);
  if (!p) throw new Error('no profile');
  return p;
};
// Hidden characters are built at runtime so the source never contains them.
const RLO = String.fromCodePoint(0x202e);
const BELL = String.fromCodePoint(7);
const settle = (ms = 900) => new Promise((r) => setTimeout(r, ms));

describe('demo backend', () => {
  it('starts on first run without a workspace and refuses profiles until one exists', async () => {
    const b = demoBackend('fresh');
    expect((await b.workspaces.appState()).first_run).toBe(true);
    expect(await code(b.profiles.create('Shop'))).toBe('NO_WORKSPACE');
    const ws = await b.workspaces.createWorkspace('Agency');
    expect(ws.id).toMatch(/^wsp_[0-9A-HJKMNP-TV-Z]{26}$/);
    const p = await b.profiles.create('Shop', 'Client A');
    expect(p.id).toMatch(/^prf_/);
    expect([p.client_name, p.client_id]).toEqual(['Client A', expect.stringMatching(/^cli_/)]);
    expect((await all(b)).map((x) => x.name)).toEqual(['Shop']);
  });

  it('rejects control characters, oversized search and disallowed URLs', async () => {
    const b = demoBackend();
    expect(await code(b.profiles.create('bad\u0007name'))).not.toBe('OK');
    expect(await code(b.profiles.query({ filter: { text: 'x'.repeat(201) } }))).toBe('INVALID_FILTER');
    expect(await code(b.system.openExternal('http://example.com'))).toBe('DISALLOWED_URL');
    expect(await code(b.system.openExternal('javascript:alert(1)'))).toBe('DISALLOWED_URL');
    expect(await code(b.system.updateSetting('downloads.directory', '/tmp'))).toBe('SETTING_READ_ONLY');
    expect(await code(b.system.updateSetting('nope', 1))).toBe('UNKNOWN_SETTING');
    expect(await code(b.system.updateSetting('profiles.trash_retention_days', '5'))).toBe(
      'INVALID_SETTING_VALUE',
    );
  });

  it('refuses to remove local data while profiles run or without confirmation', async () => {
    const b = demoBackend('running');
    expect(await code(b.system.removeLocalData('yes'))).toBe('CONFIRMATION_REQUIRED');
    expect(await code(b.system.removeLocalData('DELETE'))).toBe('PROFILES_RUNNING');
  });

  it('pages 10,000 profiles by cursor or offset and refuses a cursor from another filter', async () => {
    const b = demoBackend('rows:10000');
    const page = await b.profiles.query({ limit: 200 });
    expect([page.total, page.rows.length]).toEqual([10000, 200]);
    const next = await b.profiles.query({ cursor: page.next_cursor ?? '', limit: 200 });
    expect(next.rows[0]?.name).toBe('Profile 00200');
    expect((await b.profiles.query({ offset: 9990, limit: 50 })).rows).toHaveLength(10);
    expect(await code(b.profiles.query({ cursor: page.next_cursor ?? '', filter: { text: 'x' } }))).toBe(
      'CURSOR_STALE',
    );
  });
});

describe('demo backend run states (mirrors the Rust state machine)', () => {
  it('opens, repeats a launch without a second run, and closes', async () => {
    const b = demoBackend();
    const p = await first(b);
    const op = await b.profiles.launch(p.id);
    expect((await b.profiles.launch(p.id)).operation_id).toBe(op.operation_id);
    await settle();
    expect((await b.profiles.status(p.id)).profile.state).toBe('running');
    await b.profiles.stop(p.id);
    await settle();
    expect((await b.profiles.status(p.id)).profile.state).toBe('stopped');
  });

  it('offers a force close when closing times out', async () => {
    const b = demoBackend('stuck');
    const p = await first(b, (x) => x.state === 'running');
    await b.profiles.stop(p.id);
    await settle();
    const s = await b.profiles.status(p.id);
    expect([s.profile.state, s.profile.force_available]).toEqual(['stopping', true]);
    expect(await code(b.profiles.launch(p.id))).toBe('PROFILE_STOPPING');
    await b.profiles.stop(p.id, true);
    await settle();
    expect((await b.profiles.status(p.id)).profile.state).toBe('stopped');
  });

  it('recovers a crashed profile and refuses launch until the runtime is installed', async () => {
    const crashed = demoBackend('crashed');
    const p = await first(crashed, (x) => x.state === 'crashed');
    expect((await crashed.profiles.status(p.id)).suggested_recovery).toBe('restore_backup');
    await crashed.profiles.recover(p.id, 'restore_backup');
    await settle();
    expect((await crashed.profiles.status(p.id)).profile).toMatchObject({ state: 'stopped', crash_count: 0 });

    const fresh = demoBackend('noruntime');
    const q = await first(fresh);
    expect(await code(fresh.profiles.launch(q.id))).toBe('RUNTIME_NOT_INSTALLED');
    expect(await code(fresh.system.installRuntime('1.2.3.4'))).toBe('RUNTIME_NOT_IN_MANIFEST');
    const rs = await fresh.system.runtimeStatus();
    await fresh.system.installRuntime(rs.browser.manifest?.version ?? '');
    await settle(1500);
    expect((await fresh.system.runtimeStatus()).browser.configured).toBe(true);
  });

  it('validates profile settings like the Rust command', async () => {
    const b = demoBackend();
    const p = await first(b);
    expect(
      await code(b.profiles.update(p.id, { expectedVersion: p.version, startUrls: ['file:///etc/passwd'] })),
    ).toBe('BAD_START_URL');
    expect(
      await code(b.profiles.update(p.id, { expectedVersion: p.version, notes: 'Password: hunter2' })),
    ).toBe('NOTES_LOOK_SECRET');
    expect(await code(b.profiles.update(p.id, { expectedVersion: p.version, clientId: 'cli_X' }))).toBe(
      'UNKNOWN_CLIENT',
    );
    const ok = await b.profiles.update(p.id, {
      expectedVersion: p.version,
      startUrls: ['https://a.example/'],
      camera: 'block',
      tags: ['VIP', 'vip', 'Ads'],
      notes: `call${RLO} on Mondays`,
    });
    expect([ok.start_urls, ok.permissions.camera, ok.notes]).toEqual([
      ['https://a.example/'],
      'block',
      'call on Mondays',
    ]);
    // "Ads" reuses the existing tag "ads"; "vip" folds into "VIP".
    expect(ok.tags.map((t) => t.name)).toEqual(['ads', 'VIP']);
    expect(await code(b.profiles.update(p.id, { expectedVersion: p.version, name: 'stale' }))).toBe(
      'VERSION_CONFLICT',
    );
  });
});

describe('demo backend library (milestone 04)', () => {
  it('keeps clients and tags unique per workspace by folded name, while profile names may repeat', async () => {
    const b = demoBackend();
    const a = await b.profiles.create('Same', 'Client Ä');
    const c = await b.profiles.create('Same', 'client a');
    expect(a.id).not.toBe(c.id);
    expect(a.client_id).toBe(c.client_id);
    expect(await code(b.library.createClient('CLIENT NORTH'))).toBe('DUPLICATE_NAME');
    expect(nameKey('  Café ')).toBe('cafe');
    const lib = await b.library.library();
    expect(lib.counts).toMatchObject({ active: 5, archived: 1, trash: 1 });
  });

  it('searches names, clients and tags, filters by view and sorts', async () => {
    const b = demoBackend();
    expect((await all(b, { text: 'north' })).map((p) => p.name)).toEqual(['Shop admin']);
    expect((await all(b, { text: 'QA' })).map((p) => p.name)).toEqual(['Ads QA']);
    expect((await all(b, { view: 'trash' })).map((p) => p.name)).toEqual(['Test account']);
    expect((await all(b, { favourites_only: true })).map((p) => p.name)).toEqual(['Shop admin']);
    const desc = await b.profiles.query({ sort: { key: 'name', descending: true } });
    expect(desc.rows[0]?.name).toBe('Support desk');
  });

  it('applies bulk actions per profile, refuses open profiles for the trash, and undoes', async () => {
    const b = demoBackend('running');
    const rows = await all(b);
    const open = rows.find((p) => p.state === 'running');
    const ids = rows.map((p) => p.id);
    const r = await b.profiles.bulk(
      { action: 'trash' },
      { kind: 'ids', ids: [...ids, 'prf_00000000000000000000000000'] },
    );
    expect([r.requested, r.changed, r.failed.length]).toEqual([4, 2, 2]);
    expect(r.failed.map((f) => f.code).sort()).toEqual(['PROFILE_RUNNING', 'UNKNOWN_PROFILE']);
    expect(r.failed.find((f) => f.code === 'PROFILE_RUNNING')?.id).toBe(open?.id);
    expect((await all(b, { view: 'trash' })).length).toBe(2);
    expect(await b.profiles.undo(r.undo_token ?? '')).toEqual({ restored: 2, skipped: 0 });
    expect((await all(b, { view: 'trash' })).length).toBe(0);
    expect(await code(b.profiles.undo(r.undo_token ?? ''))).toBe('UNDO_EXPIRED');
  });

  it('checks "all matching" selections against the count the user saw', async () => {
    const b = demoBackend('rows:300');
    const tagged = await b.profiles.bulk(
      { action: 'add_tag', tag_name: 'Batch' },
      { kind: 'filter', filter: {}, expected_total: 300 },
    );
    expect(tagged.changed).toBe(300);
    expect(
      await code(b.profiles.bulk({ action: 'archive' }, { kind: 'filter', filter: {}, expected_total: 299 })),
    ).toBe('SELECTION_CHANGED');
    // An undo skips profiles that changed after the action.
    const p = await first(b);
    await b.profiles.update(p.id, { expectedVersion: p.version, name: 'Edited' });
    expect(await b.profiles.undo(tagged.undo_token ?? '')).toEqual({ restored: 299, skipped: 1 });
  });

  it('deletes only from the trash, with the confirmed count', async () => {
    const b = demoBackend();
    const trashed = await all(b, { view: 'trash' });
    const active = await first(b);
    const sel = { kind: 'ids' as const, ids: [...trashed.map((p) => p.id), active.id] };
    expect(await code(b.profiles.deletePermanently(sel, 1))).toBe('CONFIRMATION_REQUIRED');
    const r = await b.profiles.deletePermanently(sel, 2);
    expect([r.changed, r.failed[0]?.code]).toEqual([1, 'NOT_IN_TRASH']);
    expect(await all(b, { view: 'trash' })).toEqual([]);
  });

  it('creates from a template with empty storage and duplicates without sessions', async () => {
    const b = demoBackend();
    const lib = await b.library.library();
    const t = lib.templates[0];
    const p = await b.profiles.create('From template', undefined, t?.id);
    expect([p.template_id, p.start_urls, p.permissions.camera]).toEqual([
      t?.id,
      ['https://shop.example/admin'],
      'block',
    ]);
    expect(p.last_started_at).toBeNull();
    const copy = await b.profiles.duplicate(p.id, 'Copy');
    expect([copy.start_urls, copy.last_started_at, copy.notes]).toEqual([
      ['https://shop.example/admin'],
      null,
      '',
    ]);
  });

  it('previews an import with row errors, then imports once even when run again', async () => {
    const b = demoBackend();
    const f = await b.transfer.chooseFile();
    const preview = await b.transfer.preview(f.file_ref ?? '', {});
    expect(preview).toMatchObject({ total: 10, invalid: 3, will_skip: 2, will_create: 5 });
    expect(preview.errors.map((e) => [e.row, e.field])).toEqual([
      [5, 'name'],
      [6, 'start_urls'],
      [10, 'template'],
    ]);
    expect(preview.rows.find((r) => r.name === 'Social')?.warnings[0]).toMatch(/notes left out/);
    await b.transfer.commit(preview.preview_id ?? '');
    await settle(300);
    const jobs = await b.transfer.jobs();
    expect(jobs[0]).toMatchObject({ status: 'completed_with_errors', succeeded: 5, failed: 3, skipped: 2 });
    const again = await b.transfer.preview(f.file_ref ?? '', {});
    expect([again.already_imported, again.will_create]).toEqual([5, 0]);
    expect((await all(b, { text: 'Social' }))[0]?.notes).toBe('');
  });

  it('cancels a 10,000-row import and continues without duplicates', async () => {
    const b = demoBackend('bigimport');
    const f = await b.transfer.chooseFile();
    const preview = await b.transfer.preview(f.file_ref ?? '', {});
    expect([preview.total, preview.invalid]).toEqual([10000, 1]);
    const id = preview.preview_id ?? '';
    await b.transfer.commit(id);
    await settle(150);
    await b.transfer.cancel(id);
    await settle(150);
    const partial = (await b.transfer.jobs())[0];
    expect(partial?.status).toBe('cancelled');
    expect(partial?.succeeded).toBeGreaterThan(0);
    expect(partial?.succeeded).toBeLessThan(9999);
    await b.transfer.commit(id);
    await settle(2500);
    const done = (await b.transfer.jobs())[0];
    expect(done?.status).toBe('completed_with_errors');
    expect((await b.profiles.query({ filter: { text: 'Imported' } })).total).toBe(9999);
  });

  it('reports an unsafe archive as a file error and imports nothing', async () => {
    const b = demoBackend('unsafeimport');
    const f = await b.transfer.chooseFile();
    const preview = await b.transfer.preview(f.file_ref ?? '', {});
    expect([preview.file_error?.code, preview.preview_id]).toEqual(['UNSAFE_ARCHIVE', null]);
  });

  it('flags secrets in notes and strips hidden characters', () => {
    expect(secretHint('Password: hunter2')).not.toBeNull();
    expect(secretHint('4111 1111 1111 1111')).not.toBeNull();
    expect(secretHint('Uses the password manager')).toBeNull();
    expect(sanitizeNotes(`a\r\nb${RLO}c${BELL}  `)).toBe('a\nbc');
  });
});

describe('proxies and privacy (milestone 05)', () => {
  const secret = ['pw', 'Zq7', 'Lm'].join('-');

  it('parses pasted proxy lines into fields without keeping a URL', () => {
    expect(parseProxyLine('proxy.example.net:8080')).toEqual({ host: 'proxy.example.net', port: 8080 });
    expect(parseProxyLine('proxy.example.net:8080:alice:pa:ss')).toEqual({
      host: 'proxy.example.net',
      port: 8080,
      username: 'alice',
      password: 'pa:ss',
    });
    expect(parseProxyLine('socks5://bob:p%40ss@10.0.0.2:1080/')).toEqual({
      type: 'socks5',
      host: '10.0.0.2',
      port: 1080,
      username: 'bob',
      password: 'p@ss',
    });
    expect(parseProxyLine('https://[2001:db8::1]:443')).toEqual({
      type: 'https',
      host: '2001:db8::1',
      port: 443,
    });
    expect(parseProxyLine('host:99999')).toBeNull();
    expect(parseProxyLine('  ')).toBeNull();
  });

  it('validates proxies like the Rust commands and never returns a login', async () => {
    const b = demoBackend();
    const base = { name: 'P', type: 'http' as const, host: 'proxy.example.net', port: 8080 };
    expect(await code(b.network.createProxy({ ...base, host: 'http://x.example' }))).toBe('PROXY_BAD_HOST');
    expect(await code(b.network.createProxy({ ...base, port: 0 }))).toBe('PROXY_BAD_PORT');
    expect(await code(b.network.createProxy({ ...base, host: '127.0.0.1' }))).toBe('PROXY_PRIVATE_ADDRESS');
    expect(await code(b.network.createProxy({ ...base, host: '169.254.169.254' }))).toBe(
      'PROXY_FORBIDDEN_ADDRESS',
    );
    expect(await code(b.network.createProxy({ ...base, login: { username: 'a:b', password: 'c' } }))).toBe(
      'PROXY_BAD_CREDENTIALS',
    );
    expect(await code(b.network.createProxy({ ...base, expires_at: '2026-13-40' }))).toBe('INVALID_DATE');
    const p = await b.network.createProxy({ ...base, login: { username: 'alice', password: secret } });
    expect(p.has_login).toBe(true);
    expect(JSON.stringify(await b.network.proxies())).not.toContain(secret);
    await b.system.updateSetting('proxies.allow_private_addresses', true);
    expect((await b.network.createProxy({ ...base, name: 'Local', host: '127.0.0.1' })).host).toBe(
      '127.0.0.1',
    );
  });

  it('assigns proxies with versions, protects used proxies and reports checks', async () => {
    const b = demoBackend();
    const shop = await first(b, (p) => p.name === 'Ads QA');
    const [px] = await b.network.proxies();
    if (!px) throw new Error('no proxy');
    expect(await code(b.network.assign(shop.id, px.id, true, shop.version + 5))).toBe('VERSION_CONFLICT');
    const v = await b.network.assign(shop.id, px.id, true, shop.version);
    expect([v.proxy_label, v.network.status]).toEqual([px.name, 'ready']);
    expect(await code(b.network.deleteProxy(px.id))).toBe('PROXY_IN_USE');
    const c = await b.network.testProxy(px.id);
    expect([c.result, c.egress_ip !== null]).toEqual(['ok', true]);
    expect((await b.network.checks(px.id))[0]?.id).toBe(c.id);
  });

  it('asks for a missing login before opening and shows a failing proxy', async () => {
    const missing = demoBackend('nologin');
    const shop = await first(missing, (p) => p.name === 'Shop admin');
    expect(await code(missing.profiles.launch(shop.id))).toBe('PROXY_CREDENTIALS_MISSING');
    const down = demoBackend('proxydown');
    const s = await first(down, (p) => p.name === 'Shop admin');
    await down.profiles.launch(s.id);
    await settle();
    expect((await first(down, (p) => p.id === s.id)).network.status).toBe('failing');
  });

  it('validates privacy settings and reports what this OS cannot apply', async () => {
    const b = demoBackend('win');
    const v = await b.network.validatePrivacy({ timezone: 'Asia/Kathmandu', language: 'ne-NP' }, false);
    expect(v.valid).toBe(true);
    expect(v.report.find((r) => r.field === 'timezone')?.support).toBe('unavailable');
    expect((await b.network.validatePrivacy({ language: 'xx-XX' }, false)).error?.code).toBe(
      'INVALID_LANGUAGE',
    );
    const p = await first(b);
    expect(
      await code(b.profiles.update(p.id, { expectedVersion: p.version, privacy: { timezone: 'Mars/Base' } })),
    ).toBe('INVALID_TIMEZONE');
    const options = await b.network.privacyOptions();
    expect(options.presets.every((x) => x.config.preset === x.id)).toBe(true);
  });
});
