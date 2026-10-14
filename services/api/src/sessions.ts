/**
 * Session leases (milestone 08, ADR-0015): shared helpers for the lease routes, the profile list (who has a profile
 * open) and the places that take access away (members, grants, devices).
 *
 * A profile's lease row (`profile_leases`, one per profile) is authoritative:
 *  - held:      state 'active' and expires_at > now() (database clock only);
 *  - uncertain: a *session* lease in state 'active' whose expiry passed without a release. Its browser may still be
 *               open on the holder's device, so nobody else may open the profile until the holder confirms closure
 *               (revives or releases its lease) or an administrator forces a takeover. Upload leases just expire.
 *  - ended:     released, taken_over, revoked or superseded. Ending a lease other than by its own release allocates
 *               a new fencing token, so anything the old holder still sends is refused.
 */
import { type GrantCapability, type PlanFeature, type Role, roleAllows, SESSION_LEASE } from '@pb/contracts';
import type pg from 'pg';
import { audit } from './audit.ts';
import { requireFeature } from './billing/state.ts';
import { ts } from './db.ts';
import { appendEvent } from './outbox.ts';
import type { TenantAccess } from './tenancy.ts';

/** Lease columns as the SessionLease resource; the query aliases profile_leases as `l`, users `u`, devices `d`. */
export const SESSION_LEASE_COLUMNS = `l.id, l.profile_id, l.purpose,
  case when l.state = 'active' and l.expires_at <= now() then 'uncertain' else l.state end as state,
  l.holder_user_id, coalesce(u.display_name, '') as holder_name, l.holder_device_id as device_id,
  coalesce(l.device_name, '') as device_name,
  l.fencing_token::text as fencing_token, l.run_state, ${ts('l.acquired_at')} as acquired_at,
  ${ts('l.expires_at')} as expires_at, ${ts('l.heartbeat_at')} as heartbeat_at, l.ttl_seconds,
  ${SESSION_LEASE.heartbeatSeconds} as heartbeat_seconds`;

/** Users are visible to co-members only (a removed holder's name may be missing); devices only to their owner, so
 *  the lease keeps a copy of its device's name. */
export const SESSION_LEASE_FROM = 'profile_leases l left join users u on u.id = l.holder_user_id';

/**
 * SQL (scalar subquery) for a profile's `in_use` object, or null when nobody has it open. Upload leases count only
 * while live; session leases also while uncertain. `$user` is the placeholder holding the caller's user id.
 */
export function inUseJson(p: string, userParam: string): string {
  return `(select json_build_object(
      'lease_id', l.id, 'purpose', l.purpose,
      'state', case when l.expires_at > now() then 'active' else 'uncertain' end,
      'holder_user_id', l.holder_user_id, 'holder_name', coalesce(u.display_name, ''),
      'device_id', l.holder_device_id, 'device_name', coalesce(l.device_name, ''), 'run_state', l.run_state,
      'since', ${ts('l.acquired_at')}, 'heartbeat_at', ${ts('l.heartbeat_at')}, 'expires_at', ${ts('l.expires_at')},
      'mine', l.holder_user_id = ${userParam})
    from ${SESSION_LEASE_FROM}
   where l.org_id = ${p}.org_id and l.profile_id = ${p}.id and l.state = 'active'
     and (l.expires_at > now() or l.purpose = 'session'))`;
}

/** SQL for the caller's capabilities on profile `p` (organization scope: all; granted scope: from their grants). */
export function capabilitiesSql(access: TenantAccess, p: string, userParam: string): string {
  switch (access.scope) {
    case 'organization':
      return `(case when ${userParam}::text is not null then
                 array['launch', 'edit', 'backup_download']::text[] else '{}'::text[] end)`;
    case 'none':
      return `(case when ${userParam}::text is null then '{}'::text[] else '{}'::text[] end)`;
    case 'granted':
      return `coalesce((select array_agg(distinct cap order by cap) from permission_grants g, unnest(g.capabilities) cap
                         where g.org_id = ${p}.org_id and g.user_id = ${userParam}
                           and (g.profile_id = ${p}.id or (g.client_id is not null and g.client_id = ${p}.client_id))
                           and ${access.role === 'operator' ? 'true' : 'false'}), '{}'::text[])`;
  }
}

/** Whether a member (by user id) may open `profileId` now: role permission, scope and a grant with `launch`. */
export async function userMayLaunch(
  c: pg.PoolClient,
  orgId: string,
  userId: string,
  profileId: string,
): Promise<boolean> {
  const m = await c.query<{ role: Role }>('select role from memberships where org_id = $1 and user_id = $2', [
    orgId,
    userId,
  ]);
  const role = m.rows[0]?.role;
  if (!role || !roleAllows(role, 'profile.launch')) return false;
  if (role === 'owner' || role === 'admin') return true;
  const g = await c.query(
    `select 1 from permission_grants g join profiles p on p.org_id = g.org_id and p.id = $3
      where g.org_id = $1 and g.user_id = $2 and p.deleted_at is null
        and (g.profile_id = p.id or (g.client_id is not null and g.client_id = p.client_id))
        and 'launch' = any(g.capabilities)`,
    [orgId, userId, profileId],
  );
  return (g.rowCount ?? 0) > 0;
}

/**
 * Ends the leases a member may no longer hold (after a role change, removal or grant change): state 'revoked', a new
 * fencing token (their device's writes are refused), audited with the admin who made the change. Their browser is
 * told to stop at its next heartbeat; data already on their computer is not erased. Returns the profiles affected.
 */
export async function endLeasesOutOfReach(
  c: pg.PoolClient,
  access: Pick<TenantAccess, 'orgId' | 'userId' | 'deviceId' | 'requestId'>,
  memberId: string,
  reason: string,
): Promise<string[]> {
  const open = await c.query<{ id: string; profile_id: string }>(
    `select id, profile_id from profile_leases
      where org_id = $1 and holder_user_id = $2 and state = 'active' for update`,
    [access.orgId, memberId],
  );
  const ended: string[] = [];
  for (const l of open.rows) {
    if (await userMayLaunch(c, access.orgId, memberId, l.profile_id)) continue;
    await endLease(c, access, l.profile_id, 'revoked', reason);
    ended.push(l.profile_id);
  }
  return ended;
}

/**
 * Ends the profile's open lease by someone other than its holder (takeover, revocation): a new fencing token is
 * allocated so the previous holder is fenced out. Returns the new token.
 */
export async function endLease(
  c: pg.PoolClient,
  access: Pick<TenantAccess, 'orgId' | 'userId' | 'deviceId' | 'requestId'>,
  profileId: string,
  state: 'taken_over' | 'revoked',
  reason: string,
): Promise<{ token: string; leaseId: string; holder: string; device: string } | null> {
  const { rows } = await c.query<{
    id: string;
    fencing_token: string;
    holder_user_id: string;
    holder_device_id: string;
    version: number;
  }>(
    `update profile_leases
        set state = $3, released_at = now(), ended_by = $4, end_reason = $5,
            fencing_token = nextval('lease_fencing_seq'), version = version + 1
      where org_id = $1 and profile_id = $2 and state = 'active'
      returning id, fencing_token::text as fencing_token, holder_user_id, holder_device_id, version`,
    [access.orgId, profileId, state, access.userId, reason],
  );
  const row = rows[0];
  if (!row) return null;
  await c.query(
    `update lease_history set ended_at = now(), end_state = $2, end_reason = $3, ended_by = $4 where id = $1`,
    [row.id, state, reason, access.userId],
  );
  await audit(c, {
    orgId: access.orgId,
    actorUserId: access.userId,
    actorDeviceId: access.deviceId,
    action: state === 'taken_over' ? 'lease.taken_over' : 'lease.revoked',
    targetType: 'profile',
    targetId: profileId,
    outcome: 'success',
    requestId: access.requestId,
    details: {
      lease_id: row.id,
      previous_holder: row.holder_user_id,
      device_id: row.holder_device_id,
      reason,
    },
  });
  await appendEvent(c, {
    orgId: access.orgId,
    actorId: access.userId,
    aggregateId: profileId,
    aggregateVersion: row.version,
    eventType: state === 'taken_over' ? 'lease.taken_over' : 'lease.revoked',
    payload: { lease_id: row.id, previous_holder: row.holder_user_id },
  });
  // Requests addressed to the ended holder are answered: the profile is free now.
  await c.query(
    `update handoff_requests set status = 'fulfilled', responded_at = now()
      where org_id = $1 and profile_id = $2 and status = 'open'`,
    [access.orgId, profileId],
  );
  return {
    token: row.fencing_token,
    leaseId: row.id,
    holder: row.holder_user_id,
    device: row.holder_device_id,
  };
}

/** Milestone 11: the organization's plan (with overrides) must include the feature (ADR-0018). */
export async function requireEntitlement(c: pg.PoolClient, orgId: string, key: PlanFeature): Promise<void> {
  await requireFeature(c, orgId, key);
}

/** The major version of a browser version string (`155.0.8059.39` -> 155), or null. */
export function browserMajor(v: string | null | undefined): number | null {
  const m = /^(\d{1,4})\./.exec(v ?? '');
  return m ? Number(m[1]) : null;
}

export const SESSION_CAPABILITY: GrantCapability = 'launch';
