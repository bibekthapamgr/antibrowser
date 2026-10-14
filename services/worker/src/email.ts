/**
 * R2 (ADR-0021): sends the e-mails the API queued in `email_tasks` (invitation links, welcome), with retries and
 * backoff. Each task is taken with SKIP LOCKED in its own transaction, so several workers never send one twice; a
 * crash after sending and before committing can repeat one e-mail (at least once), never lose it. The sealed
 * variables are erased once the e-mail went out or was given up. Only counts and error classes are logged: never an
 * address, a link or the message.
 *
 * Without SMTP_URL tasks are marked `skipped` (the inviter sees the link in the app, as before R2).
 */
import { openEmailVars } from '@pb/api/email';
import nodemailer, { type Transporter } from 'nodemailer';
import type pg from 'pg';
import { renderEmail } from './email-templates.ts';

export const EMAIL_MAX_ATTEMPTS = 8;

export interface EmailDeps {
  pool: pg.Pool;
  key: Buffer | null;
  transport: Pick<Transporter, 'sendMail'> | null;
  from: string | null;
  brand: string;
  log: (level: string, msg: string, extra?: Record<string, unknown>) => void;
}

export function smtpTransport(url: string): Transporter {
  return nodemailer.createTransport(url, {
    // Bounded waits: a stuck mail server must not stall the worker loop.
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
  } as never);
}

/** Classifies a send failure for the record (5xx: the server refused the message; else temporary). */
export function errorClass(err: unknown): { code: string; permanent: boolean } {
  const e = err as { responseCode?: number; code?: string };
  if (e.code === 'EAUTH') return { code: 'smtp_auth', permanent: false };
  if (typeof e.responseCode === 'number' && e.responseCode >= 500)
    return { code: 'smtp_rejected', permanent: true };
  if (typeof e.responseCode === 'number') return { code: 'smtp_deferred', permanent: false };
  return { code: 'smtp_unavailable', permanent: false };
}

export interface EmailResult {
  sent: number;
  retried: number;
  failed: number;
  skipped: number;
}

export async function processEmailTasks(deps: EmailDeps, limit = 20): Promise<EmailResult> {
  const result: EmailResult = { sent: 0, retried: 0, failed: 0, skipped: 0 };
  for (let i = 0; i < limit; i++) {
    const client = await deps.pool.connect();
    try {
      await client.query('begin');
      const { rows } = await client.query<{
        id: string;
        kind: 'invitation' | 'welcome';
        to_email: string;
        payload_enc: Buffer | null;
        attempts: number;
      }>(
        `select id, kind, to_email, payload_enc, attempts from email_tasks
          where state = 'pending' and next_attempt_at <= now()
          order by next_attempt_at, id limit 1 for update skip locked`,
      );
      const task = rows[0];
      if (!task) {
        await client.query('commit');
        break;
      }
      const finish = (state: 'sent' | 'failed' | 'skipped', error: string | null) =>
        client.query(
          `update email_tasks set state = $2, last_error = $3, payload_enc = null, attempts = attempts + 1,
                  sent_at = case when $2 = 'sent' then now() end
            where id = $1`,
          [task.id, state, error],
        );
      if (!deps.transport || !deps.from) {
        await finish('skipped', 'smtp_not_configured');
        result.skipped++;
      } else if (!deps.key || !task.payload_enc) {
        await finish('failed', 'payload_unreadable');
        result.failed++;
      } else {
        let vars: Record<string, string> | null = null;
        try {
          vars = openEmailVars(deps.key, task.id, task.payload_enc);
        } catch {
          vars = null;
        }
        if (!vars) {
          await finish('failed', 'payload_unreadable');
          result.failed++;
        } else {
          const message = renderEmail(task.kind, vars, deps.brand);
          try {
            await deps.transport.sendMail({
              from: deps.from,
              to: task.to_email,
              subject: message.subject,
              text: message.text,
              html: message.html,
              headers: { 'auto-submitted': 'auto-generated' },
            });
            await finish('sent', null);
            result.sent++;
          } catch (err) {
            const { code, permanent } = errorClass(err);
            if (permanent || task.attempts + 1 >= EMAIL_MAX_ATTEMPTS) {
              await finish('failed', code);
              result.failed++;
              deps.log('warn', 'e-mail given up', { kind: task.kind, error: code });
            } else {
              const delay = Math.min(3600, 30 * 2 ** task.attempts);
              await client.query(
                `update email_tasks set attempts = attempts + 1, last_error = $2,
                        next_attempt_at = now() + make_interval(secs => $3::int)
                  where id = $1`,
                [task.id, code, delay],
              );
              result.retried++;
            }
          }
        }
      }
      await client.query('commit');
    } catch (err) {
      await client.query('rollback').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }
  return result;
}
