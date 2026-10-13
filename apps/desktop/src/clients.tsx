/**
 * Client workspaces (milestone 09).
 *
 * - Local: an overview of one client's profiles on this computer, what the app did with them recently and where
 *   their downloads go.
 * - Organization: the client dashboard from the server (counts never include profiles the member cannot see), with
 *   tasks and shared bookmarks. A task is an app record: ticking it off says nothing about what happened on a site.
 *
 * "Recent activity" is what the app did (opened, closed, backed up, changed settings), never website activity.
 */
import {
  BOOKMARKS_PER_CLIENT,
  type Bookmark,
  bookmarkUrlProblem,
  type ClientDashboard,
  type ClientTask,
} from '@pb/contracts/agency';
import type { Member, Role } from '@pb/contracts/resources';
import { type FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import type { Backend, ClientOverview } from './backend/types.ts';
import { errorMessage } from './backend/types.ts';
import { can, get, send } from './cloud.ts';
import { Dialog } from './components.tsx';
import { day, type Notify, plural, relative, when } from './status.tsx';

// ----------------------------------------------------------------------------- local overview

const LOCAL_ACTION: Record<string, string> = {
  start: 'Opened',
  stop: 'Closed',
  exit: 'Closed',
  crash: 'Closed unexpectedly',
  backup: 'Safety copy',
  sync: 'Organization backup',
  team: 'Shared session',
  extension: 'Extensions',
  create: 'Created',
  trash: 'Moved to trash',
  restore: 'Restored',
  proxy: 'Proxy',
  network: 'Connection',
  import: 'Imported',
  export: 'Exported',
  bulk: 'Changed',
};

export function ClientOverviewDialog(props: {
  backend: Backend;
  clientId: string;
  notify: Notify;
  onClose: () => void;
}) {
  const { backend, clientId, notify } = props;
  const [o, setO] = useState<ClientOverview | null>(null);
  const load = useCallback(() => {
    backend.agency
      .clientOverview(clientId)
      .then(setO)
      .catch((e) => notify(errorMessage(e), 'error'));
  }, [backend, clientId, notify]);
  useEffect(load, [load]);

  if (!o) return null;
  const p = o.profiles;
  return (
    <Dialog wide title={`${o.client.name}: overview`} onClose={props.onClose}>
      <div className="stack">
        <ul className="stat-row" aria-label="Profiles of this client">
          <li>
            <strong>{p.total}</strong> profiles
          </li>
          <li>
            <strong>{p.running}</strong> open now
          </li>
          <li>
            <strong>{p.never_opened}</strong> never opened
          </li>
          <li>
            <strong>{p.shared}</strong> shared with an organization
          </li>
          {p.crashed > 0 && (
            <li className="warn">
              <strong>{p.crashed}</strong> closed unexpectedly
            </li>
          )}
        </ul>
        {p.items.length > 0 && (
          <table className="simple records">
            <caption className="pb-sr-only">Profiles of {o.client.name}</caption>
            <thead>
              <tr>
                <th scope="col">Profile</th>
                <th scope="col">Status</th>
                <th scope="col">Last opened</th>
                <th scope="col">Last safety copy</th>
              </tr>
            </thead>
            <tbody>
              {p.items.map((x) => (
                <tr key={x.id}>
                  <th scope="row">
                    {x.name}
                    {x.shared && <span className="muted small"> · shared</span>}
                    {x.archived && <span className="muted small"> · archived</span>}
                  </th>
                  <td>{x.running ? 'Open' : x.state === 'crashed' ? 'Closed unexpectedly' : 'Closed'}</td>
                  <td>{relative(x.last_started_at)}</td>
                  <td>{relative(x.last_backup_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {p.more && <p className="muted small">Showing the first 50. The profile list shows all of them.</p>}

        <section aria-labelledby="co-dl">
          <h3 id="co-dl">Downloads</h3>
          <p className="small">
            {o.downloads.client_folder
              ? `This client's profiles download to ${o.downloads.client_folder}.`
              : o.downloads.per_client_folders
                ? `Downloads go into a folder named “${o.downloads.folder_name}”${o.downloads.effective ? ` (${o.downloads.effective})` : ''}.`
                : o.downloads.effective
                  ? `Downloads go to ${o.downloads.effective}.`
                  : "Downloads go to the browser's usual folder."}{' '}
            A profile with its own folder keeps using it. Changes apply the next time each profile opens;
            files already downloaded, and downloads in progress, stay where they are.
          </p>
          <div className="row">
            <button
              type="button"
              className="pb-button"
              onClick={async () => {
                try {
                  const r = await backend.agency.selectClientDownloadDirectory(clientId);
                  if (r.path) {
                    notify(`${o.client.name} downloads to ${r.path} from the next open.`);
                    load();
                  }
                } catch (e) {
                  notify(errorMessage(e), 'error');
                }
              }}
            >
              Choose a folder for this client…
            </button>
            {o.downloads.client_folder && (
              <button
                type="button"
                className="pb-button"
                onClick={async () => {
                  try {
                    await backend.agency.selectClientDownloadDirectory(clientId, true);
                    notify(`${o.client.name} uses the usual downloads folder from the next open.`);
                    load();
                  } catch (e) {
                    notify(errorMessage(e), 'error');
                  }
                }}
              >
                Use the usual folder
              </button>
            )}
          </div>
        </section>

        <section aria-labelledby="co-act">
          <h3 id="co-act">Recent app activity</h3>
          {o.activity.length === 0 ? (
            <p className="muted small">Nothing yet.</p>
          ) : (
            <ul className="activity">
              {o.activity.map((a) => (
                <li key={`${a.at}-${a.profile_id}-${a.action}`}>
                  <span className="muted small">{when(a.at)}</span> {LOCAL_ACTION[a.action] ?? a.action}:{' '}
                  {a.profile_name}
                </li>
              ))}
            </ul>
          )}
          <p className="muted small">
            What this app did with these profiles — not what happened on websites.
          </p>
        </section>
        <div className="row row--end">
          <button type="button" className="pb-button" onClick={props.onClose}>
            Close
          </button>
        </div>
      </div>
    </Dialog>
  );
}

// ----------------------------------------------------------------------------- organization dashboard

const CAPABILITY_LABEL: Record<string, string> = {
  launch: 'Open',
  edit: 'Change settings',
  backup_download: 'Restore backups',
};

interface Props {
  backend: Backend;
  orgId: string;
  clientId: string;
  role: Role;
  me: string;
  notify: Notify;
  offline: boolean;
  onBack: () => void;
}

const ORG_ACTION: Record<string, string> = {
  'profile.created': 'Profile created',
  'profile.updated': 'Profile changed',
  'profile.deleted': 'Profile deleted',
  'session.opened': 'Opened',
  'session.released': 'Closed and handed off',
  'session.taken_over': 'Taken over',
  'snapshot.committed': 'Backed up',
  'client.created': 'Client created',
  'client.updated': 'Client changed',
  'task.created': 'Task added',
  'task.updated': 'Task changed',
  'task.completed': 'Task ticked off',
  'task.deleted': 'Task deleted',
  'bookmark.created': 'Bookmark added',
  'bookmark.updated': 'Bookmark changed',
  'bookmark.deleted': 'Bookmark removed',
  'grant.created': 'Access given',
  'grant.deleted': 'Access removed',
};

export function OrgClientDashboard(props: Props) {
  const { backend, orgId, clientId, notify } = props;
  const [d, setD] = useState<ClientDashboard | null>(null);
  const [stale, setStale] = useState<string | null | false>(false);
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => setNonce((n) => n + 1), []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: nonce reloads
  useEffect(() => {
    let live = true;
    get<ClientDashboard>(backend, `/v1/orgs/${orgId}/clients/${clientId}/dashboard`)
      .then((r) => {
        if (!live) return;
        setD(r.data);
        setStale(r.stale ? r.fetchedAt : false);
      })
      .catch((e) => live && notify(errorMessage(e, 'The dashboard could not be loaded.'), 'error'));
    return () => {
      live = false;
    };
  }, [backend, orgId, clientId, nonce, notify]);

  if (!d) return <p role="status">Loading the client dashboard…</p>;
  const p = d.profiles;
  const offline = props.offline || stale !== false;
  return (
    <section className="stack" aria-labelledby="cd-title">
      <header className="row">
        <button type="button" className="pb-button" onClick={props.onBack}>
          ← All clients
        </button>
        <h2 id="cd-title" className="grow">
          {d.client.name}
          {d.client.archived_at && <span className="muted"> (archived)</span>}
        </h2>
        <button type="button" className="pb-button" onClick={reload}>
          Refresh
        </button>
      </header>
      {stale !== false && (
        <p className="notice" role="status">
          Offline: showing the dashboard saved {stale ? `at ${when(stale)}` : 'earlier'}. Changes need a
          connection.
        </p>
      )}
      <ul className="stat-row" aria-label="Profiles you can see">
        <li>
          <strong>{p.total}</strong> profiles you can see
        </li>
        <li>
          <strong>{p.in_use}</strong> open now
        </li>
        <li className={p.never_backed_up ? 'warn' : undefined}>
          <strong>{p.never_backed_up}</strong> never backed up
        </li>
        <li className={p.stale_backups ? 'warn' : undefined}>
          <strong>{p.stale_backups}</strong> last backup over 7 days ago
        </li>
        <li className={d.tasks.overdue ? 'warn' : undefined}>
          <strong>{d.tasks.open}</strong> open tasks{d.tasks.overdue ? ` (${d.tasks.overdue} overdue)` : ''}
        </li>
      </ul>

      <section aria-labelledby="cd-profiles">
        <h3 id="cd-profiles">Profiles</h3>
        {p.items.length === 0 ? (
          <p className="muted small">No profiles you can see.</p>
        ) : (
          <table className="simple records">
            <caption className="pb-sr-only">Profiles of {d.client.name}</caption>
            <thead>
              <tr>
                <th scope="col">Profile</th>
                <th scope="col">Open by</th>
                <th scope="col">Last opened in the app</th>
                <th scope="col">Last backup</th>
              </tr>
            </thead>
            <tbody>
              {p.items.map((x) => (
                <tr key={x.id}>
                  <th scope="row">{x.name}</th>
                  <td>
                    {x.in_use ? (
                      <>
                        {x.in_use.mine ? 'You' : x.in_use.holder_name || 'Someone'}
                        {x.in_use.state === 'uncertain' && <span className="warn"> (not answering)</span>}
                      </>
                    ) : (
                      <span className="muted">Nobody</span>
                    )}
                  </td>
                  <td>{relative(x.last_opened_at)}</td>
                  <td>
                    {x.snapshot_version ? relative(x.last_snapshot_at) : <span className="warn">Never</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {p.more && (
          <p className="muted small">Showing 50 of {p.total}. The Profiles section lists all of them.</p>
        )}
      </section>

      {d.people && (
        <section aria-labelledby="cd-people">
          <h3 id="cd-people">Who works on this client</h3>
          {d.people.length === 0 ? (
            <p className="muted small">Only owners and admins (they reach every client).</p>
          ) : (
            <ul>
              {d.people.map((x) => (
                <li key={x.user_id}>
                  <strong>{x.display_name || x.user_id}</strong> ({x.role}) —{' '}
                  {x.access === 'client' ? 'the whole client' : plural(x.profiles, 'profile')}
                  {x.capabilities.length > 0 && (
                    <span className="muted small"> · {x.capabilities.join(', ')}</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      <TasksPanel {...props} dashboard={d} offline={offline} onChanged={reload} />
      <BookmarksPanel {...props} dashboard={d} offline={offline} onChanged={reload} />

      {d.activity && (
        <section aria-labelledby="cd-activity">
          <h3 id="cd-activity">Recent app activity</h3>
          {d.activity.length === 0 ? (
            <p className="muted small">Nothing yet.</p>
          ) : (
            <ul className="activity">
              {d.activity.map((a) => (
                <li key={a.id}>
                  <span className="muted small">{when(a.created_at)}</span> {ORG_ACTION[a.action] ?? a.action}
                  {a.target_name ? `: ${a.target_name}` : ''}
                  {a.actor_name ? <span className="muted small"> — {a.actor_name}</span> : null}
                </li>
              ))}
            </ul>
          )}
          <p className="muted small">What people did in the app — not what happened on websites.</p>
        </section>
      )}
    </section>
  );
}

type TaskFilter = 'open' | 'done' | 'all';

function TasksPanel(props: Props & { dashboard: ClientDashboard; onChanged: () => void }) {
  const { backend, orgId, clientId, notify, role, me, offline } = props;
  const [filter, setFilter] = useState<TaskFilter>('open');
  const [tasks, setTasks] = useState<ClientTask[] | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [title, setTitle] = useState('');
  const [profile, setProfile] = useState('');
  const [assignee, setAssignee] = useState('');
  const [due, setDue] = useState('');
  const [nonce, setNonce] = useState(0);
  const admin = can(role, 'members.read');
  const writer = can(role, 'tasks.write');
  const base = `/v1/orgs/${orgId}/clients/${clientId}/tasks`;

  // biome-ignore lint/correctness/useExhaustiveDependencies: nonce reloads
  useEffect(() => {
    let live = true;
    get<{ items: ClientTask[] }>(backend, base, [
      ['status', filter],
      ['limit', '100'],
    ])
      .then((r) => live && setTasks(r.data.items))
      .catch((e) => live && notify(errorMessage(e), 'error'));
    return () => {
      live = false;
    };
  }, [backend, base, filter, nonce, notify]);
  useEffect(() => {
    if (!admin) return;
    get<{ items: Member[] }>(backend, `/v1/orgs/${orgId}/members`, [['limit', '100']])
      .then((r) => setMembers(r.data.items))
      .catch(() => setMembers([]));
  }, [backend, orgId, admin]);

  const changed = () => {
    setNonce((n) => n + 1);
    props.onChanged();
  };
  const add = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await send(backend, 'POST', base, {
        title: title.trim(),
        ...(profile ? { profile_id: profile } : {}),
        ...(assignee ? { assignee_id: assignee } : {}),
        ...(due ? { due_at: new Date(`${due}T17:00:00`).toISOString() } : {}),
      });
      notify(`Task “${title.trim()}” added.`);
      setTitle('');
      setDue('');
      changed();
    } catch (err) {
      notify(errorMessage(err), 'error');
    }
  };
  const patch = async (t: ClientTask, body: Record<string, unknown>, done: string) => {
    try {
      await send(backend, 'PATCH', `${base}/${t.id}`, body, t.version);
      notify(done);
      changed();
    } catch (err) {
      notify(errorMessage(err), 'error');
      changed();
    }
  };
  const assignees = useMemo(
    () =>
      admin
        ? members.filter((m) => m.role !== 'billing').map((m) => [m.user_id, m.display_name] as const)
        : ([[me, 'Me']] as const),
    [admin, members, me],
  );

  return (
    <section aria-labelledby="cd-tasks">
      <header className="row">
        <h3 id="cd-tasks" className="grow">
          Tasks
        </h3>
        <label className="row small">
          Show
          <select value={filter} onChange={(e) => setFilter(e.target.value as TaskFilter)}>
            <option value="open">Open</option>
            <option value="done">Done</option>
            <option value="all">All</option>
          </select>
        </label>
      </header>
      <p className="muted small">
        Checklists for the team. Ticking a task off records who did it and when in this app; it does not mean
        anything happened on a website.
      </p>
      {writer && (
        <form className="row wrap" onSubmit={add} aria-label="Add a task">
          <label className="grow">
            New task
            <input
              required
              maxLength={200}
              value={title}
              disabled={offline}
              onChange={(e) => setTitle(e.target.value)}
            />
          </label>
          <label>
            Profile
            <select value={profile} disabled={offline} onChange={(e) => setProfile(e.target.value)}>
              <option value="">Whole client</option>
              {props.dashboard.profiles.items.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            For
            <select value={assignee} disabled={offline} onChange={(e) => setAssignee(e.target.value)}>
              <option value="">Nobody yet</option>
              {assignees.map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Due
            <input type="date" value={due} disabled={offline} onChange={(e) => setDue(e.target.value)} />
          </label>
          <button type="submit" className="pb-button" disabled={offline || !title.trim()}>
            Add task
          </button>
        </form>
      )}
      {tasks === null ? (
        <p role="status">Loading tasks…</p>
      ) : tasks.length === 0 ? (
        <p className="muted small">{filter === 'done' ? 'Nothing done yet.' : 'No open tasks.'}</p>
      ) : (
        <ul className="task-list">
          {tasks.map((t) => {
            const done = t.status === 'done';
            const mine = t.assignee_id === me;
            return (
              <li key={t.id} className={t.overdue ? 'task task--overdue' : 'task'}>
                <label className="choice">
                  <input
                    type="checkbox"
                    checked={done}
                    disabled={offline || !writer}
                    onChange={() =>
                      void patch(
                        t,
                        { status: done ? 'open' : 'done' },
                        done ? `Reopened “${t.title}”.` : `Ticked off “${t.title}”.`,
                      )
                    }
                  />
                  <span>
                    <strong>{t.title}</strong>
                    {t.profile_name && <span className="muted"> · {t.profile_name}</span>}
                  </span>
                </label>
                <div className="muted small">
                  {t.assignee_name ? `For ${mine ? 'you' : t.assignee_name}` : 'Not assigned'}
                  {t.due_at && (
                    <>
                      {' · '}
                      <span className={t.overdue ? 'warn' : undefined}>
                        {t.overdue ? 'Overdue since' : 'Due'} {day(t.due_at)}
                      </span>
                    </>
                  )}
                  {done && t.completed_at && ` · done ${relative(t.completed_at).toLowerCase()}`}
                </div>
                {writer && (
                  <div className="row small">
                    {!t.assignee_id && !done && (
                      <button
                        type="button"
                        className="link-button"
                        disabled={offline}
                        onClick={() => void patch(t, { assignee_id: me }, `“${t.title}” is yours.`)}
                      >
                        Take it<span className="pb-sr-only"> ({t.title})</span>
                      </button>
                    )}
                    {(admin || t.created_by === me) && (
                      <button
                        type="button"
                        className="link-button"
                        disabled={offline}
                        onClick={async () => {
                          try {
                            await send(backend, 'DELETE', `${base}/${t.id}`);
                            notify(`Deleted “${t.title}”.`);
                            changed();
                          } catch (err) {
                            notify(errorMessage(err), 'error');
                          }
                        }}
                      >
                        Delete<span className="pb-sr-only"> {t.title}</span>
                      </button>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function BookmarksPanel(props: Props & { dashboard: ClientDashboard; onChanged: () => void }) {
  const { backend, orgId, clientId, notify, role, offline } = props;
  const manage = can(role, 'clients.manage');
  const [title, setTitle] = useState('');
  const [url, setUrl] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [startPagesFor, setStartPagesFor] = useState<{ local: string; name: string }[] | null>(null);
  const items = props.dashboard.bookmarks;
  const base = `/v1/orgs/${orgId}/clients/${clientId}/bookmarks`;

  // Profiles of this client that are on this computer can use the bookmarks as start pages.
  useEffect(() => {
    let live = true;
    backend.account
      .links(orgId)
      .then((links) => {
        if (!live) return;
        const here = props.dashboard.profiles.items.flatMap((p) => {
          const l = links.find((x) => x.org_profile_id === p.id);
          return l ? [{ local: l.local_profile_id, name: p.name }] : [];
        });
        setStartPagesFor(here);
      })
      .catch(() => live && setStartPagesFor([]));
    return () => {
      live = false;
    };
  }, [backend, orgId, props.dashboard]);

  const PROBLEM_TEXT: Record<string, string> = {
    scheme: 'Only http:// and https:// links can be shared.',
    credentials: 'Links cannot contain a user name or password.',
    whitespace: 'Links cannot contain spaces or hidden characters.',
    too_long: 'That link is too long.',
    invalid: 'That is not a complete web address.',
  };
  const add = async (e: FormEvent) => {
    e.preventDefault();
    const p = bookmarkUrlProblem(url.trim());
    if (p) {
      setProblem(PROBLEM_TEXT[p] ?? 'That link cannot be shared.');
      return;
    }
    try {
      await send(backend, 'POST', base, { title: title.trim(), url: url.trim() });
      notify(`Bookmark “${title.trim()}” added.`);
      setTitle('');
      setUrl('');
      setProblem(null);
      props.onChanged();
    } catch (err) {
      notify(errorMessage(err), 'error');
    }
  };
  const move = async (b: Bookmark, by: -1 | 1) => {
    try {
      await send(
        backend,
        'PATCH',
        `${base}/${b.id}`,
        { position: Math.max(0, Math.min(999, b.position + by)) },
        b.version,
      );
      props.onChanged();
    } catch (err) {
      notify(errorMessage(err), 'error');
    }
  };
  const applyStartPages = async (localId: string, name: string) => {
    try {
      const s = await backend.profiles.status(localId);
      await backend.profiles.update(localId, {
        expectedVersion: s.profile.version,
        startUrls: items.slice(0, 10).map((b) => b.url),
      });
      notify(`${name} opens these ${Math.min(10, items.length)} pages from its next start.`);
    } catch (err) {
      notify(errorMessage(err), 'error');
    }
  };

  return (
    <section aria-labelledby="cd-bookmarks">
      <h3 id="cd-bookmarks">Shared bookmarks</h3>
      <p className="muted small">
        Start pages for this client's profiles (http and https links only, at most {BOOKMARKS_PER_CLIENT}).
      </p>
      {items.length === 0 ? (
        <p className="muted small">No bookmarks yet.</p>
      ) : (
        <ol className="bookmark-list">
          {items.map((b, i) => (
            <li key={b.id}>
              <strong>{b.title}</strong> <span className="mono small">{b.url}</span>
              <div className="row small">
                <button
                  type="button"
                  className="link-button"
                  onClick={() => {
                    void navigator.clipboard?.writeText(b.url).then(
                      () => notify('Link copied.'),
                      () => notify('The link could not be copied.', 'error'),
                    );
                  }}
                >
                  Copy link<span className="pb-sr-only"> ({b.title})</span>
                </button>
                {manage && (
                  <>
                    <button
                      type="button"
                      className="link-button"
                      disabled={offline || i === 0}
                      onClick={() => void move(b, -1)}
                    >
                      Move up<span className="pb-sr-only"> ({b.title})</span>
                    </button>
                    <button
                      type="button"
                      className="link-button"
                      disabled={offline}
                      onClick={async () => {
                        try {
                          await send(backend, 'DELETE', `${base}/${b.id}`);
                          notify(`Removed “${b.title}”.`);
                          props.onChanged();
                        } catch (err) {
                          notify(errorMessage(err), 'error');
                        }
                      }}
                    >
                      Remove<span className="pb-sr-only"> {b.title}</span>
                    </button>
                  </>
                )}
              </div>
            </li>
          ))}
        </ol>
      )}
      {items.length > 0 && startPagesFor && startPagesFor.length > 0 && (
        <div className="row small">
          <span className="grow">Use these as start pages on this computer:</span>
          {startPagesFor.map((p) => (
            <button
              key={p.local}
              type="button"
              className="pb-button"
              onClick={() => void applyStartPages(p.local, p.name)}
            >
              {p.name}
            </button>
          ))}
        </div>
      )}
      {manage && (
        <form className="row wrap" onSubmit={add} aria-label="Add a bookmark" noValidate>
          <label className="grow">
            Title
            <input
              required
              maxLength={120}
              value={title}
              disabled={offline}
              onChange={(e) => setTitle(e.target.value)}
            />
          </label>
          <label className="grow">
            Link
            <input
              required
              type="url"
              inputMode="url"
              placeholder="https://"
              maxLength={2048}
              value={url}
              disabled={offline}
              aria-invalid={problem ? true : undefined}
              aria-describedby={problem ? 'bk-problem' : undefined}
              onChange={(e) => {
                setUrl(e.target.value);
                setProblem(null);
              }}
            />
          </label>
          <button type="submit" className="pb-button" disabled={offline || !title.trim() || !url.trim()}>
            Add bookmark
          </button>
          {problem && (
            <p id="bk-problem" role="alert" className="error small">
              {problem}
            </p>
          )}
        </form>
      )}
    </section>
  );
}
