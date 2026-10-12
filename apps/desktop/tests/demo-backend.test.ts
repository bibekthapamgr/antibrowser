/** The demo backend backs the UI tests, so it must keep the same validation behaviour as the Rust commands. */
import { describe, expect, it } from 'vitest';
import { demoBackend } from '../src/backend/demo.ts';

const code = async (p: Promise<unknown>) =>
  p.then(
    () => 'OK',
    (e: { code: string }) => e.code,
  );

describe('demo backend', () => {
  it('starts on first run without a workspace and refuses profiles until one exists', async () => {
    const b = demoBackend('fresh');
    expect((await b.workspaces.appState()).first_run).toBe(true);
    expect(await code(b.profiles.create('Shop'))).toBe('NO_WORKSPACE');
    const ws = await b.workspaces.createWorkspace('Agency');
    expect(ws.id).toMatch(/^wsp_[0-9A-HJKMNP-TV-Z]{26}$/);
    const p = await b.profiles.create('Shop', 'Client A');
    expect(p.id).toMatch(/^prf_/);
    expect((await b.profiles.list()).map((x) => x.name)).toEqual(['Shop']);
  });

  it('rejects control characters, oversized search and disallowed URLs', async () => {
    const b = demoBackend();
    expect(await code(b.profiles.create('bad\u0007name'))).not.toBe('OK');
    expect(await code(b.profiles.list('x'.repeat(201)))).toBe('QUERY_TOO_LONG');
    expect(await code(b.system.openExternal('http://example.com'))).toBe('DISALLOWED_URL');
    expect(await code(b.system.openExternal('javascript:alert(1)'))).toBe('DISALLOWED_URL');
    expect(await code(b.system.updateSetting('downloads.directory', '/tmp'))).toBe('SETTING_READ_ONLY');
    expect(await code(b.system.updateSetting('nope', 1))).toBe('UNKNOWN_SETTING');
  });

  it('refuses to remove local data while profiles run or without confirmation', async () => {
    const b = demoBackend('running');
    expect(await code(b.system.removeLocalData('yes'))).toBe('CONFIRMATION_REQUIRED');
    expect(await code(b.system.removeLocalData('DELETE'))).toBe('PROFILES_RUNNING');
  });

  it('generates large lists for virtualization tests', async () => {
    const b = demoBackend('rows:10000');
    expect(await b.profiles.list()).toHaveLength(10000);
  });
});

describe('demo backend run states (mirrors the Rust state machine)', () => {
  const settle = () => new Promise((r) => setTimeout(r, 900));

  it('opens, repeats a launch without a second run, and closes', async () => {
    const b = demoBackend();
    const [p] = await b.profiles.list();
    if (!p) throw new Error('no profile');
    const first = await b.profiles.launch(p.id);
    expect((await b.profiles.launch(p.id)).operation_id).toBe(first.operation_id);
    await settle();
    expect((await b.profiles.status(p.id)).profile.state).toBe('running');
    await b.profiles.stop(p.id);
    await settle();
    expect((await b.profiles.status(p.id)).profile.state).toBe('stopped');
  });

  it('offers a force close when closing times out', async () => {
    const b = demoBackend('stuck');
    const p = (await b.profiles.list()).find((x) => x.state === 'running');
    if (!p) throw new Error('no profile');
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
    const p = (await crashed.profiles.list()).find((x) => x.state === 'crashed');
    if (!p) throw new Error('no profile');
    expect((await crashed.profiles.status(p.id)).suggested_recovery).toBe('restore_backup');
    await crashed.profiles.recover(p.id, 'restore_backup');
    await settle();
    expect((await crashed.profiles.status(p.id)).profile).toMatchObject({ state: 'stopped', crash_count: 0 });

    const fresh = demoBackend('noruntime');
    const [q] = await fresh.profiles.list();
    if (!q) throw new Error('no profile');
    expect(await code(fresh.profiles.launch(q.id))).toBe('RUNTIME_NOT_INSTALLED');
    expect(await code(fresh.system.installRuntime('1.2.3.4'))).toBe('RUNTIME_NOT_IN_MANIFEST');
    const rs = await fresh.system.runtimeStatus();
    await fresh.system.installRuntime(rs.browser.manifest?.version ?? '');
    await new Promise((r) => setTimeout(r, 1500));
    expect((await fresh.system.runtimeStatus()).browser.configured).toBe(true);
  });

  it('validates profile settings like the Rust command', async () => {
    const b = demoBackend();
    const [p] = await b.profiles.list();
    if (!p) throw new Error('no profile');
    expect(await code(b.profiles.update(p.id, { expectedVersion: 1, clientColour: 'red' }))).toBe(
      'INVALID_COLOUR',
    );
    expect(
      await code(b.profiles.update(p.id, { expectedVersion: 1, startUrls: ['file:///etc/passwd'] })),
    ).toBe('BAD_START_URL');
    const ok = await b.profiles.update(p.id, {
      expectedVersion: 1,
      clientColour: '#0e7490',
      startUrls: ['https://a.example/'],
      camera: 'block',
    });
    expect([ok.client_colour, ok.start_urls, ok.permissions.camera]).toEqual([
      '#0e7490',
      ['https://a.example/'],
      'block',
    ]);
  });
});
