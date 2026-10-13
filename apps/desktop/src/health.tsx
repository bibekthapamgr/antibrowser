/**
 * Health (milestone 09): what is working on this computer right now, each result with the time it was checked and
 * a button to check again; what open profiles use (browser trees per profile, the manager apart); the extensions in
 * each profile and how the organization's policy judges them; and the diagnostics report.
 *
 * Health describes this computer, the server connection, proxies, the browser, backups, sessions and extensions. It
 * never says anything about website accounts: whether a site restricts an account is not something the app can know.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  Backend,
  ExtensionsView,
  ExtensionVerdict,
  HealthCard,
  HealthView,
  ResourcesView,
} from './backend/types.ts';
import { errorMessage } from './backend/types.ts';
import { formatBytes } from './components.tsx';
import { DiagnosticsScreen } from './screens.tsx';
import { type Notify, plural, relative, when } from './status.tsx';

export type HealthTab = 'health' | 'resources' | 'extensions' | 'diagnostics';
const TABS: [HealthTab, string][] = [
  ['health', 'Health'],
  ['resources', 'Resources'],
  ['extensions', 'Extensions'],
  ['diagnostics', 'Diagnostics'],
];

/** Text, not colour alone, says what a status means. */
export const STATUS_LABEL: Record<HealthCard['status'], string> = {
  ok: 'OK',
  warning: 'Needs attention',
  problem: 'Problem',
  unknown: 'Unknown',
  off: 'Not used',
};
const STATUS_MARK: Record<HealthCard['status'], string> = {
  ok: '✓',
  warning: '!',
  problem: '✕',
  unknown: '?',
  off: '–',
};

export function StatusBadge({ status }: { status: HealthCard['status'] }) {
  return (
    <span className={`badge badge--${status}`}>
      <span aria-hidden="true">{STATUS_MARK[status]}</span> {STATUS_LABEL[status]}
    </span>
  );
}

export function HealthScreen(props: {
  backend: Backend;
  notify: Notify;
  refreshKey: number;
  tab: HealthTab;
  onTab: (t: HealthTab) => void;
  onNavigate: (view: 'profiles' | 'downloads' | 'proxies') => void;
}) {
  const { backend, notify, tab } = props;
  return (
    <section className="screen" aria-labelledby="health-title">
      <header className="toolbar">
        <div className="toolbar__title">
          <h1 id="health-title">Health</h1>
          <p className="muted small">
            This computer, the server, proxies, the browser, backups and extensions — with when each was
            checked.
          </p>
        </div>
      </header>
      <nav aria-label="Health sections" className="org-nav">
        {TABS.map(([id, label]) => (
          <button
            key={id}
            type="button"
            className="pb-button"
            aria-current={tab === id ? 'page' : undefined}
            onClick={() => props.onTab(id)}
          >
            {label}
          </button>
        ))}
      </nav>
      {tab === 'health' && (
        <HealthCards
          backend={backend}
          notify={notify}
          refreshKey={props.refreshKey}
          onTab={props.onTab}
          onNavigate={props.onNavigate}
        />
      )}
      {tab === 'resources' && (
        <ResourcesPanel backend={backend} notify={notify} refreshKey={props.refreshKey} />
      )}
      {tab === 'extensions' && (
        <ExtensionsPanel backend={backend} notify={notify} refreshKey={props.refreshKey} />
      )}
      {tab === 'diagnostics' && <DiagnosticsScreen backend={backend} notify={notify} />}
    </section>
  );
}

const ACTION_LABEL: Record<NonNullable<HealthCard['action']>, string> = {
  retry_server: 'Check again',
  check_proxies: 'Check all proxies',
  rescan_extensions: 'Check extensions',
  open_extensions: 'Show extensions',
  open_backups: 'Show profiles',
  open_runtime: 'Open downloads and updates',
  open_sessions: 'Show profiles',
  open_resources: 'Show resources',
};

function HealthCards(props: {
  backend: Backend;
  notify: Notify;
  refreshKey: number;
  onTab: (t: HealthTab) => void;
  onNavigate: (view: 'profiles' | 'downloads' | 'proxies') => void;
}) {
  const { backend, notify } = props;
  const [health, setHealth] = useState<HealthView | null>(null);
  const [running, setRunning] = useState<string | null>(null);
  const autoChecked = useRef(false);

  const load = useCallback(async () => {
    try {
      setHealth(await backend.agency.health());
    } catch (e) {
      notify(errorMessage(e, 'Health could not be loaded.'), 'error');
    }
  }, [backend, notify]);
  const check = useCallback(
    async (kind: 'server' | 'proxies' | 'extensions') => {
      setRunning(kind);
      try {
        setHealth(await backend.agency.runCheck(kind));
      } catch (e) {
        notify(errorMessage(e, 'The check could not run.'), 'error');
      } finally {
        setRunning(null);
      }
    },
    [backend, notify],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey reloads after app events
  useEffect(() => {
    void load();
  }, [load, props.refreshKey]);

  // A server result that is missing or no longer current is checked once when the page opens.
  useEffect(() => {
    const server = health?.cards.find((c) => c.id === 'connectivity');
    if (!autoChecked.current && server && server.status === 'unknown') {
      autoChecked.current = true;
      void check('server');
    }
  }, [health, check]);

  if (!health) return <p role="status">Checking…</p>;
  const act = (a: NonNullable<HealthCard['action']>) => {
    if (a === 'retry_server') return check('server');
    if (a === 'check_proxies') return check('proxies');
    if (a === 'rescan_extensions') return check('extensions');
    if (a === 'open_extensions') return props.onTab('extensions');
    if (a === 'open_resources') return props.onTab('resources');
    if (a === 'open_runtime') return props.onNavigate('downloads');
    return props.onNavigate('profiles');
  };
  const busyFor = (a: HealthCard['action']) =>
    (a === 'retry_server' && running === 'server') ||
    (a === 'check_proxies' && running === 'proxies') ||
    (a === 'rescan_extensions' && running === 'extensions');
  const attention = health.cards.filter((c) => c.status === 'warning' || c.status === 'problem').length;
  return (
    <div className="stack">
      <p className="small" role="status">
        {attention === 0 ? 'Nothing needs attention.' : `${plural(attention, 'area')} need attention.`}{' '}
        <span className="muted">Updated {when(health.generated_at)}.</span>
      </p>
      <ul className="health-grid" aria-label="Health checks">
        {health.cards.map((c) => (
          <li key={c.id}>
            <article className={`health-card health-card--${c.status}`} aria-labelledby={`hc-${c.id}`}>
              <header className="row">
                <h2 id={`hc-${c.id}`} className="grow">
                  {c.title}
                </h2>
                <StatusBadge status={c.status} />
              </header>
              <p>{c.summary}</p>
              <p className="muted small">
                {c.checked_at
                  ? `Checked ${relative(c.checked_at).toLowerCase()} (${when(c.checked_at)})`
                  : 'Never checked'}
                {c.valid_until ? ` · counts until ${when(c.valid_until)}` : ''}
              </p>
              {c.items.length > 0 && (
                <ul className="health-items">
                  {c.items.slice(0, 8).map((i) => (
                    <li key={`${i.label}-${i.detail}`}>
                      <strong>{i.label}</strong> — <StatusBadge status={i.status} /> {i.detail}
                      {i.checked_at && <span className="muted small"> ({relative(i.checked_at)})</span>}
                    </li>
                  ))}
                  {c.items.length > 8 && <li className="muted small">and {c.items.length - 8} more</li>}
                </ul>
              )}
              {c.action && (
                <button
                  type="button"
                  className="pb-button"
                  disabled={busyFor(c.action) || running !== null}
                  onClick={() => void act(c.action as NonNullable<HealthCard['action']>)}
                >
                  {busyFor(c.action) ? 'Checking…' : ACTION_LABEL[c.action]}
                  <span className="pb-sr-only"> ({c.title})</span>
                </button>
              )}
            </article>
          </li>
        ))}
      </ul>
    </div>
  );
}

const duration = (s: number) =>
  s < 3600 ? `${Math.max(1, Math.round(s / 60))} min` : `${(s / 3600).toFixed(s < 36_000 ? 1 : 0)} h`;

function ResourcesPanel(props: { backend: Backend; notify: Notify; refreshKey: number }) {
  const { backend, notify } = props;
  const [r, setR] = useState<ResourcesView | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey reloads after app events
  useEffect(() => {
    let live = true;
    const load = () =>
      backend.agency
        .resources()
        .then((x) => live && setR(x))
        .catch((e) => live && notify(errorMessage(e), 'error'));
    void load();
    const t = setInterval(load, 5000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [backend, notify, props.refreshKey]);
  if (!r) return <p role="status">Measuring…</p>;
  return (
    <div className="stack">
      <p className="small">
        Memory available: <strong>{formatBytes(r.available_memory_bytes)}</strong> of{' '}
        {formatBytes(r.total_memory_bytes)}. Open profiles use {formatBytes(r.browsers_memory_bytes)}{' '}
        together; the manager uses {formatBytes(r.manager.memory_bytes)} (
        {plural(r.manager.processes, 'process', 'processes')}
        ), counted separately.
      </p>
      <p className="muted small">
        A profile usually needs about {formatBytes(r.estimate.per_profile_bytes)}{' '}
        {r.estimate.source === 'measured'
          ? `(the middle of ${plural(r.estimate.samples, 'measurement')} on this computer)`
          : '(nothing measured on this computer yet)'}
        . Real use depends on the sites that are open. Only browsers this app opened are counted; memory
        shared between a browser's processes is counted in each of them.
      </p>
      {r.profiles.length === 0 ? (
        <p className="muted">No profiles are open.</p>
      ) : (
        <table className="simple records">
          <caption className="pb-sr-only">Open profiles and their resource use</caption>
          <thead>
            <tr>
              <th scope="col">Profile</th>
              <th scope="col">Client</th>
              <th scope="col">Processes</th>
              <th scope="col">Memory</th>
              <th scope="col">Open for</th>
            </tr>
          </thead>
          <tbody>
            {r.profiles.map((p) => (
              <tr key={p.profile_id}>
                <th scope="row">{p.name}</th>
                <td>{p.client_name ?? <span className="muted">No client</span>}</td>
                <td>{p.processes}</td>
                <td>{formatBytes(p.memory_bytes)}</td>
                <td>{duration(p.open_seconds)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="muted small">Measured {when(r.measured_at)}; updates every 5 seconds.</p>
    </div>
  );
}

const SOURCE_LABEL: Record<string, string> = {
  web_store: 'Chrome Web Store',
  policy: 'Installed by a policy on this computer',
  external: 'Installed by another program',
  unpacked: 'Loaded from a folder (developer mode)',
  other: 'Other',
};

export function verdictText(v: ExtensionVerdict): string {
  switch (v.status) {
    case 'approved':
      return 'Approved';
    case 'blocked':
      return 'Blocked by your organization';
    case 'not_listed':
      return 'Not on your organization’s list';
    case 'source_not_allowed':
      return 'Only allowed from the Chrome Web Store';
    case 'version_not_approved':
      return `Version ${v.version} is not approved yet`;
    case 'permissions_need_review':
      return `Asks for more access than approved: ${v.permissions.join(', ')}`;
  }
}

const MODE_TEXT: Record<string, string> = {
  local: 'Your own profile: you decide; updates that ask for more access are shown for review.',
  unknown: 'Your organization’s policy has not been downloaded yet.',
  off: 'Your organization lists extensions but does not restrict them.',
  warn: 'Your organization warns about extensions it has not approved.',
  enforce:
    'Your organization requires approved extensions: if one is not approved, the profile opens with extensions turned off.',
};

export function ExtensionsPanel(props: { backend: Backend; notify: Notify; refreshKey: number }) {
  const { backend, notify } = props;
  const [v, setV] = useState<ExtensionsView | null>(null);
  const [busy, setBusy] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey reloads after app events
  useEffect(() => {
    backend.agency
      .extensions()
      .then(setV)
      .catch((e) => notify(errorMessage(e), 'error'));
  }, [backend, notify, props.refreshKey]);
  if (!v) return <p role="status">Loading extensions…</p>;
  return (
    <div className="stack">
      <div className="row">
        <p className="muted small grow">
          Read from each profile's own browser files when it opens and closes. The app never installs, removes
          or loads extensions, and never bypasses the browser's own checks; each profile keeps its extensions
          and their data separate.
        </p>
        <button
          type="button"
          className="pb-button"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              setV(await backend.agency.rescanExtensions());
              notify('Extensions checked again.');
            } catch (e) {
              notify(errorMessage(e), 'error');
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? 'Checking…' : 'Check again'}
        </button>
      </div>
      {v.profiles.length === 0 && (
        <p className="muted">No extensions found in profiles on this computer yet.</p>
      )}
      {v.profiles.map((p) => (
        <section key={p.profile_id} className="card" aria-labelledby={`ext-${p.profile_id}`}>
          <header className="row">
            <h2 id={`ext-${p.profile_id}`} className="grow">
              {p.name}
              {p.client_name && <span className="muted"> · {p.client_name}</span>}
            </h2>
            {p.needs_attention > 0 && <StatusBadge status={p.will_disable ? 'problem' : 'warning'} />}
          </header>
          <p className="small">{MODE_TEXT[p.mode]}</p>
          {p.will_disable && (
            <p className="notice notice--error small">
              Extensions will be turned off the next time this profile opens, until your organization approves
              them.
            </p>
          )}
          <p className="muted small">
            {p.scanned_at ? `Read ${relative(p.scanned_at).toLowerCase()}` : 'Not read yet'}
            {p.scan_status === 'unreadable' ? ' — the browser’s settings file could not be read' : ''}
            {p.org_id
              ? p.reported_at
                ? ` · reported to your organization ${relative(p.reported_at).toLowerCase()}`
                : ' · not reported yet'
              : ''}
          </p>
          {p.extensions.length === 0 ? (
            <p className="muted small">No extensions.</p>
          ) : (
            <ul className="ext-list">
              {p.extensions.map((e) => (
                <li key={e.id}>
                  <strong>{e.name}</strong> {e.version}
                  {e.previous_version && e.previous_version !== e.version && (
                    <span className="muted"> (updated from {e.previous_version})</span>
                  )}
                  {!e.enabled && <span className="muted"> · turned off in the browser</span>}
                  <div className="muted small">
                    {SOURCE_LABEL[e.source] ?? e.source}
                    {e.sensitive.length > 0 && <> · can access: {e.sensitive.join(', ')}</>}
                  </div>
                  {e.verdict && p.mode !== 'off' && (
                    <div className={e.verdict.status === 'approved' ? 'ok small' : 'warn small'}>
                      {verdictText(e.verdict)}
                    </div>
                  )}
                  {p.mode === 'local' && e.added_sensitive.length > 0 && (
                    <div className="row small">
                      <span className="warn grow">
                        Its last update asks for more access: {e.added_sensitive.join(', ')}.
                      </span>
                      <button
                        type="button"
                        className="pb-button"
                        onClick={async () => {
                          try {
                            const next = await backend.agency.reviewExtension(p.profile_id, e.id);
                            setV((cur) =>
                              cur
                                ? {
                                    ...cur,
                                    profiles: cur.profiles.map((x) =>
                                      x.profile_id === p.profile_id ? (next.profiles[0] ?? x) : x,
                                    ),
                                  }
                                : cur,
                            );
                            notify(`${e.name}: marked as reviewed.`);
                          } catch (err) {
                            notify(errorMessage(err), 'error');
                          }
                        }}
                      >
                        Mark as reviewed<span className="pb-sr-only"> ({e.name})</span>
                      </button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      ))}
      {v.policies.length > 0 && (
        <p className="muted small">
          Organization policies:{' '}
          {v.policies
            .map(
              (x) =>
                `${x.mode} mode, ${plural(x.rules, 'rule')}, downloaded ${relative(x.fetched_at).toLowerCase()}`,
            )
            .join('; ')}
          .
        </p>
      )}
    </div>
  );
}
