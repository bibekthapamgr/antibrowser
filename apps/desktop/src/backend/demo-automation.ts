/**
 * In-memory stand-in for the milestone 10 API (UI development and UI tests only): automation settings, the job
 * dashboard, enrolled computers, API tokens and webhook endpoints, following services/api closely enough for the
 * screens (permissions from the shared matrix, scopes within the creator's role, secrets shown once, versions, the
 * same approved-site grammar and webhook destination checks). "This computer" can be enrolled; a job given to it
 * then runs through its steps on a timer, the way the desktop agent reports them.
 */
import {
  type Agent,
  API_SCOPES,
  type ApiScope,
  type ApiToken,
  type AutomationSettings,
  type Job,
  type JobStep,
  ORIGIN_PATTERN_MAX,
  parseOriginPattern,
  STEP_REGISTRY,
  type StepAction,
  scopeAllowedForRole,
  TOKEN_LIMITS,
  WEBHOOK_EVENTS,
  type WebhookDelivery,
  type WebhookEndpoint,
  webhookUrlProblem,
} from '@pb/contracts/automation';
import type { AutomationRun, AutomationStatus } from '@pb/contracts/ipc';
import type { Permission, Role } from '@pb/contracts/resources';
import { ROLE_PERMISSIONS } from '@pb/contracts/resources';
import type { AutomationRepository, CloudRequest } from './types.ts';

const CROCK = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const rid = (prefix: string) =>
  `${prefix}_${Array.from({ length: 26 }, () => CROCK[Math.floor(Math.random() * 32)]).join('')}`;
const b64url = (n: number) =>
  Array.from(
    { length: n },
    () => 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'[Math.floor(Math.random() * 64)],
  ).join('');
const now = () => new Date().toISOString();
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const DAY = 86_400_000;

/** What this module needs to know about a demo organization. */
export interface DemoAutomationOrg {
  id: string;
  members: Map<string, { role: Role }>;
  clients: { id: string; name: string }[];
  profiles: { id: string; name: string; client_id: string | null; deleted: boolean }[];
}

interface DemoJob {
  job: Job;
  steps: JobStep[];
  artifacts: { id: string; seq: number; label: string | null; created_at: string; image: string }[];
}

interface OrgState {
  settings: AutomationSettings;
  agents: Agent[];
  jobs: DemoJob[];
  tokens: ApiToken[];
  endpoints: WebhookEndpoint[];
  deliveries: WebhookDelivery[];
}

type Res = { status: number; body: unknown };

export interface DemoAutomationDeps {
  me: { id: string; display_name: string };
  deviceId: string;
  personName: (userId: string) => string;
  err: (status: number, code: string, message: string, details?: Record<string, unknown>) => Res;
  audit: (org: DemoAutomationOrg, action: string, target: string | null) => void;
  /** Whether the signed-in person can see this organization profile. */
  visibleProfile: (org: DemoAutomationOrg, profileId: string) => boolean;
  orgs: () => DemoAutomationOrg[];
  emit: (payload: { kind: 'poll' | 'job'; org_id: string; job_id?: string; state?: string }) => void;
}

/** A small picture for demo screenshots (the real app shows the JPEG the computer uploaded). */
function demoImage(title: string, tone: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360"><rect width="640" height="360" fill="#f4f6fa"/><rect width="640" height="48" fill="${tone}"/><text x="24" y="31" font-family="sans-serif" font-size="18" fill="#fff">${title}</text><rect x="24" y="80" width="360" height="22" rx="4" fill="#d5dbe6"/><rect x="24" y="118" width="520" height="14" rx="4" fill="#e3e8f0"/><rect x="24" y="142" width="480" height="14" rx="4" fill="#e3e8f0"/><rect x="24" y="190" width="140" height="36" rx="6" fill="${tone}"/></svg>`;
  const bytes = new TextEncoder().encode(svg);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return `data:image/svg+xml;base64,${btoa(binary)}`;
}

export function demoAutomation(deps: DemoAutomationDeps) {
  const { me, err } = deps;
  const states = new Map<string, OrgState>();
  const enrolled = new Map<
    string,
    { agent_id: string; accepts: 'mine' | 'org'; max_jobs: number; at: string }
  >();
  const runs: AutomationRun[] = [];
  let allowDebugging = false;
  const lastPoll = new Map<string, number>();

  const role = (org: DemoAutomationOrg) => org.members.get(me.id)?.role ?? null;
  const allows = (org: DemoAutomationOrg, p: Permission) => {
    const r = role(org);
    return !!r && ROLE_PERMISSIONS[r].includes(p);
  };
  const forbid = (p: Permission) =>
    err(403, 'FORBIDDEN', 'Your role does not allow this action', { permission: p });
  const conflict = (current: number) =>
    err(409, 'VERSION_CONFLICT', 'This was changed by someone else; reload and retry', {
      current_version: current,
    });
  const page = <T>(items: T[]) => ({ status: 200, body: { items: items.slice(0, 100), next_cursor: null } });

  const step = (seq: number, action: StepAction, input: Record<string, unknown> = {}): JobStep => ({
    seq,
    action,
    effect: STEP_REGISTRY[action].effect,
    input:
      action === 'open_url' || action === 'wait_for' || action === 'screenshot' ? { action, ...input } : {},
    state: 'pending',
    attempt: 0,
    started_at: null,
    finished_at: null,
    error_code: null,
    output: null,
  });

  function newJob(
    org: DemoAutomationOrg,
    s: OrgState,
    profileId: string,
    opts: {
      label: string | null;
      steps: [StepAction, Record<string, unknown>][];
      keepOpen?: number;
      agent?: (typeof s.agents)[number];
      by?: { id: string; name: string };
      token?: ApiToken;
    },
  ): DemoJob {
    const p = org.profiles.find((x) => x.id === profileId);
    const t = now();
    const all: [StepAction, Record<string, unknown>][] = [
      ['open_profile', {}],
      ...opts.steps,
      ...(opts.keepOpen ? ([['hold_open', {}]] as [StepAction, Record<string, unknown>][]) : []),
      ['close_profile', {}],
    ];
    const by = opts.by ?? { id: me.id, name: me.display_name };
    return {
      job: {
        id: rid('job'),
        org_id: org.id,
        profile_id: profileId,
        profile_name: p?.name ?? 'Profile',
        client_id: p?.client_id ?? null,
        client_name: org.clients.find((c) => c.id === p?.client_id)?.name ?? null,
        label: opts.label,
        state: 'QUEUED',
        agent_id: opts.agent?.id ?? null,
        agent_name: opts.agent?.name ?? null,
        requested_agent_id: null,
        requested_by: by.id,
        requested_by_name: by.name,
        token_id: opts.token?.id ?? null,
        token_name: opts.token?.name ?? null,
        steps_total: all.length,
        steps_done: 0,
        keep_open_minutes: opts.keepOpen ?? null,
        debug: false,
        attempt: 0,
        lease_id: null,
        error_code: null,
        reconciliation_required: false,
        holding: false,
        created_at: t,
        queue_expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        claimed_at: null,
        started_at: null,
        finished_at: null,
        cancel_requested_at: null,
        version: 1,
        mine: by.id === me.id,
      },
      steps: all.map(([a, input], i) => step(i, a, input)),
      artifacts: [],
    };
  }

  /** Sample data the first time an organization's automation is opened. */
  function stateOf(org: DemoAutomationOrg): OrgState {
    const existing = states.get(org.id);
    if (existing) return existing;
    const t = now();
    const s: OrgState = {
      settings: {
        org_id: org.id,
        allowed_origins: ['https://portal.example.com', 'https://*.shop.example.com'],
        max_running_jobs: 5,
        version: 1,
        updated_at: null,
      },
      agents: [],
      jobs: [],
      tokens: [],
      endpoints: [],
      deliveries: [],
    };
    states.set(org.id, s);
    const profiles = org.profiles.filter((p) => !p.deleted);
    if (profiles.length === 0) return s;
    const sam = {
      id: rid('agt'),
      org_id: org.id,
      device_id: rid('dev'),
      user_id: rid('usr'),
      user_name: 'Sam Ortiz',
      name: 'Sam’s Windows laptop',
      platform: 'windows-x64',
      browser_version: '155.0.8059.39',
      enabled: true,
      accepts: 'org' as const,
      debug_allowed: false,
      max_jobs: 2,
      online: true,
      last_seen_at: t,
      running_jobs: 1,
      created_at: ago(60 * 24 * 5),
      version: 1,
      mine: false,
    };
    const build = {
      ...sam,
      id: rid('agt'),
      device_id: rid('dev'),
      user_name: 'Build account',
      name: 'Build server',
      platform: 'linux-x64',
      online: false,
      last_seen_at: ago(60 * 26),
      running_jobs: 0,
      accepts: 'mine' as const,
    };
    s.agents.push(sam, build);
    const token: ApiToken = {
      id: rid('tok'),
      org_id: org.id,
      name: 'Nightly checks',
      owner_id: me.id,
      owner_name: me.display_name,
      scopes: ['automation:run', 'profiles:read'],
      client_ids: null,
      profile_ids: null,
      state: 'active',
      created_at: ago(60 * 24 * 12),
      expires_at: new Date(Date.now() + 78 * DAY).toISOString(),
      last_used_at: ago(42),
      rotated_at: null,
      previous_valid_until: null,
      revoked_at: null,
      mine: true,
    };
    s.tokens.push(token);
    const [p1, p2 = p1, p3 = p1] = profiles;
    if (!p1 || !p2 || !p3) return s;
    const by = { id: me.id, name: me.display_name };
    // Succeeded, with a screenshot.
    const ok = newJob(org, s, p1.id, {
      label: 'Morning login check',
      steps: [
        ['open_url', { url: 'https://portal.example.com/login' }],
        ['wait_for', { condition: { type: 'text', text: 'Welcome' } }],
        ['screenshot', { label: 'login' }],
      ],
      agent: sam,
      by,
      token,
    });
    finishAll(ok, 'SUCCEEDED', ago(55));
    const artId = rid('art');
    ok.artifacts.push({
      id: artId,
      seq: 3,
      label: 'login',
      created_at: ago(55),
      image: demoImage('portal.example.com — Welcome back', '#2f5fb3'),
    });
    const shot = ok.steps[3];
    if (shot) shot.output = { artifact_id: artId, width: 1280, height: 720, elapsed_ms: 640 };
    // Failed: the site sent the page elsewhere.
    const bad = newJob(org, s, p2.id, {
      label: 'Order status',
      steps: [
        ['open_url', { url: 'https://orders.shop.example.com/' }],
        ['screenshot', {}],
      ],
      agent: sam,
      by: { id: rid('usr'), name: 'Alex Kim' },
    });
    finishAll(bad, 'FAILED', ago(30), 1, 'PAGE_LEFT_APPROVED_SITES');
    // Holding a profile open for someone.
    const hold = newJob(org, s, p3.id, {
      label: 'Keep open for review',
      steps: [['open_url', { url: 'https://portal.example.com/reports' }]],
      keepOpen: 60,
      agent: sam,
      by,
    });
    hold.job.state = 'RUNNING';
    hold.job.attempt = 1;
    hold.job.claimed_at = ago(9);
    hold.job.started_at = ago(9);
    hold.job.holding = true;
    hold.job.lease_id = rid('lse');
    for (const st of hold.steps.slice(0, 2)) {
      st.state = 'succeeded';
      st.attempt = 1;
      st.started_at = ago(9);
      st.finished_at = ago(9);
    }
    const h = hold.steps[2];
    if (h) {
      h.state = 'running';
      h.attempt = 1;
      h.started_at = ago(9);
    }
    hold.job.steps_done = 2;
    // Waiting for a computer.
    const queued = newJob(org, s, p1.id, {
      label: 'Weekly invoice screenshot',
      steps: [
        ['open_url', { url: 'https://portal.example.com/invoices' }],
        ['screenshot', { label: 'invoices' }],
      ],
      by,
    });
    s.jobs.push(queued, hold, bad, ok);
    const endpoint: WebhookEndpoint = {
      id: rid('whk'),
      org_id: org.id,
      url: 'https://hooks.example.com/project-browser',
      description: 'Job results to our ticket system',
      events: ['automation.job.succeeded', 'automation.job.failed'],
      state: 'active',
      disabled_reason: null,
      created_at: ago(60 * 24 * 3),
      updated_at: ago(60 * 24 * 3),
      secret_rotated_at: null,
      last_success_at: ago(55),
      last_failure_at: ago(30),
      dead_deliveries: 1,
      pending_deliveries: 0,
      version: 1,
    };
    s.endpoints.push(endpoint);
    s.deliveries.push(
      {
        id: rid('dlv'),
        endpoint_id: endpoint.id,
        event_id: rid('evt'),
        event_type: 'automation.job.failed',
        state: 'dead',
        attempts: 8,
        next_attempt_at: null,
        last_status: 502,
        last_error: 'status_5xx',
        created_at: ago(30),
        delivered_at: null,
      },
      {
        id: rid('dlv'),
        endpoint_id: endpoint.id,
        event_id: rid('evt'),
        event_type: 'automation.job.succeeded',
        state: 'delivered',
        attempts: 1,
        next_attempt_at: null,
        last_status: 200,
        last_error: null,
        created_at: ago(55),
        delivered_at: ago(55),
      },
    );
    return s;
  }

  function finishAll(
    j: DemoJob,
    state: 'SUCCEEDED' | 'FAILED' | 'CANCELED',
    at: string,
    failAt?: number,
    code?: Job['error_code'],
  ) {
    j.job.state = state;
    j.job.attempt = Math.max(1, j.job.attempt);
    j.job.claimed_at ??= at;
    j.job.started_at ??= at;
    j.job.finished_at = at;
    j.job.error_code = code ?? (state === 'CANCELED' ? 'CANCELED' : null);
    j.job.holding = false;
    let done = 0;
    for (const st of j.steps) {
      const closing = st.action === 'close_profile';
      if (failAt !== undefined && st.seq === failAt) {
        st.state = 'failed';
        st.error_code = code ?? 'INTERNAL';
      } else if (failAt !== undefined && st.seq > failAt && !closing) {
        st.state = 'skipped';
      } else if (st.state === 'pending' || st.state === 'running') {
        st.state = state === 'CANCELED' && !closing ? 'skipped' : 'succeeded';
      }
      if (st.state === 'succeeded') {
        done++;
        st.attempt = Math.max(1, st.attempt);
        st.started_at ??= at;
        st.finished_at ??= at;
        if (st.action === 'open_url')
          st.output ??= { final_origin: 'https://portal.example.com', http_status: 200, elapsed_ms: 1840 };
        if (closing) st.output ??= { backup: 'committed', elapsed_ms: 4200 };
      }
    }
    j.job.steps_done = done;
    j.job.version++;
  }

  const jobVisible = (org: DemoAutomationOrg, j: DemoJob) =>
    allows(org, 'automation.manage') || j.job.mine || deps.visibleProfile(org, j.job.profile_id);

  const agentView = (a: OrgState['agents'][number]): Agent => {
    return {
      ...a,
      online: a.device_id === deps.deviceId ? lastPollFresh(a.org_id) : a.online,
      mine: a.device_id === deps.deviceId,
      running_jobs: (states.get(a.org_id)?.jobs ?? []).filter(
        (j) => j.job.agent_id === a.id && (j.job.state === 'RUNNING' || j.job.state === 'CLAIMED'),
      ).length,
    };
  };
  const lastPollFresh = (orgId: string) => Date.now() - (lastPoll.get(orgId) ?? 0) < 30_000;

  const endpointView = (s: OrgState, e: WebhookEndpoint): WebhookEndpoint => ({
    ...e,
    dead_deliveries: s.deliveries.filter((d) => d.endpoint_id === e.id && d.state === 'dead').length,
    pending_deliveries: s.deliveries.filter((d) => d.endpoint_id === e.id && d.state === 'pending').length,
  });
  const whsec = () => `whsec_${btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))}`;

  /** Handles `/v1/orgs/{org}/automation/...`, `/api-tokens...` and `/webhook-endpoints...`; null otherwise. */
  function route(org: DemoAutomationOrg, req: CloudRequest, parts: string[], version?: number): Res | null {
    const [, , c, d, e, f, g] = parts;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const q = new Map(req.query ?? []);
    if (c !== 'automation' && c !== 'api-tokens' && c !== 'webhook-endpoints') return null;
    const s = stateOf(org);
    const r = role(org);
    if (!r) return err(404, 'NOT_FOUND', 'Organization not found');

    // ---------------------------------------------------------------- settings
    if (c === 'automation' && d === 'settings') {
      if (!allows(org, 'automation.read')) return forbid('automation.read');
      if (req.method === 'GET') return { status: 200, body: s.settings };
      if (!allows(org, 'automation.manage')) return forbid('automation.manage');
      if (version !== undefined && version !== s.settings.version) return conflict(s.settings.version);
      if (Array.isArray(body.allowed_origins)) {
        const list = body.allowed_origins.map(String);
        if (list.length > ORIGIN_PATTERN_MAX)
          return err(400, 'VALIDATION_FAILED', 'Too many approved sites', { max: ORIGIN_PATTERN_MAX });
        const badIndex = list.findIndex((o) => parseOriginPattern(o) === null);
        if (badIndex >= 0)
          return err(400, 'VALIDATION_FAILED', 'Approved sites look like https://app.example.com', {
            index: badIndex,
          });
        s.settings.allowed_origins = [...new Set(list)];
      }
      if (typeof body.max_running_jobs === 'number') s.settings.max_running_jobs = body.max_running_jobs;
      s.settings.version++;
      s.settings.updated_at = now();
      deps.audit(org, 'automation.settings_updated', org.id);
      return { status: 200, body: s.settings };
    }

    // ---------------------------------------------------------------- jobs
    if (c === 'automation' && d === 'jobs') {
      if (!allows(org, 'automation.read')) return forbid('automation.read');
      if (!e) {
        if (req.method !== 'GET') return err(405, 'NOT_ALLOWED', 'Create jobs through the API or the SDK');
        const state = q.get('state');
        const items = s.jobs
          .filter((j) => jobVisible(org, j))
          .filter((j) =>
            !state || state === 'all'
              ? true
              : state === 'active'
                ? ['QUEUED', 'CLAIMED', 'RUNNING'].includes(j.job.state)
                : state === 'finished'
                  ? ['SUCCEEDED', 'FAILED', 'CANCELED'].includes(j.job.state)
                  : j.job.state === state,
          )
          .filter((j) => q.get('mine') !== 'true' || j.job.mine)
          .filter((j) => !q.get('profile_id') || j.job.profile_id === q.get('profile_id'))
          .filter((j) => !q.get('agent_id') || j.job.agent_id === q.get('agent_id'))
          .map((j) => j.job);
        return page(items);
      }
      const j = s.jobs.find((x) => x.job.id === e && jobVisible(org, x));
      if (!j) return err(404, 'NOT_FOUND', 'Job not found');
      if (!f && req.method === 'GET') {
        return {
          status: 200,
          body: {
            job: j.job,
            steps: j.steps,
            artifacts: j.artifacts.map((a) => ({
              id: a.id,
              seq: a.seq,
              content_type: 'image/jpeg',
              size_bytes: 48_213,
              width: 1280,
              height: 720,
              label: a.label,
              created_at: a.created_at,
              expires_at: new Date(Date.parse(a.created_at) + 7 * DAY).toISOString(),
            })),
          },
        };
      }
      if (f === 'cancel' && req.method === 'POST') {
        const may = allows(org, 'automation.manage') || (j.job.mine && allows(org, 'automation.run'));
        if (!may) return forbid('automation.manage');
        if (['SUCCEEDED', 'FAILED', 'CANCELED'].includes(j.job.state))
          return err(409, 'JOB_FINISHED', 'This job already finished', { state: j.job.state });
        if (j.job.state === 'RUNNING') {
          j.job.cancel_requested_at = now();
          j.job.version++;
          // The computer stops before the next step and closes the profile (a held profile: the job succeeded).
          setTimeout(() => {
            if (j.job.state !== 'RUNNING') return;
            finishAll(j, j.job.holding ? 'SUCCEEDED' : 'CANCELED', now());
            deps.emit({ kind: 'job', org_id: org.id, job_id: j.job.id, state: j.job.state });
          }, 900);
        } else {
          finishAll(j, 'CANCELED', now());
        }
        deps.audit(org, 'automation.job_cancel_requested', j.job.id);
        return { status: 200, body: j.job };
      }
      return err(404, 'NOT_FOUND', 'Route not found');
    }

    // ---------------------------------------------------------------- computers
    if (c === 'automation' && d === 'agents') {
      if (!allows(org, 'automation.read')) return forbid('automation.read');
      if (!e && req.method === 'GET') return page(s.agents.map(agentView));
      const a = s.agents.find((x) => x.id === e);
      if (!a || f) return err(404, 'NOT_FOUND', 'Computer not found');
      const mine = a.device_id === deps.deviceId;
      if (!mine && !allows(org, 'automation.manage')) return forbid('automation.manage');
      if (req.method === 'DELETE') {
        s.agents.splice(s.agents.indexOf(a), 1);
        for (const j of s.jobs)
          if (j.job.agent_id === a.id && ['CLAIMED', 'RUNNING'].includes(j.job.state))
            finishAll(j, 'FAILED', now(), undefined, 'ACCESS_REMOVED');
        if (mine) enrolled.delete(org.id);
        deps.audit(org, 'automation.agent_removed', a.id);
        return { status: 204, body: null };
      }
      if (version !== undefined && version !== a.version) return conflict(a.version);
      if (typeof body.enabled === 'boolean') a.enabled = body.enabled;
      if (body.accepts === 'mine' || body.accepts === 'org') a.accepts = body.accepts;
      if (typeof body.max_jobs === 'number') a.max_jobs = body.max_jobs;
      if (typeof body.name === 'string' && body.name.trim()) a.name = body.name.trim().slice(0, 80);
      a.version++;
      deps.audit(org, 'automation.agent_updated', a.id);
      return { status: 200, body: agentView(a) };
    }

    // ---------------------------------------------------------------- API tokens
    if (c === 'api-tokens') {
      if (!d && req.method === 'GET') {
        const everyone = q.get('all') === 'true';
        if (everyone && !allows(org, 'tokens.manage')) return forbid('tokens.manage');
        const all = q.get('state') === 'all';
        return page(
          s.tokens
            .filter((t) => everyone || t.owner_id === me.id)
            .filter((t) => all || t.state === 'active')
            .map((t) => ({ ...t, mine: t.owner_id === me.id })),
        );
      }
      if (!d && req.method === 'POST') {
        if (!allows(org, 'tokens.create')) return forbid('tokens.create');
        const name = String(body.name ?? '').trim();
        const scopes = (Array.isArray(body.scopes) ? body.scopes : []) as ApiScope[];
        const days = Number(body.expires_in_days);
        if (!name || name.length > 80)
          return err(400, 'VALIDATION_FAILED', 'Name the token (up to 80 characters)');
        if (scopes.length === 0 || scopes.some((x) => !API_SCOPES.includes(x)))
          return err(400, 'VALIDATION_FAILED', 'Choose at least one permission');
        const beyond = scopes.filter((x) => !scopeAllowedForRole(r, x));
        if (beyond.length)
          return err(403, 'FORBIDDEN', 'A token cannot do more than you can', { scopes: beyond });
        if (!Number.isInteger(days) || days < 1 || days > TOKEN_LIMITS.maxDays)
          return err(400, 'VALIDATION_FAILED', 'Tokens expire after 1 to 365 days');
        const clientIds = Array.isArray(body.client_ids) ? body.client_ids.map(String) : null;
        const profileIds = Array.isArray(body.profile_ids) ? body.profile_ids.map(String) : null;
        if (clientIds?.some((id) => !org.clients.some((x) => x.id === id)))
          return err(404, 'NOT_FOUND', 'Client not found');
        if (profileIds?.some((id) => !deps.visibleProfile(org, id)))
          return err(404, 'NOT_FOUND', 'Profile not found');
        const t: ApiToken = {
          id: rid('tok'),
          org_id: org.id,
          name,
          owner_id: me.id,
          owner_name: me.display_name,
          scopes,
          client_ids: clientIds,
          profile_ids: profileIds,
          state: 'active',
          created_at: now(),
          expires_at: new Date(Date.now() + days * DAY).toISOString(),
          last_used_at: null,
          rotated_at: null,
          previous_valid_until: null,
          revoked_at: null,
          mine: true,
        };
        s.tokens.unshift(t);
        deps.audit(org, 'api_token.created', t.id);
        return { status: 201, body: { token: t, secret: `pbt_${t.id}_${b64url(43)}` } };
      }
      const t = s.tokens.find((x) => x.id === d);
      if (!t) return err(404, 'NOT_FOUND', 'Token not found');
      const may = t.owner_id === me.id || allows(org, 'tokens.manage');
      if (!may) return err(404, 'NOT_FOUND', 'Token not found');
      if (e === 'rotate' && req.method === 'POST') {
        if (t.state !== 'active') return err(409, 'TOKEN_INACTIVE', 'Only an active token can be rotated');
        const grace = Number(body.grace_minutes ?? 60);
        t.rotated_at = now();
        t.previous_valid_until = grace > 0 ? new Date(Date.now() + grace * 60_000).toISOString() : null;
        deps.audit(org, 'api_token.rotated', t.id);
        return { status: 200, body: { token: t, secret: `pbt_${t.id}_${b64url(43)}` } };
      }
      if (!e && req.method === 'DELETE') {
        t.state = 'revoked';
        t.revoked_at = now();
        deps.audit(org, 'api_token.revoked', t.id);
        return { status: 204, body: null };
      }
      return err(404, 'NOT_FOUND', 'Route not found');
    }

    // ---------------------------------------------------------------- webhooks
    if (!allows(org, 'webhooks.manage')) return forbid('webhooks.manage');
    if (!d && req.method === 'GET') return page(s.endpoints.map((x) => endpointView(s, x)));
    const checkUrl = (u: string) => {
      const problem = webhookUrlProblem(u);
      return problem
        ? err(422, 'WEBHOOK_DESTINATION_BLOCKED', 'This address cannot receive webhooks', { reason: problem })
        : null;
    };
    const checkEvents = (ev: unknown) =>
      !Array.isArray(ev) ||
      ev.length === 0 ||
      ev.some((x) => !(WEBHOOK_EVENTS as readonly string[]).includes(x))
        ? err(400, 'VALIDATION_FAILED', 'Choose at least one event')
        : null;
    if (!d && req.method === 'POST') {
      const url = String(body.url ?? '');
      const bad = checkUrl(url) ?? checkEvents(body.events);
      if (bad) return bad;
      if (s.endpoints.length >= 10) return err(409, 'LIMIT_REACHED', 'At most 10 endpoints per organization');
      const t = now();
      const ep: WebhookEndpoint = {
        id: rid('whk'),
        org_id: org.id,
        url,
        description: String(body.description ?? '').slice(0, 200),
        events: body.events as WebhookEndpoint['events'],
        state: 'active',
        disabled_reason: null,
        created_at: t,
        updated_at: t,
        secret_rotated_at: null,
        last_success_at: null,
        last_failure_at: null,
        dead_deliveries: 0,
        pending_deliveries: 0,
        version: 1,
      };
      s.endpoints.push(ep);
      deps.audit(org, 'webhook.created', ep.id);
      return { status: 201, body: { endpoint: ep, secret: whsec() } };
    }
    const ep = s.endpoints.find((x) => x.id === d);
    if (!ep) return err(404, 'NOT_FOUND', 'Endpoint not found');
    if (!e) {
      if (req.method === 'GET') return { status: 200, body: endpointView(s, ep) };
      if (req.method === 'DELETE') {
        s.endpoints.splice(s.endpoints.indexOf(ep), 1);
        deps.audit(org, 'webhook.deleted', ep.id);
        return { status: 204, body: null };
      }
      if (version !== undefined && version !== ep.version) return conflict(ep.version);
      if (typeof body.url === 'string') {
        const bad = checkUrl(body.url);
        if (bad) return bad;
        ep.url = body.url;
      }
      if (body.events !== undefined) {
        const bad = checkEvents(body.events);
        if (bad) return bad;
        ep.events = body.events as WebhookEndpoint['events'];
      }
      if (typeof body.description === 'string') ep.description = body.description.slice(0, 200);
      if (body.state === 'active' || body.state === 'disabled') {
        ep.state = body.state;
        ep.disabled_reason = body.state === 'disabled' ? 'manual' : null;
      }
      ep.version++;
      ep.updated_at = now();
      deps.audit(org, 'webhook.updated', ep.id);
      return { status: 200, body: endpointView(s, ep) };
    }
    if (e === 'rotate-secret' && req.method === 'POST') {
      ep.secret_rotated_at = now();
      ep.version++;
      deps.audit(org, 'webhook.secret_rotated', ep.id);
      return { status: 200, body: { endpoint: endpointView(s, ep), secret: whsec() } };
    }
    if (e === 'test' && req.method === 'POST') {
      const dl: WebhookDelivery = {
        id: rid('dlv'),
        endpoint_id: ep.id,
        event_id: rid('evt'),
        event_type: 'webhook.test',
        state: 'pending',
        attempts: 0,
        next_attempt_at: now(),
        last_status: null,
        last_error: null,
        created_at: now(),
        delivered_at: null,
      };
      s.deliveries.unshift(dl);
      setTimeout(() => {
        dl.attempts = 1;
        dl.state = 'delivered';
        dl.last_status = 200;
        dl.delivered_at = now();
        dl.next_attempt_at = null;
        ep.last_success_at = now();
      }, 400);
      return { status: 202, body: dl };
    }
    if (e === 'deliveries' && !f && req.method === 'GET') {
      const st = q.get('state');
      return page(s.deliveries.filter((x) => x.endpoint_id === ep.id && (!st || x.state === st)));
    }
    if (e === 'deliveries' && g === 'redeliver' && req.method === 'POST') {
      const dl = s.deliveries.find((x) => x.id === f && x.endpoint_id === ep.id);
      if (!dl) return err(404, 'NOT_FOUND', 'Delivery not found');
      if (dl.state !== 'dead') return err(409, 'VALIDATION_FAILED', 'Only a dead delivery is sent again');
      dl.state = 'pending';
      dl.next_attempt_at = now();
      setTimeout(() => {
        dl.attempts++;
        dl.state = 'delivered';
        dl.last_status = 200;
        dl.last_error = null;
        dl.delivered_at = now();
        dl.next_attempt_at = null;
      }, 400);
      deps.audit(org, 'webhook.redelivered', dl.id);
      return { status: 200, body: dl };
    }
    return err(404, 'NOT_FOUND', 'Route not found');
  }

  // ------------------------------------------------------------------ this computer
  const status = (): AutomationStatus => ({
    enrollments: [...enrolled.entries()].map(([org_id, e]) => ({
      org_id,
      agent_id: e.agent_id,
      accepts: e.accepts,
      max_jobs: e.max_jobs,
      created_at: e.at,
      last_poll_seconds: lastPoll.has(org_id)
        ? Math.round((Date.now() - (lastPoll.get(org_id) ?? 0)) / 1000)
        : null,
      poll_error: null,
      enabled: states.get(org_id)?.agents.find((a) => a.id === e.agent_id)?.enabled ?? true,
      running: runs.filter((r) => r.org_id === org_id && r.state !== 'done').length,
    })),
    allow_debugging: allowDebugging,
    running: runs.filter((r) => r.state !== 'done').map((r) => r.job_id),
    runs: [...runs].sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, 50),
  });

  /** The demo poll: claims a queued job for this computer and runs its steps on a timer. */
  function poll() {
    for (const [orgId, e] of enrolled) {
      lastPoll.set(orgId, Date.now());
      const org = deps.orgs().find((o) => o.id === orgId);
      const s = org ? stateOf(org) : null;
      const agent = s?.agents.find((a) => a.id === e.agent_id);
      if (!org || !s || !agent?.enabled) continue;
      const busy = runs.filter((r) => r.org_id === orgId && r.state !== 'done').length;
      if (busy >= e.max_jobs) continue;
      const next = s.jobs.find(
        (j) =>
          j.job.state === 'QUEUED' &&
          !j.job.debug &&
          (e.accepts === 'org' || j.job.requested_by === me.id) &&
          !s.jobs.some(
            (o) =>
              o !== j &&
              o.job.profile_id === j.job.profile_id &&
              ['CLAIMED', 'RUNNING'].includes(o.job.state),
          ),
      );
      if (next) run(org, agent, next);
    }
  }

  function run(org: DemoAutomationOrg, agent: OrgState['agents'][number], j: DemoJob) {
    j.job.state = 'RUNNING';
    j.job.agent_id = agent.id;
    j.job.agent_name = agent.name;
    j.job.attempt++;
    j.job.claimed_at = now();
    j.job.started_at = now();
    j.job.lease_id = rid('lse');
    const rec: AutomationRun = {
      job_id: j.job.id,
      org_id: org.id,
      org_profile_id: j.job.profile_id,
      profile_id: null,
      label: j.job.label ?? j.job.profile_name,
      attempt: j.job.attempt,
      opens: 1,
      state: 'running',
      outcome: null,
      error_code: null,
      steps_total: j.steps.length,
      steps_done: 0,
      debug_endpoint: null,
      started_at: now(),
      updated_at: now(),
    };
    runs.unshift(rec);
    deps.emit({ kind: 'job', org_id: org.id, job_id: j.job.id, state: 'running' });
    let i = 0;
    const tick = () => {
      const st = j.steps[i];
      const stopped = j.job.cancel_requested_at !== null || rec.error_code === 'STOPPED_HERE';
      if (!st || stopped) {
        finishAll(j, stopped ? 'CANCELED' : 'SUCCEEDED', now());
        rec.state = 'done';
        rec.outcome = j.job.state as AutomationRun['outcome'];
        rec.error_code = stopped ? 'CANCELED' : null;
        rec.steps_done = j.job.steps_done;
        rec.updated_at = now();
        deps.emit({ kind: 'job', org_id: org.id, job_id: j.job.id, state: 'done' });
        return;
      }
      st.state = 'succeeded';
      st.attempt = 1;
      st.started_at = now();
      st.finished_at = now();
      if (st.action === 'open_url')
        st.output = { final_origin: 'https://portal.example.com', http_status: 200, elapsed_ms: 1210 };
      if (st.action === 'screenshot') {
        const art = {
          id: rid('art'),
          seq: st.seq,
          label: (st.input.label as string | undefined) ?? null,
          created_at: now(),
          image: demoImage(`portal.example.com — ${j.job.label ?? 'screenshot'}`, '#3b7a57'),
        };
        j.artifacts.push(art);
        st.output = { artifact_id: art.id, width: 1280, height: 720, elapsed_ms: 520 };
      }
      if (st.action === 'close_profile') st.output = { backup: 'committed', elapsed_ms: 3100 };
      j.job.steps_done = i + 1;
      rec.steps_done = i + 1;
      rec.state = st.action === 'close_profile' ? 'closing' : 'running';
      rec.updated_at = now();
      i++;
      deps.emit({ kind: 'job', org_id: org.id, job_id: j.job.id, state: rec.state });
      setTimeout(tick, 500);
    };
    setTimeout(tick, 500);
  }

  setInterval(poll, 1500);

  const computer: AutomationRepository = {
    async status() {
      return status();
    },
    async enroll(orgId, accepts, maxJobs) {
      const org = deps.orgs().find((o) => o.id === orgId);
      if (!org || !allows(org, 'automation.agent'))
        throw {
          code: 'AUTOMATION_FORBIDDEN',
          message: 'Your role in that organization does not allow running automation jobs on this computer.',
        };
      const s = stateOf(org);
      let a = s.agents.find((x) => x.device_id === deps.deviceId);
      if (!a) {
        a = {
          id: rid('agt'),
          org_id: orgId,
          device_id: deps.deviceId,
          user_id: me.id,
          user_name: me.display_name,
          name: 'This computer (demo)',
          platform: 'demo',
          browser_version: '155.0.8059.39',
          enabled: true,
          accepts,
          debug_allowed: allowDebugging,
          max_jobs: maxJobs,
          online: true,
          last_seen_at: now(),
          running_jobs: 0,
          created_at: now(),
          version: 1,
          mine: true,
        };
        s.agents.push(a);
      } else {
        a.accepts = accepts;
        a.max_jobs = maxJobs;
        a.version++;
      }
      enrolled.set(orgId, { agent_id: a.id, accepts, max_jobs: maxJobs, at: now() });
      lastPoll.set(orgId, Date.now());
      deps.audit(org, 'automation.agent_enrolled', a.id);
      return status();
    },
    async unenroll(orgId) {
      if (!enrolled.has(orgId))
        throw {
          code: 'AUTOMATION_NOT_ENROLLED',
          message: 'This computer does not run automation jobs for that organization.',
        };
      if (runs.some((r) => r.org_id === orgId && r.state !== 'done'))
        throw {
          code: 'AUTOMATION_BUSY',
          message: 'Jobs of that organization are running on this computer. Stop them first.',
        };
      const s = states.get(orgId);
      const e = enrolled.get(orgId);
      if (s && e) s.agents = s.agents.filter((a) => a.id !== e.agent_id);
      enrolled.delete(orgId);
      lastPoll.delete(orgId);
      return status();
    },
    async stopJob(jobId) {
      const r = runs.find((x) => x.job_id === jobId && x.state !== 'done');
      if (!r) throw { code: 'UNKNOWN_JOB', message: 'That job is not running on this computer.' };
      r.error_code = 'STOPPED_HERE';
      return status();
    },
    async setDebugging(allow) {
      allowDebugging = allow;
      for (const s of states.values())
        for (const a of s.agents) if (a.device_id === deps.deviceId) a.debug_allowed = allow;
      return status();
    },
    async screenshot(orgId, jobId, artifactId) {
      const a = states
        .get(orgId)
        ?.jobs.find((j) => j.job.id === jobId)
        ?.artifacts.find((x) => x.id === artifactId);
      if (!a)
        throw {
          code: 'SCREENSHOT_UNAVAILABLE',
          message: 'This screenshot is no longer available (screenshots are kept for 7 days).',
        };
      return a.image;
    },
  };

  return { route, computer };
}
