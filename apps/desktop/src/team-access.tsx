/**
 * R3 Team page (ADR-0022): members, pending invitations and what each person can reach, in one place. Inviting is one
 * short flow — e-mail → role preset → all profiles / a folder / selected profiles → a preview of exactly what they
 * will get → send. Presets are only labels: what is stored is the role plus granular grants (profile, folder, whole
 * workspace) with capabilities. A Member opens and uses profiles; editing, downloading backups, deleting, sharing and
 * billing stay off unless chosen. A folder or "all profiles" includes future profiles only when that rule is chosen
 * and shown in the preview.
 */

import type {
  AccessPreview,
  AccessScope,
  Grant,
  GrantCapability,
  Invitation,
  Member,
  Profile as OrgProfile,
  Role,
} from '@pb/contracts/resources';
import type { Folder } from '@pb/contracts/workspace';
import { type ReactNode, useEffect, useId, useState } from 'react';
import type { Backend } from './backend/types.ts';
import { errorMessage } from './backend/types.ts';
import { can, get, getAll, ROLE_LABEL, send } from './cloud.ts';
import { Dialog } from './components.tsx';
import {
  AccessSection,
  type CreatedInvitation,
  InvitationsSection,
  MembersSection,
  type SectionProps,
} from './org.tsx';
import { type Notify, plural } from './status.tsx';

type InvitableRole = 'admin' | 'operator' | 'viewer' | 'billing';
interface Preset {
  id: string;
  role: InvitableRole;
  label: string;
  help: string;
  /** Capabilities of the grants (operators); null: the role reaches profiles by itself, or none at all. */
  caps: GrantCapability[] | null;
}
export const PRESETS: Preset[] = [
  {
    id: 'member',
    role: 'operator',
    label: 'Member',
    help: 'Opens and uses the profiles you choose. Cannot change their settings, download backups, delete, share or manage billing.',
    caps: ['launch'],
  },
  {
    id: 'member_edit',
    role: 'operator',
    label: 'Member who can edit',
    help: 'Opens and uses the profiles you choose, and can change their settings. No deleting, sharing or billing.',
    caps: ['launch', 'edit'],
  },
  {
    id: 'viewer',
    role: 'viewer',
    label: 'Viewer',
    help: 'Sees the profiles you choose and who has them open. Cannot open them.',
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
    help: 'The subscription and invoices only. No profiles.',
    caps: null,
  },
];
const CAP_TEXT: Record<GrantCapability, string> = {
  launch: 'open and use them',
  edit: 'change their settings',
  backup_download: 'restore and download their backups',
};
export const capsText = (caps: GrantCapability[]): string =>
  caps.length === 0 ? 'see them only (not open them)' : caps.map((c) => CAP_TEXT[c]).join(', ');

// ------------------------------------------------------------------------------------------------ scope picker
export interface ScopeChoice {
  kind: 'all' | 'folder' | 'profiles';
  folderId: string;
  includeFuture: boolean;
  ids: string[];
}
export const emptyChoice = (): ScopeChoice => ({
  kind: 'profiles',
  folderId: '',
  includeFuture: false,
  ids: [],
});
export function scopeOf(c: ScopeChoice): AccessScope | null {
  if (c.kind === 'all') return { kind: 'all', include_future: c.includeFuture };
  if (c.kind === 'folder')
    return c.folderId ? { kind: 'folder', folder_id: c.folderId, include_future: c.includeFuture } : null;
  return c.ids.length > 0 ? { kind: 'profiles', profile_ids: c.ids.slice(0, 500) } : null;
}

/** All profiles / a folder / selected profiles, with the explicit "future profiles too" rule. */
export function ScopePicker(props: {
  backend: Backend;
  orgId: string;
  value: ScopeChoice;
  onChange: (c: ScopeChoice) => void;
  notify: Notify;
}) {
  const { backend, orgId, value, onChange, notify } = props;
  const [profiles, setProfiles] = useState<OrgProfile[] | null>(null);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [filter, setFilter] = useState('');
  const name = useId();
  useEffect(() => {
    let live = true;
    Promise.all([
      getAll<OrgProfile>(backend, `/v1/orgs/${orgId}/profiles`),
      getAll<Folder>(backend, `/v1/orgs/${orgId}/folders`).catch(() => ({ items: [] as Folder[] })),
    ])
      .then(([p, f]) => {
        if (!live) return;
        setProfiles(p.items);
        setFolders(f.items);
      })
      .catch((e) => live && notify(errorMessage(e, 'Could not load the profiles.'), 'error'));
    return () => {
      live = false;
    };
  }, [backend, orgId, notify]);
  const set = (patch: Partial<ScopeChoice>) => onChange({ ...value, ...patch });
  const shown = (profiles ?? []).filter((p) => p.name.toLowerCase().includes(filter.trim().toLowerCase()));
  const chosen = new Set(value.ids);
  return (
    <fieldset className="stack">
      <legend>Which profiles</legend>
      <label className="choice">
        <input
          type="radio"
          name={name}
          checked={value.kind === 'all'}
          onChange={() => set({ kind: 'all' })}
        />
        All profiles in this workspace
      </label>
      <label className="choice">
        <input
          type="radio"
          name={name}
          checked={value.kind === 'folder'}
          disabled={folders.length === 0}
          onChange={() => set({ kind: 'folder', folderId: value.folderId || folders[0]?.id || '' })}
        />
        The profiles in a folder{folders.length === 0 ? ' (no folders yet)' : ''}
      </label>
      {value.kind === 'folder' && (
        <label>
          Folder
          <select value={value.folderId} onChange={(e) => set({ folderId: e.target.value })}>
            {folders.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name} ({plural(f.profile_count, 'profile')})
              </option>
            ))}
          </select>
        </label>
      )}
      {(value.kind === 'all' || value.kind === 'folder') && (
        <label className="choice">
          <input
            type="checkbox"
            checked={value.includeFuture}
            onChange={(e) => set({ includeFuture: e.target.checked })}
          />
          Also profiles added {value.kind === 'all' ? 'to this workspace' : 'to this folder'} later
        </label>
      )}
      <label className="choice">
        <input
          type="radio"
          name={name}
          checked={value.kind === 'profiles'}
          onChange={() => set({ kind: 'profiles' })}
        />
        Selected profiles
      </label>
      {value.kind === 'profiles' &&
        (profiles === null ? (
          <p role="status">Loading profiles…</p>
        ) : (
          <div className="stack">
            <div className="row">
              <label className="grow">
                Find a profile
                <input type="search" value={filter} onChange={(e) => setFilter(e.target.value)} />
              </label>
              <span className="muted small" aria-live="polite">
                {plural(chosen.size, 'profile')} selected
              </span>
            </div>
            <ul className="pick-list" aria-label="Profiles to share">
              {shown.map((p) => (
                <li key={p.id}>
                  <label className="choice">
                    <input
                      type="checkbox"
                      checked={chosen.has(p.id)}
                      onChange={(e) => {
                        const next = new Set(chosen);
                        if (e.target.checked) next.add(p.id);
                        else next.delete(p.id);
                        set({ ids: [...next] });
                      }}
                    />
                    {p.name}
                  </label>
                </li>
              ))}
              {shown.length === 0 && <li className="muted">No profiles match.</li>}
            </ul>
          </div>
        ))}
    </fieldset>
  );
}

/** What a choice reaches now (and whether it follows future profiles), asked from the server before granting. */
function PreviewPanel(props: { preview: AccessPreview; who: string }) {
  const { preview: p } = props;
  return (
    <section className="card stack" aria-label="Access preview">
      <p>
        <strong>{props.who}</strong> will reach <strong>{plural(p.profile_count, 'profile')}</strong>
        {p.includes_future ? ', and profiles added there later' : ' (only these; not ones added later)'} and
        can {capsText(p.capabilities)}.
      </p>
      {p.profiles.length > 0 && (
        <ul className="preview-list">
          {p.profiles.map((x) => (
            <li key={x.id}>{x.name}</li>
          ))}
          {p.profile_count > p.profiles.length && (
            <li className="muted">and {plural(p.profile_count - p.profiles.length, 'more profile')}</li>
          )}
        </ul>
      )}
    </section>
  );
}

function Steps({ step, labels }: { step: number; labels: string[] }) {
  return (
    <ol className="steps" aria-label="Steps">
      {labels.map((l, i) => (
        <li key={l} aria-current={i === step ? 'step' : undefined} className={i < step ? 'done' : undefined}>
          {l}
        </li>
      ))}
    </ol>
  );
}

// ------------------------------------------------------------------------------------------------ invite wizard
export function InviteWizard(props: {
  backend: Backend;
  orgId: string;
  role: Role;
  notify: Notify;
  onClose: () => void;
  onSent: (created: CreatedInvitation) => void;
}) {
  const { backend, orgId, notify } = props;
  const [step, setStep] = useState(0);
  const [email, setEmail] = useState('');
  const [days, setDays] = useState('7');
  const [presetId, setPresetId] = useState('member');
  const [downloads, setDownloads] = useState(false);
  const [choice, setChoice] = useState<ScopeChoice>(emptyChoice);
  const [preview, setPreview] = useState<AccessPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const presetName = useId();
  // Owners invite anyone; admins cannot hand out billing.
  const presets = PRESETS.filter((p) => p.role !== 'billing' || props.role === 'owner');
  const preset = presets.find((p) => p.id === presetId) ?? (presets[0] as Preset);
  const granted = preset.role === 'operator' || preset.role === 'viewer';
  const caps: GrantCapability[] =
    preset.role === 'operator'
      ? [...(preset.caps ?? []), ...(downloads ? (['backup_download'] as const) : [])]
      : [];
  const scope = scopeOf(choice);
  const labels = granted ? ['E-mail', 'Role', 'Profiles', 'Review'] : ['E-mail', 'Role', 'Review'];
  const reviewStep = labels.length - 1;

  const toReview = async () => {
    if (!granted) {
      setStep(reviewStep);
      return;
    }
    if (!scope) return;
    setBusy(true);
    try {
      const res = await send<AccessPreview>(backend, 'POST', `/v1/orgs/${orgId}/access/preview`, {
        scope,
        capabilities: caps,
      });
      setPreview(res.data);
      setStep(reviewStep);
    } catch (e) {
      notify(errorMessage(e), 'error');
    }
    setBusy(false);
  };
  const sendInvite = async () => {
    setBusy(true);
    try {
      const res = await send<{ invitation: Invitation; token: string; email_delivery?: string }>(
        backend,
        'POST',
        `/v1/orgs/${orgId}/invitations`,
        {
          email: email.trim(),
          role: preset.role,
          expires_in_days: Number(days),
          ...(granted && scope ? { access: { scope, capabilities: caps } } : {}),
        },
      );
      props.onSent({
        email: res.data.invitation.email,
        code: res.data.token,
        expires: res.data.invitation.expires_at,
        emailed: res.data.email_delivery === 'queued',
      });
    } catch (e) {
      notify(errorMessage(e), 'error');
      setBusy(false);
    }
  };
  const validEmail = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim());

  let body: ReactNode;
  if (step === 0)
    body = (
      <>
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
        <label>
          The invitation is valid for
          <select value={days} onChange={(e) => setDays(e.target.value)}>
            {['1', '3', '7', '14', '30'].map((d) => (
              <option key={d} value={d}>
                {d === '1' ? '1 day' : `${d} days`}
              </option>
            ))}
          </select>
        </label>
        <p className="muted small">
          Only someone signed in with this e-mail address can accept. Each person uses one seat of this
          workspace’s plan; they do not need a plan of their own.
        </p>
      </>
    );
  else if (step === 1)
    body = (
      <fieldset className="stack">
        <legend>Role</legend>
        {presets.map((p) => (
          <label key={p.id} className="choice choice--block">
            <input
              type="radio"
              name={presetName}
              checked={presetId === p.id}
              onChange={() => setPresetId(p.id)}
            />
            <span>
              <strong>{p.label}</strong>
              <span className="muted small"> — {p.help}</span>
            </span>
          </label>
        ))}
        {preset.role === 'operator' && (
          <label className="choice">
            <input type="checkbox" checked={downloads} onChange={(e) => setDownloads(e.target.checked)} />
            Also let them restore and download backups of these profiles
          </label>
        )}
      </fieldset>
    );
  else if (step === 2 && granted)
    body = (
      <ScopePicker backend={backend} orgId={orgId} value={choice} onChange={setChoice} notify={notify} />
    );
  else
    body = (
      <>
        <p>
          Invite <strong>{email.trim()}</strong> as <strong>{preset.label}</strong>.
        </p>
        {granted && preview ? (
          <PreviewPanel preview={preview} who={email.trim()} />
        ) : (
          <p className="muted">{preset.help}</p>
        )}
      </>
    );

  const next = () => {
    if (step === 0 && validEmail) setStep(1);
    else if (step === 1) {
      if (granted) setStep(2);
      else void toReview();
    } else if (step === 2) void toReview();
  };
  return (
    <Dialog title="Invite someone" onClose={props.onClose} initialFocus="input" wide>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          if (step === reviewStep) void sendInvite();
          else next();
        }}
      >
        <Steps step={step} labels={labels} />
        {body}
        <div className="row row--end">
          <button
            type="button"
            className="pb-button"
            onClick={() =>
              step === 0 ? props.onClose() : setStep(step === reviewStep && !granted ? 1 : step - 1)
            }
          >
            {step === 0 ? 'Cancel' : 'Back'}
          </button>
          {step < reviewStep ? (
            <button
              type="submit"
              className="pb-button"
              data-variant="primary"
              disabled={busy || (step === 0 && !validEmail) || (step === 2 && !scope)}
            >
              {step === reviewStep - 1 ? 'Preview access' : 'Next'}
            </button>
          ) : (
            <button type="submit" className="pb-button" data-variant="primary" disabled={busy}>
              Send invitation
            </button>
          )}
        </div>
      </form>
    </Dialog>
  );
}

// ------------------------------------------------------------------------------------------------ member access
/** The scope a member's grants amount to (for editing); client grants are shown as a note and replaced. */
function choiceFromGrants(grants: Grant[]): {
  choice: ScopeChoice;
  caps: GrantCapability[];
  clients: number;
} {
  const caps = [...new Set(grants.flatMap((g) => g.capabilities))] as GrantCapability[];
  const clients = grants.filter((g) => g.client_id).length;
  if (grants.some((g) => g.all_profiles))
    return { choice: { ...emptyChoice(), kind: 'all', includeFuture: true }, caps, clients };
  const folder = grants.find((g) => g.folder_id);
  if (folder?.folder_id)
    return {
      choice: { ...emptyChoice(), kind: 'folder', folderId: folder.folder_id, includeFuture: true },
      caps,
      clients,
    };
  return {
    choice: { ...emptyChoice(), ids: grants.flatMap((g) => (g.profile_id ? [g.profile_id] : [])) },
    caps,
    clients,
  };
}

export function MemberAccessDialog(props: {
  backend: Backend;
  orgId: string;
  member: Member;
  notify: Notify;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { backend, orgId, member: m, notify } = props;
  const [choice, setChoice] = useState<ScopeChoice | null>(null);
  const [clients, setClients] = useState(0);
  const [edit, setEdit] = useState(false);
  const [downloads, setDownloads] = useState(false);
  const [preview, setPreview] = useState<AccessPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const operator = m.role === 'operator';
  useEffect(() => {
    let live = true;
    getAll<Grant>(backend, `/v1/orgs/${orgId}/grants`, [['user_id', m.user_id]])
      .then((r) => {
        if (!live) return;
        const c = choiceFromGrants(r.items);
        setChoice(c.choice);
        setClients(c.clients);
        setEdit(c.caps.includes('edit'));
        setDownloads(c.caps.includes('backup_download'));
      })
      .catch((e) => {
        if (!live) return;
        setChoice(emptyChoice());
        notify(errorMessage(e), 'error');
      });
    return () => {
      live = false;
    };
  }, [backend, orgId, m.user_id, notify]);
  const caps: GrantCapability[] = operator
    ? (['launch', ...(edit ? ['edit'] : []), ...(downloads ? ['backup_download'] : [])] as GrantCapability[])
    : [];
  const scope = choice ? scopeOf(choice) : null;
  const review = async () => {
    if (!scope) return;
    setBusy(true);
    try {
      const res = await send<AccessPreview>(backend, 'POST', `/v1/orgs/${orgId}/access/preview`, {
        scope,
        capabilities: caps,
      });
      setPreview(res.data);
    } catch (e) {
      notify(errorMessage(e), 'error');
    }
    setBusy(false);
  };
  const save = async () => {
    if (!scope) return;
    setBusy(true);
    try {
      await send(backend, 'PUT', `/v1/orgs/${orgId}/members/${m.user_id}/access`, {
        scope,
        capabilities: caps,
      });
      notify(
        `${m.display_name}’s access was changed. Profiles they no longer reach are closed in their app; their computers keep what they had, but nothing new opens.`,
      );
      props.onSaved();
    } catch (e) {
      notify(errorMessage(e), 'error');
      setBusy(false);
    }
  };
  return (
    <Dialog title={`Access of ${m.display_name}`} onClose={props.onClose} wide>
      {!choice ? (
        <p role="status">Loading…</p>
      ) : preview ? (
        <div className="stack">
          <PreviewPanel preview={preview} who={m.display_name} />
          <p className="muted small">This replaces their current access.</p>
          <div className="row row--end">
            <button type="button" className="pb-button" onClick={() => setPreview(null)}>
              Back
            </button>
            <button type="button" className="pb-button" data-variant="primary" disabled={busy} onClick={save}>
              Save access
            </button>
          </div>
        </div>
      ) : (
        <div className="stack">
          <p className="muted small">
            {ROLE_LABEL[m.role]}:{' '}
            {operator ? 'opens and uses the profiles below.' : 'sees the profiles below; cannot open them.'}
          </p>
          {clients > 0 && (
            <p className="notice">
              They also have access through {plural(clients, 'client')} (Agency tools). Saving here replaces
              it.
            </p>
          )}
          <ScopePicker backend={backend} orgId={orgId} value={choice} onChange={setChoice} notify={notify} />
          {operator && (
            <fieldset className="stack">
              <legend>They can also</legend>
              <label className="choice">
                <input type="checkbox" checked={edit} onChange={(e) => setEdit(e.target.checked)} />
                Change profile settings
              </label>
              <label className="choice">
                <input type="checkbox" checked={downloads} onChange={(e) => setDownloads(e.target.checked)} />
                Restore and download backups
              </label>
            </fieldset>
          )}
          <div className="row row--end">
            <button type="button" className="pb-button" onClick={props.onClose}>
              Cancel
            </button>
            <button
              type="button"
              className="pb-button"
              data-variant="primary"
              disabled={busy || !scope}
              onClick={review}
            >
              Preview access
            </button>
          </div>
        </div>
      )}
    </Dialog>
  );
}

// ------------------------------------------------------------------------------------------------ the page
export function TeamScreen(
  props: SectionProps & {
    seats: { used: number; allowed: number | null } | null;
    onLeft: () => void;
    onChanged: () => void;
  },
) {
  const { backend, orgId, role, notify, offline } = props;
  const [inviting, setInviting] = useState(false);
  const [created, setCreated] = useState<CreatedInvitation | null>(null);
  const [editing, setEditing] = useState<Member | null>(null);
  const [nonce, setNonce] = useState(0);
  const [advanced, setAdvanced] = useState(false);
  return (
    <section className="screen stack" aria-labelledby="team-title">
      <header className="toolbar">
        <div className="toolbar__title">
          <h1 id="team-title">Team</h1>
          <p className="muted small">
            {props.seats
              ? `${plural(props.seats.used, 'seat')} used${props.seats.allowed !== null ? ` of ${props.seats.allowed}` : ''} on this workspace’s plan (members and pending invitations).`
              : 'Members use seats of this workspace’s plan; they do not need a plan of their own.'}
          </p>
        </div>
      </header>
      <MembersSection
        key={`m${nonce}`}
        {...props}
        onEditAccess={can(role, 'grants.manage') ? setEditing : undefined}
      />
      {can(role, 'members.manage') && (
        <InvitationsSection
          key={`i${nonce}`}
          {...props}
          onInvite={() => setInviting(true)}
          created={created}
          onCreatedDone={() => setCreated(null)}
        />
      )}
      {can(role, 'grants.manage') && (
        <section className="stack" aria-label="Detailed access">
          <button
            type="button"
            className="pb-button"
            aria-expanded={advanced}
            onClick={() => setAdvanced((a) => !a)}
          >
            {advanced ? 'Hide detailed access' : 'Show detailed access (each grant)'}
          </button>
          {advanced && <AccessSection key={`a${nonce}`} {...props} />}
        </section>
      )}
      {inviting && (
        <InviteWizard
          backend={backend}
          orgId={orgId}
          role={role}
          notify={notify}
          onClose={() => setInviting(false)}
          onSent={(c) => {
            setInviting(false);
            setCreated(c);
            setNonce((n) => n + 1);
            props.onChanged();
          }}
        />
      )}
      {editing && !offline && (
        <MemberAccessDialog
          backend={backend}
          orgId={orgId}
          member={editing}
          notify={notify}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            setNonce((n) => n + 1);
          }}
        />
      )}
    </section>
  );
}

/** Seats used and allowed, for the Team page (owners and billing managers can read the plan's usage). */
export async function seatUsage(
  backend: Backend,
  orgId: string,
  role: Role,
): Promise<{ used: number; allowed: number | null } | null> {
  if (!can(role, 'billing.read')) return null;
  try {
    const r = await get<{ current: { seats: number }; limits: { seats?: number | null } }>(
      backend,
      `/v1/orgs/${orgId}/billing/usage`,
    );
    return { used: r.data.current.seats, allowed: r.data.limits.seats ?? null };
  } catch {
    return null;
  }
}
