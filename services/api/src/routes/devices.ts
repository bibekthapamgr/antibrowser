/**
 * The caller's own devices. Revoking a device ends its sessions at once: its access tokens fail at the next request
 * and its refresh token can no longer be used. Revocation cannot erase anything already copied to a compromised
 * device (see docs/security/authentication-threat-review.md).
 */
import { ApiError, Device } from '@pb/contracts';
import Type from 'typebox';
import { type App, type Deps, principalOf } from '../app.ts';
import { audit } from '../audit.ts';
import { ts, withTx } from '../db.ts';
import { DeviceParams, errors } from './common.ts';

const DEVICE_COLUMNS = `d.id, d.name, d.platform, ${ts('d.created_at')} as created_at,
  ${ts('d.last_seen_at')} as last_seen_at, ${ts('d.revoked_at')} as revoked_at`;

type DeviceRow = Omit<Device, 'current'>;

export function deviceRoutes(app: App, deps: Deps): void {
  app.get(
    '/devices',
    {
      schema: {
        tags: ['devices'],
        description: 'Devices enrolled for the signed-in account (most recent first, at most 100).',
        response: {
          200: Type.Object({ items: Type.Array(Device) }, { additionalProperties: false }),
          ...errors,
        },
      },
    },
    async (req) => {
      const principal = principalOf(req);
      const rows = await withTx(deps.pool, { orgId: null, userId: principal.userId }, async (c) => {
        const result = await c.query<DeviceRow>(
          `select ${DEVICE_COLUMNS} from devices d where d.user_id = $1 order by d.created_at desc, d.id limit 100`,
          [principal.userId],
        );
        return result.rows;
      });
      return { items: rows.map((d) => ({ ...d, current: d.id === principal.deviceId })) };
    },
  );

  app.post(
    '/devices/:deviceId/revoke',
    {
      schema: {
        tags: ['devices'],
        description:
          'Signs a device out everywhere: its sessions end and it cannot refresh or call the API again until it is ' +
          'enrolled anew. Profiles it had open are released from it (a new fencing token). Local browser data on ' +
          'that device is not deleted (the server cannot reach it).',
        params: DeviceParams,
        response: { 200: Device, ...errors },
      },
    },
    async (req) => {
      const principal = principalOf(req);
      const device = await withTx(deps.pool, { orgId: null, userId: principal.userId }, async (c) => {
        const { rows } = await c.query<DeviceRow & { was_revoked: boolean }>(
          `update devices d set revoked_at = coalesce(d.revoked_at, now()),
                  revoked_reason = coalesce(d.revoked_reason, 'user')
             from (select id, revoked_at is not null as was_revoked from devices where id = $1 and user_id = $2) prev
            where d.id = prev.id
            returning ${DEVICE_COLUMNS}, prev.was_revoked`,
          [req.params.deviceId, principal.userId],
        );
        const row = rows[0];
        if (!row) throw new ApiError('NOT_FOUND', 'Device not found');
        await c.query(
          `update device_sessions set revoked_at = now(), revoke_reason = 'device_revoked'
            where device_id = $1 and user_id = $2 and revoked_at is null`,
          [req.params.deviceId, principal.userId],
        );
        // Milestone 08: the profiles this device has open are released from it (fenced out, audited per profile).
        await c.query('select app.end_device_leases($1, $2, $3)', [
          req.params.deviceId,
          principal.userId,
          'device_signed_out',
        ]);
        if (!row.was_revoked) {
          await audit(c, {
            orgId: null,
            actorUserId: principal.userId,
            actorDeviceId: principal.deviceId,
            action: 'device.revoked',
            targetType: 'device',
            targetId: row.id,
            outcome: 'success',
            requestId: req.id,
          });
        }
        const { was_revoked: _ignored, ...rest } = row;
        return rest;
      });
      return { ...device, current: device.id === principal.deviceId };
    },
  );
}
