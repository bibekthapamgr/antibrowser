/**
 * Automation (milestone 10, ADR-0017).
 *
 * - Organization → Automation: the job dashboard (steps, screenshots, cancel), the computers that run jobs, API
 *   tokens (the secret is shown once), webhook endpoints (secret once, test, deliveries and dead letters) and the
 *   approved sites. Every action is decided by the server; this screen hides what the role cannot do.
 * - Settings → Automation on this computer: which organizations this computer runs jobs for, "Allow Playwright
 *   connections" (off by default) and the jobs it ran.
 *
 * Jobs are created through the API or the SDK, never from page content: a job opens only approved sites, and
 * what a page says never changes what a job may do.
 */
import {
  type Agent,
  API_SCOPES,
  type ApiScope,
  type ApiToken,
  type AutomationSettings,
  type Job,
  type JobDetail,
  type JobStep,
  ORIGIN_PATTERN_MAX,
  parseOriginPattern,
  SCOPE_LABELS,
  scopeAllowedForRole,
  WEBHOOK_EVENTS,
  type WebhookDelivery,
  type WebhookEndpoint,
  webhookUrlProblem,
} from '@pb/contracts/automation';
import type { Client as OrgClient, Profile as OrgProfile, Role } from '@pb/contracts/resources';
import { type FormEvent, type ReactNode, useCallback, useEffect, useId, useMemo, useState } from 'react';
import type { AutomationRun, AutomationStatus, Backend } from './backend/types.ts';
import { errorMessage } from './backend/types.ts';
import { can, get, send } from './cloud.ts';
import { Dialog } from './components.tsx';
import { type Notify, plural, relative, when } from './status.tsx';

interface Page<T> {
  items: T[];
  next_cursor: string | null;
}

// ================================================================================================ wording
export const JOB_STATE_TEXT: Record<Job['state'], string> = {
  QUEUED: 'Waiting for a computer',
  CLAIMED: 'Starting',
  RUNNING: 'Running',
  SUCCEEDED: 'Succeeded',
  FAILED: 'Failed',
  CANCELED: 'Canceled',
};
const JOB_STATE_TONE: Record<Job['state'], string> = {
  QUEUED: 'badge badge--off',
  CLAIMED: 'badge',
  RUNNING: 'badge',
  SUCCEEDED: 'badge badge--ok',
  FAILED: 'badge badge--problem',
  CANCELED: 'badge badge--off',
};

/** Job error codes in words (packages/contracts JOB_ERROR_CODES; local-only codes from this computer too). */
export const JOB_ERROR_TEXT: Record<string, string> = {
  TIMEOUT: 'The step took too long.',
  NAVIGATION_FAILED: 'The page could not be opened.',
  PAGE_LEFT_APPROVED_SITES: 'The page went to a site that is not approved; the job stopped there.',
  CONDITION_NOT_MET: 'What the job waited for did not appear in time.',
  BROWSER_CLOSED: 'The browser was closed.',
  LEASE_LOST: 'The profile was taken over or access was removed while the job ran.',
  PROFILE_IN_USE: 'Someone had the profile open.',
  PROFILE_NOT_AVAILABLE:
    'The profile could not be put on the computer (no backup yet, or it is in the trash).',
  RESTORE_FAILED: 'The newest backup could not be restored on the computer.',
  LAUNCH_FAILED: 'The browser could not be started.',
  BACKUP_PENDING:
    'The closing backup is waiting on the computer; the profile stays held there until it uploads.',
  AGENT_LOST: 'The computer stopped answering and did not come back in time.',
  CANCELED: 'Canceled.',
  OUTCOME_UNKNOWN: 'A step’s outcome is unknown; check by hand before running it again.',
  QUEUE_EXPIRED: 'No computer started the job in time.',
  UNSUPPORTED_BROWSER: 'The computer’s browser or app does not support this.',
  DEBUG_NOT_ALLOWED: 'That computer does not allow Playwright connections.',
  ARTIFACT_TOO_LARGE: 'The screenshot was too large.',
  ACCESS_REMOVED: 'The person who asked for the job (or their token) no longer has access.',
  URL_NOT_APPROVED: 'An address in the job is not on the approved sites.',
  TOO_MANY_ATTEMPTS: 'The job was given back too often.',
  INTERNAL: 'Something went wrong.',
  ABANDONED: 'The organization gave the job to another computer (or it was removed).',
  ENDED: 'The job had already ended in the organization.',
  DISCONNECTED: 'The organization server could not be reached; it continues or ends the job.',
};

const STEP_STATE_TEXT: Record<JobStep['state'], string> = {
  pending: 'Not started',
  running: 'Running',
  succeeded: 'Done',
  failed: 'Failed',
  skipped: 'Skipped',
  canceled: 'Canceled',
  outcome_unknown: 'Outcome unknown',
};

function stepText(s: JobStep, job: Job): string {
  const input = s.input as Record<string, unknown>;
  switch (s.action) {
    case 'open_profile':
      return 'Open the profile (session lease, newest backup)';
    case 'open_url':
      return `Open ${String(input.url ?? '')}`;
    case 'wait_for': {
      const c = (input.condition ?? {}) as Record<string, string>;
      if (c.type === 'selector') return `Wait for the page element ${c.selector}`;
      if (c.type === 'text') return `Wait for the text “${c.text}”`;
      if (c.type === 'title_contains') return `Wait for a title containing “${c.text}”`;
      return `Wait for an address starting with ${c.prefix ?? ''}`;
    }
    case 'screenshot':
      return input.label ? `Screenshot “${String(input.label)}”` : 'Screenshot';
    case 'debug_bridge':
      return 'Hand the session to Playwright on that computer';
    case 'hold_open':
      return `Keep the profile open (up to ${plural(job.keep_open_minutes ?? 0, 'minute')})`;
    case 'close_profile':
      return 'Close the profile (closing backup)';
  }
}

function stepResult(s: JobStep): string {
  const o = s.output;
  if (!o) return s.error_code ? (JOB_ERROR_TEXT[s.error_code] ?? s.error_code) : '';
  const parts: string[] = [];
  if (o.final_origin) parts.push(`${o.final_origin}${o.http_status ? ` (HTTP ${o.http_status})` : ''}`);
  if (o.restored) parts.push('restored the newest backup first');
  if (o.backup === 'committed') parts.push('closing backup saved');
  if (o.backup === 'pending') parts.push('closing backup still uploading');
  if (o.backup === 'not_needed') parts.push('nothing to back up');
  if (o.endpoint) parts.push(o.endpoint);
  if (o.elapsed_ms !== undefined) parts.push(`${(o.elapsed_ms / 1000).toFixed(1)} s`);
  return parts.join(' · ');
}

const finished = (j: Job) => j.state === 'SUCCEEDED' || j.state === 'FAILED' || j.state === 'CANCELED';

async function copy(text: string, notify: Notify, what: string) {
  try {
    await navigator.clipboard.writeText(text);
    notify(`${what} copied.`);
  } catch {
    notify(`Select the ${what.toLowerCase()} and copy it.`, 'error');
  }
}

/** Loads an API resource; `reload` refetches. Errors are reported once per load. */
function useApi<T>(backend: Backend, path: string | null, notify: Notify, query?: [string, string][]) {
  const [data, setData] = useState<T | null>(null);
  const [stale, setStale] = useState(false);
  const [nonce, setNonce] = useState(0);
  const key = JSON.stringify(query ?? []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: key stands for query; nonce reloads
  useEffect(() => {
    if (!path) return;
    let live = true;
    get<T>(backend, path, query)
      .then((r) => {
        if (!live) return;
        setData(r.data);
        setStale(r.stale);
      })
      .catch((e) => live && notify(errorMessage(e, 'Could not load this information.'), 'error'));
    return () => {
      live = false;
    };
  }, [backend, path, key, nonce, notify]);
  return { data, stale, reload: useCallback(() => setNonce((n) => n + 1), []) };
}

/** The secret of a new token or webhook endpoint: shown once, never again. */
function SecretDialog(props: {
  title: string;
  secret: string;
  help: string;
  notify: Notify;
  onClose: () => void;
}) {
  const id = useId();
  return (
    <Dialog
      title={props.title}
      onClose={props.onClose}
      initialFocus={`#${CSS.escape(id)}`}
      role="alertdialog"
    >
      <div className="stack">
        <p className="notice" role="status">
          Copy it now: it is shown only this once and is not stored anywhere in this app. If it is lost,
          rotate it for a new one.
        </p>
        <label>
          Secret
          <input id={id} readOnly value={props.secret} className="mono" onFocus={(e) => e.target.select()} />
        </label>
        <p className="muted small">{props.help}</p>
        <div className="row row--end">
          <button
            type="button"
            className="pb-button"
            onClick={() => void copy(props.secret, props.notify, 'Secret')}
          >
            Copy secret
          </button>
          <button type="button" className="pb-button" data-variant="primary" onClick={props.onClose}>
            I copied it
          </button>
        </div>
      </div>
    </Dialog>
  );
}

// ================================================================================================ organization
type Tab = 'jobs' | 'computers' | 'tokens' | 'webhooks' | 'sites';

export function OrgAutomationSection(props: {
  backend: Backend;
  orgId: string;
  role: Role;
  notify: Notify;
  offline: boolean;
  me: string;
}) {
  const { role } = props;
  const [tab, setTab] = useState<Tab>('jobs');
  const tabs: [Tab, string, boolean][] = [
    ['jobs', 'Jobs', true],
    ['computers', 'Computers', true],
    ['tokens', 'API tokens', can(role, 'tokens.create')],
    ['webhooks', 'Webhooks', can(role, 'webhooks.manage')],
    ['sites', 'Approved sites', true],
  ];
  const visible = tabs.filter(([, , show]) => show);
  const current = visible.some(([t]) => t === tab) ? tab : 'jobs';
  return (
    <section className="stack" aria-labelledby="org-automation-title">
      <h2 id="org-automation-title">Automation</h2>
      <p className="muted small">
        Jobs open a profile on an enrolled computer — under the same session lease as a person, so nobody else
        can have it open — visit approved sites, take screenshots and close it again with its closing backup.
        Jobs are started through the API (API tokens, the SDK); websites can tell the browser is automated.
      </p>
      <nav aria-label="Automation sections" className="org-nav">
        {visible.map(([id, label]) => (
          <button
            key={id}
            type="button"
            className="pb-button"
            aria-current={current === id ? 'page' : undefined}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </nav>
      {current === 'jobs' && <JobsPanel {...props} />}
      {current === 'computers' && <ComputersPanel {...props} />}
      {current === 'tokens' && <TokensPanel {...props} />}
      {current === 'webhooks' && <WebhooksPanel {...props} />}
      {current === 'sites' && <SitesPanel {...props} />}
    </section>
  );
}

type PanelProps = Parameters<typeof OrgAutomationSection>[0];

// ------------------------------------------------------------------------------------------------ jobs
function JobsPanel(props: PanelProps) {
  const { backend, orgId, role, notify, offline } = props;
  const [filter, setFilter] = useState<'active' | 'finished' | 'all'>('all');
  const [mine, setMine] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [cancel, setCancel] = useState<Job | null>(null);
  const query = useMemo<[string, string][]>(
    () => [['state', filter], ...(mine ? ([['mine', 'true']] as [string, string][]) : []), ['limit', '100']],
    [filter, mine],
  );
  const jobs = useApi<Page<Job>>(backend, `/v1/orgs/${orgId}/automation/jobs`, notify, query);
  const active = (jobs.data?.items ?? []).some((j) => !finished(j));
  const { reload } = jobs;
  // Running jobs move on: refresh while any is active, and when this computer reports progress.
  useEffect(() => {
    if (!active) return;
    const t = setInterval(reload, 4000);
    return () => clearInterval(t);
  }, [active, reload]);
  useEffect(() => backend.on('automation', (e) => e.org_id === orgId && reload()), [backend, orgId, reload]);
  const mayCancel = (j: Job) =>
    !finished(j) && (can(role, 'automation.manage') || (j.mine && can(role, 'automation.run')));

  return (
    <section className="stack" aria-labelledby="jobs-title">
      <h3 id="jobs-title">Jobs</h3>
      <div className="row">
        <label>
          Show
          <select value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)}>
            <option value="all">All jobs</option>
            <option value="active">Waiting and running</option>
            <option value="finished">Finished</option>
          </select>
        </label>
        <label className="choice">
          <input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} />
          Only mine
        </label>
        <button type="button" className="pb-button" onClick={reload}>
          Refresh
        </button>
      </div>
      {jobs.data === null ? (
        <p role="status">Loading jobs…</p>
      ) : jobs.data.items.length === 0 ? (
        <p className="muted">
          No jobs yet. Create an API token (API tokens), then start jobs with the API or the SDK; a computer
          enrolled under Settings → Automation on this computer runs them.
        </p>
      ) : (
        <table className="simple records">
          <caption className="pb-sr-only">Automation jobs</caption>
          <thead>
            <tr>
              <th scope="col">Job</th>
              <th scope="col">State</th>
              <th scope="col">Computer</th>
              <th scope="col">Requested</th>
              <th scope="col">
                <span className="pb-sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {jobs.data.items.map((j) => (
              <JobRow
                key={j.id}
                job={j}
                expanded={open === j.id}
                onToggle={() => setOpen(open === j.id ? null : j.id)}
                onCancel={mayCancel(j) && !offline ? () => setCancel(j) : null}
                {...props}
              />
            ))}
          </tbody>
        </table>
      )}
      {cancel && (
        <CancelDialog
          backend={backend}
          orgId={orgId}
          job={cancel}
          notify={notify}
          onClose={(changed) => {
            setCancel(null);
            if (changed) reload();
          }}
        />
      )}
    </section>
  );
}

function JobRow(
  props: PanelProps & { job: Job; expanded: boolean; onToggle: () => void; onCancel: (() => void) | null },
) {
  const { job: j } = props;
  const detailId = useId();
  return (
    <>
      <tr>
        <th scope="row">
          {j.label ?? 'Job'}
          <div className="muted small">
            {j.profile_name}
            {j.client_name ? ` · ${j.client_name}` : ''}
          </div>
        </th>
        <td>
          <span className={JOB_STATE_TONE[j.state]}>
            {j.holding && j.state === 'RUNNING' ? 'Holding open' : JOB_STATE_TEXT[j.state]}
          </span>
          {j.cancel_requested_at && !finished(j) && <div className="muted small">Stopping…</div>}
          {j.reconciliation_required && <div className="warn small">Check by hand</div>}
          <div className="muted small">
            {j.steps_done} of {j.steps_total} steps
          </div>
          {j.error_code && <div className="small">{JOB_ERROR_TEXT[j.error_code] ?? j.error_code}</div>}
        </td>
        <td>{j.agent_name ?? <span className="muted">—</span>}</td>
        <td>
          {j.requested_by_name}
          {j.token_name ? <div className="muted small">token “{j.token_name}”</div> : null}
          <div className="muted small">{relative(j.created_at)}</div>
        </td>
        <td>
          <div className="cell-actions">
            <button
              type="button"
              className="pb-button"
              aria-expanded={props.expanded}
              aria-controls={detailId}
              onClick={props.onToggle}
            >
              {props.expanded ? 'Hide steps' : 'Steps'}
            </button>
            {props.onCancel && (
              <button type="button" className="pb-button" onClick={props.onCancel}>
                {j.holding ? 'Stop' : 'Cancel'}
              </button>
            )}
          </div>
        </td>
      </tr>
      {props.expanded && (
        <tr id={detailId}>
          <td colSpan={5}>
            <JobDetailView {...props} jobId={j.id} />
          </td>
        </tr>
      )}
    </>
  );
}

function JobDetailView(props: PanelProps & { jobId: string; job: Job }) {
  const { backend, orgId, notify } = props;
  const detail = useApi<JobDetail>(backend, `/v1/orgs/${orgId}/automation/jobs/${props.jobId}`, notify);
  const { reload } = detail;
  // biome-ignore lint/correctness/useExhaustiveDependencies: the row's job version tells when to reload
  useEffect(reload, [props.job.version]);
  const [images, setImages] = useState<Record<string, string>>({});
  if (!detail.data) return <p role="status">Loading steps…</p>;
  const d = detail.data;
  return (
    <div className="stack">
      {d.job.reconciliation_required && (
        <p className="notice notice--error" role="status">
          A step’s outcome is unknown (the computer lost its connection after starting it). It is never
          repeated automatically: check the website by hand before running the job again.
        </p>
      )}
      <ol className="job-steps">
        {d.steps.map((s) => {
          const art = d.artifacts.find((a) => a.seq === s.seq);
          return (
            <li key={s.seq}>
              <span
                className={`badge ${s.state === 'succeeded' ? 'badge--ok' : s.state === 'failed' || s.state === 'outcome_unknown' ? 'badge--problem' : 'badge--off'}`}
              >
                {STEP_STATE_TEXT[s.state]}
              </span>{' '}
              {stepText(s, d.job)}
              {s.attempt > 1 && <span className="muted small"> (run {s.attempt} times: safe to repeat)</span>}
              {stepResult(s) && <div className="muted small">{stepResult(s)}</div>}
              {art &&
                (images[art.id] ? (
                  <img
                    className="job-shot"
                    src={images[art.id]}
                    alt={`Screenshot${art.label ? ` “${art.label}”` : ''} of ${d.job.profile_name}, ${art.width}×${art.height}`}
                  />
                ) : (
                  <button
                    type="button"
                    className="pb-button"
                    onClick={async () => {
                      try {
                        const url = await backend.automation.screenshot(orgId, d.job.id, art.id);
                        setImages((m) => ({ ...m, [art.id]: url }));
                      } catch (e) {
                        notify(errorMessage(e), 'error');
                      }
                    }}
                  >
                    Show screenshot{art.label ? ` “${art.label}”` : ''}
                  </button>
                ))}
            </li>
          );
        })}
      </ol>
      <p className="muted small">
        Created {when(d.job.created_at)}
        {d.job.started_at ? ` · started ${when(d.job.started_at)}` : ''}
        {d.job.finished_at ? ` · finished ${when(d.job.finished_at)}` : ''} · claims: {d.job.attempt}.
        Screenshots are kept for 7 days.
      </p>
    </div>
  );
}

function CancelDialog(props: {
  backend: Backend;
  orgId: string;
  job: Job;
  notify: Notify;
  onClose: (changed: boolean) => void;
}) {
  const { job: j } = props;
  const [busy, setBusy] = useState(false);
  const who = `${j.profile_name}${j.client_name ? ` (${j.client_name})` : ''}`;
  const running = j.state === 'RUNNING';
  return (
    <Dialog
      title={j.holding ? `Stop holding ${who} open?` : `Cancel the job on ${who}?`}
      role="alertdialog"
      onClose={() => props.onClose(false)}
    >
      <div className="stack">
        <p>
          {running
            ? 'The computer stops before the next step and closes the profile; its closing backup still uploads, so nothing done so far is lost.'
            : 'Nothing has run yet: the job ends now.'}
        </p>
        <div className="row row--end">
          <button type="button" className="pb-button" onClick={() => props.onClose(false)}>
            Keep it
          </button>
          <button
            type="button"
            className="pb-button"
            data-variant="danger"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await send<Job>(
                  props.backend,
                  'POST',
                  `/v1/orgs/${props.orgId}/automation/jobs/${j.id}/cancel`,
                  {},
                );
                props.notify(
                  running ? 'Stopping: the profile closes after the current step.' : 'Job canceled.',
                );
                props.onClose(true);
              } catch (e) {
                props.notify(errorMessage(e), 'error');
                props.onClose(true);
              }
            }}
          >
            {j.holding ? 'Stop and close the profile' : 'Cancel the job'}
          </button>
        </div>
      </div>
    </Dialog>
  );
}

// ------------------------------------------------------------------------------------------------ computers
function ComputersPanel(props: PanelProps) {
  const { backend, orgId, role, notify, offline } = props;
  const agents = useApi<Page<Agent>>(backend, `/v1/orgs/${orgId}/automation/agents`, notify);
  const [removing, setRemoving] = useState<Agent | null>(null);
  const manage = can(role, 'automation.manage');
  const update = async (a: Agent, change: Record<string, unknown>) => {
    try {
      await send<Agent>(backend, 'PATCH', `/v1/orgs/${orgId}/automation/agents/${a.id}`, change, a.version);
      agents.reload();
    } catch (e) {
      notify(errorMessage(e), 'error');
      agents.reload();
    }
  };
  return (
    <section className="stack" aria-labelledby="computers-title">
      <h3 id="computers-title">Computers</h3>
      <p className="muted small">
        A computer runs jobs as the person who enrolled it, only on profiles they may open. Enroll this
        computer under Settings → Automation on this computer. Playwright connections are allowed only on the
        computer itself.
      </p>
      {agents.data === null ? (
        <p role="status">Loading computers…</p>
      ) : agents.data.items.length === 0 ? (
        <p className="muted">No computer runs this organization’s jobs yet.</p>
      ) : (
        <table className="simple records">
          <caption className="pb-sr-only">Computers that run jobs</caption>
          <thead>
            <tr>
              <th scope="col">Computer</th>
              <th scope="col">Status</th>
              <th scope="col">Runs</th>
              <th scope="col">
                <span className="pb-sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {agents.data.items.map((a) => {
              const editable = (a.mine || manage) && !offline;
              return (
                <tr key={a.id}>
                  <th scope="row">
                    {a.name}
                    {a.mine && <span className="badge">This computer</span>}
                    <div className="muted small">
                      {a.user_name}
                      {a.platform ? ` · ${a.platform}` : ''}
                      {a.browser_version ? ` · browser ${a.browser_version}` : ''}
                    </div>
                  </th>
                  <td>
                    <span className={a.online ? 'badge badge--ok' : 'badge badge--off'}>
                      {a.online ? 'Online' : 'Offline'}
                    </span>{' '}
                    {!a.enabled && <span className="badge badge--warning">Turned off</span>}
                    <div className="muted small">
                      {a.last_seen_at ? `seen ${relative(a.last_seen_at).toLowerCase()}` : 'never seen'}
                      {a.running_jobs ? ` · ${plural(a.running_jobs, 'job')} running` : ''}
                    </div>
                  </td>
                  <td>
                    {a.accepts === 'org' ? 'Anyone’s jobs' : `Only ${a.user_name}’s jobs`}
                    <div className="muted small">
                      up to {a.max_jobs} at a time · Playwright {a.debug_allowed ? 'allowed' : 'not allowed'}
                    </div>
                  </td>
                  <td>
                    <div className="cell-actions">
                      {editable && (
                        <button
                          type="button"
                          className="pb-button"
                          onClick={() => void update(a, { enabled: !a.enabled })}
                        >
                          {a.enabled ? 'Turn off' : 'Turn on'}
                        </button>
                      )}
                      {editable && (
                        <button type="button" className="pb-button" onClick={() => setRemoving(a)}>
                          Remove
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {removing && (
        <Dialog title={`Remove ${removing.name}?`} role="alertdialog" onClose={() => setRemoving(null)}>
          <div className="stack">
            <p>
              It stops getting jobs. A job it is running now fails and its profile is closed there; queued
              jobs go to other computers. It can be enrolled again later.
            </p>
            <div className="row row--end">
              <button type="button" className="pb-button" onClick={() => setRemoving(null)}>
                Keep it
              </button>
              <button
                type="button"
                className="pb-button"
                data-variant="danger"
                onClick={async () => {
                  try {
                    await send(backend, 'DELETE', `/v1/orgs/${orgId}/automation/agents/${removing.id}`);
                    notify(`${removing.name} removed.`);
                  } catch (e) {
                    notify(errorMessage(e), 'error');
                  }
                  setRemoving(null);
                  agents.reload();
                }}
              >
                Remove computer
              </button>
            </div>
          </div>
        </Dialog>
      )}
    </section>
  );
}

// ------------------------------------------------------------------------------------------------ API tokens
function TokensPanel(props: PanelProps) {
  const { backend, orgId, role, notify, offline } = props;
  const everyone = can(role, 'tokens.manage');
  const [all, setAll] = useState(false);
  const [showInactive, setShowInactive] = useState(false);
  const query = useMemo<[string, string][]>(
    () => [
      ...(all ? ([['all', 'true']] as [string, string][]) : []),
      ['state', showInactive ? 'all' : 'active'],
    ],
    [all, showInactive],
  );
  const tokens = useApi<Page<ApiToken>>(backend, `/v1/orgs/${orgId}/api-tokens`, notify, query);
  const [creating, setCreating] = useState(false);
  const [secret, setSecret] = useState<{ title: string; value: string } | null>(null);
  const [revoking, setRevoking] = useState<ApiToken | null>(null);
  const [rotating, setRotating] = useState<ApiToken | null>(null);
  return (
    <section className="stack" aria-labelledby="tokens-title">
      <h3 id="tokens-title">API tokens</h3>
      <p className="muted small">
        A token acts as you, never with more access than you have: only the permissions you choose, optionally
        only some clients or profiles, until it expires. Tokens are stored only as a fingerprint; the secret
        is shown once.
      </p>
      <div className="row">
        <button
          type="button"
          className="pb-button"
          data-variant="primary"
          disabled={offline}
          onClick={() => setCreating(true)}
        >
          New token…
        </button>
        {everyone && (
          <label className="choice">
            <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} />
            Everyone’s tokens
          </label>
        )}
        <label className="choice">
          <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />
          Show expired and revoked
        </label>
      </div>
      {tokens.data === null ? (
        <p role="status">Loading tokens…</p>
      ) : tokens.data.items.length === 0 ? (
        <p className="muted">No tokens.</p>
      ) : (
        <table className="simple records">
          <caption className="pb-sr-only">API tokens</caption>
          <thead>
            <tr>
              <th scope="col">Token</th>
              <th scope="col">Permissions</th>
              <th scope="col">Limited to</th>
              <th scope="col">Expires</th>
              <th scope="col">
                <span className="pb-sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {tokens.data.items.map((t) => (
              <tr key={t.id}>
                <th scope="row">
                  {t.name}
                  {t.state !== 'active' && (
                    <span className="badge badge--off">{t.state === 'revoked' ? 'Revoked' : 'Expired'}</span>
                  )}
                  <div className="muted small">
                    {t.mine ? 'yours' : t.owner_name} ·{' '}
                    {t.last_used_at ? `used ${relative(t.last_used_at).toLowerCase()}` : 'never used'}
                  </div>
                  {t.previous_valid_until && Date.parse(t.previous_valid_until) > Date.now() && (
                    <div className="small warn">
                      The previous secret works until {when(t.previous_valid_until)}
                    </div>
                  )}
                </th>
                <td>
                  <ul className="plain small">
                    {t.scopes.map((s) => (
                      <li key={s}>{SCOPE_LABELS[s]}</li>
                    ))}
                  </ul>
                </td>
                <td className="small">
                  {t.client_ids === null && t.profile_ids === null
                    ? 'Everything you can reach'
                    : [
                        t.client_ids ? plural(t.client_ids.length, 'client') : null,
                        t.profile_ids ? plural(t.profile_ids.length, 'profile') : null,
                      ]
                        .filter(Boolean)
                        .join(', ')}
                </td>
                <td className="small">{when(t.expires_at)}</td>
                <td>
                  {t.state === 'active' && !offline && (
                    <div className="cell-actions">
                      <button type="button" className="pb-button" onClick={() => setRotating(t)}>
                        Rotate…
                      </button>
                      <button type="button" className="pb-button" onClick={() => setRevoking(t)}>
                        Revoke…
                      </button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {creating && (
        <CreateTokenDialog
          {...props}
          onClose={(created) => {
            setCreating(false);
            if (created) {
              setSecret({ title: `Token “${created.name}” created`, value: created.secret });
              tokens.reload();
            }
          }}
        />
      )}
      {rotating && (
        <RotateDialog
          {...props}
          token={rotating}
          onClose={(value) => {
            const name = rotating.name;
            setRotating(null);
            if (value) {
              setSecret({ title: `New secret for “${name}”`, value });
              tokens.reload();
            }
          }}
        />
      )}
      {revoking && (
        <Dialog title={`Revoke “${revoking.name}”?`} role="alertdialog" onClose={() => setRevoking(null)}>
          <div className="stack">
            <p>
              Requests with this token stop working at once (its jobs that already run finish; new ones are
              refused). This cannot be undone.
            </p>
            <div className="row row--end">
              <button type="button" className="pb-button" onClick={() => setRevoking(null)}>
                Keep it
              </button>
              <button
                type="button"
                className="pb-button"
                data-variant="danger"
                onClick={async () => {
                  try {
                    await send(backend, 'DELETE', `/v1/orgs/${orgId}/api-tokens/${revoking.id}`);
                    notify(`Token “${revoking.name}” revoked.`);
                  } catch (e) {
                    notify(errorMessage(e), 'error');
                  }
                  setRevoking(null);
                  tokens.reload();
                }}
              >
                Revoke token
              </button>
            </div>
          </div>
        </Dialog>
      )}
      {secret && (
        <SecretDialog
          title={secret.title}
          secret={secret.value}
          help="Use it as a bearer token: Authorization: Bearer pbt_…. Keep it in a secret store, never in code or a webpage."
          notify={notify}
          onClose={() => setSecret(null)}
        />
      )}
    </section>
  );
}

function CreateTokenDialog(
  props: PanelProps & { onClose: (created: { name: string; secret: string } | null) => void },
) {
  const { backend, orgId, role, notify } = props;
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<ApiScope[]>(['automation:read']);
  const [limit, setLimit] = useState<'all' | 'some'>('all');
  const [clients, setClients] = useState<string[]>([]);
  const [profiles, setProfiles] = useState<string[]>([]);
  const [days, setDays] = useState(90);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const orgClients = useApi<Page<OrgClient>>(
    backend,
    limit === 'some' ? `/v1/orgs/${orgId}/clients` : null,
    notify,
  );
  const orgProfiles = useApi<Page<OrgProfile>>(
    backend,
    limit === 'some' ? `/v1/orgs/${orgId}/profiles` : null,
    notify,
    [['limit', '100']],
  );
  const nameId = useId();
  const toggle = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!name.trim()) return setError('Name the token.');
    if (scopes.length === 0) return setError('Choose at least one permission.');
    if (limit === 'some' && clients.length === 0 && profiles.length === 0)
      return setError('Choose the clients or profiles it may use, or allow everything you can reach.');
    setBusy(true);
    try {
      const r = await send<{ token: ApiToken; secret: string }>(
        backend,
        'POST',
        `/v1/orgs/${orgId}/api-tokens`,
        {
          name: name.trim(),
          scopes,
          expires_in_days: days,
          ...(limit === 'some' && clients.length ? { client_ids: clients } : {}),
          ...(limit === 'some' && profiles.length ? { profile_ids: profiles } : {}),
        },
      );
      props.onClose({ name: r.data.token.name, secret: r.data.secret });
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };
  return (
    <Dialog
      title="New API token"
      onClose={() => props.onClose(null)}
      initialFocus={`#${CSS.escape(nameId)}`}
      wide
    >
      <form className="stack" onSubmit={submit}>
        <label>
          Name
          <input
            id={nameId}
            value={name}
            maxLength={80}
            onChange={(e) => setName(e.target.value)}
            placeholder="Nightly checks"
          />
        </label>
        <fieldset>
          <legend>Permissions</legend>
          {API_SCOPES.map((s) => {
            const allowed = scopeAllowedForRole(role, s);
            return (
              <label key={s} className="choice">
                <input
                  type="checkbox"
                  checked={scopes.includes(s)}
                  disabled={!allowed}
                  onChange={() => setScopes(toggle(scopes, s))}
                />
                {SCOPE_LABELS[s]}
                {!allowed && <span className="muted small"> (your role does not allow it)</span>}
              </label>
            );
          })}
          {scopes.includes('automation:debug') && (
            <p className="muted small">
              Debugging sessions hand a profile’s whole session (sign-ins included) to a Playwright script,
              only on a computer whose owner allowed it. Give this to as few tokens as possible.
            </p>
          )}
        </fieldset>
        <fieldset>
          <legend>Profiles it may use</legend>
          <label className="choice">
            <input
              type="radio"
              name="token-limit"
              checked={limit === 'all'}
              onChange={() => setLimit('all')}
            />
            Every client and profile I can reach
          </label>
          <label className="choice">
            <input
              type="radio"
              name="token-limit"
              checked={limit === 'some'}
              onChange={() => setLimit('some')}
            />
            Only these clients or profiles
          </label>
          {limit === 'some' && (
            <div className="token-limits">
              <div>
                <p className="small">Clients</p>
                {(orgClients.data?.items ?? []).map((c) => (
                  <label key={c.id} className="choice">
                    <input
                      type="checkbox"
                      checked={clients.includes(c.id)}
                      onChange={() => setClients(toggle(clients, c.id))}
                    />
                    {c.name}
                  </label>
                ))}
              </div>
              <div>
                <p className="small">Profiles</p>
                {(orgProfiles.data?.items ?? []).map((p) => (
                  <label key={p.id} className="choice">
                    <input
                      type="checkbox"
                      checked={profiles.includes(p.id)}
                      onChange={() => setProfiles(toggle(profiles, p.id))}
                    />
                    {p.name}
                  </label>
                ))}
              </div>
            </div>
          )}
        </fieldset>
        <label>
          Expires after
          <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
            {[7, 30, 90, 180, 365].map((d) => (
              <option key={d} value={d}>
                {d} days
              </option>
            ))}
          </select>
        </label>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="row row--end">
          <button type="button" className="pb-button" onClick={() => props.onClose(null)}>
            Cancel
          </button>
          <button type="submit" className="pb-button" data-variant="primary" disabled={busy}>
            Create token
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function RotateDialog(props: PanelProps & { token: ApiToken; onClose: (secret: string | null) => void }) {
  const [grace, setGrace] = useState(60);
  const [busy, setBusy] = useState(false);
  return (
    <Dialog title={`Rotate “${props.token.name}”?`} onClose={() => props.onClose(null)}>
      <div className="stack">
        <p>A new secret is made. Update your scripts with it; the current one keeps working for a while.</p>
        <label>
          The current secret keeps working for
          <select value={grace} onChange={(e) => setGrace(Number(e.target.value))}>
            <option value={0}>No time (stops now)</option>
            <option value={60}>1 hour</option>
            <option value={1440}>24 hours</option>
          </select>
        </label>
        <div className="row row--end">
          <button type="button" className="pb-button" onClick={() => props.onClose(null)}>
            Cancel
          </button>
          <button
            type="button"
            className="pb-button"
            data-variant="primary"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                const r = await send<{ secret: string }>(
                  props.backend,
                  'POST',
                  `/v1/orgs/${props.orgId}/api-tokens/${props.token.id}/rotate`,
                  { grace_minutes: grace },
                );
                props.onClose(r.data.secret);
              } catch (e) {
                props.notify(errorMessage(e), 'error');
                props.onClose(null);
              }
            }}
          >
            Rotate
          </button>
        </div>
      </div>
    </Dialog>
  );
}

// ------------------------------------------------------------------------------------------------ webhooks
const EVENT_TEXT: Record<(typeof WEBHOOK_EVENTS)[number], string> = {
  'automation.job.queued': 'A job was queued',
  'automation.job.started': 'A job started',
  'automation.job.succeeded': 'A job succeeded',
  'automation.job.failed': 'A job failed',
  'automation.job.canceled': 'A job was canceled',
};
const URL_PROBLEM_TEXT: Record<string, string> = {
  scheme: 'Use an https:// address.',
  credentials: 'Leave user names and passwords out of the address.',
  fragment: 'Leave out the # part.',
  port: 'Use port 443 or a port from 1024 up.',
  blocked_address: 'Private, loopback and cloud-metadata addresses cannot receive webhooks.',
  blocked_name: 'Local names (localhost, .local, .internal) cannot receive webhooks.',
  host: 'Use a public host name.',
};

function WebhooksPanel(props: PanelProps) {
  const { backend, orgId, notify, offline } = props;
  const endpoints = useApi<Page<WebhookEndpoint>>(backend, `/v1/orgs/${orgId}/webhook-endpoints`, notify);
  const [editing, setEditing] = useState<WebhookEndpoint | 'new' | null>(null);
  const [secret, setSecret] = useState<{ title: string; value: string } | null>(null);
  const [deleting, setDeleting] = useState<WebhookEndpoint | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const act = async (fn: () => Promise<unknown>, done?: string) => {
    try {
      await fn();
      if (done) notify(done);
    } catch (e) {
      notify(errorMessage(e), 'error');
    }
    endpoints.reload();
  };
  return (
    <section className="stack" aria-labelledby="webhooks-title">
      <h3 id="webhooks-title">Webhooks</h3>
      <p className="muted small">
        Job events are sent to your HTTPS endpoint, signed (Standard Webhooks: webhook-id, webhook-timestamp,
        webhook-signature). Failed deliveries are retried for about a day, then kept as dead letters you can
        send again. An event can arrive more than once: use its webhook-id to ignore repeats. Private and
        internal addresses are refused, and redirects are not followed.
      </p>
      <div className="row">
        <button
          type="button"
          className="pb-button"
          data-variant="primary"
          disabled={offline}
          onClick={() => setEditing('new')}
        >
          New endpoint…
        </button>
      </div>
      {endpoints.data === null ? (
        <p role="status">Loading endpoints…</p>
      ) : endpoints.data.items.length === 0 ? (
        <p className="muted">No endpoints.</p>
      ) : (
        <table className="simple records">
          <caption className="pb-sr-only">Webhook endpoints</caption>
          <thead>
            <tr>
              <th scope="col">Endpoint</th>
              <th scope="col">Events</th>
              <th scope="col">Deliveries</th>
              <th scope="col">
                <span className="pb-sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {endpoints.data.items.map((w) => (
              <WebhookRow
                key={w.id}
                w={w}
                expanded={open === w.id}
                onToggle={() => setOpen(open === w.id ? null : w.id)}
                {...props}
                actions={
                  offline ? null : (
                    <div className="cell-actions">
                      <button
                        type="button"
                        className="pb-button"
                        onClick={() =>
                          act(
                            () =>
                              send(backend, 'POST', `/v1/orgs/${orgId}/webhook-endpoints/${w.id}/test`, {}),
                            'Test event sent.',
                          )
                        }
                      >
                        Send test
                      </button>
                      <button type="button" className="pb-button" onClick={() => setEditing(w)}>
                        Edit…
                      </button>
                      <button
                        type="button"
                        className="pb-button"
                        onClick={() =>
                          act(() =>
                            send(
                              backend,
                              'PATCH',
                              `/v1/orgs/${orgId}/webhook-endpoints/${w.id}`,
                              { state: w.state === 'active' ? 'disabled' : 'active' },
                              w.version,
                            ),
                          )
                        }
                      >
                        {w.state === 'active' ? 'Turn off' : 'Turn on'}
                      </button>
                      <button
                        type="button"
                        className="pb-button"
                        onClick={async () => {
                          try {
                            const r = await send<{ secret: string }>(
                              backend,
                              'POST',
                              `/v1/orgs/${orgId}/webhook-endpoints/${w.id}/rotate-secret`,
                              {},
                            );
                            setSecret({ title: 'New signing secret', value: r.data.secret });
                          } catch (e) {
                            notify(errorMessage(e), 'error');
                          }
                          endpoints.reload();
                        }}
                      >
                        Rotate secret
                      </button>
                      <button type="button" className="pb-button" onClick={() => setDeleting(w)}>
                        Delete…
                      </button>
                    </div>
                  )
                }
              />
            ))}
          </tbody>
        </table>
      )}
      {editing && (
        <WebhookDialog
          {...props}
          endpoint={editing === 'new' ? null : editing}
          onClose={(created) => {
            setEditing(null);
            if (created) setSecret({ title: 'Endpoint created', value: created });
            endpoints.reload();
          }}
        />
      )}
      {deleting && (
        <Dialog title="Delete this endpoint?" role="alertdialog" onClose={() => setDeleting(null)}>
          <div className="stack">
            <p className="mono">{deleting.url}</p>
            <p>Events stop being sent to it, and its deliveries are deleted.</p>
            <div className="row row--end">
              <button type="button" className="pb-button" onClick={() => setDeleting(null)}>
                Keep it
              </button>
              <button
                type="button"
                className="pb-button"
                data-variant="danger"
                onClick={() => {
                  const w = deleting;
                  setDeleting(null);
                  void act(
                    () => send(backend, 'DELETE', `/v1/orgs/${orgId}/webhook-endpoints/${w.id}`),
                    'Endpoint deleted.',
                  );
                }}
              >
                Delete endpoint
              </button>
            </div>
          </div>
        </Dialog>
      )}
      {secret && (
        <SecretDialog
          title={secret.title}
          secret={secret.value}
          help="Verify each delivery’s signature with it (the SDK’s verifyWebhook does this) and refuse old timestamps. After a rotation, deliveries carry both signatures for an hour, so receivers can switch over."
          notify={notify}
          onClose={() => setSecret(null)}
        />
      )}
    </section>
  );
}

function WebhookRow(
  props: PanelProps & { w: WebhookEndpoint; expanded: boolean; onToggle: () => void; actions: ReactNode },
) {
  const { w } = props;
  const id = useId();
  return (
    <>
      <tr>
        <th scope="row">
          <span className="mono">{w.url}</span>
          {w.state === 'disabled' && (
            <span className="badge badge--warning">
              {w.disabled_reason === 'failing' ? 'Turned off: kept failing' : 'Turned off'}
            </span>
          )}
          {w.description && <div className="muted small">{w.description}</div>}
        </th>
        <td className="small">{w.events.map((e) => EVENT_TEXT[e]).join(', ')}</td>
        <td className="small">
          {w.last_success_at
            ? `last delivered ${relative(w.last_success_at).toLowerCase()}`
            : 'nothing delivered yet'}
          {w.pending_deliveries > 0 && (
            <div>{plural(w.pending_deliveries, 'delivery', 'deliveries')} waiting</div>
          )}
          {w.dead_deliveries > 0 && <div className="warn">{plural(w.dead_deliveries, 'dead letter')}</div>}
          <button
            type="button"
            className="pb-button"
            aria-expanded={props.expanded}
            aria-controls={id}
            onClick={props.onToggle}
          >
            {props.expanded ? 'Hide deliveries' : 'Deliveries'}
          </button>
        </td>
        <td>{props.actions}</td>
      </tr>
      {props.expanded && (
        <tr id={id}>
          <td colSpan={4}>
            <Deliveries {...props} endpointId={w.id} />
          </td>
        </tr>
      )}
    </>
  );
}

const DELIVERY_ERROR_TEXT: Record<string, string> = {
  timeout: 'no answer in 10 s',
  connection: 'could not connect',
  tls: 'certificate problem',
  status_4xx: 'refused (4xx)',
  status_5xx: 'server error (5xx)',
  redirect: 'answered with a redirect (not followed)',
  blocked_destination: 'address not allowed',
  dns: 'host name not found',
};

function Deliveries(props: PanelProps & { endpointId: string }) {
  const { backend, orgId, notify, offline } = props;
  const [state, setState] = useState<'' | 'pending' | 'delivered' | 'dead'>('');
  const query = useMemo<[string, string][]>(() => (state ? [['state', state]] : []), [state]);
  const list = useApi<Page<WebhookDelivery>>(
    backend,
    `/v1/orgs/${orgId}/webhook-endpoints/${props.endpointId}/deliveries`,
    notify,
    query,
  );
  return (
    <div className="stack">
      <label>
        Show
        <select value={state} onChange={(e) => setState(e.target.value as typeof state)}>
          <option value="">All deliveries</option>
          <option value="pending">Waiting</option>
          <option value="delivered">Delivered</option>
          <option value="dead">Dead letters</option>
        </select>
      </label>
      {list.data === null ? (
        <p role="status">Loading deliveries…</p>
      ) : list.data.items.length === 0 ? (
        <p className="muted small">None.</p>
      ) : (
        <ul className="plain small deliveries">
          {list.data.items.map((d) => (
            <li key={d.id}>
              <span
                className={
                  d.state === 'delivered'
                    ? 'badge badge--ok'
                    : d.state === 'dead'
                      ? 'badge badge--problem'
                      : 'badge'
                }
              >
                {d.state === 'dead' ? 'Dead letter' : d.state === 'pending' ? 'Waiting' : 'Delivered'}
              </span>{' '}
              {d.event_type} · {plural(d.attempts, 'attempt')}
              {d.last_status ? ` · HTTP ${d.last_status}` : ''}
              {d.last_error ? ` · ${DELIVERY_ERROR_TEXT[d.last_error] ?? d.last_error}` : ''} ·{' '}
              {relative(d.created_at)}
              <span className="muted mono"> {d.event_id}</span>
              {d.state === 'dead' && !offline && (
                <button
                  type="button"
                  className="pb-button"
                  onClick={async () => {
                    try {
                      await send(
                        backend,
                        'POST',
                        `/v1/orgs/${orgId}/webhook-endpoints/${props.endpointId}/deliveries/${d.id}/redeliver`,
                        {},
                      );
                      notify('Sending it again.');
                    } catch (e) {
                      notify(errorMessage(e), 'error');
                    }
                    list.reload();
                  }}
                >
                  Send again
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function WebhookDialog(
  props: PanelProps & { endpoint: WebhookEndpoint | null; onClose: (secret: string | null) => void },
) {
  const { backend, orgId, endpoint } = props;
  const [url, setUrl] = useState(endpoint?.url ?? 'https://');
  const [description, setDescription] = useState(endpoint?.description ?? '');
  const [events, setEvents] = useState<WebhookEndpoint['events']>(
    endpoint?.events ?? ['automation.job.succeeded', 'automation.job.failed'],
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const urlId = useId();
  const problem = url.length > 8 ? webhookUrlProblem(url.trim()) : null;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const p = webhookUrlProblem(url.trim());
    if (p) return setError(URL_PROBLEM_TEXT[p] ?? 'This address cannot receive webhooks.');
    if (events.length === 0) return setError('Choose at least one event.');
    setBusy(true);
    try {
      if (endpoint) {
        await send(
          backend,
          'PATCH',
          `/v1/orgs/${orgId}/webhook-endpoints/${endpoint.id}`,
          { url: url.trim(), description, events },
          endpoint.version,
        );
        props.onClose(null);
      } else {
        const r = await send<{ secret: string }>(backend, 'POST', `/v1/orgs/${orgId}/webhook-endpoints`, {
          url: url.trim(),
          description,
          events,
        });
        props.onClose(r.data.secret);
      }
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };
  return (
    <Dialog
      title={endpoint ? 'Edit endpoint' : 'New webhook endpoint'}
      onClose={() => props.onClose(null)}
      initialFocus={`#${CSS.escape(urlId)}`}
      wide
    >
      <form className="stack" onSubmit={submit}>
        <label>
          Address (https)
          <input
            id={urlId}
            className="mono"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            aria-invalid={problem ? true : undefined}
            aria-describedby={problem ? `${urlId}-problem` : undefined}
          />
        </label>
        {problem && (
          <p id={`${urlId}-problem`} className="small warn">
            {URL_PROBLEM_TEXT[problem] ?? 'This address cannot receive webhooks.'}
          </p>
        )}
        <label>
          Description
          <input value={description} maxLength={200} onChange={(e) => setDescription(e.target.value)} />
        </label>
        <fieldset>
          <legend>Events</legend>
          {WEBHOOK_EVENTS.map((ev) => (
            <label key={ev} className="choice">
              <input
                type="checkbox"
                checked={events.includes(ev)}
                onChange={() =>
                  setEvents(events.includes(ev) ? events.filter((x) => x !== ev) : [...events, ev])
                }
              />
              {EVENT_TEXT[ev]} <span className="muted mono small">{ev}</span>
            </label>
          ))}
        </fieldset>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="row row--end">
          <button type="button" className="pb-button" onClick={() => props.onClose(null)}>
            Cancel
          </button>
          <button type="submit" className="pb-button" data-variant="primary" disabled={busy}>
            {endpoint ? 'Save' : 'Create endpoint'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

// ------------------------------------------------------------------------------------------------ approved sites
function SitesPanel(props: PanelProps) {
  const { backend, orgId, role, notify, offline } = props;
  const settings = useApi<AutomationSettings>(backend, `/v1/orgs/${orgId}/automation/settings`, notify);
  const manage = can(role, 'automation.manage') && !offline;
  const [draft, setDraft] = useState<string | null>(null);
  const [max, setMax] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const areaId = useId();
  if (!settings.data) return <p role="status">Loading approved sites…</p>;
  const s = settings.data;
  const text = draft ?? s.allowed_origins.join('\n');
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const bad = lines.filter((l) => parseOriginPattern(l) === null);
  const save = async () => {
    setError(null);
    if (bad.length) return setError(`Not an approved-site pattern: ${bad.join(', ')}`);
    if (lines.length > ORIGIN_PATTERN_MAX) return setError(`At most ${ORIGIN_PATTERN_MAX} sites.`);
    try {
      await send(
        backend,
        'PUT',
        `/v1/orgs/${orgId}/automation/settings`,
        { allowed_origins: lines, max_running_jobs: max ?? s.max_running_jobs },
        s.version,
      );
      setDraft(null);
      setMax(null);
      notify('Approved sites saved. Queued jobs are checked again when a computer takes them.');
    } catch (e) {
      setError(errorMessage(e));
    }
    settings.reload();
  };
  return (
    <section className="stack" aria-labelledby="sites-title">
      <h3 id="sites-title">Approved sites</h3>
      <p className="muted small">
        Jobs open only these sites, and stop if a page goes anywhere else. One per line:
        https://app.example.com, https://*.example.com (any subdomain), or http://localhost:3000 for a test
        site on the computer itself. Use sites you own or are authorized to test.
      </p>
      <label htmlFor={areaId}>Sites</label>
      <textarea
        id={areaId}
        rows={Math.min(12, Math.max(4, lines.length + 1))}
        className="mono"
        value={text}
        readOnly={!manage}
        onChange={(e) => setDraft(e.target.value)}
        aria-invalid={bad.length ? true : undefined}
      />
      {bad.length > 0 && <p className="small warn">Not a site pattern: {bad.join(', ')}</p>}
      <label>
        Jobs running at the same time (all computers together)
        <input
          type="number"
          min={1}
          max={50}
          value={max ?? s.max_running_jobs}
          readOnly={!manage}
          onChange={(e) => setMax(Number(e.target.value))}
        />
      </label>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {manage && (
        <div className="row">
          <button
            type="button"
            className="pb-button"
            data-variant="primary"
            disabled={draft === null && max === null}
            onClick={save}
          >
            Save
          </button>
        </div>
      )}
      <p className="muted small">
        Version {s.version}
        {s.updated_at ? `, changed ${relative(s.updated_at).toLowerCase()}` : ''}.
      </p>
    </section>
  );
}

// ================================================================================================ this computer
interface OrgEntry {
  kind: string;
  org_id?: string;
  name: string;
  role?: Role;
}

const RUN_STATE_TEXT: Record<AutomationRun['state'], string> = {
  opening: 'Opening the profile',
  running: 'Running',
  holding: 'Holding the profile open',
  closing: 'Closing the profile',
  done: 'Finished',
};

/** Settings → Automation on this computer. */
export function ThisComputerAutomation(props: { backend: Backend; notify: Notify; signedIn: boolean }) {
  const { backend, notify, signedIn } = props;
  const [st, setSt] = useState<AutomationStatus | null>(null);
  const [orgs, setOrgs] = useState<OrgEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [confirmDebug, setConfirmDebug] = useState(false);
  const load = useCallback(() => {
    backend.automation
      .status()
      .then(setSt)
      .catch((e) => notify(errorMessage(e), 'error'));
  }, [backend, notify]);
  useEffect(load, [load]);
  useEffect(() => backend.on('automation', () => load()), [backend, load]);
  useEffect(() => {
    const running = (st?.running.length ?? 0) > 0;
    if (!running) return;
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [st, load]);
  useEffect(() => {
    if (!signedIn) return;
    get<{ items: OrgEntry[] }>(backend, '/v1/me/workspaces')
      .then((r) => setOrgs(r.data.items.filter((w) => w.kind === 'organization' && w.org_id)))
      .catch(() => setOrgs([]));
  }, [backend, signedIn]);
  const act = async (fn: () => Promise<AutomationStatus>, done?: string) => {
    setBusy(true);
    try {
      setSt(await fn());
      if (done) notify(done);
    } catch (e) {
      notify(errorMessage(e), 'error');
    } finally {
      setBusy(false);
    }
  };
  if (!st) return <p role="status">Loading…</p>;
  const nameOf = (id: string) => orgs.find((o) => o.org_id === id)?.name ?? id;
  const eligible = orgs.filter((o) => o.role && can(o.role, 'automation.agent'));
  return (
    <fieldset className="automation-here">
      <legend>Automation on this computer</legend>
      <p className="muted small">
        When this computer is enrolled, it asks the organization for jobs every few seconds (it never opens a
        port for them) and runs them as you: only profiles you may open, only on approved sites. Profiles
        opened by a job say they are automated, and websites can tell. A job never opens a profile that
        someone has open.
      </p>
      {!signedIn ? (
        <p className="muted">Sign in to an organization (Account) to run its jobs here.</p>
      ) : eligible.length === 0 ? (
        <p className="muted">Your role in your organizations does not include running automation jobs.</p>
      ) : (
        <table className="simple records">
          <caption className="pb-sr-only">Organizations</caption>
          <thead>
            <tr>
              <th scope="col">Organization</th>
              <th scope="col">On this computer</th>
              <th scope="col">
                <span className="pb-sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {eligible.map((o) => (
              <EnrollRow
                key={o.org_id}
                org={o}
                enrollment={st.enrollments.find((e) => e.org_id === o.org_id) ?? null}
                busy={busy}
                onEnroll={(accepts, maxJobs) =>
                  act(
                    () => backend.automation.enroll(o.org_id ?? '', accepts, maxJobs),
                    `This computer now runs ${o.name}’s jobs.`,
                  )
                }
                onLeave={() =>
                  act(
                    () => backend.automation.unenroll(o.org_id ?? ''),
                    `This computer no longer runs ${o.name}’s jobs.`,
                  )
                }
              />
            ))}
          </tbody>
        </table>
      )}

      <label className="choice">
        <input
          type="checkbox"
          checked={st.allow_debugging}
          disabled={busy}
          onChange={(e) =>
            e.target.checked
              ? setConfirmDebug(true)
              : void act(() => backend.automation.setDebugging(false), 'Playwright connections turned off.')
          }
        />
        Allow Playwright connections
      </label>
      <p className="muted small">
        Off by default. When on, an owner’s or admin’s debugging job can hand a profile’s session to a
        Playwright script running on this computer, through a local address that only accepts the job’s own
        secret and no web page. Turning it off ends open debugging sessions.
      </p>
      {confirmDebug && (
        <Dialog
          title="Allow Playwright connections?"
          role="alertdialog"
          onClose={() => setConfirmDebug(false)}
        >
          <div className="stack">
            <p>
              A script connected this way controls the whole browser session of the job’s profile, including
              its sign-ins. Allow it only on a computer you use for authorized testing.
            </p>
            <div className="row row--end">
              <button type="button" className="pb-button" onClick={() => setConfirmDebug(false)}>
                Keep it off
              </button>
              <button
                type="button"
                className="pb-button"
                data-variant="danger"
                onClick={() => {
                  setConfirmDebug(false);
                  void act(
                    () => backend.automation.setDebugging(true),
                    'Playwright connections allowed on this computer.',
                  );
                }}
              >
                Allow
              </button>
            </div>
          </div>
        </Dialog>
      )}

      <h3 className="small">Jobs on this computer</h3>
      {st.runs.length === 0 ? (
        <p className="muted small">None yet.</p>
      ) : (
        <ul className="plain runs">
          {st.runs.map((r) => (
            <li key={r.job_id}>
              <strong>{r.label ?? 'Job'}</strong> <span className="muted small">({nameOf(r.org_id)})</span>{' '}
              <span
                className={
                  r.state === 'done'
                    ? r.outcome === 'SUCCEEDED'
                      ? 'badge badge--ok'
                      : 'badge badge--off'
                    : 'badge'
                }
              >
                {r.state === 'done'
                  ? r.outcome
                    ? JOB_STATE_TEXT[r.outcome]
                    : 'Ended'
                  : RUN_STATE_TEXT[r.state]}
              </span>
              <div className="muted small">
                {r.steps_done} of {r.steps_total} steps · {relative(r.updated_at)}
                {r.error_code ? ` · ${JOB_ERROR_TEXT[r.error_code] ?? r.error_code}` : ''}
              </div>
              {r.debug_endpoint && (
                <div className="small">
                  Playwright address: <span className="mono">{r.debug_endpoint}</span>
                </div>
              )}
              {r.state !== 'done' && (
                <button
                  type="button"
                  className="pb-button"
                  disabled={busy}
                  onClick={() =>
                    act(
                      () => backend.automation.stopJob(r.job_id),
                      'Stopping the job: the profile closes as usual.',
                    )
                  }
                >
                  Stop this job
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </fieldset>
  );
}

function EnrollRow(props: {
  org: OrgEntry;
  enrollment: AutomationStatus['enrollments'][number] | null;
  busy: boolean;
  onEnroll: (accepts: 'mine' | 'org', maxJobs: number) => void;
  onLeave: () => void;
}) {
  const e = props.enrollment;
  const [accepts, setAccepts] = useState<'mine' | 'org'>(e?.accepts ?? 'mine');
  const [maxJobs, setMaxJobs] = useState(e?.max_jobs ?? 1);
  const id = useId();
  return (
    <tr>
      <th scope="row">{props.org.name}</th>
      <td>
        {e ? (
          <>
            <span className={e.poll_error ? 'badge badge--warning' : 'badge badge--ok'}>
              {e.poll_error
                ? 'Cannot reach the organization'
                : e.enabled === false
                  ? 'Turned off by an admin'
                  : 'Taking jobs'}
            </span>
            <div className="muted small">
              {e.accepts === 'org' ? 'Anyone’s jobs' : 'Only my jobs'} · up to {e.max_jobs} at a time
              {e.running ? ` · ${plural(e.running, 'job')} running` : ''}
            </div>
          </>
        ) : (
          <div className="row">
            <label htmlFor={`${id}-a`} className="pb-sr-only">
              Whose jobs
            </label>
            <select
              id={`${id}-a`}
              value={accepts}
              onChange={(ev) => setAccepts(ev.target.value as 'mine' | 'org')}
            >
              <option value="mine">Only my jobs</option>
              <option value="org">Anyone’s jobs in the organization</option>
            </select>
            <label htmlFor={`${id}-m`} className="pb-sr-only">
              Jobs at a time
            </label>
            <select id={`${id}-m`} value={maxJobs} onChange={(ev) => setMaxJobs(Number(ev.target.value))}>
              {[1, 2, 3, 5].map((n) => (
                <option key={n} value={n}>
                  {plural(n, 'job')} at a time
                </option>
              ))}
            </select>
          </div>
        )}
      </td>
      <td>
        {e ? (
          <button type="button" className="pb-button" disabled={props.busy} onClick={props.onLeave}>
            Stop taking jobs
          </button>
        ) : (
          <button
            type="button"
            className="pb-button"
            disabled={props.busy}
            onClick={() => props.onEnroll(accepts, maxJobs)}
          >
            Run jobs here
          </button>
        )}
      </td>
    </tr>
  );
}
