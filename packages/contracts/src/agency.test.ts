import { describe, expect, it } from 'vitest';
import {
  bookmarkUrlProblem,
  cleanLabel,
  type ExtensionRule,
  isSensitivePermission,
  judgeExtension,
  validVersionRange,
  versionInRange,
} from './agency.ts';

describe('bookmark URLs', () => {
  it('allows http and https only, without credentials or whitespace', () => {
    expect(bookmarkUrlProblem('https://admin.shop.example/orders?status=open')).toBeNull();
    expect(bookmarkUrlProblem('http://intranet.example:8080/')).toBeNull();
    for (const [url, problem] of [
      ['javascript:alert(1)', 'scheme'],
      ['JAVASCRIPT:alert(1)', 'scheme'],
      ['data:text/html,<b>x</b>', 'scheme'],
      ['file:///etc/passwd', 'scheme'],
      ['chrome://settings', 'scheme'],
      ['ftp://files.example/', 'scheme'],
      ['//example.com', 'scheme'],
      ['https://user:pw@example.com/', 'credentials'],
      ['https://user@example.com/', 'credentials'],
      ['https://exa mple.com/', 'whitespace'],
      ['https://example.com/\u0000', 'whitespace'],
      [`https://example.com/${'a'.repeat(2048)}`, 'too_long'],
      ['https://', 'invalid'],
    ] as const) {
      expect(bookmarkUrlProblem(url), url).toBe(problem);
    }
  });

  it('cleans labels of hidden characters', () => {
    expect(cleanLabel('  Orders‮  admin\u0007 ')).toBe('Orders admin');
  });
});

describe('extension version ranges', () => {
  it('matches exact, prefix and comparison ranges', () => {
    expect(versionInRange('1.2.3', null)).toBe(true);
    expect(versionInRange('1.2.3', '1.2.3')).toBe(true);
    expect(versionInRange('1.2.3.0', '1.2.3')).toBe(true);
    expect(versionInRange('1.2.4', '1.2.3')).toBe(false);
    expect(versionInRange('1.2.9', '1.2.*')).toBe(true);
    expect(versionInRange('1.3.0', '1.2.*')).toBe(false);
    expect(versionInRange('1.9', '>=1.2 <2')).toBe(true);
    expect(versionInRange('2.0', '>=1.2 <2')).toBe(false);
    expect(versionInRange('1.1.99', '>=1.2 <2')).toBe(false);
    expect(versionInRange('10.0', '>9')).toBe(true);
    expect(versionInRange('1.2.3-beta', '>=1')).toBe(false);
    expect(versionInRange('1.2', 'latest')).toBe(false);
  });

  it('accepts only ranges that parse', () => {
    for (const ok of ['1', '1.2.3.4', '1.2.*', '>=1.2 <2', '=3', '<=4.1'])
      expect(validVersionRange(ok), ok).toBe(true);
    for (const bad of ['', '*', '1.2.3.4.5', '>= 1', '~1.2', '^1', 'latest', '1 2 3 4 5'])
      expect(validVersionRange(bad), bad).toBe(false);
  });
});

describe('extension policy', () => {
  const ID = 'a'.repeat(32);
  const rule = (r: Partial<ExtensionRule> = {}): ExtensionRule => ({
    extension_id: ID,
    name: 'Grammar helper',
    decision: 'allowed',
    source: 'web_store',
    approved_version_range: '>=4 <5',
    permissions: ['storage', 'activeTab'],
    ...r,
  });
  const item = (
    i: Partial<{ version: string; source: 'web_store' | 'unpacked'; permissions: string[] }> = {},
  ) => ({
    id: ID,
    version: '4.2.0',
    source: 'web_store' as const,
    permissions: ['storage', 'activeTab'],
    ...i,
  });

  it('flags sensitive permissions and all-site host patterns', () => {
    for (const p of [
      '<all_urls>',
      '*://*/*',
      'https://*/*',
      'http://*/*',
      'cookies',
      'webRequest',
      'debugger',
    ])
      expect(isSensitivePermission(p), p).toBe(true);
    for (const p of ['storage', 'alarms', 'https://mail.example.com/*', 'notifications'])
      expect(isSensitivePermission(p), p).toBe(false);
  });

  it('judges blocked, unlisted, source, version and expanded permissions', () => {
    expect(judgeExtension([rule()], item())).toEqual({ status: 'approved' });
    expect(judgeExtension([], item())).toEqual({ status: 'not_listed' });
    expect(judgeExtension([rule({ decision: 'blocked' })], item())).toEqual({ status: 'blocked' });
    expect(judgeExtension([rule()], item({ source: 'unpacked' }))).toEqual({ status: 'source_not_allowed' });
    expect(judgeExtension([rule({ source: 'any' })], item({ source: 'unpacked' }))).toEqual({
      status: 'approved',
    });
    expect(judgeExtension([rule()], item({ version: '5.0.0' }))).toEqual({
      status: 'version_not_approved',
      version: '5.0.0',
    });
    expect(
      judgeExtension([rule()], item({ permissions: ['storage', 'activeTab', '<all_urls>', 'alarms'] })),
    ).toEqual({ status: 'permissions_need_review', permissions: ['<all_urls>'] });
  });
});
