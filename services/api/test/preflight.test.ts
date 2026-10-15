/**
 * R6 (ADR-0025): the production preflight's checks. The machine facts are made up here; the database checks run
 * against the test database as the application and owner roles.
 */
import { randomBytes } from 'node:crypto';
import { loadConfig } from '@pb/config/env';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  checkArtifact,
  checkBackups,
  checkDatabase,
  checkDevAuth,
  checkEmail,
  checkFiles,
  checkPrivatePorts,
  checkReleaseKeys,
  checkRuntime,
  checkStaff,
  checkTlsMode,
  checkWebhook,
  type MachineFacts,
  redactReport,
} from '../src/preflight.ts';
import { type Harness, harness } from './helpers.ts';

let h: Harness;
beforeAll(async () => {
  h = await harness();
});
afterAll(async () => {
  await h.close();
});

const now = 1_800_000_000;
const facts = (over: Partial<MachineFacts> = {}): MachineFacts => ({
  env: 'prod',
  tls_mode: 'public',
  listeners: ['0.0.0.0:22', '[::]:22', '*:80', '*:443', '127.0.0.1:5432', '127.0.0.1:8080', '[::1]:8081'],
  private_ports: [5432, 8080, 8081, 8333],
  public_ports: [22, 80, 443],
  files: [
    { path: '/etc/project-browser/oidc.env', mode: '600', owner: 'root:root', expect: '600 root:root' },
  ],
  backup: {
    configured: true,
    newest_backup_epoch: now - 3600,
    newest_backup_type: 'diff',
    last_archived_epoch: now - 60,
    last_failed_epoch: null,
    objects_copied_epoch: now - 120,
  },
  proxy_active: true,
  now_epoch: now,
  ...over,
});

describe('machine checks', () => {
  it('private ports: loopback only for the database, API, sign-in and storage; the proxy must run', () => {
    expect(checkPrivatePorts(facts()).status).toBe('pass');
    const exposed = checkPrivatePorts(facts({ listeners: ['0.0.0.0:5432', '*:8080', '127.0.0.1:8333'] }));
    expect(exposed.status).toBe('fail');
    expect(exposed.detail).toBe('listening publicly: 5432, 8080');
    expect(checkPrivatePorts(facts({ proxy_active: false })).status).toBe('fail');
    const other = checkPrivatePorts(facts({ listeners: ['0.0.0.0:3306', '*:443'] }));
    expect(other.status).toBe('warn');
    expect(other.detail).toMatch(/3306/);
  });

  it('backups: recent database backup, log archiving not failing, objects copied minutes ago', () => {
    expect(checkBackups(facts()).status).toBe('pass');
    const b = facts().backup;
    expect(checkBackups(facts({ backup: { ...b, configured: false } })).status).toBe('fail');
    // A failed backup: the newest archive attempt failed (R2 unreachable, wrong credentials).
    const failing = checkBackups(
      facts({ backup: { ...b, last_failed_epoch: now - 10, last_archived_epoch: now - 600 } }),
    );
    expect(failing.status).toBe('fail');
    expect(failing.detail).toMatch(/archiving to R2 is failing/);
    // An old failure followed by a success is history, not a failure now.
    expect(checkBackups(facts({ backup: { ...b, last_failed_epoch: now - 900 } })).status).toBe('pass');
    expect(checkBackups(facts({ backup: { ...b, newest_backup_epoch: now - 9 * 86400 } })).status).toBe(
      'fail',
    );
    expect(checkBackups(facts({ backup: { ...b, newest_backup_epoch: now - 30 * 3600 } })).status).toBe(
      'warn',
    );
    expect(checkBackups(facts({ backup: { ...b, newest_backup_epoch: null } })).status).toBe('fail');
    expect(checkBackups(facts({ backup: { ...b, objects_copied_epoch: now - 3600 } })).status).toBe('fail');
  });

  it('secret files, certificates, release keys, runtime and download eligibility', () => {
    expect(checkFiles(facts()).status).toBe('pass');
    const loose = checkFiles(
      facts({
        files: [
          { path: '/etc/project-browser/smtp.env', mode: '644', owner: 'root:root', expect: '600 root:root' },
        ],
      }),
    );
    expect(loose).toMatchObject({
      status: 'fail',
      detail: '/etc/project-browser/smtp.env is 644 root:root (expected 600 root:root)',
    });
    expect(checkTlsMode(facts({ tls_mode: 'internal' })).status).toBe('fail');
    expect(checkTlsMode(facts({ tls_mode: 'internal', env: 'staging' })).status).toBe('warn');
    expect(checkReleaseKeys({ keys: [] }).status).toBe('fail');
    expect(checkReleaseKeys({ keys: [{ id: 'k1' }] }).status).toBe('pass');
    expect(
      checkRuntime({ distribution: { name: 'Chrome for Testing', customer_distribution: false } }).status,
    ).toBe('fail');
    expect(
      checkRuntime({ distribution: { name: 'Licensed build', customer_distribution: true } }).status,
    ).toBe('pass');
    expect(checkArtifact({ status: 'not_available' }).status).toBe('fail');
    expect(checkArtifact({ status: 'available', version: '1.0.0' }).status).toBe('pass');
  });
});

describe('configuration and database checks', () => {
  const key = () => ['sk', 'live', randomBytes(12).toString('hex')].join('_');

  it('development sign-in must be off and refused by the public API', () => {
    const dev = loadConfig({ ...process.env, APP_ENV: 'test' });
    expect(checkDevAuth(dev, 401).status).toBe('fail');
    const prodLike = { ...dev, appEnv: 'prod' as const, devAuth: { enabled: false as const } };
    expect(checkDevAuth(prodLike, 401).status).toBe('pass');
    expect(checkDevAuth(prodLike, 200).status).toBe('fail');
    expect(checkDevAuth(prodLike, null).status).toBe('warn');
  });

  it('the application role cannot bypass row-level security and sees nothing without a tenant', async () => {
    const c = await h.pool.connect();
    try {
      const res = await checkDatabase(c);
      expect(res, res.detail).toMatchObject({ id: 'database_rls', status: 'pass' });
    } finally {
      c.release();
    }
  });

  it('e-mail, webhook and staff checks need real evidence', async () => {
    const owner = await h.owner.connect();
    try {
      const base = loadConfig({ ...process.env, APP_ENV: 'test' });
      expect((await checkEmail(owner, { ...base, email: { ...base.email, smtpUrl: null } })).status).toBe(
        'fail',
      );
      const withMail = { ...base, email: { ...base.email, smtpUrl: 'smtp://mail.example:587' } };
      const sent = await owner.query<{ n: number }>(
        "select count(*)::int as n from email_tasks where state = 'sent' and sent_at > now() - interval '30 days'",
      );
      const mail = await checkEmail(owner, withMail);
      if ((sent.rows[0]?.n ?? 0) > 0) expect(['pass', 'warn']).toContain(mail.status);
      else expect(mail).toMatchObject({ status: 'fail', detail: expect.stringMatching(/contact form/) });

      expect(
        (await checkWebhook(owner, { ...base, billing: { ...base.billing, stripe: null } })).status,
      ).toBe('fail');
      const live = {
        ...base,
        appEnv: 'prod' as const,
        billing: {
          ...base.billing,
          stripe: {
            secretKey: key(),
            webhookSecrets: ['whsec_x'],
            apiBase: 'https://api.stripe.com',
            livemode: true,
          },
        },
      };
      // No live-mode event has ever reached the test database: not proven yet.
      const res = await checkWebhook(owner, live);
      expect(res.status).toBe('fail');
      expect(res.detail).toMatch(/no signed live-mode event/);
      expect(JSON.stringify(res)).not.toContain(live.billing.stripe.secretKey);
      const testKeyInProd = {
        ...live,
        billing: { ...live.billing, stripe: { ...live.billing.stripe, livemode: false } },
      };
      expect((await checkWebhook(owner, testKeyInProd)).detail).toMatch(/test key/);

      const noMfa = { ...base, console: { ...base.console, requireMfa: false } };
      expect((await checkStaff(owner, noMfa)).status).toBe('fail');
    } finally {
      owner.release();
    }
  });

  it('a report never carries a configured secret value', () => {
    const secret = randomBytes(24).toString('hex');
    const report = { checks: [{ detail: `oops ${secret} and postgres://u:${secret}@h/db` }] };
    const out = JSON.stringify(
      redactReport(report, { STRIPE_SECRET_KEY: secret, OTHER: 'harmless-value-1234' }),
    );
    expect(out).not.toContain(secret);
    expect(out).toContain('[redacted]');
  });
});
