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
