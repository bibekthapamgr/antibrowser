/**
 * Organization screen (milestone 06): profiles, clients, members, invitations, access (grants), activity and
 * settings of one organization, as the signed-in member's role allows. Every action is decided by the server; this
 * screen only hides what the role cannot do. Information shown while offline comes from the last successful load
 * and is marked as such; nothing is changed or opened from it.
 */
import {
  ASSIGNABLE_ROLES,
  type AuditEvent,
  GRANT_CAPABILITIES,
  type Grant,
  type GrantCapability,
  type Invitation,
  type Member,
  type Organization,
  type Client as OrgClient,
  type Profile as OrgProfile,
  type Role,
} from '@pb/contracts/resources';
import { type FormEvent, type ReactNode, useCallback, useEffect, useId, useMemo, useState } from 'react';
import { OrgAutomationSection } from './automation.tsx';
import type { AccountView, AppView, Backend, OrgImportView } from './backend/types.ts';
import { errorMessage } from './backend/types.ts';
import { OrgBackupsSection } from './backups.tsx';
import { BillingBanner, OrgBillingSection } from './billing.tsx';
import { OrgClientDashboard } from './clients.tsx';
import { ApiFailure, can, get, ROLE_HELP, ROLE_LABEL, send } from './cloud.ts';
import { Dialog, useDebounced } from './components.tsx';
import { OrgExtensionsSection } from './extensions-org.tsx';
import { type Notify, plural, relative, when } from './status.tsx';
import { TakeoverDialog } from './team.tsx';

type Section =
  | 'profiles'
  | 'clients'
  | 'members'
  | 'invitations'
  | 'access'
  | 'backups'
  | 'extensions'
  | 'automation'
  | 'billing'
  | 'activity'
  | 'settings';
export interface Page<T> {
  items: T[];
  next_cursor: string | null;
}

/** Marks a screen whose data came from the offline cache. */
export function Stale({ at }: { at: string | null }) {
  return (
    <p className="notice" role="status">
      Offline: showing information saved {at ? `at ${when(at)}` : 'earlier'}. Changes need a connection.
    </p>
  );
}

/** Loads one API resource with offline fallback; `reload` refetches. */
export function useResource<T>(
  backend: Backend,
  path: string | null,
  notify: Notify,
  query?: [string, string][],
) {
  const [data, setData] = useState<T | null>(null);
  const [stale, setStale] = useState<string | null | false>(false);
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
        setStale(r.stale ? r.fetchedAt : false);
      })
      .catch((e) => live && notify(errorMessage(e, 'Could not load this information.'), 'error'));
    return () => {
      live = false;
    };
  }, [backend, path, key, nonce, notify]);
  return { data, stale, reload: useCallback(() => setNonce((n) => n + 1), []) };
}

export function OrganizationScreen(props: {
  backend: Backend;
  orgId: string;
  app: AppView;
  account: AccountView;
  refreshKey: number;
  notify: Notify;
  onLeft: () => void;
  onChanged: () => void;
}) {
  const { backend, orgId, notify } = props;
  const org = useResource<Organization>(backend, `/v1/orgs/${orgId}`, notify);
  const [section, setSection] = useState<Section>('profiles');
  const role = org.data?.role ?? null;

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new organization starts on its profiles
  useEffect(() => setSection('profiles'), [orgId]);

  if (!org.data) {
    return (
      <p role="status" className="loading">
        Loading organization…
      </p>
    );
  }
  const sections: [Section, string, boolean][] = [
    ['profiles', 'Profiles', can(role, 'profile.read')],
    ['clients', 'Clients', can(role, 'clients.read')],
    ['members', 'Members', can(role, 'members.read')],
    ['invitations', 'Invitations', can(role, 'members.manage')],
    ['access', 'Access', can(role, 'grants.manage')],
    ['backups', 'Backups', can(role, 'backups.manage')],
    ['extensions', 'Extensions', can(role, 'org.read') && role !== 'billing'],
    ['automation', 'Automation', can(role, 'automation.read')],
    ['billing', 'Billing', can(role, 'billing.read')],
    ['activity', 'Activity', can(role, 'audit.read')],
    ['settings', 'Settings', true],
  ];
  const visible = sections.filter(([, , show]) => show);
  const current = visible.some(([s]) => s === section) ? section : (visible[0]?.[0] ?? 'settings');
  const offline = org.stale !== false;
  const common = { backend, orgId, role: role as Role, notify, offline, me: props.account.user?.id ?? '' };

  return (
    <section className="screen organization" aria-labelledby="org-title">
      <header className="toolbar">
        <div className="toolbar__title">
          <h1 id="org-title">{org.data.name}</h1>
          <p className="muted small">
            Organization · your role: <strong>{ROLE_LABEL[org.data.role]}</strong> —{' '}
            {ROLE_HELP[org.data.role]}
          </p>
        </div>
      </header>
      {org.stale !== false && <Stale at={org.stale} />}
      <BillingBanner billing={org.data.billing} role={role} onOpenBilling={() => setSection('billing')} />
      <nav aria-label="Organization sections" className="org-nav">
        {visible.map(([id, label]) => (
          <button
            key={id}
            type="button"
            className="pb-button"
            aria-current={current === id ? 'page' : undefined}
            onClick={() => setSection(id)}
          >
            {label}
          </button>
        ))}
      </nav>
      {current === 'profiles' && <ProfilesSection {...common} />}
      {current === 'clients' && <ClientsSection {...common} />}
      {current === 'members' && <MembersSection {...common} onLeft={props.onLeft} onChanged={org.reload} />}
      {current === 'invitations' && <InvitationsSection {...common} />}
      {current === 'access' && <AccessSection {...common} />}
      {current === 'backups' && <OrgBackupsSection {...common} />}
      {current === 'extensions' && <OrgExtensionsSection {...common} />}
      {current === 'automation' && <OrgAutomationSection {...common} />}
      {current === 'billing' && <OrgBillingSection {...common} onChanged={org.reload} />}
      {current === 'activity' && <ActivitySection {...common} />}
      {current === 'settings' && (
        <SettingsSection
          {...common}
          org={org.data}
          app={props.app}
          onChanged={() => {
            org.reload();
            props.onChanged();
          }}
        />
      )}
    </section>
  );
}

export interface SectionProps {
  backend: Backend;
  orgId: string;
  role: Role;
  notify: Notify;
  offline: boolean;
  me: string;
}

// ----------------------------------------------------------------------------- profiles
function ProfilesSection(props: SectionProps) {
  const { backend, orgId, role, notify, offline } = props;
  const [q, setQ] = useState('');
  const [client, setClient] = useState('');
  const query = useDebounced(q.trim(), 250);
  const clients = useResource<Page<OrgClient>>(backend, `/v1/orgs/${orgId}/clients`, notify, [
    ['limit', '100'],
  ]);
  const params: [string, string][] = [['limit', '100']];
  if (query) params.push(['q', query]);
  if (client) params.push(['client_id', client]);
  const list = useResource<Page<OrgProfile>>(backend, `/v1/orgs/${orgId}/profiles`, notify, params);
  const [more, setMore] = useState<OrgProfile[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [editing, setEditing] = useState<OrgProfile | 'new' | null>(null);
  const [deleting, setDeleting] = useState<OrgProfile | null>(null);
  const [takingOver, setTakingOver] = useState<OrgProfile | null>(null);
  // Organization profiles already on this computer (linked local profiles), milestone 07.
  const [here, setHere] = useState<Set<string>>(new Set());
  const [linkNonce, setLinkNonce] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: linkNonce reloads after a restore starts
  useEffect(() => {
    let live = true;
    backend.account
      .links(orgId)
      .then((l) => live && setHere(new Set(l.map((x) => x.org_profile_id))))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [backend, orgId, linkNonce]);
  useEffect(() => backend.on('sync', (e) => e.state === 'restored' && setLinkNonce((n) => n + 1)), [backend]);

  const putHere = async (p: OrgProfile) => {
    try {
      const local = await backend.sync.restoreHere(orgId, p.id, p.name);
      notify(
        `Restoring ${local.name} to this computer. It appears in your local workspace; sign in to websites again after it opens.`,
      );
      setLinkNonce((n) => n + 1);
    } catch (e) {
      notify(errorMessage(e), 'error');
    }
  };

  useEffect(() => {
    setMore([]);
    setCursor(list.data?.next_cursor ?? null);
  }, [list.data]);

  const clientName = useMemo(
    () => new Map((clients.data?.items ?? []).map((c) => [c.id, c.name])),
    [clients.data],
  );
  const rows = [...(list.data?.items ?? []), ...more];

  const loadMore = async () => {
    if (!cursor) return;
    try {
      const res = await get<Page<OrgProfile>>(backend, `/v1/orgs/${orgId}/profiles`, [
        ...params,
        ['cursor', cursor],
      ]);
      setMore((m) => [...m, ...res.data.items]);
      setCursor(res.data.next_cursor);
    } catch (e) {
      notify(errorMessage(e), 'error');
    }
  };

  const remove = async (p: OrgProfile) => {
    setDeleting(null);
    try {
      await send(backend, 'DELETE', `/v1/orgs/${orgId}/profiles/${p.id}`, undefined, p.version);
      notify(`Deleted ${p.name} from the organization.`);
      list.reload();
    } catch (e) {
      notify(errorMessage(e), 'error');
      list.reload();
    }
  };

  return (
    <section className="stack" aria-labelledby="org-profiles-title">
      <div className="row">
        <h2 id="org-profiles-title" className="grow">
          Profiles
        </h2>
        {can(role, 'profile.create') && (
          <button
            type="button"
            className="pb-button"
            data-variant="primary"
            disabled={offline}
            onClick={() => setEditing('new')}
          >
            Add profile
          </button>
        )}
      </div>
      <p className="muted small">
        Organization profiles are shared settings (name, client, notes) with encrypted backups. Put one on
        this computer to restore its newest backup into a local profile. One person at a time works in each:
        opening it takes it until it is closed and handed off, with its backup saved for the next person.
      </p>
      <div className="row">
        <label className="grow">
          Search by name
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} />
        </label>
        <label>
          Client
          <select value={client} onChange={(e) => setClient(e.target.value)}>
            <option value="">All clients</option>
            {(clients.data?.items ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      {list.stale !== false && <Stale at={list.stale} />}
      {list.data === null ? (
        <p role="status">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="muted">
          {query || client
            ? 'No profiles match.'
            : role === 'operator' || role === 'viewer'
              ? 'No profiles have been shared with you yet. Ask an admin for access.'
              : 'No profiles yet.'}
        </p>
      ) : (
        <table className="simple records">
          <caption className="pb-sr-only">Organization profiles</caption>
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Client</th>
              <th scope="col">Notes</th>
              <th scope="col">Changed</th>
              <th scope="col">In use</th>
              <th scope="col">This computer</th>
              <th scope="col">
                <span className="pb-sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => (
              <tr key={p.id}>
                <th scope="row">{p.name}</th>
                <td>
                  {p.client_id ? (clientName.get(p.client_id) ?? '—') : <span className="muted">None</span>}
                </td>
                <td className="notes-cell">{p.notes || <span className="muted">—</span>}</td>
                <td>{relative(p.updated_at)}</td>
                <td>
                  {!p.in_use ? (
                    <span className="muted">Free</span>
                  ) : p.in_use.mine ? (
                    <span className="badge">You · {p.in_use.device_name || 'your computer'}</span>
                  ) : (
                    <span
                      className={`badge${p.in_use.state === 'uncertain' ? ' badge--warn' : ''}`}
                      title={`Since ${when(p.in_use.since)}`}
                    >
                      {p.in_use.holder_name || 'Someone'} · {p.in_use.device_name || 'another computer'}
                      {p.in_use.state === 'uncertain' ? ' · not closed properly' : ''}
                    </span>
                  )}
                </td>
                <td>{here.has(p.id) ? 'On this computer' : <span className="muted">Not here</span>}</td>
                <td>
                  <div className="cell-actions">
                    {!here.has(p.id) && can(role, 'snapshot.restore') && (
                      <button
                        type="button"
                        className="pb-button"
                        disabled={offline}
                        onClick={() => putHere(p)}
                      >
                        Put on this computer<span className="pb-sr-only"> {p.name}</span>
                      </button>
                    )}
                    {p.in_use && !p.in_use.mine && can(role, 'lease.force_release') && (
                      <button
                        type="button"
                        className="pb-button"
                        disabled={offline}
                        onClick={() => setTakingOver(p)}
                      >
                        Take over…<span className="pb-sr-only"> {p.name}</span>
                      </button>
                    )}
                    {can(role, 'profile.update') && (
                      <button
                        type="button"
                        className="pb-button"
                        disabled={offline}
                        onClick={() => setEditing(p)}
                      >
                        Edit<span className="pb-sr-only"> {p.name}</span>
                      </button>
                    )}
                    {can(role, 'profile.delete') && (
                      <button
                        type="button"
                        className="pb-button"
                        disabled={offline}
                        onClick={() => setDeleting(p)}
                      >
                        Delete<span className="pb-sr-only"> {p.name}</span>
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {cursor && (
        <button type="button" className="pb-button" onClick={loadMore}>
          Show more
        </button>
      )}
      {editing && (
        <ProfileDialog
          backend={backend}
          orgId={orgId}
          profile={editing === 'new' ? null : editing}
          clients={(clients.data?.items ?? []).filter((c) => !c.archived_at)}
          notify={notify}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            list.reload();
          }}
        />
      )}
      {takingOver?.in_use && (
        <TakeoverDialog
          backend={backend}
          orgId={orgId}
          profileId={takingOver.id}
          profileName={takingOver.name}
          holder={`${takingOver.in_use.holder_name || 'Someone'} on ${takingOver.in_use.device_name || 'another computer'}`}
          uncertain={takingOver.in_use.state === 'uncertain'}
          notify={notify}
          onClose={() => setTakingOver(null)}
          onDone={() => {
            setTakingOver(null);
            list.reload();
          }}
        />
      )}
      {deleting && (
        <Dialog
          title={`Delete ${deleting.name}?`}
          description="It is removed from the organization for everyone. Local copies on members' computers are not touched."
          role="alertdialog"
          onClose={() => setDeleting(null)}
        >
          <div className="row row--end">
            <button type="button" className="pb-button" onClick={() => setDeleting(null)}>
              Cancel
            </button>
            <button
              type="button"
              className="pb-button"
              data-variant="danger"
              onClick={() => remove(deleting)}
            >
              Delete profile
            </button>
          </div>
        </Dialog>
      )}
    </section>
  );
}

function ProfileDialog(props: {
  backend: Backend;
  orgId: string;
  profile: OrgProfile | null;
  clients: OrgClient[];
  notify: Notify;
  onClose: () => void;
  onSaved: () => void;
}) {
  const p = props.profile;
  const [name, setName] = useState(p?.name ?? '');
  const [client, setClient] = useState(p?.client_id ?? '');
  const [notes, setNotes] = useState(p?.notes ?? '');
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const body = { name: name.trim(), client_id: client || null, notes };
      if (p) await send(props.backend, 'PATCH', `/v1/orgs/${props.orgId}/profiles/${p.id}`, body, p.version);
      else await send(props.backend, 'POST', `/v1/orgs/${props.orgId}/profiles`, body);
      props.notify(p ? 'Profile saved.' : `Added ${body.name}.`);
      props.onSaved();
    } catch (err) {
      props.notify(
        err instanceof ApiFailure && err.code === 'VERSION_CONFLICT'
          ? 'Someone else changed this profile. Close this window and try again.'
          : errorMessage(err),
        'error',
      );
    }
    setBusy(false);
  };
  return (
    <Dialog title={p ? `Edit ${p.name}` : 'Add a profile'} onClose={props.onClose} initialFocus="input">
      <form className="stack" onSubmit={submit}>
        <label>
          Name
          <input required maxLength={120} value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label>
          Client
          <select value={client} onChange={(e) => setClient(e.target.value)}>
            <option value="">No client</option>
            {props.clients.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Notes
          <textarea maxLength={2000} rows={4} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </label>
        <p className="muted small">
          Notes are visible to everyone with access to this profile. Do not put passwords in them.
        </p>
        <div className="row row--end">
          <button type="button" className="pb-button" onClick={props.onClose}>
            Cancel
          </button>
          <button type="submit" className="pb-button" data-variant="primary" disabled={busy || !name.trim()}>
            {p ? 'Save' : 'Add profile'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

// ----------------------------------------------------------------------------- clients
export function ClientsSection(props: SectionProps) {
  const { backend, orgId, role, notify, offline } = props;
  const list = useResource<Page<OrgClient>>(backend, `/v1/orgs/${orgId}/clients`, notify, [['limit', '100']]);
  const [name, setName] = useState('');
  const [renaming, setRenaming] = useState<OrgClient | null>(null);
  const [dashboard, setDashboard] = useState<string | null>(null);
  const manage = can(role, 'clients.manage');
  if (dashboard)
    return (
      <OrgClientDashboard
        backend={backend}
        orgId={orgId}
        clientId={dashboard}
        role={role}
        me={props.me}
        notify={notify}
        offline={offline}
        onBack={() => setDashboard(null)}
      />
    );

  const add = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await send(backend, 'POST', `/v1/orgs/${orgId}/clients`, { name: name.trim() });
      notify(`Added client ${name.trim()}.`);
      setName('');
      list.reload();
    } catch (err) {
      notify(errorMessage(err), 'error');
    }
  };
  const archive = async (c: OrgClient) => {
    try {
      await send(
        backend,
        'PATCH',
        `/v1/orgs/${orgId}/clients/${c.id}`,
        { archived: !c.archived_at },
        c.version,
      );
      notify(c.archived_at ? `${c.name} is active again.` : `${c.name} is archived.`);
      list.reload();
    } catch (err) {
      notify(errorMessage(err), 'error');
      list.reload();
    }
  };

  return (
    <section className="stack" aria-labelledby="org-clients-title">
      <h2 id="org-clients-title">Clients</h2>
      {list.stale !== false && <Stale at={list.stale} />}
      {manage && (
        <form className="row" onSubmit={add} aria-label="Add a client">
          <label className="grow">
            New client
            <input
              required
              maxLength={120}
              value={name}
              disabled={offline}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <button type="submit" className="pb-button" disabled={offline || !name.trim()}>
            Add client
          </button>
        </form>
      )}
      {list.data === null ? (
        <p role="status">Loading…</p>
      ) : list.data.items.length === 0 ? (
        <p className="muted">No clients{manage ? ' yet' : ' shared with you'}.</p>
      ) : (
        <table className="simple records">
          <caption className="pb-sr-only">Clients</caption>
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Status</th>
              <th scope="col">
                <span className="pb-sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {list.data.items.map((c) => (
              <tr key={c.id}>
                <th scope="row">{c.name}</th>
                <td>{c.archived_at ? <span className="muted">Archived</span> : 'Active'}</td>
                <td>
                  <div className="cell-actions">
                    <button type="button" className="pb-button" onClick={() => setDashboard(c.id)}>
                      Dashboard<span className="pb-sr-only"> of {c.name}</span>
                    </button>
                    {manage && (
                      <>
                        <button
                          type="button"
                          className="pb-button"
                          disabled={offline}
                          onClick={() => setRenaming(c)}
                        >
                          Rename<span className="pb-sr-only"> {c.name}</span>
                        </button>
                        <button
                          type="button"
                          className="pb-button"
                          disabled={offline}
                          onClick={() => archive(c)}
                        >
                          {c.archived_at ? 'Restore' : 'Archive'}
                          <span className="pb-sr-only"> {c.name}</span>
                        </button>
                      </>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {renaming && (
        <RenameDialog
          title={`Rename ${renaming.name}`}
          label="Client name"
          initial={renaming.name}
          onClose={() => setRenaming(null)}
          onSave={async (next) => {
            try {
              await send(
                backend,
                'PATCH',
                `/v1/orgs/${orgId}/clients/${renaming.id}`,
                { name: next },
                renaming.version,
              );
              setRenaming(null);
              list.reload();
            } catch (err) {
              notify(errorMessage(err), 'error');
            }
          }}
        />
      )}
    </section>
  );
}

function RenameDialog(props: {
  title: string;
  label: string;
  initial: string;
  onClose: () => void;
  onSave: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState(props.initial);
  return (
    <Dialog title={props.title} onClose={props.onClose} initialFocus="input">
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void props.onSave(name.trim());
        }}
      >
        <label>
          {props.label}
          <input required maxLength={120} value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <div className="row row--end">
          <button type="button" className="pb-button" onClick={props.onClose}>
            Cancel
          </button>
          <button type="submit" className="pb-button" data-variant="primary" disabled={!name.trim()}>
            Save
          </button>
        </div>
      </form>
    </Dialog>
  );
}

// ----------------------------------------------------------------------------- members
export function MembersSection(
  props: SectionProps & {
    onLeft: () => void;
    onChanged: () => void;
    /** R3: the Team page edits an operator's or viewer's profile access in one step. */
    onEditAccess?: ((m: Member) => void) | undefined;
  },
) {
  const { backend, orgId, role, notify, offline, me } = props;
  const list = useResource<Page<Member>>(backend, `/v1/orgs/${orgId}/members`, notify, [['limit', '100']]);
  const [removing, setRemoving] = useState<Member | null>(null);
  const [transfer, setTransfer] = useState(false);
  const manage = can(role, 'members.manage');

  const changeRole = async (m: Member, next: string) => {
    try {
      await send(backend, 'PATCH', `/v1/orgs/${orgId}/members/${m.user_id}`, { role: next }, m.version);
      notify(`${m.display_name} is now ${ROLE_LABEL[next as Role]}.`);
    } catch (err) {
      notify(errorMessage(err), 'error');
    }
    list.reload();
    if (m.user_id === me) props.onChanged();
  };
  const remove = async (m: Member) => {
    setRemoving(null);
    try {
      await send(backend, 'DELETE', `/v1/orgs/${orgId}/members/${m.user_id}`);
      if (m.user_id === me) {
        notify('You left the organization.');
        props.onLeft();
        return;
      }
      notify(`${m.display_name} was removed. Their access ended immediately.`);
      list.reload();
    } catch (err) {
      notify(errorMessage(err), 'error');
    }
  };

  return (
    <section className="stack" aria-labelledby="org-members-title">
      <div className="row">
        <h2 id="org-members-title" className="grow">
          Members
        </h2>
        {role === 'owner' && (
          <button type="button" className="pb-button" disabled={offline} onClick={() => setTransfer(true)}>
            Transfer ownership
          </button>
        )}
      </div>
      {list.stale !== false && <Stale at={list.stale} />}
      {list.data === null ? (
        <p role="status">Loading…</p>
      ) : (
        <table className="simple records">
          <caption className="pb-sr-only">Members</caption>
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">E-mail</th>
              <th scope="col">Role</th>
              <th scope="col">Joined</th>
              <th scope="col">
                <span className="pb-sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {list.data.items.map((m) => {
              const editable = manage && !offline && (m.role !== 'owner' || role === 'owner');
              return (
                <tr key={m.user_id}>
                  <th scope="row">
                    {m.display_name}
                    {m.user_id === me && <span className="badge">You</span>}
                  </th>
                  <td>{m.email ?? '—'}</td>
                  <td>
                    {editable && m.role !== 'owner' ? (
                      <select
                        aria-label={`Role of ${m.display_name}`}
                        value={m.role}
                        onChange={(e) => void changeRole(m, e.target.value)}
                      >
                        {ASSIGNABLE_ROLES.map((r) => (
                          <option key={r} value={r}>
                            {ROLE_LABEL[r]}
                          </option>
                        ))}
                      </select>
                    ) : (
                      ROLE_LABEL[m.role]
                    )}
                  </td>
                  <td>{when(m.created_at)}</td>
                  <td>
                    <div className="cell-actions">
                      {props.onEditAccess &&
                        can(role, 'grants.manage') &&
                        (m.role === 'operator' || m.role === 'viewer') && (
                          <button
                            type="button"
                            className="pb-button"
                            disabled={offline}
                            onClick={() => props.onEditAccess?.(m)}
                          >
                            Access…<span className="pb-sr-only"> of {m.display_name}</span>
                          </button>
                        )}
                      {m.user_id === me ? (
                        <button
                          type="button"
                          className="pb-button"
                          disabled={offline}
                          onClick={() => setRemoving(m)}
                        >
                          Leave
                        </button>
                      ) : (
                        editable && (
                          <button type="button" className="pb-button" onClick={() => setRemoving(m)}>
                            Remove<span className="pb-sr-only"> {m.display_name}</span>
                          </button>
                        )
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <p className="muted small">
        {props.onEditAccess
          ? 'Owners manage ownership and billing; admins manage members and access. Members and viewers only see the profiles they are given (Access…).'
          : 'Owners manage ownership and billing; admins manage members, clients and access. Operators and viewers only see the clients and profiles they are given in Access.'}
      </p>
      {removing && (
        <Dialog
          title={removing.user_id === me ? 'Leave this organization?' : `Remove ${removing.display_name}?`}
          description={
            removing.user_id === me
              ? 'You lose access to its profiles right away. Your local profiles are not affected.'
              : 'Their access ends at their next action. Anything already on their computers stays there.'
          }
          role="alertdialog"
          onClose={() => setRemoving(null)}
        >
          <div className="row row--end">
            <button type="button" className="pb-button" onClick={() => setRemoving(null)}>
              Cancel
            </button>
            <button
              type="button"
              className="pb-button"
              data-variant="danger"
              onClick={() => remove(removing)}
            >
              {removing.user_id === me ? 'Leave' : 'Remove member'}
            </button>
          </div>
        </Dialog>
      )}
      {transfer && list.data && (
        <TransferDialog
          backend={backend}
          orgId={orgId}
          members={list.data.items.filter((m) => m.user_id !== me)}
          notify={notify}
          onClose={() => setTransfer(false)}
          onDone={() => {
            setTransfer(false);
            list.reload();
            props.onChanged();
          }}
        />
      )}
    </section>
  );
}

function TransferDialog(props: {
  backend: Backend;
  orgId: string;
  members: Member[];
  notify: Notify;
  onClose: () => void;
  onDone: () => void;
}) {
  const { backend, notify } = props;
  const [target, setTarget] = useState(props.members[0]?.user_id ?? '');
  const [phase, setPhase] = useState<'choose' | 'confirm-identity' | 'waiting'>('choose');
  const chosen = props.members.find((m) => m.user_id === target);

  const run = useCallback(async () => {
    if (!chosen) return;
    try {
      await send(backend, 'POST', `/v1/orgs/${props.orgId}/ownership-transfer`, {
        user_id: chosen.user_id,
        expected_version: chosen.version,
      });
      notify(`${chosen.display_name} is now the owner. You are an admin.`);
      props.onDone();
    } catch (err) {
      if (err instanceof ApiFailure && err.code === 'REAUTHENTICATION_REQUIRED') setPhase('confirm-identity');
      else {
        notify(errorMessage(err), 'error');
        setPhase('choose');
      }
    }
  }, [backend, chosen, notify, props]);

  // After a fresh sign-in for this purpose, the transfer continues by itself.
  useEffect(() => {
    if (phase !== 'waiting') return;
    return backend.on('account', (e) => {
      if (e.status === 'signed_in' && e.reauth) void run();
      else if (e.status === 'failed') {
        notify(e.message ?? 'Sign-in did not complete.', 'error');
        setPhase('confirm-identity');
      }
    });
  }, [backend, notify, phase, run]);

  return (
    <Dialog
      title="Transfer ownership"
      description="The new owner manages ownership and billing. You become an admin. This cannot be undone by you."
      onClose={props.onClose}
      role="alertdialog"
    >
      {phase === 'choose' && (
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            void run();
          }}
        >
          {props.members.length === 0 ? (
            <p>Invite someone first: ownership can only go to another member.</p>
          ) : (
            <label>
              New owner
              <select value={target} onChange={(e) => setTarget(e.target.value)}>
                {props.members.map((m) => (
                  <option key={m.user_id} value={m.user_id}>
                    {m.display_name} ({ROLE_LABEL[m.role]})
                  </option>
                ))}
              </select>
            </label>
          )}
          <div className="row row--end">
            <button type="button" className="pb-button" onClick={props.onClose}>
              Cancel
            </button>
            <button type="submit" className="pb-button" data-variant="danger" disabled={!chosen}>
              Transfer
            </button>
          </div>
        </form>
      )}
      {phase !== 'choose' && (
        <div className="stack">
          <p role="status">
            {phase === 'waiting'
              ? 'Confirm in your browser. The transfer continues when you are back.'
              : 'For your security, sign in again to confirm it is you. Your sign-in page opens in your browser.'}
          </p>
          <div className="row row--end">
            <button type="button" className="pb-button" onClick={props.onClose}>
              Cancel
            </button>
            {phase === 'confirm-identity' && (
              <button
                type="button"
                className="pb-button"
                data-variant="primary"
                onClick={async () => {
                  try {
                    setPhase('waiting');
                    await backend.account.signIn(true);
                  } catch (err) {
                    notify(errorMessage(err), 'error');
                    setPhase('confirm-identity');
                  }
                }}
              >
                Confirm it's me
              </button>
            )}
          </div>
        </div>
      )}
    </Dialog>
  );
}

// ----------------------------------------------------------------------------- invitations
/** An invitation just created: its one-time code is shown only now. */
export interface CreatedInvitation {
  email: string;
  code: string;
  expires: string;
  emailed: boolean;
}

export function InvitationsSection(
  props: SectionProps & {
    /** R3: the Team page invites through its wizard (email, role, access, preview); this lists them. */
    onInvite?: () => void;
    created?: CreatedInvitation | null;
    onCreatedDone?: () => void;
  },
) {
  const { backend, orgId, notify, offline } = props;
  const list = useResource<Page<Invitation>>(backend, `/v1/orgs/${orgId}/invitations`, notify, [
    ['limit', '100'],
  ]);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<(typeof ASSIGNABLE_ROLES)[number]>('operator');
  const [days, setDays] = useState('7');
  const [ownCreated, setCreated] = useState<CreatedInvitation | null>(null);
  const created = props.onInvite ? (props.created ?? null) : ownCreated;
  const done = () => (props.onInvite ? props.onCreatedDone?.() : setCreated(null));
  const codeId = useId();

  const invite = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const res = await send<{ invitation: Invitation; token: string; email_delivery?: string }>(
        backend,
        'POST',
        `/v1/orgs/${orgId}/invitations`,
        {
          email: email.trim(),
          role,
          expires_in_days: Number(days),
        },
      );
      setCreated({
        email: res.data.invitation.email,
        code: res.data.token,
        expires: res.data.invitation.expires_at,
        // R2: the server e-mails the link when it has a mail server.
        emailed: res.data.email_delivery === 'queued',
      });
      setEmail('');
      list.reload();
    } catch (err) {
      notify(errorMessage(err), 'error');
    }
  };
  const withdraw = async (i: Invitation) => {
    try {
      await send(backend, 'POST', `/v1/orgs/${orgId}/invitations/${i.id}/revoke`);
      notify(`The invitation for ${i.email} was withdrawn.`);
      list.reload();
    } catch (err) {
      notify(errorMessage(err), 'error');
    }
  };

  return (
    <section className="stack" aria-labelledby="org-invitations-title">
      <div className="row">
        <h2 id="org-invitations-title" className="grow">
          {props.onInvite ? 'Pending invitations' : 'Invitations'}
        </h2>
        {props.onInvite && (
          <button
            type="button"
            className="pb-button"
            data-variant="primary"
            disabled={offline}
            onClick={props.onInvite}
          >
            Invite someone…
          </button>
        )}
      </div>
      {!props.onInvite && (
        <form className="card stack" onSubmit={invite} aria-label="Invite someone">
          <div className="row">
            <label className="grow">
              E-mail address
              <input
                type="email"
                required
                maxLength={254}
                value={email}
                disabled={offline}
                onChange={(e) => setEmail(e.target.value)}
              />
            </label>
            <label>
              Role
              <select value={role} onChange={(e) => setRole(e.target.value as typeof role)}>
                {ASSIGNABLE_ROLES.map((r) => (
                  <option key={r} value={r}>
                    {ROLE_LABEL[r]}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Valid for
              <select value={days} onChange={(e) => setDays(e.target.value)}>
                {['1', '3', '7', '14', '30'].map((d) => (
                  <option key={d} value={d}>
                    {d === '1' ? '1 day' : `${d} days`}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <p className="muted small">{ROLE_HELP[role]}</p>
          <div className="row row--end">
            <button
              type="submit"
              className="pb-button"
              data-variant="primary"
              disabled={offline || !email.trim()}
            >
              Create invitation
            </button>
          </div>
        </form>
      )}
      {created && (
        <div className="notice stack" role="status">
          <p>
            {created.emailed ? (
              <>
                Invitation e-mailed to <strong>{created.email}</strong>. You can also send them this code; it
                is shown only now.
              </>
            ) : (
              <>
                Send this code to <strong>{created.email}</strong>. It is shown only now.
              </>
            )}{' '}
            It works once, only for that e-mail address, until {when(created.expires)}.
          </p>
          <div className="row">
            <label className="grow">
              Invitation code
              <input
                id={codeId}
                readOnly
                value={created.code}
                className="mono"
                onFocus={(e) => e.target.select()}
              />
            </label>
            <button
              type="button"
              className="pb-button"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(created.code);
                  notify('Code copied.');
                } catch {
                  notify('Select the code and copy it.', 'error');
                }
              }}
            >
              Copy code
            </button>
            <button type="button" className="pb-button" onClick={done}>
              Done
            </button>
          </div>
          <p className="muted small">
            {props.onInvite
              ? 'They open the link in the e-mail, or paste the code in Project Browser under Settings → Account → Join a workspace. Signing in opens the profiles shared with them.'
              : 'They paste it in Project Browser under Account → Join an organization.'}
          </p>
        </div>
      )}
      {list.stale !== false && <Stale at={list.stale} />}
      {list.data && list.data.items.length > 0 && (
        <table className="simple records">
          <caption className="pb-sr-only">Invitations</caption>
          <thead>
            <tr>
              <th scope="col">E-mail</th>
              <th scope="col">Role</th>
              <th scope="col">Status</th>
              <th scope="col">Expires</th>
              <th scope="col">
                <span className="pb-sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {list.data.items.map((i) => (
              <tr key={i.id}>
                <th scope="row">{i.email}</th>
                <td>{ROLE_LABEL[i.role]}</td>
                <td>
                  {
                    {
                      open: 'Waiting',
                      accepted: <span className="ok">Accepted</span>,
                      expired: <span className="muted">Expired</span>,
                      revoked: <span className="muted">Withdrawn</span>,
                    }[i.status]
                  }
                </td>
                <td>{i.status === 'open' ? when(i.expires_at) : '—'}</td>
                <td>
                  {i.status === 'open' && (
                    <button
                      type="button"
                      className="pb-button"
                      disabled={offline}
                      onClick={() => withdraw(i)}
                    >
                      Withdraw<span className="pb-sr-only"> the invitation for {i.email}</span>
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

// ----------------------------------------------------------------------------- access (grants)
export function AccessSection(props: SectionProps) {
  const { backend, orgId, notify, offline } = props;
  const members = useResource<Page<Member>>(backend, `/v1/orgs/${orgId}/members`, notify, [['limit', '100']]);
  const clients = useResource<Page<OrgClient>>(backend, `/v1/orgs/${orgId}/clients`, notify, [
    ['limit', '100'],
  ]);
  const profiles = useResource<Page<OrgProfile>>(backend, `/v1/orgs/${orgId}/profiles`, notify, [
    ['limit', '100'],
  ]);
  const limited = (members.data?.items ?? []).filter((m) => m.role === 'operator' || m.role === 'viewer');
  const [who, setWho] = useState('');
  const person = who || limited[0]?.user_id || '';
  const grants = useResource<Page<Grant>>(backend, person ? `/v1/orgs/${orgId}/grants` : null, notify, [
    ['limit', '100'],
    ['user_id', person],
  ]);
  const [adding, setAdding] = useState('');

  const clientName = new Map((clients.data?.items ?? []).map((c) => [c.id, c.name]));
  const profileName = new Map((profiles.data?.items ?? []).map((p) => [p.id, p.name]));

  const add = async (e: FormEvent) => {
    e.preventDefault();
    const [kind, id] = adding.split(':');
    if (!kind || !id) return;
    try {
      await send(backend, 'POST', `/v1/orgs/${orgId}/grants`, {
        user_id: person,
        ...(kind === 'client' ? { client_id: id } : { profile_id: id }),
      });
      setAdding('');
      grants.reload();
    } catch (err) {
      notify(errorMessage(err), 'error');
    }
  };
  const setCaps = async (g: Grant, capabilities: GrantCapability[]) => {
    try {
      await send(backend, 'PATCH', `/v1/orgs/${orgId}/grants/${g.id}`, { capabilities });
      notify(
        capabilities.includes('launch') || !g.capabilities.includes('launch')
          ? 'Access changed.'
          : 'Access changed. If they had one of these profiles open, it is closed in their app now.',
      );
      grants.reload();
    } catch (err) {
      notify(errorMessage(err), 'error');
    }
  };
  const personRole = limited.find((m) => m.user_id === person)?.role;
  const remove = async (g: Grant) => {
    try {
      await send(backend, 'DELETE', `/v1/orgs/${orgId}/grants/${g.id}`);
      notify('Access removed. It takes effect at their next action.');
      grants.reload();
    } catch (err) {
      notify(errorMessage(err), 'error');
    }
  };

  return (
    <section className="stack" aria-labelledby="org-access-title">
      <h2 id="org-access-title">Access</h2>
      <p className="muted small">
        Owners and admins see everything. Operators and viewers see only what you give them here: a whole
        client (including its future profiles) or single profiles. For operators, choose whether they may open
        the profiles, change their settings and restore their backups. Exporting, sharing and permanent
        deletion stay with owners and admins.
      </p>
      {limited.length === 0 ? (
        <p className="muted">No operators or viewers yet. Invite people in Invitations.</p>
      ) : (
        <>
          <label>
            Member
            <select value={person} onChange={(e) => setWho(e.target.value)}>
              {limited.map((m) => (
                <option key={m.user_id} value={m.user_id}>
                  {m.display_name} ({ROLE_LABEL[m.role]})
                </option>
              ))}
            </select>
          </label>
          {grants.stale !== false && <Stale at={grants.stale} />}
          {grants.data === null ? (
            <p role="status">Loading…</p>
          ) : grants.data.items.length === 0 ? (
            <p className="muted">Nothing shared with this member yet.</p>
          ) : (
            <ul className="plain stack">
              {grants.data.items.map((g) => (
                <li key={g.id} className="stack">
                  <div className="row">
                    <span className="grow">
                      {g.client_id
                        ? `Client: ${clientName.get(g.client_id) ?? 'a client'} (all its profiles)`
                        : `Profile: ${profileName.get(g.profile_id ?? '') ?? 'a profile'}`}
                    </span>
                    <button type="button" className="pb-button" disabled={offline} onClick={() => remove(g)}>
                      Remove access
                    </button>
                  </div>
                  {personRole === 'viewer' ? (
                    <p className="muted small">
                      Viewers can see these profiles but never open, edit or download them.
                    </p>
                  ) : (
                    <fieldset className="plain row" disabled={offline}>
                      <legend className="pb-sr-only">What this access allows</legend>
                      {GRANT_CAPABILITIES.map((c) => (
                        <label key={c} className="choice">
                          <input
                            type="checkbox"
                            checked={g.capabilities.includes(c)}
                            onChange={(e) =>
                              setCaps(
                                g,
                                e.target.checked
                                  ? GRANT_CAPABILITIES.filter((x) => x === c || g.capabilities.includes(x))
                                  : g.capabilities.filter((x) => x !== c),
                              )
                            }
                          />
                          {CAPABILITY_LABEL[c]}
                        </label>
                      ))}
                    </fieldset>
                  )}
                </li>
              ))}
            </ul>
          )}
          <form className="row" onSubmit={add} aria-label="Give access">
            <label className="grow">
              Give access to
              <select value={adding} onChange={(e) => setAdding(e.target.value)}>
                <option value="">Choose a client or profile…</option>
                <optgroup label="Clients (with all their profiles)">
                  {(clients.data?.items ?? []).map((c) => (
                    <option key={c.id} value={`client:${c.id}`}>
                      {c.name}
                    </option>
                  ))}
                </optgroup>
                <optgroup label="Single profiles">
                  {(profiles.data?.items ?? []).map((p) => (
                    <option key={p.id} value={`profile:${p.id}`}>
                      {p.name}
                    </option>
                  ))}
                </optgroup>
              </select>
            </label>
            <button type="submit" className="pb-button" disabled={offline || !adding}>
              Give access
            </button>
          </form>
        </>
      )}
    </section>
  );
}

const CAPABILITY_LABEL: Record<GrantCapability, string> = {
  launch: 'Open',
  edit: 'Change settings',
  backup_download: 'Restore backups',
};

// ----------------------------------------------------------------------------- activity
const ACTION_TEXT: Record<string, string> = {
  'organization.created': 'created the organization',
  'organization.renamed': 'renamed the organization',
  'organization.ownership_transferred': 'transferred ownership',
  'membership.role_changed': 'changed a role',
  'membership.removed': 'removed a member',
  'membership.left': 'left',
  'invitation.created': 'invited someone',
  'invitation.revoked': 'withdrew an invitation',
  'invitation.accepted': 'joined through an invitation',
  'client.created': 'added a client',
  'client.updated': 'changed a client',
  'grant.created': 'gave access',
  'grant.removed': 'removed access',
  'profile.created': 'added a profile',
  'profile.updated': 'changed a profile',
  'profile.deleted': 'deleted a profile',
  'profile.bulk': 'changed several profiles',
  'profile.exported': 'exported profiles',
  'lease.acquired': 'opened a profile',
  'lease.released': 'closed and handed off a profile',
  'lease.revived': 'reconnected to a profile',
  'lease.taken_over': 'took over a profile',
  'lease.revoked': 'ended a session (access removed)',
  'handoff.requested': 'asked for a profile',
  'handoff.answered': 'answered a request for a profile',
  'grant.updated': 'changed access',
  'session.restoring': 'got the newest version of a profile',
  'session.running': 'started working in a profile',
  'session.stopping': 'closed a profile',
  'session.uploading': 'saved a profile’s closing backup',
  'snapshot.recovery_kept': 'kept a recovery copy of a profile',
  'snapshot.download_authorized': 'downloaded a profile snapshot',
  'workspace.imported': 'copied local profiles in',
  'access.denied': 'was refused an action',
  'org.access': 'was refused access',
};

export function ActivitySection(props: SectionProps) {
  const { backend, orgId, notify } = props;
  const events = useResource<Page<AuditEvent>>(backend, `/v1/orgs/${orgId}/audit-events`, notify, [
    ['limit', '100'],
  ]);
  const members = useResource<Page<Member>>(backend, `/v1/orgs/${orgId}/members`, notify, [['limit', '100']]);
  const name = new Map((members.data?.items ?? []).map((m) => [m.user_id, m.display_name]));
  return (
    <section className="stack" aria-labelledby="org-activity-title">
      <h2 id="org-activity-title">Activity</h2>
      <p className="muted small">
        Who did what and when, including refused attempts. Never passwords, tokens or browsing history.
      </p>
      {events.stale !== false && <Stale at={events.stale} />}
      {events.data === null ? (
        <p role="status">Loading…</p>
      ) : (
        <table className="simple records">
          <caption className="pb-sr-only">Recent activity</caption>
          <thead>
            <tr>
              <th scope="col">When</th>
              <th scope="col">Who</th>
              <th scope="col">What</th>
              <th scope="col">Result</th>
            </tr>
          </thead>
          <tbody>
            {events.data.items.map((e) => (
              <tr key={e.id}>
                <td>{when(e.created_at)}</td>
                <td>{e.actor_user_id ? (name.get(e.actor_user_id) ?? 'A former member') : 'Unknown'}</td>
                <td>{ACTION_TEXT[e.action] ?? e.action}</td>
                <td>
                  {e.outcome === 'success' ? (
                    'Done'
                  ) : (
                    <span className="error">{e.outcome === 'denied' ? 'Refused' : 'Failed'}</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

// ----------------------------------------------------------------------------- settings
export function SettingsSection(
  props: SectionProps & { org: Organization; app: AppView; onChanged: () => void },
) {
  const { backend, orgId, role, notify, offline, org } = props;
  const [renaming, setRenaming] = useState(false);
  const [copying, setCopying] = useState(false);
  return (
    <section className="stack" aria-labelledby="org-settings-title">
      <h2 id="org-settings-title">Settings</h2>
      <dl className="facts">
        <dt>Name</dt>
        <dd>{org.name}</dd>
        <dt>Created</dt>
        <dd>{when(org.created_at)}</dd>
        <dt>Your role</dt>
        <dd>{ROLE_LABEL[org.role]}</dd>
      </dl>
      <div className="row">
        {can(role, 'org.update') && (
          <button type="button" className="pb-button" disabled={offline} onClick={() => setRenaming(true)}>
            Rename organization
          </button>
        )}
        {can(role, 'profile.create') && can(role, 'clients.manage') && (
          <button type="button" className="pb-button" disabled={offline} onClick={() => setCopying(true)}>
            Copy profiles from this computer…
          </button>
        )}
      </div>
      {renaming && (
        <RenameDialog
          title="Rename organization"
          label="Organization name"
          initial={org.name}
          onClose={() => setRenaming(false)}
          onSave={async (next) => {
            try {
              await send(backend, 'PATCH', `/v1/orgs/${orgId}`, { name: next }, org.version);
              setRenaming(false);
              props.onChanged();
            } catch (err) {
              notify(errorMessage(err), 'error');
            }
          }}
        />
      )}
      {copying && (
        <CopyWorkspaceDialog
          backend={backend}
          orgId={orgId}
          orgName={org.name}
          app={props.app}
          notify={notify}
          onClose={() => setCopying(false)}
        />
      )}
    </section>
  );
}

/** Local workspace -> organization: choose, preview (dry run), map clients, copy. Local records stay unchanged. */
function CopyWorkspaceDialog(props: {
  backend: Backend;
  orgId: string;
  orgName: string;
  app: AppView;
  notify: Notify;
  onClose: () => void;
}) {
  const { backend, orgId, notify } = props;
  const [workspace, setWorkspace] = useState(
    props.app.active_workspace_id ?? props.app.workspaces[0]?.id ?? '',
  );
  const [plan, setPlan] = useState<OrgImportView | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [result, setResult] = useState<OrgImportView | null>(null);
  const [busy, setBusy] = useState(false);
  const orgClients = useResource<Page<OrgClient>>(backend, `/v1/orgs/${orgId}/clients`, notify, [
    ['limit', '100'],
  ]);

  const preview = async (map = mapping) => {
    setBusy(true);
    try {
      const res = await backend.account.orgImport(workspace, orgId, true, map);
      if (res.status >= 400)
        notify((res.body as { message?: string })?.message ?? 'The preview failed.', 'error');
      else setPlan(res);
    } catch (e) {
      notify(errorMessage(e), 'error');
    }
    setBusy(false);
  };
  const commit = async () => {
    setBusy(true);
    try {
      const res = await backend.account.orgImport(workspace, orgId, false, mapping);
      if (res.status >= 400)
        notify((res.body as { message?: string })?.message ?? 'The copy failed.', 'error');
      else setResult(res);
    } catch (e) {
      notify(errorMessage(e), 'error');
    }
    setBusy(false);
  };

  type PlanBody = { clients: { ref: string; client_id: string | null; outcome: string }[] };
  const planned = new Map(((plan?.body as PlanBody | undefined)?.clients ?? []).map((c) => [c.ref, c]));

  let content: ReactNode;
  if (result) {
    content = (
      <div className="stack">
        <p role="status">
          Copied {plural(result.linked, 'profile')} into {props.orgName}. The profiles on this computer are
          unchanged and still open from here; they are marked as copied.
        </p>
        <div className="row row--end">
          <button type="button" className="pb-button" data-variant="primary" onClick={props.onClose}>
            Done
          </button>
        </div>
      </div>
    );
  } else if (!plan) {
    content = (
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void preview();
        }}
      >
        <label>
          Local workspace
          <select value={workspace} onChange={(e) => setWorkspace(e.target.value)}>
            {props.app.workspaces.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        </label>
        <p className="muted small">
          Copies names, clients and notes of the workspace's active profiles. Browser data (sign-ins, cookies)
          stays on this computer. Nothing is copied until you confirm the preview.
        </p>
        <div className="row row--end">
          <button type="button" className="pb-button" onClick={props.onClose}>
            Cancel
          </button>
          <button type="submit" className="pb-button" data-variant="primary" disabled={busy || !workspace}>
            Preview
          </button>
        </div>
      </form>
    );
  } else {
    content = (
      <div className="stack">
        <p>
          {plural(plan.profiles, 'profile')} will be added to {props.orgName} as new organization profiles.
        </p>
        {plan.clients.length > 0 && (
          <table className="simple records">
            <caption>Clients</caption>
            <thead>
              <tr>
                <th scope="col">On this computer</th>
                <th scope="col">In {props.orgName}</th>
              </tr>
            </thead>
            <tbody>
              {plan.clients.map((c) => {
                const p = planned.get(c.ref);
                return (
                  <tr key={c.ref}>
                    <th scope="row">{c.name}</th>
                    <td>
                      <select
                        aria-label={`Client for ${c.name}`}
                        value={mapping[c.ref] ?? ''}
                        onChange={(e) => {
                          const next = { ...mapping };
                          if (e.target.value) next[c.ref] = e.target.value;
                          else delete next[c.ref];
                          setMapping(next);
                          void preview(next);
                        }}
                      >
                        <option value="">
                          {p?.outcome === 'existing'
                            ? 'Use the client with the same name'
                            : 'Create a new client'}
                        </option>
                        {(orgClients.data?.items ?? []).map((oc) => (
                          <option key={oc.id} value={oc.id}>
                            Put into {oc.name}
                          </option>
                        ))}
                      </select>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        <div className="row row--end">
          <button type="button" className="pb-button" onClick={() => setPlan(null)}>
            Back
          </button>
          <button type="button" className="pb-button" data-variant="primary" disabled={busy} onClick={commit}>
            Copy {plural(plan.profiles, 'profile')}
          </button>
        </div>
      </div>
    );
  }
  return (
    <Dialog title={`Copy profiles into ${props.orgName}`} onClose={props.onClose} wide>
      {content}
    </Dialog>
  );
}
