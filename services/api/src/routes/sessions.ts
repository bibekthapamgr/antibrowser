/**
 * Session leases and handoff (milestone 08, ADR-0015): one authorized writer per shared profile.
 *
 *   open      POST /orgs/{org}/profiles/{prf}/leases                      (Idempotency-Key) -> LeaseOpened
 *   heartbeat POST /orgs/{org}/profiles/{prf}/leases/{lse}/heartbeat       every 15 s; the lease lasts 60 s past it
 *   release   POST /orgs/{org}/profiles/{prf}/leases/{lse}/release         after the closing backup committed
 *   ask       POST /orgs/{org}/profiles/{prf}/handoff-requests             a teammate asks the holder for the profile
 *   takeover  POST /orgs/{org}/profiles/{prf}/force-takeover               admins, with a reason and a warning
 *
 * Rules: the database clock decides expiry; every acquisition takes a new fencing token from one sequence; a session
 * lease that expires without a release is uncertain and blocks others (see sessions.ts); a request to take over never
 * ends the other session by itself; a forced takeover or a revocation fences the old holder out with a new token.
 */
import {
  ApiError,
  ForceTakeover,
  HANDOFF_REQUEST_HOURS,
  HandoffRequest,
  HandoffRequestCreate,
  ID_PATTERN,
  LeaseBeat,
  LeaseEnd,
  LeaseHeartbeat,
  LeaseOpen,
  LeaseOpened,
  newId,
  Page,
  PageQuery,
  RecoveryCopy,
  SESSION_LEASE,
  SessionLease,
  secretHint,
  TakeoverResult,
} from '@pb/contracts';
import type pg from 'pg';
import Type, { type Static } from 'typebox';
import { type App, type Deps, principalOf } from '../app.ts';
import { audit, changeEntry } from '../audit.ts';
import { ts, withTx } from '../db.ts';
import { requestDigest, requireIdempotencyKey, runIdempotent } from '../idempotency.ts';
import { appendEvent } from '../outbox.ts';
import {
  browserMajor,
  endLease,
  requireEntitlement,
  SESSION_LEASE_COLUMNS,
  SESSION_LEASE_FROM,
} from '../sessions.ts';
import { profileFor, requirePermission, resolveTenant, type TenantAccess } from '../tenancy.ts';
import { errors, OrgParams, ProfileParams, pageOf, pageWindow } from './common.ts';

const param = (prefix: Parameters<typeof ID_PATTERN>[0]) => Type.String({ pattern: ID_PATTERN(prefix) });
const LeaseParams = Type.Object(
  { orgId: param('org'), profileId: param('prf'), leaseId: param('lse') },
  { additionalProperties: false },
);
const RequestParams = Type.Object(
  { orgId: param('org'), profileId: param('prf'), requestId: param('hrq') },
  { additionalProperties: false },
);
const OrgRequestsQuery = Type.Object(
  { mine: Type.Optional(Type.Boolean()) },
  { additionalProperties: false },
);

type LeaseView = Static<typeof SessionLease>;
type RequestView = Static<typeof HandoffRequest>;

interface LeaseRow {
  id: string;
  purpose: 'session' | 'upload';
  state: string;
  holder_user_id: string;
  holder_device_id: string;
  fencing_token: string;
  live: boolean;
  run_state: string | null;
  ttl_seconds: number;
  handoff_note: string | null;
  handoff_note_by: string | null;
  handoff_note_by_name: string | null;
  handoff_note_at: string | null;
  holder_name: string;
  device_name: string;
  acquired_at: string;
  heartbeat_at: string | null;
}

async function currentLease(c: pg.PoolClient, orgId: string, profileId: string, lock = false) {
  const { rows } = await c.query<LeaseRow>(
    `select l.id, l.purpose, l.state, l.holder_user_id, l.holder_device_id, l.fencing_token::text as fencing_token,
            l.expires_at > now() as live, l.run_state, l.ttl_seconds, l.handoff_note, l.handoff_note_by,
            nb.display_name as handoff_note_by_name, ${ts('l.handoff_note_at')} as handoff_note_at,
            coalesce(u.display_name, '') as holder_name, coalesce(l.device_name, '') as device_name,
            ${ts('l.acquired_at')} as acquired_at,
            ${ts('l.heartbeat_at')} as heartbeat_at
       from ${SESSION_LEASE_FROM} left join users nb on nb.id = l.handoff_note_by
      where l.org_id = $1 and l.profile_id = $2 ${lock ? 'for update of l' : ''}`,
    [orgId, profileId],
  );
  return rows[0] ?? null;
}

async function leaseView(c: pg.PoolClient, orgId: string, profileId: string): Promise<LeaseView> {
  const { rows } = await c.query<LeaseView>(
    `select ${SESSION_LEASE_COLUMNS} from ${SESSION_LEASE_FROM} where l.org_id = $1 and l.profile_id = $2`,
    [orgId, profileId],
  );
  const row = rows[0];
  if (!row) throw new ApiError('INTERNAL', 'Lease vanished');
  return row;
}

const REQUEST_COLUMNS = `r.id, r.profile_id, r.requested_by, coalesce(ru.display_name, '') as requested_by_name, r.holder_user_id,
  r.note, case when r.status = 'open' and r.expires_at <= now() then 'expired' else r.status end as status,
  ${ts('r.created_at')} as created_at, ${ts('r.responded_at')} as responded_at, ${ts('r.expires_at')} as expires_at`;

async function requestsFor(
  c: pg.PoolClient,
  access: TenantAccess,
  profileId: string,
  openOnly: boolean,
): Promise<RequestView[]> {
  const { rows } = await c.query<RequestView>(
    `select ${REQUEST_COLUMNS}, r.requested_by = $3 as mine
       from handoff_requests r left join users ru on ru.id = r.requested_by
      where r.org_id = $1 and r.profile_id = $2
        and (case when $4::boolean then r.status = 'open' and r.expires_at > now()
                  else r.created_at > now() - interval '24 hours' end)
      order by r.created_at desc limit 20`,
    [access.orgId, profileId, access.userId, openOnly],
  );
  return rows;
}

function checkNote(text: string | undefined, field: string): string | null {
  const t = (text ?? '').trim();
  if (!t) return null;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are refused, not shown
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F‪-‮⁦-⁩]/u.test(t)) {
    throw new ApiError('VALIDATION_FAILED', `${field} contains hidden characters`);
  }
  const hint = secretHint(t);
  if (hint) throw new ApiError('NOTE_LOOKS_SECRET', hint, { field });
  return t;
}

/** Ends the lease history row and the current lease of another holder that expired (upload) or is being replaced. */
async function supersede(c: pg.PoolClient, leaseId: string, by: string): Promise<void> {
  await c.query(
    `update lease_history set ended_at = coalesce(ended_at, now()), end_state = coalesce(end_state, 'superseded'),
            end_reason = coalesce(end_reason, 'superseded'), ended_by = coalesce(ended_by, $2)
      where id = $1`,
    [leaseId, by],
  );
}

export function sessionRoutes(app: App, deps: Deps): void {
  // ---------------------------------------------------------------- current lease
  app.get(
    '/orgs/:orgId/profiles/:profileId/leases/current',
    {
      schema: {
        tags: ['sessions'],
        description: 'Who has the profile open right now (null: nobody). Uncertain sessions are included.',
        params: ProfileParams,
        response: { 200: Type.Object({ lease: Type.Union([SessionLease, Type.Null()]) }), ...errors },
      },
    },
    async (req) => {
      const access = await resolveTenant(deps.pool, req, req.params.orgId);
      return withTx(deps.pool, access, async (c) => {
        await profileFor(c, access, req.params.profileId, 'profile.read', 'p.id');
        const { rows } = await c.query<LeaseView>(
          `select ${SESSION_LEASE_COLUMNS} from ${SESSION_LEASE_FROM}
            where l.org_id = $1 and l.profile_id = $2 and l.state = 'active'
              and (l.expires_at > now() or l.purpose = 'session')`,
          [access.orgId, req.params.profileId],
        );
        return { lease: rows[0] ?? null };
      });
    },
  );

  // ---------------------------------------------------------------- open
  app.post(
    '/orgs/:orgId/profiles/:profileId/leases',
    {
      schema: {
        tags: ['sessions'],
        description:
          'Takes the profile for this device (Idempotency-Key required): checks membership, the launch ' +
          'capability, the plan and the browser, then issues a new fencing token. 409 LEASE_HELD while someone has ' +
          'it open; 409 LEASE_UNCERTAIN when the last session ended without closing (ask that person to open the ' +
          'app, or an admin to force a takeover).',
        params: ProfileParams,
        body: LeaseOpen,
        response: { 201: LeaseOpened, 200: LeaseOpened, ...errors },
      },
    },
    async (req, reply) => {
      const access = await resolveTenant(deps.pool, req, req.params.orgId);
      const principal = principalOf(req);
      const key = requireIdempotencyKey(req.headers['idempotency-key']);
      const body = req.body;
      const purpose = body.purpose ?? 'session';
      const ttl = purpose === 'session' ? SESSION_LEASE.ttlSeconds : SESSION_LEASE.uploadTtlSeconds;
      const profileId = req.params.profileId;
      const digest = requestDigest({ user: access.userId, profile: profileId, body: { ...body, purpose } });

      const result = await withTx(deps.pool, access, async (c) => {
        // Authorization before any replay (a revoked grant also stops replays); the row lock serializes takers.
        const profile = await profileFor<{ snapshot_version: number; head_browser: string | null }>(
          c,
          access,
          profileId,
          purpose === 'session' ? 'profile.launch' : 'snapshot.commit',
          `p.snapshot_version, (select s.browser_revision from snapshot_manifests s
                                 where s.id = p.head_snapshot_id) as head_browser`,
          true,
        );
        return runIdempotent(
          c,
          { orgId: access.orgId, operation: 'lease.acquire', key, digest },
          async () => {
            const taken = await takeLease(c, access, principal.deviceId, {
              profileId,
              deviceId: body.device_id,
              purpose,
              ttl,
              platform: body.platform,
              browserVersion: body.browser_version,
              headBrowser: profile.head_browser,
            });
            const opened: Static<typeof LeaseOpened> = {
              lease: await leaseView(c, access.orgId, profileId),
              handoff_note: taken.note,
              head_version: profile.snapshot_version,
              server_time: new Date().toISOString(),
            };
            return { status: 201, body: opened };
          },
        );
      });
      return reply
        .status(result.replayed ? 200 : result.status)
        .header('idempotent-replayed', String(result.replayed))
        .send(result.body);
    },
  );

  // ---------------------------------------------------------------- heartbeat
  app.post(
    '/orgs/:orgId/profiles/:profileId/leases/:leaseId/heartbeat',
    {
      schema: {
        tags: ['sessions'],
        description:
          `Keeps the lease (every ${SESSION_LEASE.heartbeatSeconds} s; it lasts ${SESSION_LEASE.ttlSeconds} s past the ` +
          'last heartbeat) and reports the run state. Returns teammates’ open requests. A holder whose lease expired ' +
          'without anyone else taking it gets it back (revived). 409 FENCING_TOKEN_STALE once it was taken over, ' +
          'revoked or replaced (safe_details.state): stop the browser and keep the local copy aside. 404/403 when ' +
          'access was removed.',
        params: LeaseParams,
        body: LeaseHeartbeat,
        response: { 200: LeaseBeat, ...errors },
      },
    },
    async (req) => {
      const access = await resolveTenant(deps.pool, req, req.params.orgId);
      const { profileId, leaseId } = req.params;
      return withTx(deps.pool, access, async (c) => {
        await profileFor(c, access, profileId, 'profile.launch', 'p.id');
        const l = await ownLease(c, access, profileId, leaseId, req.body.fencing_token);
        if (l.state !== 'active') {
          throw new ApiError('FENCING_TOKEN_STALE', 'This lease has ended', { state: l.state });
        }
        const revived = !l.live;
        const runState = req.body.run_state ?? null;
        const { rows } = await c.query<{ version: number }>(
          `update profile_leases set expires_at = now() + make_interval(secs => ttl_seconds), heartbeat_at = now(),
                  run_state = coalesce($2, run_state), version = version + 1
            where id = $1 returning version`,
          [leaseId, runState],
        );
        if (revived) {
          await audit(c, changeEntry(access, 'lease.revived', 'profile', profileId, { lease_id: leaseId }));
        }
        if (runState && runState !== l.run_state) {
          await audit(
            c,
            changeEntry(access, `session.${runState}`, 'profile', profileId, {
              lease_id: leaseId,
              from: l.run_state,
            }),
          );
          await appendEvent(c, {
            orgId: access.orgId,
            actorId: access.userId,
            aggregateId: profileId,
            aggregateVersion: rows[0]?.version ?? 1,
            eventType: 'session.state_changed',
            payload: { lease_id: leaseId, run_state: runState },
          });
        }
        return {
          lease: await leaseView(c, access.orgId, profileId),
          revived,
          handoff_requests: await requestsFor(c, access, profileId, true),
          server_time: new Date().toISOString(),
        };
      });
    },
  );

  // ---------------------------------------------------------------- release
  app.post(
    '/orgs/:orgId/profiles/:profileId/leases/:leaseId/release',
    {
      schema: {
        tags: ['sessions'],
        description:
          'Gives the profile back (holder only, current fencing token), optionally with a handoff note for the next ' +
          'person. Allowed after expiry: the holder confirms its browser closed. Releasing twice is a no-op. Open ' +
          'requests for the profile are answered (fulfilled).',
        params: LeaseParams,
        body: LeaseEnd,
        response: { 204: Type.Null(), ...errors },
      },
    },
    async (req, reply) => {
      const access = await resolveTenant(deps.pool, req, req.params.orgId);
      const { profileId, leaseId } = req.params;
      const note = checkNote(req.body.handoff_note, 'handoff_note');
      await withTx(deps.pool, access, async (c) => {
        await profileFor(c, access, profileId, 'profile.read', 'p.id');
        const l = await ownLease(c, access, profileId, leaseId, req.body.fencing_token);
        if (l.state === 'released') return;
        if (l.state !== 'active') {
          throw new ApiError('FENCING_TOKEN_STALE', 'This lease has ended', { state: l.state });
        }
        const { rows } = await c.query<{ version: number }>(
          `update profile_leases set state = 'released', released_at = now(), end_reason = $2, run_state = 'closed',
                  handoff_note = $3, handoff_note_by = case when $3::text is null then null else $4 end,
                  handoff_note_at = case when $3::text is null then null else now() end, version = version + 1
            where id = $1 returning version`,
          [leaseId, req.body.outcome, note, access.userId],
        );
        await c.query(
          `update lease_history set ended_at = now(), end_state = 'released', end_reason = $2, ended_by = $3
            where id = $1`,
          [leaseId, req.body.outcome, access.userId],
        );
        const answered = await c.query(
          `update handoff_requests set status = 'fulfilled', responded_at = now()
            where org_id = $1 and profile_id = $2 and status = 'open'`,
          [access.orgId, profileId],
        );
        await audit(
          c,
          changeEntry(access, 'lease.released', 'profile', profileId, {
            lease_id: leaseId,
            outcome: req.body.outcome,
            handoff_note: note !== null,
            requests_fulfilled: answered.rowCount ?? 0,
          }),
        );
        await appendEvent(c, {
          orgId: access.orgId,
          actorId: access.userId,
          aggregateId: profileId,
          aggregateVersion: rows[0]?.version ?? 1,
          eventType: 'lease.released',
          payload: { lease_id: leaseId, outcome: req.body.outcome },
        });
      });
      return reply.status(204).send(null);
    },
  );

  // ---------------------------------------------------------------- handoff requests
  app.post(
    '/orgs/:orgId/profiles/:profileId/handoff-requests',
    {
      schema: {
        tags: ['sessions'],
        description:
          'Asks the person who has the profile open to hand it over (optional note, no passwords). It never closes ' +
          'their session: they choose when to close and hand off. One open request per person and profile; ' +
          `requests expire after ${HANDOFF_REQUEST_HOURS} hours.`,
        params: ProfileParams,
        body: HandoffRequestCreate,
        response: { 201: HandoffRequest, 200: HandoffRequest, ...errors },
      },
    },
    async (req, reply) => {
      const access = await resolveTenant(deps.pool, req, req.params.orgId);
      const principal = principalOf(req);
      const { profileId } = req.params;
      const note = checkNote(req.body.note, 'note') ?? '';
      const out = await withTx(deps.pool, access, async (c) => {
        await profileFor(c, access, profileId, 'profile.launch', 'p.id', true);
        const l = await currentLease(c, access.orgId, profileId);
        if (l?.state !== 'active' || (!l.live && l.purpose !== 'session')) {
          throw new ApiError('PROFILE_NOT_IN_USE', 'Nobody has this profile open: you can open it now');
        }
        if (l.holder_user_id === access.userId) {
          throw new ApiError('VALIDATION_FAILED', 'You have this profile open yourself');
        }
        await c.query(
          `update handoff_requests set status = 'expired', responded_at = now()
            where org_id = $1 and profile_id = $2 and status = 'open' and expires_at <= now()`,
          [access.orgId, profileId],
        );
        const existing = await c.query<{ id: string }>(
          `select id from handoff_requests where org_id = $1 and profile_id = $2 and requested_by = $3 and status = 'open'`,
          [access.orgId, profileId, access.userId],
        );
        let id = existing.rows[0]?.id;
        let status = 200;
        if (!id) {
          id = newId('handoffRequest');
          status = 201;
          await c.query(
            `insert into handoff_requests (id, org_id, profile_id, requested_by, requested_device, holder_user_id,
                                           lease_id, note, status, expires_at)
             values ($1, $2, $3, $4, $5, $6, $7, $8, 'open', now() + make_interval(hours => $9))`,
            [
              id,
              access.orgId,
              profileId,
              access.userId,
              req.body.device_id ?? principal.deviceId,
              l.holder_user_id,
              l.id,
              note,
              HANDOFF_REQUEST_HOURS,
            ],
          );
          await audit(
            c,
            changeEntry(access, 'handoff.requested', 'profile', profileId, {
              request_id: id,
              holder: l.holder_user_id,
              note: note.length > 0,
            }),
          );
          await appendEvent(c, {
            orgId: access.orgId,
            actorId: access.userId,
            aggregateId: id,
            aggregateVersion: 1,
            eventType: 'handoff.requested',
            payload: { profile_id: profileId, holder: l.holder_user_id },
          });
        }
        return { status, request: await requestById(c, access, id) };
      });
      return reply.status(out.status).send(out.request);
    },
  );

  app.get(
    '/orgs/:orgId/profiles/:profileId/handoff-requests',
    {
      schema: {
        tags: ['sessions'],
        description: 'Requests for this profile from the last 24 hours, newest first.',
        params: ProfileParams,
        response: { 200: Type.Object({ items: Type.Array(HandoffRequest) }), ...errors },
      },
    },
    async (req) => {
      const access = await resolveTenant(deps.pool, req, req.params.orgId);
      return withTx(deps.pool, access, async (c) => {
        await profileFor(c, access, req.params.profileId, 'profile.read', 'p.id');
        return { items: await requestsFor(c, access, req.params.profileId, false) };
      });
    },
  );

  app.get(
    '/orgs/:orgId/handoff-requests',
    {
      schema: {
        tags: ['sessions'],
        description:
          'The caller’s requests (mine=true) or requests addressed to the caller as holder, from the last 24 hours.',
        params: OrgParams,
        querystring: OrgRequestsQuery,
        response: { 200: Type.Object({ items: Type.Array(HandoffRequest) }), ...errors },
      },
    },
    async (req) => {
      const access = await resolveTenant(deps.pool, req, req.params.orgId);
      requirePermission(access, 'profile.read');
      return withTx(deps.pool, access, async (c) => {
        const { rows } = await c.query<RequestView>(
          `select ${REQUEST_COLUMNS}, r.requested_by = $2 as mine
             from handoff_requests r left join users ru on ru.id = r.requested_by
            where r.org_id = $1 and r.created_at > now() - interval '24 hours'
              and (case when $3::boolean then r.requested_by = $2 else r.holder_user_id = $2 end)
            order by r.created_at desc limit 50`,
          [access.orgId, access.userId, req.query.mine ?? false],
        );
        return { items: rows };
      });
    },
  );

  for (const action of ['decline', 'cancel'] as const) {
    app.post(
      `/orgs/:orgId/profiles/:profileId/handoff-requests/:requestId/${action}`,
      {
        schema: {
          tags: ['sessions'],
          description:
            action === 'decline'
              ? 'The person who has the profile open says not now (the requester sees it).'
              : 'The requester withdraws the request.',
          params: RequestParams,
          response: { 200: HandoffRequest, ...errors },
        },
      },
      async (req) => {
        const access = await resolveTenant(deps.pool, req, req.params.orgId);
        const { profileId, requestId } = req.params;
        return withTx(deps.pool, access, async (c) => {
          await profileFor(c, access, profileId, 'profile.read', 'p.id');
          const { rows } = await c.query<{ requested_by: string; status: string; open: boolean }>(
            `select requested_by, status, (status = 'open' and expires_at > now()) as open
               from handoff_requests where org_id = $1 and profile_id = $2 and id = $3 for update`,
            [access.orgId, profileId, requestId],
          );
          const r = rows[0];
          if (!r) throw new ApiError('NOT_FOUND', 'Request not found');
          if (action === 'cancel' && r.requested_by !== access.userId) {
            throw new ApiError('NOT_FOUND', 'Request not found');
          }
          if (action === 'decline') {
            const l = await currentLease(c, access.orgId, profileId);
            if (l?.state !== 'active' || l.holder_user_id !== access.userId) {
              throw new ApiError('FORBIDDEN', 'Only the person who has the profile open can answer');
            }
          }
          if (r.open) {
            await c.query(`update handoff_requests set status = $2, responded_at = now() where id = $1`, [
              requestId,
              action === 'decline' ? 'declined' : 'canceled',
            ]);
            await audit(
              c,
              changeEntry(
                access,
                `handoff.${action === 'decline' ? 'declined' : 'canceled'}`,
                'profile',
                profileId,
                {
                  request_id: requestId,
                },
              ),
            );
            await appendEvent(c, {
              orgId: access.orgId,
              actorId: access.userId,
              aggregateId: requestId,
              aggregateVersion: 2,
              eventType: 'handoff.answered',
              payload: { profile_id: profileId, status: action === 'decline' ? 'declined' : 'canceled' },
            });
          }
          return requestById(c, access, requestId);
        });
      },
    );
  }

  // ---------------------------------------------------------------- forced takeover
  app.post(
    '/orgs/:orgId/profiles/:profileId/force-takeover',
    {
      schema: {
        tags: ['sessions'],
        description:
          'Owners and admins end someone’s session or uncertain lease (reason required, confirm: true). A new ' +
          'fencing token fences the old device out: nothing it still sends is written, and its unsynced copy is kept ' +
          'aside on that computer (and as a recovery copy if it uploads one). The other browser may still be open: ' +
          'this cannot stop activity on websites there.',
        params: ProfileParams,
        body: ForceTakeover,
        response: { 200: TakeoverResult, ...errors },
      },
    },
    async (req) => {
      const access = await resolveTenant(deps.pool, req, req.params.orgId);
      const reason = checkNote(req.body.reason, 'reason');
      if (!reason || reason.length < 3) throw new ApiError('VALIDATION_FAILED', 'A reason is required');
      return withTx(deps.pool, access, async (c) => {
        await profileFor(c, access, req.params.profileId, 'lease.force_release', 'p.id', true);
        const l = await currentLease(c, access.orgId, req.params.profileId, true);
        if (l?.state !== 'active' || (!l.live && l.purpose !== 'session')) {
          throw new ApiError('PROFILE_NOT_IN_USE', 'Nobody has this profile open');
        }
        const previous = await leaseView(c, access.orgId, req.params.profileId);
        const ended = await endLease(c, access, req.params.profileId, 'taken_over', reason);
        if (!ended) throw new ApiError('PROFILE_NOT_IN_USE', 'Nobody has this profile open');
        return { previous, fencing_token: ended.token };
      });
    },
  );

  // ---------------------------------------------------------------- recovery copies
  app.get(
    '/orgs/:orgId/recovery-copies',
    {
      schema: {
        tags: ['sessions'],
        description:
          'Uploads kept from devices that lost their session (taken over or revoked), newest first. Owners and ' +
          'admins can restore one as a separate copy; they are erased after the trash period.',
        params: OrgParams,
        querystring: PageQuery,
        response: { 200: Page(RecoveryCopy), ...errors },
      },
    },
    async (req) => {
      const access = await resolveTenant(deps.pool, req, req.params.orgId);
      requirePermission(access, 'backups.manage');
      const window = pageWindow(req.query);
      const rows = await withTx(deps.pool, access, async (c) => {
        const { rows } = await c.query<Static<typeof RecoveryCopy>>(
          `select s.id, s.profile_id, p.name as profile_name, s.lease_id, s.created_by, coalesce(u.display_name, '') as created_by_name,
                  s.device_id, s.size_bytes::float8 as ciphertext_size, s.plaintext_size::float8 as plaintext_size,
                  s.platform, s.browser_revision as browser_version, ${ts('s.committed_at')} as kept_at,
                  ${ts('(s.committed_at + make_interval(days => o.trash_days))')} as erase_after
             from snapshot_manifests s join profiles p on p.org_id = s.org_id and p.id = s.profile_id
             left join users u on u.id = s.created_by join organizations o on o.id = s.org_id
            where s.org_id = $1 and s.status = 'recovery'
              and ($2::timestamptz is null or (s.committed_at, s.id) < ($2::timestamptz, $3::text))
            order by s.committed_at desc, s.id desc limit $4`,
          [access.orgId, window.after?.k ?? null, window.after?.id ?? '', window.limit + 1],
        );
        return rows;
      });
      return pageOf(rows, window, (r) => ({ k: r.kept_at, id: r.id }));
    },
  );
}

export interface TakeLease {
  profileId: string;
  deviceId: string;
  purpose: 'session' | 'upload';
  ttl: number;
  platform: string | null;
  browserVersion: string | null;
  /** Browser version of the profile's newest backup (sessions need at least its major version). */
  headBrowser: string | null;
}

/**
 * Takes the profile's lease for the caller's device (inside the caller's transaction, after authorization and with
 * the profile row locked). Refuses while another device holds it (LEASE_HELD) or its session ended without closing
 * (LEASE_UNCERTAIN); the same device taking it again replaces its own lease (a new token).
 */
export async function takeLease(
  c: pg.PoolClient,
  access: TenantAccess,
  callerDevice: string | null,
  input: TakeLease,
): Promise<{ leaseId: string; token: string; note: Static<typeof LeaseOpened>['handoff_note'] }> {
  if (callerDevice && callerDevice !== input.deviceId) {
    throw new ApiError('FORBIDDEN', 'device_id must be the device making the request');
  }
  const device = await c.query<{ name: string }>(
    'select name from devices where id = $1 and user_id = $2 and revoked_at is null',
    [input.deviceId, access.userId],
  );
  if (device.rowCount === 0) {
    throw new ApiError('FORBIDDEN', 'device_id is not an active device of the caller');
  }
  if (input.purpose === 'session') {
    await requireEntitlement(c, access.orgId, 'team_sessions');
    const need = browserMajor(input.headBrowser);
    const have = browserMajor(input.browserVersion);
    if (need !== null && (have === null || have < need)) {
      throw new ApiError('RUNTIME_TOO_OLD', 'The newest backup needs a newer browser on this device', {
        required_major: need,
      });
    }
  }

  const existing = await currentLease(c, access.orgId, input.profileId, true);
  let note: Static<typeof LeaseOpened>['handoff_note'] = null;
  if (existing?.state === 'active') {
    const mine = existing.holder_user_id === access.userId && existing.holder_device_id === input.deviceId;
    const details = {
      holder_name: existing.holder_name,
      device_name: existing.device_name,
      since: existing.acquired_at,
      run_state: existing.run_state,
      purpose: existing.purpose,
    };
    if (!mine) {
      if (existing.live) throw new ApiError('LEASE_HELD', 'Profile is in use on another device', details);
      if (existing.purpose === 'session') {
        throw new ApiError(
          'LEASE_UNCERTAIN',
          'The last session on another device ended without closing; its browser may still be open',
          { ...details, last_heartbeat_at: existing.heartbeat_at },
        );
      }
    } else if (existing.purpose === 'session' && input.purpose === 'upload') {
      throw new ApiError('LEASE_HELD', 'A session of this profile is open on this device', details);
    }
    await supersede(c, existing.id, access.userId);
  } else if (existing?.state === 'released' && existing.handoff_note && existing.handoff_note_by) {
    note = {
      text: existing.handoff_note,
      by_user_id: existing.handoff_note_by,
      by_name: existing.handoff_note_by_name ?? '',
      at: existing.handoff_note_at ?? new Date().toISOString(),
    };
  }

  const leaseId = newId('lease');
  const { rows } = await c.query<{ version: number; fencing_token: string }>(
    `insert into profile_leases as l
         (id, profile_id, org_id, holder_device_id, holder_user_id, fencing_token, acquired_at, expires_at,
          purpose, state, ttl_seconds, run_state, platform, browser_version, device_name)
       values ($1, $2, $3, $4, $5, nextval('lease_fencing_seq'), now(), now() + make_interval(secs => $6),
               $7, 'active', $6, $8, $9, $10, $11)
       on conflict (profile_id) do update set
         id = excluded.id, holder_device_id = excluded.holder_device_id,
         holder_user_id = excluded.holder_user_id, fencing_token = excluded.fencing_token,
         acquired_at = excluded.acquired_at, expires_at = excluded.expires_at, released_at = null,
         purpose = excluded.purpose, state = 'active', ttl_seconds = excluded.ttl_seconds,
         run_state = excluded.run_state, platform = excluded.platform,
         browser_version = excluded.browser_version, device_name = excluded.device_name, heartbeat_at = null,
         ended_by = null, end_reason = null,
         handoff_note = null, handoff_note_by = null, handoff_note_at = null, version = l.version + 1
       returning version, fencing_token::text as fencing_token`,
    [
      leaseId,
      input.profileId,
      access.orgId,
      input.deviceId,
      access.userId,
      input.ttl,
      input.purpose,
      input.purpose === 'session' ? 'starting' : null,
      input.platform,
      input.browserVersion,
      device.rows[0]?.name ?? null,
    ],
  );
  const row = rows[0];
  if (!row) throw new ApiError('INTERNAL', 'Lease was not created');
  await c.query(
    `insert into lease_history (id, org_id, profile_id, purpose, holder_user_id, holder_device_id, fencing_token)
       values ($1, $2, $3, $4, $5, $6, $7::bigint)`,
    [leaseId, access.orgId, input.profileId, input.purpose, access.userId, input.deviceId, row.fencing_token],
  );
  await audit(
    c,
    changeEntry(access, 'lease.acquired', 'profile', input.profileId, {
      lease_id: leaseId,
      purpose: input.purpose,
      device_id: input.deviceId,
    }),
  );
  await appendEvent(c, {
    orgId: access.orgId,
    actorId: access.userId,
    aggregateId: input.profileId,
    aggregateVersion: row.version,
    eventType: 'lease.acquired',
    payload: { lease_id: leaseId, purpose: input.purpose, device_id: input.deviceId },
  });
  return { leaseId, token: row.fencing_token, note };
}

/** The caller's lease `leaseId` on the profile with this token, locked; or why it is not theirs any more. */
async function ownLease(
  c: pg.PoolClient,
  access: TenantAccess,
  profileId: string,
  leaseId: string,
  token: string,
): Promise<LeaseRow> {
  const l = await currentLease(c, access.orgId, profileId, true);
  const holder = (h: { holder_user_id: string; holder_device_id: string }) =>
    h.holder_user_id === access.userId && (!access.deviceId || h.holder_device_id === access.deviceId);
  if (!l || l.id !== leaseId) {
    // Replaced since: say how this lease ended (only to its holder).
    const { rows } = await c.query<{
      end_state: string | null;
      holder_user_id: string;
      holder_device_id: string;
    }>(
      `select end_state, holder_user_id, holder_device_id from lease_history
        where org_id = $1 and profile_id = $2 and id = $3`,
      [access.orgId, profileId, leaseId],
    );
    const h = rows[0];
    if (!h || !holder(h)) throw new ApiError('NOT_FOUND', 'Lease not found');
    if (h.end_state === 'released') return { ...(l as LeaseRow), id: leaseId, state: 'released' };
    throw new ApiError('FENCING_TOKEN_STALE', 'This lease has ended', { state: h.end_state ?? 'superseded' });
  }
  if (!holder(l)) throw new ApiError('LEASE_NOT_HELD', 'This lease belongs to another device');
  if (l.fencing_token !== token) {
    throw new ApiError('FENCING_TOKEN_STALE', 'A newer lease exists for this profile; stop writing', {
      state: l.state === 'active' ? 'superseded' : l.state,
    });
  }
  return l;
}

async function requestById(c: pg.PoolClient, access: TenantAccess, id: string): Promise<RequestView> {
  const { rows } = await c.query<RequestView>(
    `select ${REQUEST_COLUMNS}, r.requested_by = $3 as mine
       from handoff_requests r left join users ru on ru.id = r.requested_by
      where r.org_id = $1 and r.id = $2`,
    [access.orgId, id, access.userId],
  );
  const row = rows[0];
  if (!row) throw new ApiError('INTERNAL', 'Request vanished');
  return row;
}
