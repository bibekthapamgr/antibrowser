/**
 * Milestone 11: the support console's page at /console/ (CONSOLE_DIR). Only files of the bundle, read at start-up,
 * are served; nothing outside the directory (no traversal, no symbolic links); the strict CSP names only the identity
 * provider's origin besides the page's own; organization credentials never reach the staff routes.
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { consoleCsp } from '@pb/contracts/billing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { redactUrl } from '../src/app.ts';
import { loadConsoleFiles } from '../src/routes/console.ts';
import { type Harness, harness } from './helpers.ts';
import { TEST_ISSUER } from './idp.ts';

describe('support console page', () => {
  let h: Harness;
  let plain: Harness;
  let root: string;
  let dir: string;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'pb-console-'));
    dir = join(root, 'dist');
    mkdirSync(join(dir, 'assets'), { recursive: true });
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>console</title>');
    writeFileSync(join(dir, 'assets', 'index-abc.js'), 'console.log(1)');
    writeFileSync(join(dir, 'assets', 'index-abc.css'), 'body{}');
    writeFileSync(join(root, 'secret.txt'), 'outside the bundle');
    symlinkSync(join(root, 'secret.txt'), join(dir, 'link.txt'));
    h = await harness({ env: { CONSOLE_DIR: dir } });
    plain = await harness();
  });
  afterAll(async () => {
    await h?.close();
    await plain?.close();
    rmSync(root, { recursive: true, force: true });
  });

  const get = (url: string, x = h) => x.app.inject({ method: 'GET', url });

  it('serves the page with the console CSP and protective headers', async () => {
    const redirect = await get('/console');
    expect(redirect.statusCode).toBe(308);
    expect(redirect.headers.location).toBe('/console/');

    const page = await get('/console/');
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-type']).toContain('text/html');
    const issuer = new URL(TEST_ISSUER).origin;
    expect(page.headers['content-security-policy']).toBe(consoleCsp(issuer));
    expect(page.headers['content-security-policy']).toContain("script-src 'self';");
    expect(page.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(page.headers['referrer-policy']).toBe('no-referrer');
    expect(page.headers['x-frame-options']).toBe('DENY');
    expect(page.headers['cache-control']).toBe('no-store');
    expect(page.body).toContain('<title>console</title>');

    const js = await get('/console/assets/index-abc.js');
    expect(js.statusCode).toBe(200);
    expect(js.headers['content-type']).toContain('text/javascript');
    expect((await get('/console/assets/index-abc.css')).headers['content-type']).toContain('text/css');
    // Paths without an extension are the page itself (hash routing; the provider's redirect back has a query).
    expect((await get('/console/orgs')).body).toContain('<title>console</title>');
    expect((await get('/console/?code=abc&state=def')).statusCode).toBe(200);
  });

  it('serves nothing outside the bundle', async () => {
    for (const url of [
      '/console/link.txt',
      '/console/../secret.txt',
      '/console/%2e%2e/secret.txt',
      '/console/assets/../../secret.txt',
      '/console/missing.js',
      '/console/assets/%2e%2e%2f%2e%2e%2fsecret.txt',
    ]) {
      const res = await get(url);
      expect(res.body, url).not.toContain('outside the bundle');
      expect([404, 200], url).toContain(res.statusCode);
      if (res.statusCode === 200) expect(res.body, url).toContain('<title>console</title>');
    }
    expect((await get('/console/missing.js')).statusCode).toBe(404);
    expect([...loadConsoleFiles(dir).keys()].sort()).toEqual([
      'assets/index-abc.css',
      'assets/index-abc.js',
      'index.html',
    ]);
  });

  it('the identity provider’s code in the console address never reaches the logs', async () => {
    expect(redactUrl('/console/?code=abc.def&state=xyz&iss=http%3A%2F%2Fidp')).toBe(
      '/console/?code=[redacted]&state=[redacted]&iss=http%3A%2F%2Fidp',
    );
    const lines: string[] = [];
    const logged = await harness({ env: { CONSOLE_DIR: dir }, logLines: lines });
    try {
      const code = `kc-${'c0de'.repeat(6)}`;
      const res = await logged.app.inject({ method: 'GET', url: `/console/?code=${code}&state=st4te-value` });
      expect(res.statusCode).toBe(200);
      expect(lines.join('\n')).toContain('/console/');
      expect(lines.join('\n')).not.toContain(code);
      expect(lines.join('\n')).not.toContain('st4te-value');
    } finally {
      await logged.close();
    }
  });

  it('is absent when CONSOLE_DIR is not set, and a bundle without a page is refused', async () => {
    expect((await get('/console/', plain)).statusCode).toBe(404);
    const empty = mkdtempSync(join(tmpdir(), 'pb-console-empty-'));
    try {
      expect(() => loadConsoleFiles(empty)).toThrow(/no index.html/);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it('staff routes refuse organization sessions and missing tokens', async () => {
    const member = await h.signIn();
    for (const headers of [{}, member.headers]) {
      const res = await h.app.inject({ method: 'GET', url: '/v1/support/alerts', headers });
      expect(res.statusCode).toBe(401);
    }
  });
});
