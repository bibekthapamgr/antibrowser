/**
 * R4 portal Team page, with the R3 semantics (ADR-0022): members and pending invitations; inviting is e-mail → role
 * preset → which profiles (all / a folder / selected; future profiles only when chosen) → a preview from the server
 * → send. Presets are labels over a role and granular grants; a Member opens and uses only.
 */
import type {
  AccessPreview,
  AccessScope,
  GrantCapability,
  Invitation,
  Member,
  Organization,
  Profile,
} from '@pb/contracts/resources';
import type { Folder } from '@pb/contracts/workspace';
import { type FormEvent, useId, useState } from 'react';
import type { PortalApi } from './api.ts';
import { Card, can, day, ErrorBox, Loading, ROLE_NAME, useLoad, usePageHeading } from './common.tsx';

interface Preset {
  id: string;
  role: 'admin' | 'operator' | 'viewer' | 'billing';
  label: string;
  help: string;
  caps: GrantCapability[] | null;
}
const PRESETS: Preset[] = [
  {
    id: 'member',
    role: 'operator',
    label: 'Member',
    help: 'Opens and uses the profiles you choose. No editing, backup downloads, deleting, sharing or billing.',
    caps: ['launch'],
  },
  {
    id: 'member_edit',
    role: 'operator',
    label: 'Member who can edit',
    help: 'Also changes the settings of those profiles.',
    caps: ['launch', 'edit'],
  },
  {
    id: 'viewer',
    role: 'viewer',
    label: 'Viewer',
    help: 'Sees the profiles you choose; cannot open them.',
    caps: [],
  },
  {
    id: 'admin',
    role: 'admin',
    label: 'Admin',
    help: 'Every profile; manages members and access. No billing.',
    caps: null,
  },
  {
    id: 'billing',
    role: 'billing',
    label: 'Billing manager',
    help: 'Subscription and invoices only.',
    caps: null,
  },
];
const CAP_TEXT: Record<GrantCapability, string> = {
  launch: 'open and use them',
  edit: 'change their settings',
  backup_download: 'restore and download their backups',
};
const capsText = (c: GrantCapability[]) =>
  c.length ? c.map((x) => CAP_TEXT[x]).join(', ') : 'see them only';

interface Choice {
  kind: 'all' | 'folder' | 'profiles';
  folderId: string;
  future: boolean;
  ids: string[];
}
const scopeOf = (c: Choice): AccessScope | null =>
  c.kind === 'all'
    ? { kind: 'all', include_future: c.future }
    : c.kind === 'folder'
      ? c.folderId
        ? { kind: 'folder', folder_id: c.folderId, include_future: c.future }
        : null
      : c.ids.length
        ? { kind: 'profiles', profile_ids: c.ids.slice(0, 500) }
        : null;

async function all<T>(api: PortalApi, path: string): Promise<T[]> {
  const out: T[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < 20; i++) {
    const page: { items: T[]; next_cursor: string | null } = await api.request(
      'GET',
      `${path}${path.includes('?') ? '&' : '?'}limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
    );
    out.push(...page.items);
    cursor = page.next_cursor;
    if (!cursor) break;
  }
  return out;
}

function ScopePicker(props: { api: PortalApi; org: string; value: Choice; onChange: (c: Choice) => void }) {
  const { value: v, onChange } = props;
  const data = useLoad(
    async () => ({
      profiles: await all<Profile>(props.api, `/orgs/${props.org}/profiles`),
      folders: await all<Folder>(props.api, `/orgs/${props.org}/folders`).catch(() => [] as Folder[]),
    }),
    [props.api, props.org],
  );
  const [q, setQ] = useState('');
  const name = useId();
  const set = (p: Partial<Choice>) => onChange({ ...v, ...p });
  const folders = data.data?.folders ?? [];
  const shown = (data.data?.profiles ?? []).filter((p) =>
    p.name.toLowerCase().includes(q.trim().toLowerCase()),
  );
  return (
    <fieldset className="stack">
      <legend>Which profiles</legend>
      {data.error !== null && <ErrorBox error={data.error} retry={data.reload} />}
      <label className="check">
        <input type="radio" name={name} checked={v.kind === 'all'} onChange={() => set({ kind: 'all' })} />
        <span>All profiles in this workspace</span>
      </label>
      <label className="check">
        <input
          type="radio"
          name={name}
          checked={v.kind === 'folder'}
          disabled={folders.length === 0}
          onChange={() => set({ kind: 'folder', folderId: v.folderId || folders[0]?.id || '' })}
        />
        <span>The profiles in a folder{folders.length === 0 ? ' (no folders yet)' : ''}</span>
      </label>
      {v.kind === 'folder' && (
        <label>
          Folder
          <select value={v.folderId} onChange={(e) => set({ folderId: e.target.value })}>
            {folders.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {(v.kind === 'all' || v.kind === 'folder') && (
        <label className="check">
          <input type="checkbox" checked={v.future} onChange={(e) => set({ future: e.target.checked })} />
          <span>Also profiles added later</span>
        </label>
      )}
      <label className="check">
        <input
          type="radio"
          name={name}
          checked={v.kind === 'profiles'}
          onChange={() => set({ kind: 'profiles' })}
        />
        <span>Selected profiles</span>
      </label>
      {v.kind === 'profiles' &&
        (data.loading && !data.data ? (
          <Loading what="Loading profiles…" />
        ) : (
          <>
            <label>
              Find a profile
              <input type="search" value={q} onChange={(e) => setQ(e.target.value)} />
            </label>
            <p className="muted small" aria-live="polite">
              {v.ids.length} selected
            </p>
            <ul className="pick-list" aria-label="Profiles to share">
              {shown.map((p) => (
                <li key={p.id}>
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={v.ids.includes(p.id)}
                      onChange={(e) =>
                        set({ ids: e.target.checked ? [...v.ids, p.id] : v.ids.filter((x) => x !== p.id) })
                      }
                    />
                    <span>{p.name}</span>
                  </label>
                </li>
              ))}
              {shown.length === 0 && <li className="muted">No profiles match.</li>}
            </ul>
          </>
        ))}
    </fieldset>
  );
}

function PreviewBox({ p, who }: { p: AccessPreview; who: string }) {
  return (
    <section className="card card--inner" aria-label="Access preview">
      <p>
        <strong>{who}</strong> will reach <strong>{p.profile_count} profiles</strong>
        {p.includes_future ? ', and profiles added there later' : ' (only these; not ones added later)'} and
        can {capsText(p.capabilities)}.
      </p>
      {p.profiles.length > 0 && (
        <ul className="preview-list">
          {p.profiles.map((x) => (
            <li key={x.id}>{x.name}</li>
          ))}
        </ul>
      )}
    </section>
  );
}

function InviteForm(props: {
  api: PortalApi;
  org: Organization;
  onSent: (code: string, email: string, mailed: boolean) => void;
}) {
  const { api, org } = props;
  const [step, setStep] = useState<'details' | 'scope' | 'review'>('details');
  const [email, setEmail] = useState('');
  const [presetId, setPresetId] = useState('member');
  const [choice, setChoice] = useState<Choice>({ kind: 'profiles', folderId: '', future: false, ids: [] });
  const [preview, setPreview] = useState<AccessPreview | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const pname = useId();
  const presets = PRESETS.filter((p) => p.role !== 'billing' || org.role === 'owner');
  const preset = presets.find((p) => p.id === presetId) ?? (presets[0] as Preset);
  const granted = preset.role === 'operator' || preset.role === 'viewer';
  const caps = preset.role === 'operator' ? (preset.caps ?? ['launch']) : [];
  const scope = scopeOf(choice);
  const submitDetails = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (granted) setStep('scope');
    else setStep('review');
  };
  const toReview = async () => {
    if (!scope) return;
    setBusy(true);
    setError(null);
    try {
      setPreview(
        await api.request<AccessPreview>('POST', `/orgs/${org.id}/access/preview`, {
          scope,
          capabilities: caps,
        }),
      );
      setStep('review');
    } catch (e) {
      setError(e);
    }
    setBusy(false);
  };
  const send = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.request<{ invitation: Invitation; token: string; email_delivery?: string }>(
        'POST',
        `/orgs/${org.id}/invitations`,
        {
          email: email.trim(),
          role: preset.role,
          ...(granted && scope ? { access: { scope, capabilities: caps } } : {}),
        },
      );
      props.onSent(r.token, r.invitation.email, r.email_delivery === 'queued');
      setStep('details');
      setEmail('');
      setPreview(null);
      setChoice({ kind: 'profiles', folderId: '', future: false, ids: [] });
    } catch (e) {
      setError(e);
    }
    setBusy(false);
  };
  return (
    <Card title="Invite someone" id="invite-title">
      <ol className="steps" aria-label="Steps">
        <li aria-current={step === 'details' ? 'step' : undefined}>E-mail and role</li>
        {granted && <li aria-current={step === 'scope' ? 'step' : undefined}>Profiles</li>}
        <li aria-current={step === 'review' ? 'step' : undefined}>Review</li>
      </ol>
      {step === 'details' && (
        <form className="stack" onSubmit={submitDetails}>
          <label>
            E-mail address
            <input
              type="email"
              required
              maxLength={254}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </label>
          <fieldset className="stack">
            <legend>Role</legend>
            {presets.map((p) => (
              <label key={p.id} className="check">
                <input
                  type="radio"
                  name={pname}
                  checked={presetId === p.id}
                  onChange={() => setPresetId(p.id)}
                />
                <span>
                  <strong>{p.label}</strong> <span className="muted small">— {p.help}</span>
                </span>
              </label>
            ))}
          </fieldset>
          <div className="actions">
            <button type="submit" className="primary">
              Next
            </button>
          </div>
        </form>
      )}
      {step === 'scope' && (
        <div className="stack">
          <ScopePicker api={api} org={org.id} value={choice} onChange={setChoice} />
          <div className="actions">
            <button type="button" onClick={() => setStep('details')}>
              Back
            </button>
            <button type="button" className="primary" disabled={busy || !scope} onClick={toReview}>
              Preview access
            </button>
          </div>
        </div>
      )}
      {step === 'review' && (
        <div className="stack">
          <p>
            Invite <strong>{email.trim()}</strong> as <strong>{preset.label}</strong>.
          </p>
          {granted && preview ? (
            <PreviewBox p={preview} who={email.trim()} />
          ) : (
            <p className="muted">{preset.help}</p>
          )}
          <p className="muted small">
            Each person uses one seat of this workspace’s plan; they need no plan of their own.
          </p>
          <div className="actions">
            <button type="button" onClick={() => setStep(granted ? 'scope' : 'details')}>
              Back
            </button>
            <button type="button" className="primary" disabled={busy} onClick={send}>
              Send invitation
            </button>
          </div>
        </div>
      )}
      {error !== null && <ErrorBox error={error} />}
    </Card>
  );
}

function AccessEditor(props: {
  api: PortalApi;
  org: string;
  member: Member;
  onDone: (msg: string) => void;
  onCancel: () => void;
}) {
  const { api, member: m } = props;
  const [choice, setChoice] = useState<Choice>({ kind: 'profiles', folderId: '', future: false, ids: [] });
  const [edit, setEdit] = useState(false);
  const [preview, setPreview] = useState<AccessPreview | null>(null);
  const [error, setError] = useState<unknown>(null);
  const caps: GrantCapability[] = m.role === 'operator' ? (edit ? ['launch', 'edit'] : ['launch']) : [];
  const scope = scopeOf(choice);
  return (
    <Card title={`Access of ${m.display_name}`} id="access-title">
      {!preview ? (
        <div className="stack">
          <ScopePicker api={api} org={props.org} value={choice} onChange={setChoice} />
          {m.role === 'operator' && (
            <label className="check">
              <input type="checkbox" checked={edit} onChange={(e) => setEdit(e.target.checked)} />
              <span>Can also change profile settings</span>
            </label>
          )}
          <div className="actions">
            <button type="button" onClick={props.onCancel}>
              Cancel
            </button>
            <button
              type="button"
              className="primary"
              disabled={!scope}
              onClick={async () => {
                try {
                  setPreview(
                    await api.request<AccessPreview>('POST', `/orgs/${props.org}/access/preview`, {
                      scope,
                      capabilities: caps,
                    }),
                  );
                } catch (e) {
                  setError(e);
                }
              }}
            >
              Preview access
            </button>
          </div>
        </div>
      ) : (
        <div className="stack">
          <PreviewBox p={preview} who={m.display_name} />
          <p className="muted small">
            This replaces their current access. Profiles they no longer reach close in their app.
          </p>
          <div className="actions">
            <button type="button" onClick={() => setPreview(null)}>
              Back
            </button>
            <button
              type="button"
              className="primary"
              onClick={async () => {
                try {
                  await api.request('PUT', `/orgs/${props.org}/members/${m.user_id}/access`, {
                    scope,
                    capabilities: caps,
                  });
                  props.onDone(`${m.display_name}’s access was changed.`);
                } catch (e) {
                  setError(e);
                }
              }}
            >
              Save access
            </button>
          </div>
        </div>
      )}
      {error !== null && <ErrorBox error={error} />}
    </Card>
  );
}

export function TeamPage(props: { api: PortalApi; org: Organization; me: string }) {
  const { api, org } = props;
  const h = usePageHeading('Team');
  const [nonce, setNonce] = useState(0);
  const members = useLoad(() => all<Member>(api, `/orgs/${org.id}/members`), [api, org.id, nonce]);
  const manage = can(org.role, 'members.manage');
  const invites = useLoad(
    () =>
      manage ? all<Invitation>(api, `/orgs/${org.id}/invitations`) : Promise.resolve([] as Invitation[]),
    [api, org.id, nonce, manage],
  );
  const [created, setCreated] = useState<{ code: string; email: string; mailed: boolean } | null>(null);
  const [editing, setEditing] = useState<Member | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const act = async (fn: () => Promise<unknown>, done: string) => {
    setError(null);
    try {
      await fn();
      setMessage(done);
      setNonce((n) => n + 1);
    } catch (e) {
      setError(e);
    }
  };
  if (!can(org.role, 'members.read'))
    return (
      <>
        <h1 ref={h} tabIndex={-1}>
          Team
        </h1>
        <Card>
          <p>Owners and admins manage who is in {org.name} and what each person can open.</p>
        </Card>
      </>
    );
  return (
    <>
      <h1 ref={h} tabIndex={-1}>
        Team
      </h1>
      {message && (
        <p className="notice" role="status">
          {message}
        </p>
      )}
      {error !== null && <ErrorBox error={error} />}
      <Card title="Members" id="members-title">
        {members.loading && !members.data && <Loading />}
        {members.error !== null && <ErrorBox error={members.error} retry={members.reload} />}
        {members.data && (
          <ul className="people">
            {members.data.map((m) => (
              <li key={m.user_id}>
                <div>
                  <strong>{m.display_name}</strong>
                  {m.user_id === props.me && <span className="badge">You</span>}
                  <div className="muted small">
                    {m.email ?? ''} · {ROLE_NAME[m.role]} · joined {day(m.created_at)}
                  </div>
                </div>
                <div className="row-actions">
                  {can(org.role, 'grants.manage') && (m.role === 'operator' || m.role === 'viewer') && (
                    <button type="button" onClick={() => setEditing(m)}>
                      Access…<span className="sr-only"> of {m.display_name}</span>
                    </button>
                  )}
                  {manage && m.user_id !== props.me && (m.role !== 'owner' || org.role === 'owner') && (
                    <button
                      type="button"
                      onClick={() =>
                        window.confirm(`Remove ${m.display_name}? Their access ends at their next action.`) &&
                        void act(
                          () => api.request('DELETE', `/orgs/${org.id}/members/${m.user_id}`),
                          `${m.display_name} was removed. What is already on their computers stays there.`,
                        )
                      }
                    >
                      Remove<span className="sr-only"> {m.display_name}</span>
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
      {editing && (
        <AccessEditor
          api={api}
          org={org.id}
          member={editing}
          onCancel={() => setEditing(null)}
          onDone={(msg) => {
            setEditing(null);
            setMessage(msg);
          }}
        />
      )}
      {manage && (
        <InviteForm
          api={api}
          org={org}
          onSent={(code, email, mailed) => {
            setCreated({ code, email, mailed });
            setNonce((n) => n + 1);
          }}
        />
      )}
      {created && (
        <section className="notice stack" aria-label="Invitation created" role="status">
          <p>
            {created.mailed ? (
              <>
                Invitation e-mailed to <strong>{created.email}</strong>.
              </>
            ) : (
              <>
                Send this code to <strong>{created.email}</strong>; it is shown only now.
              </>
            )}{' '}
            It works once, only for that address.
          </p>
          {!created.mailed && <p className="mono">{created.code}</p>}
          <button type="button" onClick={() => setCreated(null)}>
            Done
          </button>
        </section>
      )}
      {manage && (
        <Card title="Pending invitations" id="invitations-title">
          {invites.loading && !invites.data && <Loading />}
          {invites.error !== null && <ErrorBox error={invites.error} retry={invites.reload} />}
          {invites.data && invites.data.filter((i) => i.status === 'open').length === 0 && (
            <p className="muted">No invitations waiting.</p>
          )}
          <ul className="people">
            {(invites.data ?? [])
              .filter((i) => i.status === 'open')
              .map((i) => (
                <li key={i.id}>
                  <div>
                    <strong>{i.email}</strong>
                    <div className="muted small">
                      {ROLE_NAME[i.role]} · until {day(i.expires_at)}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() =>
                      void act(
                        () => api.request('POST', `/orgs/${org.id}/invitations/${i.id}/revoke`),
                        `The invitation for ${i.email} was withdrawn.`,
                      )
                    }
                  >
                    Withdraw<span className="sr-only"> the invitation for {i.email}</span>
                  </button>
                </li>
              ))}
          </ul>
        </Card>
      )}
    </>
  );
}
