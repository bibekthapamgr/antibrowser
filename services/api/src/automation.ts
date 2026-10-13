/**
 * Automation jobs (milestone 10, ADR-0017): shared helpers for the job, agent and report routes.
 *
 *   QUEUED ──claim──▶ CLAIMED ──lease taken──▶ RUNNING ──▶ SUCCEEDED | FAILED | CANCELED
 *      │                 │ given back / claim expired (nothing ran) ▲
 *      └─────────────────┘◀────────────────────────────────────────┘ (CLAIMED → QUEUED only)
 *
 * - A job runs as the person whose computer runs it: the session lease is taken by that person and device through the
 *   same rules as an interactive open (grant capability `launch`, plan, browser). Every step start checks that this
 *   lease is still current; a job whose lease was taken over, revoked or replaced stops (LEASE_LOST).
 * - Who asked must still be allowed when a computer claims the job (role, grants, token not revoked or narrowed).
 * - Two jobs never run on one profile at once: a partial unique index, and claims skip profiles that are open anywhere.
 * - Finished steps are checkpoints; a step that started without a reported result is repeated only when its effect
 *   is safe to repeat (planResume), otherwise its outcome is unknown and the job needs reconciliation.
 */
import {
  AGENT_TIMING,
  ApiError,
  type ClaimedJob,
  type Job,
  type JobErrorCode,
  type JobEventData,
  type JobState,
  type JobStep,
  planResume,
  STEP_REGISTRY,
  type StepAction,
  type StepInput,
  scopesAllow,
  stepsProblem,
} from '@pb/contracts';
import type pg from 'pg';
import { audit } from './audit.ts';
import { ts } from './db.ts';
import { appendEvent } from './outbox.ts';
import { userMayLaunch } from './sessions.ts';

export const JOB_COLUMNS = `j.id, j.org_id, j.profile_id, coalesce(p.name, '') as profile_name, p.client_id,
  cl.name as client_name, j.label, j.state, j.agent_id, ag.name as agent_name, j.requested_agent_id, j.requested_by,
  coalesce(ru.display_name, '') as requested_by_name, j.token_id, tk.name as token_name,
  (select count(*)::int from job_steps s where s.job_id = j.id) as steps_total,
  (select count(*)::int from job_steps s where s.job_id = j.id and s.state in ('succeeded', 'skipped')) as steps_done,
  j.keep_open_minutes, j.debug_capability_sha256 is not null as debug, j.attempt, j.lease_id, j.error_code,
  j.reconciliation_required, j.holding, ${ts('j.created_at')} as created_at,
  ${ts('j.queue_expires_at')} as queue_expires_at, ${ts('j.claimed_at')} as claimed_at,
  ${ts('j.started_at')} as started_at, ${ts('j.finished_at')} as finished_at,
  ${ts('j.cancel_requested_at')} as cancel_requested_at, j.version`;

export const JOB_FROM = `automation_jobs j
  join profiles p on p.org_id = j.org_id and p.id = j.profile_id
  left join clients cl on cl.org_id = p.org_id and cl.id = p.client_id
  left join automation_agents ag on ag.id = j.agent_id
  left join users ru on ru.id = j.requested_by
  left join api_tokens tk on tk.id = j.token_id`;

export const STEP_COLUMNS = `s.sequence as seq, s.action, s.effect, s.input, s.state, s.attempt,
  ${ts('s.started_at')} as started_at, ${ts('s.finished_at')} as finished_at, s.error_code, s.safe_output as output`;

export const ARTIFACT_COLUMNS = `a.id, a.sequence as seq, a.content_type, octet_length(a.bytes) as size_bytes, a.width,
  a.height, a.label, ${ts('a.created_at')} as created_at, ${ts('a.expires_at')} as expires_at`;

export interface Actor {
  orgId: string;
  userId: string;
  deviceId: string | null;
  requestId: string;
}

export async function jobById(
  c: pg.PoolClient,
  orgId: string,
  jobId: string,
  me: string,
): Promise<Job | null> {
  const { rows } = await c.query<Job>(
    `select ${JOB_COLUMNS}, j.requested_by = $3 as mine from ${JOB_FROM} where j.org_id = $1 and j.id = $2`,
    [orgId, jobId, me],
  );
  return rows[0] ?? null;
}

export async function stepsOf(c: pg.PoolClient, jobId: string): Promise<JobStep[]> {
  const { rows } = await c.query<JobStep>(
    `select ${STEP_COLUMNS} from job_steps s where s.job_id = $1 order by s.sequence`,
    [jobId],
  );
  return rows;
}

/** The steps a job is made of: open the profile, the requested steps, optional debugging and holding, close. */
export function plannedSteps(
  steps: readonly StepInput[],
  opts: { debug: boolean; keepOpen: boolean },
): { action: StepAction; input: Record<string, unknown> }[] {
  const out: { action: StepAction; input: Record<string, unknown> }[] = [
    { action: 'open_profile', input: {} },
  ];
  for (const s of steps) out.push({ action: s.action, input: { ...s } });
  if (opts.debug) out.push({ action: 'debug_bridge', input: {} });
  if (opts.keepOpen) out.push({ action: 'hold_open', input: {} });
  out.push({ action: 'close_profile', input: {} });
  return out;
}

/** Outbox event for a job state change (delivered to webhooks): identifiers and states only. */
export async function jobEvent(
  c: pg.PoolClient,
  actorId: string,
  job: {
    id: string;
    org_id: string;
    profile_id: string;
    state: JobState;
    agent_id: string | null;
    error_code: string | null;
    reconciliation_required: boolean;
    attempt: number;
    version: number;
  },
): Promise<void> {
  const type =
    job.state === 'QUEUED'
      ? 'automation.job.queued'
      : job.state === 'RUNNING'
        ? 'automation.job.started'
        : job.state === 'SUCCEEDED'
          ? 'automation.job.succeeded'
          : job.state === 'FAILED'
            ? 'automation.job.failed'
            : job.state === 'CANCELED'
              ? 'automation.job.canceled'
              : null;
  if (!type) return;
  const data: JobEventData = {
    job_id: job.id,
    profile_id: job.profile_id,
    state: job.state,
    agent_id: job.agent_id,
    error_code: (job.error_code as JobErrorCode | null) ?? null,
    reconciliation_required: job.reconciliation_required,
    attempt: job.attempt,
  };
  await appendEvent(c, {
    orgId: job.org_id,
    actorId,
    aggregateId: job.id,
    aggregateVersion: job.version,
    eventType: type,
    payload: { ...data },
  });
}

interface JobRow {
  id: string;
  org_id: string;
  profile_id: string;
  state: JobState;
  agent_id: string | null;
  error_code: string | null;
  reconciliation_required: boolean;
  attempt: number;
  version: number;
}

/**
 * Ends a job (cancel of a queued job, a computer's final report, removal of a computer or of access). Steps that were
 * running fail (or become outcome_unknown when their effect is not safe to repeat), pending ones are skipped.
 */
export async function endJob(
  c: pg.PoolClient,
  actor: Actor,
  jobId: string,
  state: 'SUCCEEDED' | 'FAILED' | 'CANCELED',
  code: JobErrorCode | null,
  details: Record<string, unknown> = {},
): Promise<JobRow> {
  const unknown = await c.query(
    `update job_steps set state = 'outcome_unknown', finished_at = now(), error_code = 'OUTCOME_UNKNOWN'
      where job_id = $1 and state = 'running' and effect = 'external_mutation'`,
    [jobId],
  );
  await c.query(
    `update job_steps set state = case when $2 = 'CANCELED' then 'canceled' else 'failed' end, finished_at = now(),
            error_code = coalesce(error_code, $3)
      where job_id = $1 and state = 'running'`,
    [jobId, state, code ?? (state === 'CANCELED' ? 'CANCELED' : 'INTERNAL')],
  );
  await c.query(`update job_steps set state = 'skipped' where job_id = $1 and state = 'pending'`, [jobId]);
  const { rows } = await c.query<JobRow>(
    `update automation_jobs
        set state = $2, error_code = $3, finished_at = now(), holding = false,
            reconciliation_required = reconciliation_required or $4, version = version + 1
      where id = $1
      returning id, org_id, profile_id, state, agent_id, error_code, reconciliation_required, attempt, version`,
    [jobId, state, code, (unknown.rowCount ?? 0) > 0],
  );
  const row = rows[0];
  if (!row) throw new ApiError('NOT_FOUND', 'Job not found');
  await audit(c, {
    orgId: actor.orgId,
    actorUserId: actor.userId,
    actorDeviceId: actor.deviceId,
    action: `automation.job_${state.toLowerCase()}`,
    targetType: 'job',
    targetId: jobId,
    outcome: 'success',
    requestId: actor.requestId,
    details: { profile_id: row.profile_id, error_code: code, ...details },
  });
  await jobEvent(c, actor.userId, row);
  return row;
}

// ---------------------------------------------------------------- agents
export interface AgentRow {
  id: string;
  org_id: string;
  device_id: string;
  user_id: string;
  enabled: boolean;
  accepts: 'mine' | 'org';
  debug_allowed: boolean;
  max_jobs: number;
  version: number;
}

export const AGENT_COLUMNS = `a.id, a.org_id, a.device_id, a.user_id, coalesce(u.display_name, '') as user_name, a.name,
  a.platform, a.browser_version, a.enabled, a.accepts, a.debug_allowed, a.max_jobs,
  coalesce(a.last_seen_at > now() - make_interval(secs => ${AGENT_TIMING.onlineSeconds}), false) as online,
  ${ts('a.last_seen_at')} as last_seen_at,
  (select count(*)::int from automation_jobs r where r.agent_id = a.id and r.state in ('CLAIMED', 'RUNNING'))
    as running_jobs, ${ts('a.created_at')} as created_at, a.version`;
export const AGENT_FROM = 'automation_agents a left join users u on u.id = a.user_id';

/** The lease key a computer uses for a job: the same for every retry of that job on that computer. */
export function leaseKeyFor(jobId: string, agentId: string): string {
  return `${jobId}-${agentId}`;
}

/** Whether the job's requester (a person, or their token) may still have it run. */
async function requesterStillAllowed(
  c: pg.PoolClient,
  job: {
    org_id: string;
    profile_id: string;
    requested_by: string;
    token_id: string | null;
    client_id: string | null;
  },
): Promise<boolean> {
  // Membership, role and a grant with `launch` (userMayLaunch reads them as they are now).
  if (!(await userMayLaunch(c, job.org_id, job.requested_by, job.profile_id))) return false;
  if (!job.token_id) return true;
  const t = await c.query<{
    ok: boolean;
    scopes: string[];
    client_ids: string[] | null;
    profile_ids: string[] | null;
  }>(
    `select revoked_at is null and expires_at > now() as ok, scopes, client_ids, profile_ids
       from api_tokens where org_id = $1 and id = $2`,
    [job.org_id, job.token_id],
  );
  const tok = t.rows[0];
  if (!tok?.ok || !scopesAllow(tok.scopes, 'automation.run')) return false;
  if (tok.client_ids || tok.profile_ids) {
    const inProfiles = tok.profile_ids?.includes(job.profile_id) ?? false;
    const inClients = job.client_id !== null && (tok.client_ids?.includes(job.client_id) ?? false);
    if (!inProfiles && !inClients) return false;
  }
  return true;
}

interface Candidate {
  id: string;
  org_id: string;
  profile_id: string;
  requested_by: string;
  token_id: string | null;
  client_id: string | null;
  debug_capability_sha256: string | null;
}

/**
 * Claims up to `slots` queued jobs for an agent, fairly: requesters (a token, or a person without one) with fewer
 * running jobs go first, then the oldest. Skips profiles that are open anywhere or already have a running job. A
 * job whose requester lost access, or whose steps are no longer on the approved sites, fails instead.
 */
export async function claimJobs(
  c: pg.PoolClient,
  actor: Actor,
  agent: AgentRow,
  slots: number,
  allowedOrigins: readonly string[],
  maxRunning: number,
): Promise<string[]> {
  if (slots <= 0 || !agent.enabled) return [];
  const running = await c.query<{ n: number }>(
    `select count(*)::int as n from automation_jobs where org_id = $1 and state in ('CLAIMED', 'RUNNING')`,
    [agent.org_id],
  );
  let free = Math.min(slots, maxRunning - (running.rows[0]?.n ?? 0));
  if (free <= 0) return [];
  const { rows } = await c.query<Candidate>(
    `select j.id, j.org_id, j.profile_id, j.requested_by, j.token_id, p.client_id, j.debug_capability_sha256
       from automation_jobs j join profiles p on p.org_id = j.org_id and p.id = j.profile_id
      where j.org_id = $1 and j.state = 'QUEUED' and j.queue_expires_at > now() and p.deleted_at is null
        and (j.requested_agent_id is null or j.requested_agent_id = $2)
        and ($3 = 'org' or j.requested_by = $4)
        and ($5::boolean or j.debug_capability_sha256 is null)
        and not exists (select 1 from automation_jobs b where b.org_id = j.org_id and b.profile_id = j.profile_id
                          and b.state in ('CLAIMED', 'RUNNING'))
        and not exists (select 1 from profile_leases l where l.org_id = j.org_id and l.profile_id = j.profile_id
                          and l.state = 'active' and (l.expires_at > now() or l.purpose = 'session'))
      order by (select count(*) from automation_jobs a
                 where a.org_id = j.org_id and a.state in ('CLAIMED', 'RUNNING')
                   and coalesce(a.token_id, a.requested_by) = coalesce(j.token_id, j.requested_by)),
               j.created_at, j.id
      limit 25
      for update of j skip locked`,
    [agent.org_id, agent.id, agent.accepts, agent.user_id, agent.debug_allowed],
  );
  const claimed: string[] = [];
  const profiles = new Set<string>();
  for (const job of rows) {
    if (free <= 0) break;
    if (profiles.has(job.profile_id)) continue;
    if (!(await requesterStillAllowed(c, job))) {
      await endJob(c, actor, job.id, 'FAILED', 'ACCESS_REMOVED', { reason: 'requester_access' });
      continue;
    }
    // The steps must still be on the approved sites (an admin may have removed one since).
    const steps = await c.query<{ input: StepInput }>(
      `select input from job_steps where job_id = $1 and action in ('open_url', 'wait_for', 'screenshot')
        order by sequence`,
      [job.id],
    );
    if (
      stepsProblem(
        steps.rows.map((s) => s.input),
        allowedOrigins,
      )
    ) {
      await endJob(c, actor, job.id, 'FAILED', 'URL_NOT_APPROVED');
      continue;
    }
    // The computer's person must be able to open it (the lease will be theirs).
    if (!(await userMayLaunch(c, job.org_id, agent.user_id, job.profile_id))) continue;
    const { rows: updated } = await c.query<JobRow>(
      `update automation_jobs
          set state = 'CLAIMED', agent_id = $2, attempt = attempt + 1, claimed_at = now(),
              claim_expires_at = now() + make_interval(secs => $3), heartbeat_at = now(), lost_at = null,
              version = version + 1
        where id = $1 and state = 'QUEUED'
        returning id, org_id, profile_id, state, agent_id, error_code, reconciliation_required, attempt, version`,
      [job.id, agent.id, AGENT_TIMING.claimSeconds],
    );
    const row = updated[0];
    if (!row) continue;
    await audit(c, {
      orgId: actor.orgId,
      actorUserId: actor.userId,
      actorDeviceId: actor.deviceId,
      action: 'automation.job_claimed',
      targetType: 'job',
      targetId: job.id,
      outcome: 'success',
      requestId: actor.requestId,
      details: { agent_id: agent.id, attempt: row.attempt, profile_id: job.profile_id },
    });
    profiles.add(job.profile_id);
    claimed.push(job.id);
    free--;
  }
  return claimed;
}

/** What a computer needs to run (or continue) a job it holds. */
export async function claimedJob(
  c: pg.PoolClient,
  orgId: string,
  jobId: string,
  agent: AgentRow,
  allowedOrigins: readonly string[],
): Promise<ClaimedJob | null> {
  const job = await jobById(c, orgId, jobId, agent.user_id);
  if (!job) return null;
  const steps = await stepsOf(c, jobId);
  const { rows } = await c.query<{ debug_capability_sha256: string | null }>(
    'select debug_capability_sha256 from automation_jobs where id = $1',
    [jobId],
  );
  const plan = planResume(
    steps.map((s) => ({ seq: s.seq, action: s.action, state: s.state, effect: s.effect })),
  );
  return {
    job,
    steps,
    allowed_origins: [...allowedOrigins],
    lease_key: leaseKeyFor(jobId, agent.id),
    debug_capability_sha256: rows[0]?.debug_capability_sha256 ?? null,
    resume_from: plan.resumeFrom,
  };
}

export async function settingsOf(
  c: pg.PoolClient,
  orgId: string,
): Promise<{
  allowed_origins: string[];
  max_running_jobs: number;
  version: number;
  updated_at: string | null;
}> {
  const { rows } = await c.query<{
    allowed_origins: string[];
    max_running_jobs: number;
    version: number;
    updated_at: string | null;
  }>(
    `select allowed_origins, max_running_jobs, version, ${ts('updated_at')} as updated_at
       from automation_settings where org_id = $1`,
    [orgId],
  );
  return rows[0] ?? { allowed_origins: [], max_running_jobs: 5, version: 1, updated_at: null };
}

/** Effects of the steps (from the registry; stored with each step so the database can apply the resume rules). */
export function effectOf(action: StepAction): string {
  return STEP_REGISTRY[action].effect;
}

/**
 * When someone leaves the organization: their tokens are revoked, their computers removed (running jobs there end:
 * ACCESS_REMOVED; claimed ones go back to the queue) and the queued jobs they asked for end.
 */
export async function endMemberAutomation(c: pg.PoolClient, actor: Actor, memberId: string): Promise<void> {
  await c.query(
    `update api_tokens set revoked_at = now(), revoked_by = $3, revoke_reason = 'member_removed'
      where org_id = $1 and user_id = $2 and revoked_at is null`,
    [actor.orgId, memberId, actor.userId],
  );
  const agents = await c.query<{ id: string }>(
    'select id from automation_agents where org_id = $1 and user_id = $2 for update',
    [actor.orgId, memberId],
  );
  for (const a of agents.rows) await removeAgentJobs(c, actor, a.id);
  await c.query('delete from automation_agents where org_id = $1 and user_id = $2', [actor.orgId, memberId]);
  const queued = await c.query<{ id: string }>(
    `select id from automation_jobs where org_id = $1 and requested_by = $2 and state = 'QUEUED' for update`,
    [actor.orgId, memberId],
  );
  for (const j of queued.rows)
    await endJob(c, actor, j.id, 'FAILED', 'ACCESS_REMOVED', { reason: 'member_removed' });
}

/** Before a computer is removed: its claims return to the queue, its running jobs end (ACCESS_REMOVED). */
export async function removeAgentJobs(c: pg.PoolClient, actor: Actor, agentId: string): Promise<void> {
  const jobs = await c.query<{ id: string; state: JobState }>(
    `select id, state from automation_jobs where agent_id = $1 and state in ('CLAIMED', 'RUNNING') for update`,
    [agentId],
  );
  for (const j of jobs.rows) {
    if (j.state === 'CLAIMED') {
      await c.query(
        `update automation_jobs set state = 'QUEUED', agent_id = null, claimed_at = null, claim_expires_at = null,
                version = version + 1 where id = $1`,
        [j.id],
      );
    } else {
      await endJob(c, actor, j.id, 'FAILED', 'ACCESS_REMOVED', { reason: 'agent_removed' });
    }
  }
}
