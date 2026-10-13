/**
 * Automation (milestone 10, ADR-0017): approved sites, jobs, enrolled computers (agents) and what they report.
 *
 *   GET/PUT  /orgs/{org}/automation/settings                approved sites, running-job limit
 *   POST     /orgs/{org}/automation/jobs                    Idempotency-Key; API tokens: yes
 *   GET      /orgs/{org}/automation/jobs[/{job}]            API tokens: yes
 *   POST     /orgs/{org}/automation/jobs/{job}/cancel       API tokens: yes (a profile kept open closes: stop)
 *   GET      /orgs/{org}/automation/jobs/{job}/artifacts/{art}   the screenshot (API tokens: yes)
 *   POST/GET /orgs/{org}/automation/agents                  enroll this computer / list
 *   PATCH/DELETE /orgs/{org}/automation/agents/{agt}
 *   POST     /orgs/{org}/automation/agents/{agt}/poll       heartbeat + new jobs + cancellations (the computer)
 *   POST     /orgs/{org}/automation/jobs/{job}/report       started / step_started / step_finished / released / finished
 *   PUT      /orgs/{org}/automation/jobs/{job}/steps/{seq}/artifact   screenshot upload (the computer)
 *
 * Computers connect out to the server (polling); nothing listens on them for the server. Every report names the
 * claim it holds (attempt) and comes from that computer; a job's steps start only while its session lease is current.
 */
import { createHash } from 'node:crypto';
import {
  AGENT_TIMING,
  Agent,
  AgentEnroll,
  AgentPoll,
  AgentPollResult,
  AgentUpdate,
  ApiError,
  AutomationSettings,
  AutomationSettingsUpdate,
  type ClaimedJob,
  FINISHED_JOB_STATES,
  ID_PATTERN,
  Job,
  JobCancel,
  JobCreate,
  JobDetail,
  type JobErrorCode,
  JobQuery,
  JobReport,
  JobReportResult,
  type JobState,
  newId,
  Page,
  parseOriginPattern,
  STEP_LIMITS,
  type StepAction,
  stepsProblem,
} from '@pb/contracts';
import type pg from 'pg';
import Type, { type Static } from 'typebox';
import { type App, type Deps, principalOf } from '../app.ts';
import { audit, changeEntry } from '../audit.ts';
import {
  type Actor,
  AGENT_COLUMNS,
  AGENT_FROM,
  type AgentRow,
  ARTIFACT_COLUMNS,
  claimedJob,
  claimJobs,
  effectOf,
  endJob,
  JOB_COLUMNS,
  JOB_FROM,
  jobById,
  jobEvent,
  plannedSteps,
  removeAgentJobs,
  settingsOf,
  stepsOf,
} from '../automation.ts';
import { withTx } from '../db.ts';
import { requestDigest, requireIdempotencyKey, runIdempotent } from '../idempotency.ts';
import { hit, LIMITS } from '../ratelimit.ts';
import { requireEntitlement, userMayLaunch } from '../sessions.ts';
import {
  profileFor,
  profileVisible,
  requireInteractive,
  requirePermission,
  resolveTenant,
  type TenantAccess,
} from '../tenancy.ts';
import { errors, expectedVersion, OrgParams, pageOf, pageWindow, versionConflict } from './common.ts';

const param = (prefix: Parameters<typeof ID_PATTERN>[0]) => Type.String({ pattern: ID_PATTERN(prefix) });
const JobParams = Type.Object({ orgId: param('org'), jobId: param('job') }, { additionalProperties: false });
const ArtifactParams = Type.Object(
  { orgId: param('org'), jobId: param('job'), artifactId: param('art') },
  { additionalProperties: false },
);
const StepParams = Type.Object(
  { orgId: param('org'), jobId: param('job'), seq: Type.Integer({ minimum: 0, maximum: 64 }) },
  { additionalProperties: false },
);
const AgentParams = Type.Object(
  { orgId: param('org'), agentId: param('agt') },
  { additionalProperties: false },
);
const ArtifactQuery = Type.Object(
  {
    attempt: Type.Integer({ minimum: 1 }),
    width: Type.Integer({ minimum: 0, maximum: 100_000 }),
    height: Type.Integer({ minimum: 0, maximum: 100_000 }),
  },
  { additionalProperties: false },
);

/** Queued jobs allowed at once (per organization, and per requester: a token, or a person without one). */
const QUEUE_LIMITS = { perOrg: 500, perRequester: 100 } as const;

/** Output fields each action may report (StepOutput restricts the shape; this restricts by action). */
const OUTPUT_FIELDS: Record<StepAction, readonly string[]> = {
  open_profile: ['restored', 'browser_version', 'elapsed_ms'],
  open_url: ['final_origin', 'http_status', 'elapsed_ms'],
  wait_for: ['elapsed_ms'],
  screenshot: ['artifact_id', 'width', 'height', 'elapsed_ms'],
  debug_bridge: ['endpoint', 'commands'],
  hold_open: ['elapsed_ms'],
  close_profile: ['backup', 'elapsed_ms'],
};

type JobView = Static<typeof Job>;
type AgentView = Static<typeof Agent>;

function actorOf(access: TenantAccess): Actor {
  return {
    orgId: access.orgId,
    userId: access.userId,
    deviceId: access.deviceId,
    requestId: access.requestId,
  };
}

async function jobDetail(
  c: pg.PoolClient,
  access: TenantAccess,
  jobId: string,
): Promise<Static<typeof JobDetail>> {
  const job = await jobById(c, access.orgId, jobId, access.userId);
  if (!job) throw new ApiError('NOT_FOUND', 'Job not found');
  const steps = await stepsOf(c, jobId);
  const { rows: artifacts } = await c.query<Static<typeof JobDetail>['artifacts'][number]>(
    `select ${ARTIFACT_COLUMNS} from job_artifacts a where a.job_id = $1 order by a.sequence`,
    [jobId],
  );
  return { job, steps, artifacts };
}

/** A job the caller may see: its profile is within reach (role, grants, token restrictions). */
async function visibleJob(c: pg.PoolClient, access: TenantAccess, jobId: string, lock = false) {
  const { rows } = await c.query<{
    id: string;
    state: JobState;
    requested_by: string;
    token_id: string | null;
  }>(
    `select j.id, j.state, j.requested_by, j.token_id
       from automation_jobs j join profiles p on p.org_id = j.org_id and p.id = j.profile_id
      where j.org_id = $1 and j.id = $2 and ${profileVisible(access, 'p', '$3')}
      ${lock ? 'for update of j' : ''}`,
    [access.orgId, jobId, access.userId],
  );
  const row = rows[0];
  if (!row) throw new ApiError('NOT_FOUND', 'Job not found');
  return row;
}

async function agentView(c: pg.PoolClient, access: TenantAccess, agentId: string): Promise<AgentView> {
  const { rows } = await c.query<AgentView>(
    `select ${AGENT_COLUMNS}, a.user_id = $3 as mine from ${AGENT_FROM} where a.org_id = $1 and a.id = $2`,
    [access.orgId, agentId, access.userId],
  );
  const row = rows[0];
  if (!row) throw new ApiError('NOT_FOUND', 'Computer not found');
  return row;
}

/** The caller's own enrolled computer (this device, when the sign-in is a device session). */
async function ownAgent(
  c: pg.PoolClient,
  access: TenantAccess,
  agentId: string,
  lock = false,
): Promise<AgentRow> {
  const { rows } = await c.query<AgentRow>(
    `select id, org_id, device_id, user_id, enabled, accepts, debug_allowed, max_jobs, version
       from automation_agents where org_id = $1 and id = $2 ${lock ? 'for update' : ''}`,
    [access.orgId, agentId],
  );
  const a = rows[0];
  if (!a || a.user_id !== access.userId) throw new ApiError('NOT_FOUND', 'Computer not found');
  if (access.deviceId && a.device_id !== access.deviceId) {
    throw new ApiError('FORBIDDEN', 'Only that computer can do this', { permission: 'automation.agent' });
  }
  return a;
}

export function automationRoutes(app: App, deps: Deps): void {
  // Screenshots arrive as raw image bodies (only on the artifact route; its own size limit).
  app.addContentTypeParser(['image/jpeg', 'image/png'], { parseAs: 'buffer' }, (_req, body, done) =>
    done(null, body),
  );

  // ---------------------------------------------------------------- settings
  app.get(
    '/orgs/:orgId/automation/settings',
    {
      config: { tokens: true },
      schema: {
        tags: ['automation'],
        description: 'Approved sites (where job steps may go) and the running-job limit.',
        params: OrgParams,
        response: { 200: AutomationSettings, ...errors },
      },
    },
    async (req) => {
      const access = await resolveTenant(deps.pool, req, req.params.orgId);
      requirePermission(access, 'automation.read');
      return withTx(deps.pool, access, async (c) => ({
        org_id: access.orgId,
        ...(await settingsOf(c, access.orgId)),
      }));
    },
  );

  app.put(
    '/orgs/:orgId/automation/settings',
    {
      schema: {
        tags: ['automation'],
        description:
          'Owners and admins (automation.manage). Approved sites: `https://app.example.com`, `https://*.example.com`, ' +
          '`http://localhost:3000` (scheme, host, optional port). Jobs whose addresses are not approved are refused; ' +
          'queued jobs are checked again when a computer picks them up. Requires If-Match or expected_version.',
        params: OrgParams,
        body: AutomationSettingsUpdate,
        response: { 200: AutomationSettings, ...errors },
      },
    },
    async (req) => {
      requireInteractive(req.principal);
      const access = await resolveTenant(deps.pool, req, req.params.orgId);
      requirePermission(access, 'automation.manage');
      const expected = expectedVersion(req.headers['if-match'], req.body.expected_version);
      const origins = req.body.allowed_origins;
      if (origins) {
        for (const [index, o] of origins.entries()) {
          if (!parseOriginPattern(o)) {
            throw new ApiError('VALIDATION_FAILED', 'Not a valid site (scheme://host[:port])', {
              index,
              site: o,
            });
          }
        }
      }
      return withTx(deps.pool, access, async (c) => {
        const current = await settingsOf(c, access.orgId);
        if (current.version !== expected) throw versionConflict(current.version);
        await c.query(
          `insert into automation_settings as s (org_id, allowed_origins, max_running_jobs, version, updated_by, updated_at)
           values ($1, coalesce($2, '{}'::text[]), coalesce($3, 5), 2, $4, now())
           on conflict (org_id) do update set
             allowed_origins = coalesce($2, s.allowed_origins),
             max_running_jobs = coalesce($3, s.max_running_jobs),
             version = s.version + 1, updated_by = $4, updated_at = now()`,
          [
            access.orgId,
            origins ? [...new Set(origins)] : null,
            req.body.max_running_jobs ?? null,
            access.userId,
          ],
        );
        await audit(
          c,
          changeEntry(access, 'automation.settings_updated', 'organization', access.orgId, {
            sites: origins?.length ?? null,
            max_running_jobs: req.body.max_running_jobs ?? null,
          }),
        );
        return { org_id: access.orgId, ...(await settingsOf(c, access.orgId)) };
      });
    },
  );

  // ---------------------------------------------------------------- jobs
  app.post(
    '/orgs/:orgId/automation/jobs',
    {
      config: { tokens: true },
      schema: {
        tags: ['automation'],
        description:
          'Scope: automation:run. Idempotency-Key required: a repeated request answers the same job ' +
          '(200, idempotent-replayed: true); the same key with a different body is refused. The profile must be one ' +
          'you may open (grant capability launch); every address must be on the approved sites. The first step ' +
          'must open an address. keep_open_minutes keeps the profile open after the steps (a launch request) until ' +
          'canceled; debug (automation:debug, owners and admins) hands that session to a local Playwright script.',
        params: OrgParams,
        body: JobCreate,
        response: { 201: JobDetail, 200: JobDetail, ...errors },
      },
    },
    async (req, reply) => {
      const access = await resolveTenant(deps.pool, req, req.params.orgId);
      requirePermission(access, 'automation.run');
      const body = req.body;
      if (body.debug) requirePermission(access, 'automation.debug');
      if (body.debug && body.keep_open_minutes === undefined) {
        throw new ApiError('VALIDATION_FAILED', 'A debugging session needs keep_open_minutes', {
          field: 'keep_open_minutes',
        });
      }
      if (body.steps.length === 0 && body.keep_open_minutes === undefined) {
        throw new ApiError('VALIDATION_FAILED', 'Nothing to do: add steps or keep_open_minutes', {
          field: 'steps',
        });
      }
      const key = requireIdempotencyKey(req.headers['idempotency-key']);
      const digest = requestDigest({ user: access.userId, token: access.token?.id ?? null, body });
      await hit(deps.pool, LIMITS.jobCreatePerOrg, access.orgId);
      const result = await withTx(deps.pool, access, async (c) => {
        // Authorization before any replay: a revoked grant or token also stops replays.
        await profileFor(c, access, body.profile_id, 'profile.launch', 'p.id', true);
        return runIdempotent(
          c,
          { orgId: access.orgId, operation: 'automation.job', key, digest },
          async () => {
            await requireEntitlement(c, access.orgId, 'automation');
            const settings = await settingsOf(c, access.orgId);
            const problem = stepsProblem(body.steps, settings.allowed_origins);
            if (problem) {
              throw new ApiError(
                problem.code,
                problem.code === 'URL_NOT_APPROVED'
                  ? 'This address is not on your organization’s approved sites'
                  : 'These steps are not allowed',
                { step: problem.index, reason: problem.reason },
              );
            }
            if (body.agent_id)
              await checkChosenAgent(c, access, body.agent_id, body.profile_id, Boolean(body.debug));
            const queued = await c.query<{ org: number; mine: number }>(
              `select count(*)::int as org,
                    count(*) filter (where coalesce(token_id, requested_by) = coalesce($2, $3))::int as mine
               from automation_jobs where org_id = $1 and state = 'QUEUED'`,
              [access.orgId, access.token?.id ?? null, access.userId],
            );
            const q = queued.rows[0];
            if ((q?.org ?? 0) >= QUEUE_LIMITS.perOrg || (q?.mine ?? 0) >= QUEUE_LIMITS.perRequester) {
              throw new ApiError('QUEUE_FULL', 'Too many queued jobs; retry after some have started', {
                queued: q?.org ?? 0,
                queued_by_you: q?.mine ?? 0,
              });
            }
            const id = newId('job');
            const { rows } = await c.query<{ version: number }>(
              `insert into automation_jobs (id, org_id, profile_id, requested_by, token_id, requested_agent_id,
                                          idempotency_key, label, keep_open_minutes, debug_capability_sha256,
                                          queue_expires_at)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now() + make_interval(secs => $11))
             returning version`,
              [
                id,
                access.orgId,
                body.profile_id,
                access.userId,
                access.token?.id ?? null,
                body.agent_id ?? null,
                key,
                body.label?.trim() || null,
                body.keep_open_minutes ?? null,
                body.debug?.capability_sha256 ?? null,
                body.queue_timeout_seconds ?? STEP_LIMITS.queueTimeoutSeconds.default,
              ],
            );
            const steps = plannedSteps(body.steps, {
              debug: Boolean(body.debug),
              keepOpen: body.keep_open_minutes !== undefined,
            });
            for (const [seq, s] of steps.entries()) {
              await c.query(
                `insert into job_steps (org_id, job_id, sequence, action, effect, input) values ($1, $2, $3, $4, $5, $6)`,
                [access.orgId, id, seq, s.action, effectOf(s.action), JSON.stringify(s.input)],
              );
            }
            await audit(
              c,
              changeEntry(access, 'automation.job_created', 'job', id, {
                profile_id: body.profile_id,
                steps: body.steps.length,
                debug: Boolean(body.debug),
                keep_open_minutes: body.keep_open_minutes ?? null,
                token_id: access.token?.id ?? null,
              }),
            );
            await jobEvent(c, access.userId, {
              id,
              org_id: access.orgId,
              profile_id: body.profile_id,
              state: 'QUEUED',
              agent_id: null,
              error_code: null,
              reconciliation_required: false,
              attempt: 0,
              version: rows[0]?.version ?? 1,
            });
            return { status: 201, body: await jobDetail(c, access, id) };
          },
        );
      });
      return reply
        .status(result.replayed ? 200 : result.status)
        .header('idempotent-replayed', String(result.replayed))
        .send(result.body);
    },
  );

  app.get(
    '/orgs/:orgId/automation/jobs',
    {
      config: { tokens: true },
      schema: {
        tags: ['automation'],
        description:
          'Scope: automation:read. Jobs on profiles you can see, newest first. state: a state, ' +
          '`active` (queued, claimed, running) or `finished`.',
        params: OrgParams,
        querystring: JobQuery,
        response: { 200: Page(Job), ...errors },
      },
    },
    async (req) => {
      const access = await resolveTenant(deps.pool, req, req.params.orgId);
      requirePermission(access, 'automation.read');
      const q = req.query;
      const window = pageWindow(q);
      const states: string[] | null =
        q.state === 'active'
          ? ['QUEUED', 'CLAIMED', 'RUNNING']
          : q.state === 'finished'
            ? [...FINISHED_JOB_STATES]
            : q.state
              ? [q.state]
              : null;
      const rows = await withTx(deps.pool, access, async (c) => {
        const { rows } = await c.query<JobView>(
          `select ${JOB_COLUMNS}, j.requested_by = $5 as mine from ${JOB_FROM}
            where j.org_id = $1 and ${profileVisible(access, 'p', '$5')}
              and ($6::text[] is null or j.state = any($6))
              and ($7::text is null or j.profile_id = $7)
              and ($8::text is null or j.agent_id = $8)
              and (not $9::boolean or j.requested_by = $5)
              and ($2::timestamptz is null or (j.created_at, j.id) < ($2::timestamptz, $3::text))
            order by j.created_at desc, j.id desc limit $4`,
          [
            access.orgId,
            window.after?.k ?? null,
            window.after?.id ?? '',
            window.limit + 1,
            access.userId,
            states,
            q.profile_id ?? null,
            q.agent_id ?? null,
            q.mine ?? false,
          ],
        );
        return rows;
      });
      return pageOf(rows, window, (r) => ({ k: r.created_at, id: r.id }));
    },
  );

  app.get(
    '/orgs/:orgId/automation/jobs/:jobId',
    {
      config: { tokens: true },
      schema: {
        tags: ['automation'],
        description: 'Scope: automation:read. The job, its steps (with typed outputs) and its screenshots.',
        params: JobParams,
        response: { 200: JobDetail, ...errors },
      },
    },
    async (req, reply) => {
      const access = await resolveTenant(deps.pool, req, req.params.orgId);
      requirePermission(access, 'automation.read');
      const detail = await withTx(deps.pool, access, async (c) => {
        await visibleJob(c, access, req.params.jobId);
        return jobDetail(c, access, req.params.jobId);
      });
      return reply.header('etag', `"${detail.job.version}"`).send(detail);
    },
  );

  app.post(
    '/orgs/:orgId/automation/jobs/:jobId/cancel',
    {
      config: { tokens: true },
      schema: {
        tags: ['automation'],
        description:
          'Scope: automation:run. A queued job ends at once. A running job is asked to stop: its computer ' +
          'closes the profile safely (the closing backup still uploads) and reports CANCELED; a profile kept open ' +
          'after its steps closes and the job SUCCEEDED (a stop request). Your own jobs, or any with ' +
          'automation.manage. Canceling twice is a no-op; a finished job answers JOB_FINISHED.',
        params: JobParams,
        body: JobCancel,
        response: { 200: Job, ...errors },
      },
    },
    async (req) => {
      const access = await resolveTenant(deps.pool, req, req.params.orgId);
      requirePermission(access, 'automation.run');
      return withTx(deps.pool, access, async (c) => {
        const job = await visibleJob(c, access, req.params.jobId, true);
        if (job.requested_by !== access.userId) {
          try {
            requirePermission(access, 'automation.manage');
          } catch {
            throw new ApiError(
              'FORBIDDEN',
              'Only the person who asked for this job, or an admin, can cancel it',
              {
                permission: 'automation.manage',
              },
            );
          }
        }
        if ((FINISHED_JOB_STATES as readonly string[]).includes(job.state)) {
          throw new ApiError('JOB_FINISHED', 'This job already finished', { state: job.state });
        }
        const reason = req.body.reason?.trim() || null;
        // Nothing has run yet (queued, or claimed by a computer that has not started it): it ends now. A computer
        // that already took the lease learns at its next report (JOB_FINISHED) and gives the profile back.
        if (job.state === 'QUEUED' || job.state === 'CLAIMED') {
          await endJob(c, actorOf(access), job.id, 'CANCELED', 'CANCELED', { reason });
        } else {
          const { rowCount } = await c.query(
            `update automation_jobs set cancel_requested_at = now(), cancel_requested_by = $2, cancel_reason = $3,
                    version = version + 1
              where id = $1 and cancel_requested_at is null`,
            [job.id, access.userId, reason],
          );
          if (rowCount) {
            await audit(c, changeEntry(access, 'automation.job_cancel_requested', 'job', job.id, { reason }));
          }
        }
        const view = await jobById(c, access.orgId, job.id, access.userId);
        if (!view) throw new ApiError('NOT_FOUND', 'Job not found');
        return view;
      });
    },
  );

  app.get(
    '/orgs/:orgId/automation/jobs/:jobId/artifacts/:artifactId',
    {
      config: { tokens: true },
      schema: {
        tags: ['automation'],
        description:
          'Scope: automation:read. A diagnostic screenshot (image/jpeg or image/png). Kept 7 days. ' +
          'Screenshots can show whatever the page showed: treat them as confidential.',
        params: ArtifactParams,
      },
    },
    async (req, reply) => {
      const access = await resolveTenant(deps.pool, req, req.params.orgId);
      requirePermission(access, 'automation.read');
      const art = await withTx(deps.pool, access, async (c) => {
        await visibleJob(c, access, req.params.jobId);
        const { rows } = await c.query<{ content_type: string; bytes: Buffer; sha256: string }>(
          `select content_type, bytes, sha256 from job_artifacts
            where org_id = $1 and job_id = $2 and id = $3 and expires_at > now()`,
          [access.orgId, req.params.jobId, req.params.artifactId],
        );
        return rows[0];
      });
      if (!art) throw new ApiError('NOT_FOUND', 'Screenshot not found');
      return reply
        .header('content-type', art.content_type)
        .header(
          'content-disposition',
          `attachment; filename="${req.params.artifactId}.${art.content_type === 'image/png' ? 'png' : 'jpg'}"`,
        )
        .header('x-content-sha256', art.sha256)
        .send(art.bytes);
    },
  );

  // ---------------------------------------------------------------- agents (enrolled computers)
  app.post(
    '/orgs/:orgId/automation/agents',
    {
      schema: {
        tags: ['automation'],
        description:
          'Lets this computer run jobs (automation.agent), as you: only profiles you may open. accepts: `mine` ' +
          '(only jobs you or your tokens asked for, the default) or `org` (any member’s jobs you may run). Enrolling ' +
          'again updates the name and settings. Debugging sessions are allowed only from the computer itself.',
        params: OrgParams,
        body: AgentEnroll,
        response: { 201: Agent, 200: Agent, ...errors },
      },
    },
    async (req, reply) => {
      requireInteractive(req.principal);
      const access = await resolveTenant(deps.pool, req, req.params.orgId);
      const principal = principalOf(req);
      requirePermission(access, 'automation.agent');
      const body = req.body;
      if (principal.deviceId && principal.deviceId !== body.device_id) {
        throw new ApiError('FORBIDDEN', 'device_id must be the device making the request');
      }
      const out = await withTx(deps.pool, access, async (c) => {
        await requireEntitlement(c, access.orgId, 'automation');
        const device = await c.query<{ name: string; platform: string }>(
          'select name, platform from devices where id = $1 and user_id = $2 and revoked_at is null',
          [body.device_id, access.userId],
        );
        const d = device.rows[0];
        if (!d) throw new ApiError('FORBIDDEN', 'device_id is not an active device of the caller');
        const existing = await c.query<{ id: string }>(
          'select id from automation_agents where org_id = $1 and device_id = $2 for update',
          [access.orgId, body.device_id],
        );
        let id = existing.rows[0]?.id;
        let status = 200;
        if (!id) {
          id = newId('agent');
          status = 201;
          await c.query(
            `insert into automation_agents (id, org_id, device_id, user_id, name, platform, accepts, max_jobs)
             values ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [
              id,
              access.orgId,
              body.device_id,
              access.userId,
              (body.name ?? d.name).trim().slice(0, 80) || 'Computer',
              d.platform,
              body.accepts ?? 'mine',
              body.max_jobs ?? 1,
            ],
          );
          await audit(
            c,
            changeEntry(access, 'automation.agent_enrolled', 'agent', id, { device_id: body.device_id }),
          );
        } else {
          await c.query(
            `update automation_agents set name = coalesce($2, name), accepts = coalesce($3, accepts),
                    max_jobs = coalesce($4, max_jobs), version = version + 1, updated_at = now()
              where id = $1`,
            [id, body.name?.trim() || null, body.accepts ?? null, body.max_jobs ?? null],
          );
        }
        return { status, agent: await agentView(c, access, id) };
      });
      return reply.status(out.status).send(out.agent);
    },
  );

  app.get(
    '/orgs/:orgId/automation/agents',
    {
      config: { tokens: true },
      schema: {
        tags: ['automation'],
        description:
          'Scope: automation:read. Computers that run jobs: online state, owner, what they accept.',
        params: OrgParams,
        response: { 200: Type.Object({ items: Type.Array(Agent) }), ...errors },
      },
    },
    async (req) => {
      const access = await resolveTenant(deps.pool, req, req.params.orgId);
      requirePermission(access, 'automation.read');
      return withTx(deps.pool, access, async (c) => {
        const { rows } = await c.query<AgentView>(
          `select ${AGENT_COLUMNS}, a.user_id = $2 as mine from ${AGENT_FROM}
            where a.org_id = $1 order by a.created_at limit 200`,
          [access.orgId, access.userId],
        );
        return { items: rows };
      });
    },
  );

  app.patch(
    '/orgs/:orgId/automation/agents/:agentId',
    {
      schema: {
        tags: ['automation'],
        description:
          'Rename, turn off/on, change what it accepts or how many jobs at once. Your own computers, or any with ' +
          'automation.manage. A computer turned off takes no new jobs; running ones finish. Requires If-Match or ' +
          'expected_version.',
        params: AgentParams,
        body: AgentUpdate,
        response: { 200: Agent, ...errors },
      },
    },
    async (req) => {
      requireInteractive(req.principal);
      const access = await resolveTenant(deps.pool, req, req.params.orgId);
      const expected = expectedVersion(req.headers['if-match'], req.body.expected_version);
      return withTx(deps.pool, access, async (c) => {
        const { rows } = await c.query<{ user_id: string; version: number }>(
          'select user_id, version from automation_agents where org_id = $1 and id = $2 for update',
          [access.orgId, req.params.agentId],
        );
        const a = rows[0];
        if (!a) throw new ApiError('NOT_FOUND', 'Computer not found');
        requirePermission(access, a.user_id === access.userId ? 'automation.agent' : 'automation.manage');
        if (a.version !== expected) throw versionConflict(a.version);
        const b = req.body;
        await c.query(
          `update automation_agents set name = coalesce($2, name), enabled = coalesce($3, enabled),
                  accepts = coalesce($4, accepts), max_jobs = coalesce($5, max_jobs), version = version + 1,
                  updated_at = now()
            where id = $1`,
          [
            req.params.agentId,
            b.name?.trim() || null,
            b.enabled ?? null,
            b.accepts ?? null,
            b.max_jobs ?? null,
          ],
        );
        await audit(
          c,
          changeEntry(access, 'automation.agent_updated', 'agent', req.params.agentId, {
            changed_fields: Object.keys(b)
              .filter((k) => k !== 'expected_version')
              .sort(),
            enabled: b.enabled ?? null,
          }),
        );
        return agentView(c, access, req.params.agentId);
      });
    },
  );

  app.delete(
    '/orgs/:orgId/automation/agents/:agentId',
    {
      schema: {
        tags: ['automation'],
        description:
          'Removes a computer (yours, or any with automation.manage). Jobs it claimed return to the queue; jobs ' +
          'running there end (ACCESS_REMOVED) and that computer closes their profiles safely.',
        params: AgentParams,
        response: { 204: Type.Null(), ...errors },
      },
    },
    async (req, reply) => {
      requireInteractive(req.principal);
      const access = await resolveTenant(deps.pool, req, req.params.orgId);
      await withTx(deps.pool, access, async (c) => {
        const { rows } = await c.query<{ user_id: string }>(
          'select user_id from automation_agents where org_id = $1 and id = $2 for update',
          [access.orgId, req.params.agentId],
        );
        const a = rows[0];
        if (!a) throw new ApiError('NOT_FOUND', 'Computer not found');
        requirePermission(access, a.user_id === access.userId ? 'automation.agent' : 'automation.manage');
        await removeAgentJobs(c, actorOf(access), req.params.agentId);
        await c.query('delete from automation_agents where id = $1', [req.params.agentId]);
        await audit(
          c,
          changeEntry(access, 'automation.agent_removed', 'agent', req.params.agentId, { owner: a.user_id }),
        );
      });
      return reply.status(204).send(null);
    },
  );

  app.post(
    '/orgs/:orgId/automation/agents/:agentId/poll',
    {
      schema: {
        tags: ['automation'],
        description:
          `The computer itself, every ${AGENT_TIMING.pollSeconds} s (outbound; nothing listens on it). Heartbeat ` +
          'for its running jobs, new jobs up to its capacity (fair across requesters; never a profile that is open ' +
          'anywhere or already has a running job), cancellations, and jobs it should drop. A claim not started ' +
          `within ${AGENT_TIMING.claimSeconds} s returns to the queue.`,
        params: AgentParams,
        body: AgentPoll,
        response: { 200: AgentPollResult, ...errors },
      },
    },
    async (req) => {
      requireInteractive(req.principal);
      const access = await resolveTenant(deps.pool, req, req.params.orgId);
      requirePermission(access, 'automation.agent');
      const body = req.body;
      return withTx(deps.pool, access, async (c) => {
        const agent = await ownAgent(c, access, req.params.agentId, true);
        await c.query(
          `update automation_agents set last_seen_at = now(), debug_allowed = $2,
                  browser_version = coalesce($3, browser_version), platform = coalesce($4, platform)
            where id = $1`,
          [agent.id, body.debug_allowed, body.browser_version ?? null, body.platform ?? null],
        );
        agent.debug_allowed = body.debug_allowed;
        // Heartbeat for what it is running; tell it what to stop or drop.
        const held = await c.query<{ id: string; state: JobState; attempt: number; cancel: boolean }>(
          `select id, state, attempt, cancel_requested_at is not null as cancel from automation_jobs
            where org_id = $1 and agent_id = $2 and state in ('CLAIMED', 'RUNNING') for update`,
          [access.orgId, agent.id],
        );
        const heldById = new Map(held.rows.map((j) => [j.id, j]));
        const cancel: string[] = [];
        const abandon: string[] = [];
        const reported = new Set<string>();
        for (const r of body.running) {
          reported.add(r.job_id);
          const j = heldById.get(r.job_id);
          if (!j || j.attempt !== r.attempt) {
            abandon.push(r.job_id);
            continue;
          }
          await c.query(
            `update automation_jobs set heartbeat_at = now(), lost_at = null,
                    claim_expires_at = case when state = 'CLAIMED' then now() + make_interval(secs => $2)
                                            else claim_expires_at end
              where id = $1`,
            [j.id, AGENT_TIMING.claimSeconds],
          );
          if (j.cancel) cancel.push(j.id);
        }
        const settings = await settingsOf(c, access.orgId);
        const assigned: ClaimedJob[] = [];
        // Jobs it holds but did not report (an app that restarted without its notes): sent again to continue.
        for (const j of held.rows) {
          if (reported.has(j.id)) continue;
          const cj = await claimedJob(c, access.orgId, j.id, agent, settings.allowed_origins);
          if (cj) assigned.push(cj);
          if (j.cancel) cancel.push(j.id);
        }
        const slots = Math.min(body.capacity, agent.max_jobs - held.rows.length);
        if (agent.enabled && slots > 0) {
          const ids = await claimJobs(
            c,
            actorOf(access),
            agent,
            slots,
            settings.allowed_origins,
            settings.max_running_jobs,
          );
          for (const id of ids) {
            const cj = await claimedJob(c, access.orgId, id, agent, settings.allowed_origins);
            if (cj) assigned.push(cj);
          }
        }
        return {
          agent: await agentView(c, access, agent.id),
          assigned,
          cancel,
          abandon,
          poll_after_seconds: AGENT_TIMING.pollSeconds,
          server_time: new Date().toISOString(),
        };
      });
    },
  );

  // ---------------------------------------------------------------- reports from the computer running a job
  app.post(
    '/orgs/:orgId/automation/jobs/:jobId/report',
    {
      schema: {
        tags: ['automation'],
        description:
          'The computer holding the job reports, in order: `started` (its session lease: id and fencing token; the ' +
          'job becomes RUNNING), `step_started` before each step (refused unless the lease is still current and the ' +
          'steps before it finished), `step_finished` with typed outputs only, and `finished`. `released` gives a ' +
          'claim back before anything ran (it returns to the queue). Reports from another computer or an older ' +
          'claim answer JOB_CLAIM_STALE. The answer says whether a cancel was requested.',
        params: JobParams,
        body: JobReport,
        response: { 200: JobReportResult, ...errors },
      },
    },
    async (req) => {
      requireInteractive(req.principal);
      const access = await resolveTenant(deps.pool, req, req.params.orgId);
      requirePermission(access, 'automation.agent');
      const r = req.body;
      return withTx(deps.pool, access, async (c) => {
        const { rows } = await c.query<{
          id: string;
          state: JobState;
          agent_id: string | null;
          attempt: number;
          profile_id: string;
          lease_id: string | null;
          lease_token: string | null;
          cancel: boolean;
        }>(
          `select id, state, agent_id, attempt, profile_id, lease_id, lease_token::text as lease_token,
                  cancel_requested_at is not null as cancel
             from automation_jobs where org_id = $1 and id = $2 for update`,
          [access.orgId, req.params.jobId],
        );
        const job = rows[0];
        if (!job?.agent_id) throw new ApiError('NOT_FOUND', 'Job not found');
        const agent = await ownAgent(c, access, job.agent_id).catch(() => {
          throw new ApiError('JOB_CLAIM_STALE', 'This computer does not hold this job');
        });
        if ((FINISHED_JOB_STATES as readonly string[]).includes(job.state)) {
          throw new ApiError('JOB_FINISHED', 'This job already finished', { state: job.state });
        }
        if (job.attempt !== r.attempt) throw new ApiError('JOB_CLAIM_STALE', 'This claim was replaced');
        const actor = actorOf(access);
        await c.query('update automation_jobs set heartbeat_at = now(), lost_at = null where id = $1', [
          job.id,
        ]);

        switch (r.type) {
          case 'started': {
            await requireLease(c, access.orgId, job.profile_id, agent, r.lease_id, r.fencing_token);
            if (job.state === 'RUNNING') {
              if (job.lease_id !== r.lease_id) {
                // A new lease for the same job (the computer reopened after losing the old one).
                await c.query(
                  'update automation_jobs set lease_id = $2, lease_token = $3::bigint, version = version + 1 where id = $1',
                  [job.id, r.lease_id, r.fencing_token],
                );
              }
              break;
            }
            if (job.cancel) throw new ApiError('JOB_CLAIM_STALE', 'This job was canceled before it started');
            const { rows: up } = await c.query<{
              id: string;
              org_id: string;
              profile_id: string;
              state: JobState;
              agent_id: string | null;
              error_code: string | null;
              reconciliation_required: boolean;
              attempt: number;
              version: number;
            }>(
              `update automation_jobs set state = 'RUNNING', started_at = coalesce(started_at, now()), lease_id = $2,
                      lease_token = $3::bigint, claim_expires_at = null, version = version + 1
                where id = $1
                returning id, org_id, profile_id, state, agent_id, error_code, reconciliation_required, attempt, version`,
              [job.id, r.lease_id, r.fencing_token],
            );
            const row = up[0];
            if (row) {
              await audit(
                c,
                changeEntry(access, 'automation.job_started', 'job', job.id, {
                  lease_id: r.lease_id,
                  agent_id: agent.id,
                }),
              );
              await jobEvent(c, access.userId, row);
            }
            break;
          }
          case 'step_started': {
            if (job.state !== 'RUNNING' || !job.lease_id || !job.lease_token) {
              throw new ApiError('JOB_CLAIM_STALE', 'Report `started` (with the lease) first');
            }
            await requireLease(c, access.orgId, job.profile_id, agent, job.lease_id, job.lease_token);
            const steps = await stepsOf(c, job.id);
            const step = steps.find((s) => s.seq === r.seq);
            if (!step) throw new ApiError('NOT_FOUND', 'Step not found');
            const earlier = steps.filter((s) => s.seq < r.seq);
            if (step.action === 'close_profile') {
              // Closing always runs once nothing else is running (after a failure or a cancel too); what never ran
              // is skipped.
              if (earlier.some((s) => s.state === 'running')) {
                throw new ApiError('VALIDATION_FAILED', 'Finish the running step first', { seq: r.seq });
              }
              await c.query(
                `update job_steps set state = 'skipped' where job_id = $1 and sequence < $2 and state = 'pending'`,
                [job.id, r.seq],
              );
            } else if (earlier.some((s) => s.state !== 'succeeded' && s.state !== 'skipped')) {
              throw new ApiError('VALIDATION_FAILED', 'Earlier steps have not finished', { seq: r.seq });
            }
            if (step.state === 'running') {
              // Started before without a result (a lost connection or a restart): repeat only what is safe.
              if (step.effect === 'external_mutation') {
                throw new ApiError(
                  'VALIDATION_FAILED',
                  'This step’s outcome is unknown; it is never repeated',
                  {
                    seq: r.seq,
                    reason: 'outcome_unknown',
                  },
                );
              }
            } else if (step.state !== 'pending') {
              throw new ApiError('VALIDATION_FAILED', 'This step already finished', {
                seq: r.seq,
                state: step.state,
              });
            }
            // A cancel stops before the next step (the computer closes the profile instead); the close step and
            // the end of holding still run.
            if (job.cancel && step.action !== 'close_profile' && step.action !== 'hold_open') break;
            await c.query(
              `update job_steps set state = 'running', attempt = attempt + 1, started_at = now(), finished_at = null,
                      error_code = null, safe_output = null
                where job_id = $1 and sequence = $2`,
              [job.id, r.seq],
            );
            if (step.action === 'hold_open') {
              await c.query(
                `update automation_jobs set holding = true, holding_since = coalesce(holding_since, now()),
                        version = version + 1 where id = $1`,
                [job.id],
              );
            }
            break;
          }
          case 'step_finished': {
            const steps = await stepsOf(c, job.id);
            const step = steps.find((s) => s.seq === r.seq);
            if (!step) throw new ApiError('NOT_FOUND', 'Step not found');
            if (step.state !== 'running') {
              throw new ApiError('VALIDATION_FAILED', 'This step is not running', {
                seq: r.seq,
                state: step.state,
              });
            }
            const output = r.output ?? null;
            if (output) {
              const allowed = OUTPUT_FIELDS[step.action];
              const extra = Object.keys(output).filter((k) => !allowed.includes(k));
              if (extra.length) {
                throw new ApiError('VALIDATION_FAILED', 'Output fields not allowed for this step', {
                  fields: extra,
                });
              }
              if (output.artifact_id) {
                const a = await c.query(
                  'select 1 from job_artifacts where job_id = $1 and id = $2 and sequence = $3',
                  [job.id, output.artifact_id, r.seq],
                );
                if (!a.rowCount)
                  throw new ApiError('VALIDATION_FAILED', 'Unknown screenshot', { field: 'artifact_id' });
              }
            }
            if (r.state === 'succeeded' && r.error_code) {
              throw new ApiError('VALIDATION_FAILED', 'A step that succeeded has no error code');
            }
            await c.query(
              `update job_steps set state = $3, finished_at = now(), error_code = $4, safe_output = $5
                where job_id = $1 and sequence = $2`,
              [
                job.id,
                r.seq,
                r.state,
                r.state === 'succeeded'
                  ? null
                  : (r.error_code ?? (r.state === 'outcome_unknown' ? 'OUTCOME_UNKNOWN' : 'INTERNAL')),
                output ? JSON.stringify(output) : null,
              ],
            );
            if (r.state === 'outcome_unknown') {
              await c.query('update automation_jobs set reconciliation_required = true where id = $1', [
                job.id,
              ]);
            }
            if (output?.artifact_id) {
              await c.query('update automation_jobs set result_ref = $2 where id = $1', [
                job.id,
                output.artifact_id,
              ]);
            }
            if (step.action === 'hold_open') {
              await c.query(
                'update automation_jobs set holding = false, version = version + 1 where id = $1',
                [job.id],
              );
            }
            break;
          }
          case 'released': {
            if (job.state !== 'CLAIMED') {
              throw new ApiError('JOB_CLAIM_STALE', 'Only a claim that has not started can be given back');
            }
            const { rows: lim } = await c.query<{ n: number }>(
              'select attempt as n from automation_jobs where id = $1',
              [job.id],
            );
            if ((lim[0]?.n ?? 0) >= AGENT_TIMING.maxAttempts) {
              await endJob(c, actor, job.id, 'FAILED', r.error_code, { reason: 'released_too_often' });
            } else {
              await c.query(
                `update automation_jobs set state = 'QUEUED', agent_id = null, claimed_at = null,
                        claim_expires_at = null, version = version + 1
                  where id = $1`,
                [job.id],
              );
              await audit(
                c,
                changeEntry(access, 'automation.job_requeued', 'job', job.id, { reason: r.error_code }),
              );
            }
            break;
          }
          case 'finished': {
            const steps = await stepsOf(c, job.id);
            if (r.state === 'SUCCEEDED') {
              // Every step succeeded; closing succeeded, or was not needed (skipped).
              const bad = steps.filter((s) =>
                s.action === 'close_profile'
                  ? s.state !== 'succeeded' && s.state !== 'skipped'
                  : s.state !== 'succeeded',
              );
              if (bad.length || job.state !== 'RUNNING') {
                throw new ApiError('VALIDATION_FAILED', 'A job succeeds only when all its steps did', {
                  steps: bad.map((s) => s.seq),
                });
              }
            }
            const code: JobErrorCode | null =
              r.state === 'SUCCEEDED'
                ? null
                : (r.error_code ?? (r.state === 'CANCELED' ? 'CANCELED' : 'INTERNAL'));
            await endJob(c, actor, job.id, r.state, code, { agent_id: agent.id });
            break;
          }
        }
        const view = await jobById(c, access.orgId, job.id, access.userId);
        if (!view) throw new ApiError('NOT_FOUND', 'Job not found');
        const cancel = await c.query<{ cancel: boolean }>(
          'select cancel_requested_at is not null as cancel from automation_jobs where id = $1',
          [job.id],
        );
        return { job: view, cancel_requested: cancel.rows[0]?.cancel ?? false };
      });
    },
  );

  app.put(
    '/orgs/:orgId/automation/jobs/:jobId/steps/:seq/artifact',
    {
      bodyLimit: STEP_LIMITS.maxArtifactBytes + 1024,
      schema: {
        tags: ['automation'],
        description:
          'The computer running a screenshot step uploads the image (image/jpeg or image/png, at most 1.5 MiB) ' +
          'before reporting the step finished with the returned artifact_id. A repeated upload for the same step ' +
          'replaces the previous one.',
        params: StepParams,
        querystring: ArtifactQuery,
        response: {
          200: Type.Object({ artifact_id: Type.String({ pattern: ID_PATTERN('art') }) }),
          ...errors,
        },
      },
    },
    async (req) => {
      requireInteractive(req.principal);
      const access = await resolveTenant(deps.pool, req, req.params.orgId);
      requirePermission(access, 'automation.agent');
      const bytes = req.body as unknown;
      if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
        throw new ApiError('VALIDATION_FAILED', 'Send the image as image/jpeg or image/png');
      }
      const type = String(req.headers['content-type'] ?? '')
        .split(';')[0]
        ?.trim();
      const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
      const png = bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
      if (!((type === 'image/jpeg' && jpeg) || (type === 'image/png' && png))) {
        throw new ApiError('VALIDATION_FAILED', 'The image does not match its content type');
      }
      if (bytes.length > STEP_LIMITS.maxArtifactBytes) {
        throw new ApiError('VALIDATION_FAILED', 'The screenshot is too large', {
          max_bytes: STEP_LIMITS.maxArtifactBytes,
        });
      }
      return withTx(deps.pool, access, async (c) => {
        const { rows } = await c.query<{ agent_id: string | null; attempt: number; state: JobState }>(
          'select agent_id, attempt, state from automation_jobs where org_id = $1 and id = $2 for update',
          [access.orgId, req.params.jobId],
        );
        const job = rows[0];
        if (!job?.agent_id) throw new ApiError('NOT_FOUND', 'Job not found');
        await ownAgent(c, access, job.agent_id).catch(() => {
          throw new ApiError('JOB_CLAIM_STALE', 'This computer does not hold this job');
        });
        if (job.state !== 'RUNNING' || job.attempt !== req.query.attempt) {
          throw new ApiError('JOB_CLAIM_STALE', 'This claim was replaced or the job is not running');
        }
        const step = await c.query<{ action: string; state: string; input: { label?: string } }>(
          'select action, state, input from job_steps where job_id = $1 and sequence = $2',
          [req.params.jobId, req.params.seq],
        );
        const s = step.rows[0];
        if (s?.action !== 'screenshot' || s.state !== 'running') {
          throw new ApiError('VALIDATION_FAILED', 'Not a running screenshot step');
        }
        const sha = createHash('sha256').update(bytes).digest('hex');
        const id = newId('artifact');
        const { rows: saved } = await c.query<{ id: string }>(
          `insert into job_artifacts (id, org_id, job_id, sequence, content_type, bytes, sha256, width, height, label,
                                      expires_at)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now() + make_interval(days => $11))
           on conflict (job_id, sequence) do update set
             id = excluded.id, content_type = excluded.content_type, bytes = excluded.bytes, sha256 = excluded.sha256,
             width = excluded.width, height = excluded.height, created_at = now(), expires_at = excluded.expires_at
           returning id`,
          [
            id,
            access.orgId,
            req.params.jobId,
            req.params.seq,
            type,
            bytes,
            sha,
            req.query.width,
            req.query.height,
            s.input.label ?? null,
            STEP_LIMITS.artifactRetentionDays,
          ],
        );
        return { artifact_id: saved[0]?.id ?? id };
      });
    },
  );
}

/** The job's session lease must be current: held by that computer and person, with that token. */
async function requireLease(
  c: pg.PoolClient,
  orgId: string,
  profileId: string,
  agent: AgentRow,
  leaseId: string,
  token: string,
): Promise<void> {
  const { rows } = await c.query<{
    id: string;
    state: string;
    holder_device_id: string;
    holder_user_id: string;
    fencing_token: string;
    purpose: string;
  }>(
    `select id, state, holder_device_id, holder_user_id, fencing_token::text as fencing_token, purpose
       from profile_leases where org_id = $1 and profile_id = $2`,
    [orgId, profileId],
  );
  const l = rows[0];
  if (!l || l.id !== leaseId || l.state !== 'active' || l.purpose !== 'session') {
    throw new ApiError('FENCING_TOKEN_STALE', 'The job’s session lease has ended', {
      state: l?.id === leaseId ? l.state : 'superseded',
    });
  }
  if (l.holder_device_id !== agent.device_id || l.holder_user_id !== agent.user_id) {
    throw new ApiError('LEASE_NOT_HELD', 'This lease belongs to another device');
  }
  if (l.fencing_token !== token) {
    throw new ApiError('FENCING_TOKEN_STALE', 'A newer lease exists for this profile; stop', {
      state: 'superseded',
    });
  }
}

/** A computer chosen for a job must be able to run it now (on, allowed to run this person's jobs, with access). */
async function checkChosenAgent(
  c: pg.PoolClient,
  access: TenantAccess,
  agentId: string,
  profileId: string,
  debug: boolean,
): Promise<void> {
  const { rows } = await c.query<AgentRow>(
    `select id, org_id, device_id, user_id, enabled, accepts, debug_allowed, max_jobs, version
       from automation_agents where org_id = $1 and id = $2`,
    [access.orgId, agentId],
  );
  const a = rows[0];
  if (!a) throw new ApiError('NOT_FOUND', 'Computer not found');
  const refuse = (reason: string) =>
    new ApiError('AGENT_UNAVAILABLE', 'That computer cannot run this job', { reason });
  if (!a.enabled) throw refuse('turned_off');
  if (a.accepts === 'mine' && a.user_id !== access.userId) throw refuse('accepts_own_jobs_only');
  if (debug && !a.debug_allowed) throw refuse('debugging_not_allowed_on_that_computer');
  if (!(await userMayLaunch(c, access.orgId, a.user_id, profileId))) throw refuse('no_access_to_profile');
}
