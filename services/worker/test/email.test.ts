/**
 * R2: the worker's e-mail queue against a local SMTP receiver. Sealed variables open only with the right key and
 * task; sent, refused, unavailable and unconfigured outcomes are recorded with error classes only; payloads are
 * erased once final; two workers never send one task twice.
 */
import { randomBytes } from 'node:crypto';
import { enqueueEmail, openEmailVars, sealEmailVars } from '@pb/api/email';
import { FIXTURES } from '@pb/api/fixtures';
import { newId } from '@pb/contracts';
import nodemailer from 'nodemailer';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type EmailDeps, expireFailedEmail, processEmailTasks } from '../src/email.ts';
import { type EmailKind, renderEmail } from '../src/email-templates.ts';
import { type SmtpSink, startSmtpSink } from './smtp-sink.ts';

const key = randomBytes(32);
let worker: pg.Pool;
let owner: pg.Pool;
let sink: SmtpSink;
const org = FIXTURES.orgs.acme.id;

beforeAll(async () => {
  worker = new pg.Pool({ connectionString: process.env.WORKER_DATABASE_URL, options: '-c search_path=app' });
  owner = new pg.Pool({
    connectionString: process.env.MIGRATION_DATABASE_URL,
    options: '-c search_path=app',
  });
  sink = await startSmtpSink();
});
afterAll(async () => {
  await sink.close();
  await worker.end();
  await owner.end();
});
beforeEach(async () => {
  await owner.query('delete from email_tasks');
  sink.messages.length = 0;
});

const deps = (over: Partial<EmailDeps> = {}): EmailDeps => ({
  pool: worker,
  key,
  transport: nodemailer.createTransport({
    host: '127.0.0.1',
    port: sink.port,
    secure: false,
    ignoreTLS: true,
  }),
  from: 'Project Browser <no-reply@sender.test>',
  brand: 'Project Browser',
  log: () => undefined,
  ...over,
});

async function queue(kind: EmailKind, to: string, vars: Record<string, string>) {
  const c = await owner.connect();
  try {
    await enqueueEmail(c, key, {
      kind,
      orgId: org,
      to,
      dedupeKey: `${kind}:${randomBytes(6).toString('hex')}`,
      vars,
    });
  } finally {
    c.release();
  }
  const { rows } = await owner.query('select id from email_tasks order by created_at desc limit 1');
  return rows[0]?.id as string;
}

const task = async (id: string) =>
  (
    await owner.query(
      'select state, attempts, last_error, payload_enc, sent_at from email_tasks where id = $1',
      [id],
    )
  ).rows[0];

describe('sealing', () => {
  it('opens only with the same key and task id', () => {
    const id = newId('emailTask');
    const sealed = sealEmailVars(key, id, { link: 'https://app.test/app/#/invite/secret' });
    expect(sealed.toString('latin1')).not.toContain('secret');
    expect(openEmailVars(key, id, sealed)).toEqual({ link: 'https://app.test/app/#/invite/secret' });
    expect(() => openEmailVars(key, newId('emailTask'), sealed)).toThrow();
    expect(() => openEmailVars(randomBytes(32), id, sealed)).toThrow();
  });

  it('nothing is queued without a key, and a dedupe key queues once', async () => {
    const c = await owner.connect();
    try {
      const vars = { display_name: 'A' };
      expect(
        await enqueueEmail(c, null, { kind: 'welcome', orgId: org, to: 'a@x.test', dedupeKey: 'w:1', vars }),
      ).toBe(false);
      await enqueueEmail(c, key, { kind: 'welcome', orgId: org, to: 'A@X.test', dedupeKey: 'w:2', vars });
      await enqueueEmail(c, key, { kind: 'welcome', orgId: org, to: 'a@x.test', dedupeKey: 'w:2', vars });
    } finally {
      c.release();
    }
    const { rows } = await owner.query('select to_email from email_tasks');
    expect(rows).toEqual([{ to_email: 'a@x.test' }]);
  });
});

describe('sending', () => {
  it('sends an invitation with its link, then erases the payload', async () => {
    const link = 'https://app.example.test/app/#/invite/AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcde';
    const id = await queue('invitation', 'mate@people.test', {
      org_name: 'Acme <script>',
      inviter_name: 'Ann\r\nBcc: evil@x.test',
      role: 'operator',
      link,
      expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    });
    expect(await processEmailTasks(deps())).toEqual({ sent: 1, retried: 0, failed: 0, skipped: 0 });
    expect(sink.messages).toHaveLength(1);
    const m = sink.messages[0];
    expect(m?.to).toEqual(['mate@people.test']);
    // Quoted-printable bodies and folded headers, decoded as a mail program would.
    const data = (m?.data ?? '')
      .replace(/=\r\n/g, '')
      .replace(/=([0-9A-F]{2})/g, (_, h: string) => String.fromCharCode(Number.parseInt(h, 16)))
      .replace(/\r\n[ \t]+/g, ' ');
    expect(data).toContain(link);
    expect(data).toContain('Acme &lt;script&gt;');
    expect(data).not.toMatch(/^Bcc:/im);
    expect(data).toMatch(/^Subject: Ann Bcc: evil@x\.test invited you to/m);
    const t = await task(id);
    expect(t).toMatchObject({ state: 'sent', attempts: 1, last_error: null, payload_enc: null });
    expect(t?.sent_at).not.toBeNull();
    // Nothing is sent twice.
    expect((await processEmailTasks(deps())).sent).toBe(0);
  });

  it('a refused recipient fails permanently; an unreachable server is retried later', async () => {
    const refused = await queue('welcome', 'reject-me@people.test', { display_name: 'R' });
    await processEmailTasks(deps());
    // R5: a given-up e-mail keeps its sealed contents for a retry from the console, then they are erased.
    const failed = await task(refused);
    expect(failed).toMatchObject({ state: 'failed', last_error: 'smtp_rejected' });
    expect(failed?.payload_enc).not.toBeNull();
    await owner.query("update email_tasks set created_at = now() - interval '8 days' where id = $1", [
      refused,
    ]);
    expect(await expireFailedEmail(worker)).toBeGreaterThanOrEqual(1);
    expect(await task(refused)).toMatchObject({ state: 'failed', payload_enc: null });

    const later = await queue('welcome', 'later@people.test', { display_name: 'L' });
    const down = nodemailer.createTransport({
      host: '127.0.0.1',
      port: 1,
      secure: false,
      connectionTimeout: 500,
    } as never);
    expect((await processEmailTasks(deps({ transport: down }))).retried).toBe(1);
    const t = await task(later);
    expect(t).toMatchObject({ state: 'pending', attempts: 1, last_error: 'smtp_unavailable' });
    expect(t?.payload_enc).not.toBeNull();
    // Due later, not now.
    expect((await processEmailTasks(deps())).sent).toBe(0);
    await owner.query('update email_tasks set next_attempt_at = now() where id = $1', [later]);
    expect((await processEmailTasks(deps())).sent).toBe(1);
  });

  it('without SMTP the task is skipped; with the wrong key it cannot be read', async () => {
    const a = await queue('welcome', 'a@people.test', { display_name: 'A' });
    await processEmailTasks(deps({ transport: null }));
    expect(await task(a)).toMatchObject({
      state: 'skipped',
      last_error: 'smtp_not_configured',
      payload_enc: null,
    });
    const b = await queue('welcome', 'b@people.test', { display_name: 'B' });
    await processEmailTasks(deps({ key: randomBytes(32) }));
    expect(await task(b)).toMatchObject({
      state: 'failed',
      last_error: 'payload_unreadable',
      payload_enc: null,
    });
  });

  it('two workers never send the same task twice', async () => {
    for (let i = 0; i < 6; i++) await queue('welcome', `n${i}@people.test`, { display_name: `N${i}` });
    const [x, y] = await Promise.all([processEmailTasks(deps()), processEmailTasks(deps())]);
    expect((x?.sent ?? 0) + (y?.sent ?? 0)).toBe(6);
    expect(sink.messages).toHaveLength(6);
    expect(new Set(sink.messages.map((m) => m.to[0])).size).toBe(6);
  });

  it('the application role can queue but never read the queue', async () => {
    const app = new pg.Pool({ connectionString: process.env.DATABASE_URL, options: '-c search_path=app' });
    try {
      await expect(app.query('select * from email_tasks')).rejects.toThrow(/permission denied/);
    } finally {
      await app.end();
    }
  });
});

describe('R4 e-mails', () => {
  it('a contact request reaches support with the visitor as Reply-To, the message escaped', async () => {
    await queue('contact_request', 'support@owner.test', {
      topic: 'billing',
      name: 'Visitor <b>',
      reply_to: 'visitor@people.test',
      message: 'Can I pay yearly?\r\nBcc: evil@x.test',
    });
    expect((await processEmailTasks(deps())).sent).toBe(1);
    const data = (sink.messages[0]?.data ?? '').replace(/=\r\n/g, '').replace(/\r\n[ \t]+/g, ' ');
    expect(sink.messages[0]?.to).toEqual(['support@owner.test']);
    const headers = data.split('\r\n\r\n')[0] ?? '';
    expect(headers).toMatch(/^Reply-To: visitor@people\.test/im);
    // Text from the form stays in the body: it never becomes a header.
    expect(headers).not.toMatch(/^Bcc:/im);
    expect(data).toContain('Visitor &lt;b&gt;');
  });

  it('payment results and trial reminders name the workspace and link to billing; nothing promises deletion', () => {
    const vars = {
      workspace_name: 'Acme',
      plan_name: 'Team',
      link: 'https://app.example.test/app/#/billing',
    };
    const ok = renderEmail('payment_succeeded', vars, 'Project Browser');
    expect(ok.subject).toBe('Project Browser: Acme is on the Team plan');
    expect(ok.text).toContain('Open billing: https://app.example.test/app/#/billing');
    const failed = renderEmail('payment_failed', vars, 'Project Browser');
    expect(failed.text).toContain('not deleted because of a failed payment');
    const trial = renderEmail(
      'trial_ending',
      { ...vars, ends_at: '2026-10-20T00:00:00Z' },
      'Project Browser',
    );
    expect(trial.text).toContain('Nothing is deleted when a trial ends.');
    expect(trial.text).toContain('turn reminders off');
    const deletion = renderEmail('deletion_request', { user_id: 'usr_01J9ZSEED0U100000000000000' }, 'PB');
    expect(deletion.subject).toContain('usr_01J9ZSEED0U100000000000000');
  });

  it('R5: restriction notices say what still works and never carry the staff member’s reason', () => {
    const pay = renderEmail(
      'restriction_notice',
      { workspace_name: 'Acme', restriction: 'payment', scope: 'workspace', phase: 'applied', until: '' },
      'Project Browser',
    );
    expect(pay.subject).toBe('Project Browser: restriction notice');
    expect(pay.text).toContain('exported and deleted');
    expect(pay.text).toContain('Nothing was deleted.');
    const sec = renderEmail(
      'restriction_notice',
      { workspace_name: 'Acme', restriction: 'security', scope: 'account', phase: 'applied', until: '' },
      'Project Browser',
    );
    expect(sec.text).toContain('Your account was suspended');
    const lifted = renderEmail(
      'restriction_notice',
      { workspace_name: 'Acme', restriction: 'payment', scope: 'workspace', phase: 'lifted' },
      'Project Browser',
    );
    expect(lifted.subject).toBe('Project Browser: restriction lifted');
  });
});
