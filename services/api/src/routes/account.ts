/**
 * R4 (ADR-0023): the person's own settings in the customer portal (and the desktop): which optional e-mails they get,
 * and asking for their account to be deleted. Security, invitation and payment e-mails are essential and always
 * sent; product news needs consent; trial and renewal reminders can be turned off.
 *
 * Deleting an account is a request, processed by staff (R5) under the published policy: workspaces the person is the
 * only owner of must get another owner or be closed first, and billing records the law requires are kept.
 */
import {
  DeletionRequestCreate,
  DeletionStatus,
  NotificationSettings,
  NotificationSettingsUpdate,
} from '@pb/contracts';
import type pg from 'pg';
import { type App, type Deps, principalOf } from '../app.ts';
import { audit } from '../audit.ts';
import { ts, withTx } from '../db.ts';
import { enqueueEmail } from '../email.ts';
import { hit, LIMITS } from '../ratelimit.ts';
import { errors } from './common.ts';

async function settingsOf(c: pg.PoolClient, userId: string): Promise<NotificationSettings> {
  const { rows } = await c.query<{ marketing: boolean | null; billing_reminders: boolean | null }>(
    `select (select granted from user_consents where user_id = $1 and kind = 'marketing' order by at desc, id desc limit 1)
              as marketing,
            (select billing_reminders from notification_settings where user_id = $1) as billing_reminders`,
    [userId],
  );
  return { marketing: rows[0]?.marketing ?? false, billing_reminders: rows[0]?.billing_reminders ?? true };
}

async function deletionOf(c: pg.PoolClient, userId: string): Promise<DeletionStatus> {
  const req = await c.query<NonNullable<DeletionStatus['request']>>(
    `select state, ${ts('created_at')} as created_at, ${ts('decided_at')} as decided_at
       from account_deletion_requests where user_id = $1 order by created_at desc, id desc limit 1`,
    [userId],
  );
  const owned = await c.query<{ org_id: string; name: string }>(
    `select m.org_id, o.name from memberships m join organizations o on o.id = m.org_id
      where m.user_id = $1 and m.role = 'owner'
        and not exists (select 1 from memberships x where x.org_id = m.org_id and x.role = 'owner' and x.user_id <> $1)
      order by o.name limit 100`,
    [userId],
  );
  return { request: req.rows[0] ?? null, sole_owner_of: owned.rows };
}

export function accountRoutes(app: App, deps: Deps): void {
  app.get(
    '/me/notifications',
    {
      config: { web: true },
      schema: {
        tags: ['identity'],
        description: 'Optional e-mails: product news (consent) and trial/renewal reminders.',
        response: { 200: NotificationSettings, ...errors },
      },
    },
    async (req) => {
      const { userId } = principalOf(req);
      return withTx(deps.pool, { orgId: null, userId }, (c) => settingsOf(c, userId));
    },
  );

  app.put(
    '/me/notifications',
    {
      config: { web: true },
      schema: {
        tags: ['identity'],
        description:
          'Changes optional e-mails. Product news is recorded as consent given or withdrawn; essential e-mails ' +
          '(security, invitations, payment results) cannot be turned off.',
        body: NotificationSettingsUpdate,
        response: { 200: NotificationSettings, ...errors },
      },
    },
    async (req) => {
      const { userId } = principalOf(req);
      return withTx(deps.pool, { orgId: null, userId }, async (c) => {
        const before = await settingsOf(c, userId);
        if (req.body.marketing !== undefined && req.body.marketing !== before.marketing) {
          await c.query(
            `insert into user_consents (user_id, kind, version, granted) values ($1, 'marketing', 'settings', $2)`,
            [userId, req.body.marketing],
          );
        }
        if (req.body.billing_reminders !== undefined) {
          await c.query(
            `insert into notification_settings (user_id, billing_reminders) values ($1, $2)
             on conflict (user_id) do update set billing_reminders = excluded.billing_reminders, updated_at = now()`,
            [userId, req.body.billing_reminders],
          );
        }
        return settingsOf(c, userId);
      });
    },
  );

  app.get(
    '/me/deletion-request',
    {
      config: { web: true },
      schema: {
        tags: ['identity'],
        description: 'The newest account deletion request and what must happen before it can be completed.',
        response: { 200: DeletionStatus, ...errors },
      },
    },
    async (req) => {
      const { userId } = principalOf(req);
      return withTx(deps.pool, { orgId: null, userId }, (c) => deletionOf(c, userId));
    },
  );

  app.post(
    '/me/deletion-request',
    {
      config: { web: true },
      schema: {
        tags: ['identity'],
        description:
          'Asks for this account to be deleted (`confirm: true` after reading the policy). Staff process it; asking ' +
          'again while one is pending changes nothing. Nothing is deleted by this call.',
        body: DeletionRequestCreate,
        response: { 201: DeletionStatus, ...errors },
      },
    },
    async (req, reply) => {
      const p = principalOf(req);
      await hit(deps.pool, LIMITS.deletionPerUser, p.userId);
      const status = await withTx(deps.pool, { orgId: null, userId: p.userId }, async (c) => {
        const inserted = await c.query(
          `insert into account_deletion_requests (user_id, note) values ($1, $2) on conflict do nothing`,
          [p.userId, req.body.note?.trim() || null],
        );
        if (inserted.rowCount) {
          await audit(c, {
            orgId: null,
            actorUserId: p.userId,
            actorDeviceId: p.deviceId,
            action: 'account.deletion_requested',
            targetType: 'user',
            targetId: p.userId,
            outcome: 'success',
            requestId: req.id,
            details: {},
          });
          if (deps.config.site.supportEmail) {
            await enqueueEmail(c, deps.config.email.taskKey, {
              kind: 'deletion_request',
              orgId: null,
              to: deps.config.site.supportEmail,
              dedupeKey: `deletion:${p.userId}:${new Date().toISOString().slice(0, 10)}`,
              vars: { user_id: p.userId },
            });
          }
        }
        return deletionOf(c, p.userId);
      });
      return reply.status(201).send(status);
    },
  );

  app.delete(
    '/me/deletion-request',
    {
      config: { web: true },
      schema: {
        tags: ['identity'],
        description: 'Withdraws a pending deletion request.',
        response: { 200: DeletionStatus, ...errors },
      },
    },
    async (req) => {
      const p = principalOf(req);
      return withTx(deps.pool, { orgId: null, userId: p.userId }, async (c) => {
        const r = await c.query(
          `update account_deletion_requests set state = 'withdrawn', decided_at = now()
            where user_id = $1 and state = 'pending'`,
          [p.userId],
        );
        if (r.rowCount) {
          await audit(c, {
            orgId: null,
            actorUserId: p.userId,
            actorDeviceId: p.deviceId,
            action: 'account.deletion_withdrawn',
            targetType: 'user',
            targetId: p.userId,
            outcome: 'success',
            requestId: req.id,
            details: {},
          });
        }
        return deletionOf(c, p.userId);
      });
    },
  );
}
