import { ApiError, LEASE_TTL, Lease, LeaseAcquire, LeaseRelease, LeaseRenew } from '@pb/contracts';
import Type, { type Static } from 'typebox';
import { type App, type Deps, principalOf } from '../app.ts';
import { requireBillingAllows } from '../billing/state.ts';
import { withTx } from '../db.ts';
import { requestDigest, requireIdempotencyKey, runIdempotent } from '../idempotency.ts';
import { appendEvent } from '../outbox.ts';
import { profileFor, resolveTenant } from '../tenancy.ts';
import { errors, LEASE_COLUMNS, ProfileParams } from './common.ts';
import { takeLease } from './sessions.ts';

type LeaseRow = Static<typeof Lease>;

/**
 * Upload leases (milestone 01 data contract, used by backups of closed profiles since milestone 07). Sessions, handoff
 * and takeover are in sessions.ts (milestone 08); both share one row per profile and one fencing-token sequence.
 * - Held iff state = 'active' and expires_at > now() (database clock only); an expired upload lease is free.
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
      const access = await resolveTenant(deps.pool, req, req.params.orgId);
      return withTx(deps.pool, access, async (c) => {
        await profileFor(c, access, req.params.profileId, 'profile.read', 'p.id');
        const { rows } = await c.query<LeaseRow>(
          `select ${LEASE_COLUMNS} from profile_leases
            where profile_id = $1 and state = 'active' and expires_at > now()`,
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
      const access = await resolveTenant(deps.pool, req, req.params.orgId);
      requireBillingAllows(access, 'profile.open');
      const principal = principalOf(req);
      const key = requireIdempotencyKey(req.headers['idempotency-key']);
      const ttl = req.body.ttl_seconds ?? LEASE_TTL.default;
      const digest = requestDigest({
        user: access.userId,
        profile: req.params.profileId,
        device: req.body.device_id,
        ttl,
      });

      const result = await withTx(deps.pool, access, async (c) => {
        // Authorization runs before any idempotent replay, so a revoked grant also stops replays.
        await profileFor(c, access, req.params.profileId, 'profile.launch', 'p.id', true);
        return runIdempotent(
          c,
          { orgId: access.orgId, operation: 'lease.acquire', key, digest },
          async () => {
            // Milestone 08: this route takes an *upload* lease (a backup of the closed profile); sessions use
            // POST .../leases. The shared rules apply: an open session elsewhere (even uncertain) blocks it.
            await takeLease(c, access, principal.deviceId, {
              profileId: req.params.profileId,
              deviceId: req.body.device_id,
              purpose: 'upload',
              ttl,
              platform: null,
              browserVersion: null,
              headBrowser: null,
            });
            const { rows } = await c.query<LeaseRow>(
              `select ${LEASE_COLUMNS} from profile_leases where profile_id = $1`,
              [req.params.profileId],
            );
            const lease = rows[0];
            if (!lease) throw new ApiError('INTERNAL', 'Lease was not created');
            return { status: 201, body: lease };
          },
        );
      });
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
      const access = await resolveTenant(deps.pool, req, req.params.orgId);
      const device = principalOf(req).deviceId;
      const ttl = req.body.ttl_seconds ?? LEASE_TTL.default;
      return withTx(deps.pool, access, async (c) => {
        await profileFor(c, access, req.params.profileId, 'profile.launch', 'p.id');
        const { rows } = await c.query<LeaseRow & { version: number }>(
          `update profile_leases
              set expires_at = now() + make_interval(secs => $3), version = version + 1
            where profile_id = $1 and fencing_token = $2::bigint and holder_user_id = $4
              and ($5::text is null or holder_device_id = $5)
              and state = 'active' and expires_at > now()
            returning ${LEASE_COLUMNS}, version`,
          [req.params.profileId, req.body.fencing_token, ttl, access.userId, device],
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
      const access = await resolveTenant(deps.pool, req, req.params.orgId);
      const device = principalOf(req).deviceId;
      await withTx(deps.pool, access, async (c) => {
        await profileFor(c, access, req.params.profileId, 'profile.launch', 'p.id');
        const existing = await c.query<{ released: boolean }>(
          `select released_at is not null as released from profile_leases
            where profile_id = $1 and fencing_token = $2::bigint and holder_user_id = $3
              and ($4::text is null or holder_device_id = $4)
            for update`,
          [req.params.profileId, req.body.fencing_token, access.userId, device],
        );
        const current = existing.rows[0];
        if (!current) throw await leaseFailure(c, req.params.profileId, req.body.fencing_token);
        if (current.released) return; // idempotent no-op
        const { rows } = await c.query<{ version: number; id: string }>(
          `update profile_leases set released_at = now(), state = 'released', end_reason = 'closed', run_state = null,
                  version = version + 1
            where profile_id = $1 returning version, id`,
          [req.params.profileId],
        );
        await c.query(
          `update lease_history set ended_at = now(), end_state = 'released', end_reason = 'closed', ended_by = $2
            where id = $1`,
          [rows[0]?.id, access.userId],
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
