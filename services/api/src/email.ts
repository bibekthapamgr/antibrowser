/**
 * R2 (ADR-0021): e-mails are queued in `email_tasks` inside the transaction that causes them and sent by the worker
 * (services/worker/src/email.ts), with retries. Template variables, including secret links such as an invitation's,
 * are sealed with AES-256-GCM under EMAIL_TASK_KEY (never in the database); the task id is the additional data, so a
 * sealed payload cannot be moved to another task. The worker erases the payload once the e-mail went out or was given
 * up. Without a key nothing is queued and the caller reports that e-mail is not set up.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { newId } from '@pb/contracts';
import type pg from 'pg';

export type EmailKind = 'invitation' | 'welcome';
export type EmailVars = Record<string, string>;

export function sealEmailVars(key: Buffer, taskId: string, vars: EmailVars): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(taskId));
  const body = Buffer.concat([cipher.update(JSON.stringify(vars), 'utf8'), cipher.final()]);
  return Buffer.concat([Buffer.from([1]), iv, cipher.getAuthTag(), body]);
}

export function openEmailVars(key: Buffer, taskId: string, sealed: Buffer): EmailVars {
  if (sealed.length < 30 || sealed[0] !== 1) throw new Error('unknown e-mail payload format');
  const iv = sealed.subarray(1, 13);
  const tag = sealed.subarray(13, 29);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(Buffer.from(taskId));
  decipher.setAuthTag(tag);
  const text = Buffer.concat([decipher.update(sealed.subarray(29)), decipher.final()]).toString('utf8');
  const parsed = JSON.parse(text) as unknown;
  if (!parsed || typeof parsed !== 'object') throw new Error('bad e-mail payload');
  return parsed as EmailVars;
}

/**
 * Queues an e-mail (at most once per dedupe key). Returns false when e-mail is not set up on this server (no key):
 * the caller then shows the link itself, as before R2.
 */
export async function enqueueEmail(
  c: pg.PoolClient,
  key: Buffer | null,
  task: { kind: EmailKind; orgId: string | null; to: string; dedupeKey: string; vars: EmailVars },
): Promise<boolean> {
  if (!key) return false;
  const id = newId('emailTask');
  await c.query(
    `insert into email_tasks (id, org_id, kind, to_email, payload_enc, dedupe_key)
     values ($1, $2, $3, $4, $5, $6) on conflict do nothing`,
    [
      id,
      task.orgId,
      task.kind,
      task.to.trim().toLowerCase(),
      sealEmailVars(key, id, task.vars),
      task.dedupeKey,
    ],
  );
  return true;
}
