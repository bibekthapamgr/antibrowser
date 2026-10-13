import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  API_SCOPES,
  formatApiToken,
  isBlockedAddress,
  JOB_STATES,
  jobTransitionAllowed,
  originAllowed,
  parseApiToken,
  parseIPv6,
  parseOriginPattern,
  planResume,
  SCOPE_PERMISSIONS,
  scopeAllowedForRole,
  scopesAllow,
  stepsProblem,
  webhookUrlProblem,
} from './automation.ts';
import { newId } from './ids.ts';
import { ROLES, roleAllows } from './resources.ts';

const cases = JSON.parse(
  readFileSync(new URL('../fixtures/automation-cases.json', import.meta.url), 'utf8'),
) as {
  patterns: { valid: string[]; invalid: string[] };
  matches: { url: string; patterns: string[]; allowed: boolean }[];
};

describe('approved sites (shared vectors)', () => {
  it('accepts and refuses patterns', () => {
    for (const p of cases.patterns.valid) expect(parseOriginPattern(p), p).not.toBeNull();
    for (const p of cases.patterns.invalid) expect(parseOriginPattern(p), p).toBeNull();
  });
  it('matches addresses exactly as the computer running the job does', () => {
    for (const c of cases.matches) expect(originAllowed(c.url, c.patterns), c.url).toBe(c.allowed);
  });
});

describe('steps', () => {
  const sites = ['https://app.example.com'];
  it('needs an approved first address and allows conditions on approved prefixes only', () => {
    expect(stepsProblem([{ action: 'open_url', url: 'https://app.example.com/login' }], sites)).toBeNull();
    expect(stepsProblem([{ action: 'open_url', url: 'https://other.example.com/' }], sites)?.code).toBe(
      'URL_NOT_APPROVED',
    );
    expect(stepsProblem([{ action: 'screenshot' }], sites)?.reason).toBe('first_step_must_open_url');
    expect(
      stepsProblem(
        [
          { action: 'open_url', url: 'https://app.example.com/' },
          { action: 'wait_for', condition: { type: 'url_prefix', prefix: 'https://evil.example/' } },
        ],
        sites,
      )?.reason,
    ).toBe('url_prefix');
    const many = [
      { action: 'open_url' as const, url: 'https://app.example.com/' },
      ...Array.from({ length: 6 }, () => ({ action: 'screenshot' as const })),
    ];
    expect(stepsProblem(many, sites)?.reason).toBe('too_many_screenshots');
  });
});

describe('job state machine', () => {
  it('only moves forward; finished jobs never change', () => {
    expect(jobTransitionAllowed('QUEUED', 'CLAIMED')).toBe(true);
    expect(jobTransitionAllowed('CLAIMED', 'QUEUED')).toBe(true);
    expect(jobTransitionAllowed('RUNNING', 'QUEUED')).toBe(false);
    expect(jobTransitionAllowed('QUEUED', 'RUNNING')).toBe(false);
    for (const end of ['SUCCEEDED', 'FAILED', 'CANCELED'] as const) {
      for (const s of JOB_STATES) expect(jobTransitionAllowed(end, s)).toBe(false);
    }
  });

  it('resumes at the first unfinished step that is safe to repeat', () => {
    expect(
      planResume([
        { seq: 0, action: 'open_profile', state: 'succeeded' },
        { seq: 1, action: 'open_url', state: 'succeeded' },
        { seq: 2, action: 'wait_for', state: 'running' },
        { seq: 3, action: 'screenshot', state: 'pending' },
      ]),
    ).toEqual({ resumeFrom: 2, unknown: [] });
    expect(
      planResume([
        { seq: 0, action: 'open_profile', state: 'succeeded' },
        { seq: 1, action: 'open_url', state: 'pending' },
      ]),
    ).toEqual({ resumeFrom: 1, unknown: [] });
    expect(planResume([{ seq: 0, action: 'open_profile', state: 'succeeded' }])).toEqual({
      resumeFrom: null,
      unknown: [],
    });
  });

  it('never repeats a step that changes something on a website: its outcome is unknown', () => {
    // A future step kind (none exists in v1): a lost result after an external change is never retried blindly.
    const registry = {
      open_profile: { effect: 'session' as const },
      submit_order: { effect: 'external_mutation' as const },
      screenshot: { effect: 'read' as const },
    };
    const plan = planResume(
      [
        { seq: 0, action: 'open_profile', state: 'succeeded' },
        { seq: 1, action: 'submit_order' as never, state: 'running' },
        { seq: 2, action: 'screenshot', state: 'pending' },
      ],
      registry,
    );
    expect(plan).toEqual({ resumeFrom: null, unknown: [1] });
    // An unknown action is treated as an external change.
    expect(planResume([{ seq: 0, action: 'mystery' as never, state: 'running' }])).toEqual({
      resumeFrom: null,
      unknown: [0],
    });
  });
});

describe('API tokens', () => {
  it('round-trips the token format and refuses anything else', () => {
    const id = newId('apiToken');
    const secret = `${'A'.repeat(20) + 'b-_'.repeat(7)}Zz`;
    const token = formatApiToken(id, secret);
    expect(parseApiToken(token)).toEqual({ tokenId: id, secret });
    expect(parseApiToken(`${token}x`)).toBeNull();
    expect(parseApiToken(token.replace('pbt_', 'pbx_'))).toBeNull();
  });

  it('scopes never exceed a role', () => {
    for (const role of ROLES) {
      for (const scope of API_SCOPES) {
        if (scopeAllowedForRole(role, scope)) {
          for (const p of SCOPE_PERMISSIONS[scope]) expect(roleAllows(role, p)).toBe(true);
        }
      }
    }
    expect(scopeAllowedForRole('operator', 'automation:run')).toBe(true);
    expect(scopeAllowedForRole('operator', 'profiles:write')).toBe(false);
    expect(scopeAllowedForRole('operator', 'automation:debug')).toBe(false);
    expect(scopeAllowedForRole('viewer', 'automation:read')).toBe(false);
    expect(scopeAllowedForRole('admin', 'automation:debug')).toBe(true);
    expect(scopesAllow(['profiles:read'], 'profile.update')).toBe(false);
    expect(scopesAllow(['automation:run'], 'profile.launch')).toBe(true);
    expect(scopesAllow(['automation:run'], 'members.manage')).toBe(false);
  });
});

describe('webhook destinations', () => {
  it('blocks private, loopback, link-local, reserved and embedded addresses', () => {
    const blocked = [
      '127.0.0.1',
      '10.1.2.3',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '224.0.0.1',
      '255.255.255.255',
      '198.18.0.1',
      '::1',
      '::',
      'fe80::1',
      'fc00::1',
      'fd12:3456::1',
      'ff02::1',
      '::ffff:127.0.0.1',
      '::ffff:7f00:1',
      '64:ff9b::a9fe:a9fe',
      '2002:7f00:1::',
      '2001:db8::1',
      '2001::1',
      'not-an-ip',
    ];
    for (const a of blocked) expect(isBlockedAddress(a), a).toBe(true);
    for (const a of ['93.184.216.34', '1.1.1.1', '172.32.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8']) {
      expect(isBlockedAddress(a), a).toBe(false);
    }
    expect(parseIPv6('1:2:3:4:5:6:7:8:9')).toBeNull();
    expect(parseIPv6('1::2::3')).toBeNull();
  });

  it('refuses addresses that are not public HTTPS destinations', () => {
    expect(webhookUrlProblem('https://hooks.example.com/pb')).toBeNull();
    expect(webhookUrlProblem('https://hooks.example.com:8443/pb')).toBeNull();
    expect(webhookUrlProblem('http://hooks.example.com/pb')).toBe('scheme');
    expect(webhookUrlProblem('https://user:pw@hooks.example.com/')).toBe('credentials');
    expect(webhookUrlProblem('https://hooks.example.com/#x')).toBe('fragment');
    expect(webhookUrlProblem('https://hooks.example.com:22/')).toBe('port');
    expect(webhookUrlProblem('https://127.0.0.1/')).toBe('blocked_address');
    expect(webhookUrlProblem('https://[::1]/')).toBe('blocked_address');
    expect(webhookUrlProblem('https://[::ffff:169.254.169.254]/')).toBe('blocked_address');
    expect(webhookUrlProblem('https://localhost/')).toBe('host');
    expect(webhookUrlProblem('https://metadata.internal/')).toBe('blocked_name');
    expect(webhookUrlProblem('https://api.localhost/')).toBe('blocked_name');
    expect(webhookUrlProblem('https://2130706433/')).toBe('host');
    expect(webhookUrlProblem('https://0x7f000001/')).toBe('host');
    expect(webhookUrlProblem('https://intranet/')).toBe('host');
    expect(webhookUrlProblem('https://hooks.example.com\\@evil/')).toBe('whitespace');
    expect(webhookUrlProblem('https://93.184.216.34/hook')).toBeNull();
    // Development and tests may use a local receiver; production configuration never enables this.
    expect(webhookUrlProblem('http://127.0.0.1:9999/hook', true)).toBeNull();
  });
});
