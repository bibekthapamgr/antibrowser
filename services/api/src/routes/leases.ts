import { ApiError, LEASE_TTL, Lease, LeaseAcquire, LeaseRelease, LeaseRenew } from '@pb/contracts';
import Type, { type Static } from 'typebox';
import { type App, type Deps, principalOf } from '../app.ts';
import { withTx } from '../db.ts';
import { requestDigest, requireIdempotencyKey, runIdempotent } from '../idempotency.ts';
import { appendEvent } from '../outbox.ts';
import { requirePermission, resolveTenant } from '../tenancy.ts';
import { errors, LEASE_COLUMNS, ProfileParams } from './common.ts';

type LeaseRow = Static<typeof Lease>;

/**
 * Authoritative profile leases (milestone 01 data contract; full handoff UX is milestone 08).
 * - One row per profile; held iff released_at is null and expires_at > now() (database clock only).
 * - Every acquisition takes a new value from a monotonically increasing sequence: the fencing token.
 * - Writes that depend on holding the lease (renew, release, snapshot commit) must present the current token.
 */
export function leaseRoutes(app: App, deps: Deps): void {
  app.get(
    '/orgs/:orgId/profiles/:profileId/lease',
    {
      schema: {
        tags: ['leases'],
        params: ProfileParams,
        response: { 200: Type.Object({ lease: Type.Union([Lease, Type.Null()]) }), ...errors },
      },
    },
    async (req) => {
      const access = await resolveTenant(deps.pool, principalOf(req).userId, req.params.orgId);
      requirePermission(access, 'profile.read');
      return withTx(deps.pool, access, async (c) => {
        await assertProfile(c, req.params.profileId, access.orgId, false);
        const { rows } = await c.query<LeaseRow>(
          `select ${LEASE_COLUMNS} from profile_leases
            where profile_id = $1 and released_at is null and expires_at > now()`,
          [req.params.profileId],
        );
        return { lease: rows[0] ?? null };
      });
    },
  );

  app.post(
    '/orgs/:orgId/profiles/:profileId/lease',
    {
      schema: {
        tags: ['leases'],
        description: 'Acquire the profile lease for a device. Requires Idempotency-Key.',
        params: ProfileParams,
        body: LeaseAcquire,
        response: { 201: Lease, 200: Lease, ...errors },
      },
    },
    async (req, reply) => {
      const access = await resolveTenant(deps.pool, principalOf(req).userId, req.params.orgId);
      requirePermission(access, 'profile.launch');
      const key = requireIdempotencyKey(req.headers['idempotency-key']);
      const ttl = req.body.ttl_seconds ?? LEASE_TTL.default;
      const digest = requestDigest({
        user: access.userId,
        profile: req.params.profileId,
        device: req.body.device_id,
        ttl,
      });

      const result = await withTx(deps.pool, access, (c) =>
        runIdempotent(c, { orgId: access.orgId, operation: 'lease.acquire', key, digest }, async () => {
          const device = await c.query(
            'select 1 from devices where id = $1 and user_id = $2 and revoked_at is null',
            [req.body.device_id, access.userId],
          );
          if (device.rowCount === 0) {
            throw new ApiError('FORBIDDEN', 'device_id is not an active device of the caller');
          }
          await assertProfile(c, req.params.profileId, access.orgId, true);

          const held = await c.query<{ holder_device_id: string; expires_at: string }>(
            `select holder_device_id, expires_at from profile_leases
              where profile_id = $1 and released_at is null and expires_at > now()
              for update`,
            [req.params.profileId],
          );
          const current = held.rows[0];
          if (current && current.holder_device_id !== req.body.device_id) {
            throw new ApiError('LEASE_HELD', 'Profile is in use on another device', {
              expires_at: new Date(current.expires_at).toISOString(),
            });
          }

          const { rows } = await c.query<LeaseRow & { version: number }>(
            `insert into profile_leases
               (profile_id, org_id, holder_device_id, holder_user_id, fencing_token, acquired_at, expires_at)
             values ($1, $2, $3, $4, nextval('lease_fencing_seq'), now(), now() + make_interval(secs => $5))
             on conflict (profile_id) do update set
               holder_device_id = excluded.holder_device_id,
               holder_user_id   = excluded.holder_user_id,
               fencing_token    = excluded.fencing_token,
               acquired_at      = excluded.acquired_at,
               expires_at       = excluded.expires_at,
               released_at      = null,
               version          = profile_leases.version + 1
             returning ${LEASE_COLUMNS}, version`,
            [req.params.profileId, access.orgId, req.body.device_id, access.userId, ttl],
          );
          const { version, ...lease } = rows[0] as LeaseRow & { version: number };
          await appendEvent(c, {
            orgId: access.orgId,
            actorId: access.userId,
            aggregateId: lease.profile_id,
            aggregateVersion: version,
            eventType: 'lease.acquired',
            payload: { device_id: lease.holder_device_id, fencing_token: lease.fencing_token },
          });
          return { status: 201, body: lease };
        }),
      );
      return reply
        .status(result.replayed ? 200 : result.status)
        .header('idempotent-replayed', String(result.replayed))
        .send(result.body);
    },
  );

  app.post(
    '/orgs/:orgId/profiles/:profileId/lease/renew',
    {
      schema: {
        tags: ['leases'],
        params: ProfileParams,
        body: LeaseRenew,
        response: { 200: Lease, ...errors },
      },
    },
    async (req) => {
      const access = await resolveTenant(deps.pool, principalOf(req).userId, req.params.orgId);
      requirePermission(access, 'profile.launch');
      const ttl = req.body.ttl_seconds ?? LEASE_TTL.default;
      return withTx(deps.pool, access, async (c) => {
        await assertProfile(c, req.params.profileId, access.orgId, false);
        const { rows } = await c.query<LeaseRow & { version: number }>(
          `update profile_leases
              set expires_at = now() + make_interval(secs => $3), version = version + 1
            where profile_id = $1 and fencing_token = $2::bigint and holder_user_id = $4
              and released_at is null and expires_at > now()
            returning ${LEASE_COLUMNS}, version`,
          [req.params.profileId, req.body.fencing_token, ttl, access.userId],
        );
        const row = rows[0];
        if (!row) throw await leaseFailure(c, req.params.profileId, req.body.fencing_token);
        const { version, ...lease } = row;
        await appendEvent(c, {
          orgId: access.orgId,
          actorId: access.userId,
          aggregateId: lease.profile_id,
          aggregateVersion: version,
          eventType: 'lease.renewed',
          payload: { fencing_token: lease.fencing_token },
        });
        return lease;
      });
    },
  );

  app.post(
    '/orgs/:orgId/profiles/:profileId/lease/release',
    {
      schema: {
        tags: ['leases'],
        description:
          'Release with the current fencing token. Releasing an already-released lease is a no-op.',
        params: ProfileParams,
        body: LeaseRelease,
        response: { 204: Type.Null(), ...errors },
      },
    },
    async (req, reply) => {
      const access = await resolveTenant(deps.pool, principalOf(req).userId, req.params.orgId);
      requirePermission(access, 'profile.launch');
      await withTx(deps.pool, access, async (c) => {
        await assertProfile(c, req.params.profileId, access.orgId, false);
        const existing = await c.query<{ released: boolean }>(
          `select released_at is not null as released from profile_leases
            where profile_id = $1 and fencing_token = $2::bigint and holder_user_id = $3
            for update`,
          [req.params.profileId, req.body.fencing_token, access.userId],
        );
        const current = existing.rows[0];
        if (!current) throw await leaseFailure(c, req.params.profileId, req.body.fencing_token);
        if (current.released) return; // idempotent no-op
        const { rows } = await c.query<{ version: number }>(
          `update profile_leases set released_at = now(), version = version + 1
            where profile_id = $1 returning version`,
          [req.params.profileId],
        );
        await appendEvent(c, {
          orgId: access.orgId,
          actorId: access.userId,
          aggregateId: req.params.profileId,
          aggregateVersion: rows[0]?.version ?? 1,
          eventType: 'lease.released',
          payload: { fencing_token: req.body.fencing_token },
        });
      });
      return reply.status(204).send(null);
    },
  );
}

async function assertProfile(
  c: import('pg').PoolClient,
  profileId: string,
  orgId: string,
  lock: boolean,
): Promise<void> {
  const { rowCount } = await c.query(
    `select 1 from profiles where id = $1 and org_id = $2 and deleted_at is null ${lock ? 'for update' : ''}`,
    [profileId, orgId],
  );
  if (rowCount === 0) throw new ApiError('NOT_FOUND', 'Profile not found');
}

/** Distinguishes "no live lease" from "a newer holder exists" so clients can react correctly. */
export async function leaseFailure(
  c: import('pg').PoolClient,
  profileId: string,
  token: string,
): Promise<ApiError> {
  const { rows } = await c.query<{ fencing_token: string; live: boolean }>(
    `select fencing_token::text as fencing_token, (released_at is null and expires_at > now()) as live
       from profile_leases where profile_id = $1`,
    [profileId],
  );
  const lease = rows[0];
  if (lease && BigInt(lease.fencing_token) > BigInt(token)) {
    return new ApiError('FENCING_TOKEN_STALE', 'A newer lease exists for this profile; stop writing');
  }
  return new ApiError('LEASE_NOT_HELD', 'You do not hold a live lease for this profile');
}
