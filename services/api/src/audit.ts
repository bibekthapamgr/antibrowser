/**
 * Security audit (milestone 06): actor, action, target, outcome, request id and time. Never session secrets, tokens,
 * e-mail bodies or browsing history. Successful changes are written in the same transaction as the change (so a
 * rolled-back change leaves no "success" entry); denials and failed sign-ins are written in their own transaction.
 */
import { newId, redactPayload } from '@pb/contracts';
import type pg from 'pg';
import { type TenantContext, withTx } from './db.ts';
import type { TenantAccess } from './tenancy.ts';

export interface AuditEntry {
  orgId: string | null;
  actorUserId: string | null;
  actorDeviceId: string | null;
  action: string;
  targetType?: string;
  targetId?: string | null;
  outcome: 'success' | 'denied' | 'failed';
  requestId: string;
  details?: Record<string, unknown>;
}

export async function audit(client: pg.PoolClient, e: AuditEntry): Promise<void> {
  await client.query(
    `insert into audit_events (id, org_id, actor_user_id, actor_device_id, action, target_type, target_id, outcome,
                               request_id, details)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      newId('audit'),
      e.orgId,
      e.actorUserId,
      e.actorDeviceId,
      e.action,
      e.targetType ?? null,
      e.targetId ?? null,
      e.outcome,
      e.requestId,
      JSON.stringify(redactPayload(e.details ?? {})),
    ],
  );
}

/** Writes one entry in its own transaction (for denials and failures, after the request's work rolled back). */
export async function auditAlone(pool: pg.Pool, e: AuditEntry): Promise<void> {
  const ctx: TenantContext = { orgId: e.orgId, userId: e.actorUserId };
  await withTx(pool, ctx, (c) => audit(c, e)).catch(() => undefined);
}

/** Entry for a successful change inside an organization (written in the change's own transaction). */
export function changeEntry(
  access: Pick<TenantAccess, 'orgId' | 'userId' | 'deviceId' | 'requestId'>,
  action: string,
  targetType: string,
  targetId: string | null,
  details: Record<string, unknown> = {},
): AuditEntry {
  return {
    orgId: access.orgId,
    actorUserId: access.userId,
    actorDeviceId: access.deviceId,
    action,
    targetType,
    targetId,
    outcome: 'success',
    requestId: access.requestId,
    details,
  };
}
