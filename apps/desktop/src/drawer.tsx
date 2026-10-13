/** Profile detail drawer: status and recovery (milestone 03) plus client, tags, favourite, notes and lifecycle (04). */
import { ClientBadge } from '@pb/ui';
import { type FormEvent, useEffect, useId, useRef, useState } from 'react';
import type {
  Backend,
  BulkAction,
  Library,
  Permission,
  ProfileStatus,
  ProfileView,
} from './backend/types.ts';
import { errorMessage, isIpcError } from './backend/types.ts';
import { Dialog } from './components.tsx';
import { nameKey, secretHint } from './notes.ts';
import { day, LAST_ERROR, type Notify, primaryAction, StatusText, when, withClient } from './status.tsx';

const PERMISSIONS: [keyof ProfileView['permissions'], string][] = [
  ['camera', 'Camera'],
  ['microphone', 'Microphone'],
  ['location', 'Location'],
];
const PERMISSION_LABEL: Record<Permission, string> = {
  ask: 'Ask each time',
  block: 'Block',
  allow: 'Allow',
};
const NEW_CLIENT = '__new__';

interface Form {
  name: string;
  client: string; // client id, '' for none, NEW_CLIENT for a new one
  newClient: string;
  tags: string[];
  urls: string;
  perms: ProfileView['permissions'];
  notes: string;
}
const formFrom = (p: ProfileView): Form => ({
  name: p.name,
  client: p.client_id ?? '',
  newClient: '',
  tags: p.tags.map((t) => t.name),
  urls: p.start_urls.join('\n'),
  perms: p.permissions,
  notes: p.notes,
});
const sameTags = (a: string[], b: string[]) =>
  a.length === b.length && a.map(nameKey).sort().join('\n') === b.map(nameKey).sort().join('\n');

export function ProfileDrawer(props: {
  backend: Backend;
  profile: ProfileView;
  library: Library | null;
  refreshKey: number;
  notify: Notify;
  onToggle: (p: ProfileView) => void;
  onSaved: (p: ProfileView) => void;
  onBulk: (action: BulkAction, p: ProfileView) => void;
  onCreated: (p: ProfileView) => void;
  onLibraryChanged: () => void;
  onClose: () => void;
}) {
  const { backend, notify, library } = props;
  const [status, setStatus] = useState<ProfileStatus | null>(null);
  const p = status?.profile ?? props.profile;
  const [base, setBase] = useState<ProfileView>(p);
  const [form, setForm] = useState<Form>(() => formFrom(p));
  const [error, setError] = useState<string | null>(null);
  const [confirmFresh, setConfirmFresh] = useState(false);
  const [dialog, setDialog] = useState<'duplicate' | 'template' | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const notesHelp = useId();
  useEffect(() => headingRef.current?.focus(), []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey reloads status on profile events
  useEffect(() => {
    let live = true;
    backend.profiles
      .status(props.profile.id)
      .then((s) => live && setStatus(s))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [backend, props.profile.id, props.refreshKey]);

  // Changes made elsewhere (a bulk action, another window) refresh the form unless the user is editing it.
  const dirty = JSON.stringify(form) !== JSON.stringify(formFrom(base));
  useEffect(() => {
    if (p.version !== base.version && !dirty) {
      setBase(p);
      setForm(formFrom(p));
    }
  }, [p, base.version, dirty]);

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => ({ ...f, [k]: v }));
  const notesWarning = secretHint(form.notes);
  const trashed = Boolean(p.trashed_at);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (notesWarning) {
      setError(`${notesWarning} Remove it from the notes before saving.`);
      return;
    }
    const startUrls = form.urls
      .split('\n')
      .map((u) => u.trim())
      .filter(Boolean);
    try {
      let clientId: string | null = form.client || null;
      if (form.client === NEW_CLIENT) {
        try {
          clientId = (await backend.library.createClient(form.newClient)).id;
        } catch (err) {
          const existing = library?.clients.find((c) => nameKey(c.name) === nameKey(form.newClient));
          if (!(isIpcError(err) && err.code === 'DUPLICATE_NAME' && existing)) throw err;
          clientId = existing.id;
        }
        props.onLibraryChanged();
      }
      const saved = await backend.profiles.update(p.id, {
        expectedVersion: p.version,
        ...(form.name !== p.name ? { name: form.name } : {}),
        ...(clientId === null && p.client_id ? { clearClient: true } : {}),
        ...(clientId !== null && clientId !== p.client_id ? { clientId } : {}),
        ...(sameTags(
          form.tags,
          p.tags.map((t) => t.name),
        )
          ? {}
          : { tags: form.tags }),
        ...(startUrls.join('\n') !== p.start_urls.join('\n') ? { startUrls } : {}),
        ...(form.perms.camera !== p.permissions.camera ? { camera: form.perms.camera } : {}),
        ...(form.perms.microphone !== p.permissions.microphone ? { microphone: form.perms.microphone } : {}),
        ...(form.perms.location !== p.permissions.location ? { location: form.perms.location } : {}),
        ...(form.notes !== p.notes ? { notes: form.notes } : {}),
      });
      props.onSaved(saved);
      setStatus((s) => (s ? { ...s, profile: saved } : s));
      setBase(saved);
      setForm(formFrom(saved));
      if (form.tags.length || form.client === NEW_CLIENT) props.onLibraryChanged();
      notify(
        p.state === 'stopped' || p.state === 'crashed'
          ? 'Profile settings saved.'
          : 'Profile settings saved. They apply the next time the profile opens.',
      );
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const recover = async (action: 'reopen' | 'restore_backup' | 'start_fresh' | 'backup_now') => {
    try {
      await backend.profiles.recover(p.id, action);
      notify(
        {
          reopen: `Opening ${withClient(p)}…`,
          restore_backup: 'Restoring the last good copy…',
          start_fresh: 'Starting with empty browser data…',
          backup_now: 'Making a backup…',
        }[action],
      );
    } catch (err) {
      notify(errorMessage(err), 'error');
    }
  };

  const reload = async () => {
    const s = await backend.profiles.status(p.id);
    setStatus(s);
    props.onSaved(s.profile);
  };

  const chooseDownloads = async () => {
    try {
      const r = await backend.profiles.selectDownloadDirectory(p.id);
      if (r.path) {
        await reload();
        notify('Download folder saved.');
      }
    } catch (err) {
      notify(errorMessage(err), 'error');
    }
  };

  const useDefaultDownloads = async () => {
    try {
      const saved = await backend.profiles.update(p.id, {
        expectedVersion: p.version,
        clearDownloadDir: true,
      });
      props.onSaved(saved);
      setStatus((s) => (s ? { ...s, profile: saved } : s));
    } catch (err) {
      notify(errorMessage(err), 'error');
    }
  };

  const action = primaryAction(p);
  const closed = p.state === 'stopped' || p.state === 'crashed';
  const backup = status?.backup ?? null;
  const problem = p.last_error ? (LAST_ERROR[p.last_error] ?? 'Something went wrong last time.') : null;
  const template = library?.templates.find((t) => t.id === p.template_id);
  const clientNames = library?.clients.map((c) => c.name) ?? [];

  return (
    <aside
      className="drawer"
      aria-labelledby="profile-settings-title"
      onKeyDown={(e) => e.key === 'Escape' && !dialog && !confirmFresh && props.onClose()}
    >
      <header>
        <h2 id="profile-settings-title" ref={headingRef} tabIndex={-1}>
          Profile settings
        </h2>
        <button
          type="button"
          className="pb-button"
          onClick={props.onClose}
          aria-label="Close profile settings"
        >
          ×
        </button>
      </header>

      <div className="identity">
        <p className="identity__name">{p.name}</p>
        {p.client_name ? (
          <ClientBadge label={p.client_name} colour={p.client_colour} />
        ) : (
          <span className="muted small">No client</span>
        )}
        <button
          type="button"
          className="pb-button star-toggle"
          aria-pressed={p.favourite}
          disabled={trashed}
          onClick={() => props.onBulk({ action: 'favourite', value: !p.favourite }, p)}
        >
          <span aria-hidden="true">{p.favourite ? '★' : '☆'}</span> Favourite
        </button>
      </div>

      {trashed && (
        <div className="notice" role="status">
          <p>
            In the trash. It will be deleted permanently on {day(p.purge_after)}. Restore it to open or edit
            it.
          </p>
          <button
            type="button"
            className="pb-button"
            data-variant="primary"
            onClick={() => props.onBulk({ action: 'restore' }, p)}
          >
            Restore
          </button>
        </div>
      )}

      <dl className="facts">
        <dt>Status</dt>
        <dd>
          <StatusText p={p} />
        </dd>
        <dt>Tags</dt>
        <dd>{p.tags.length ? p.tags.map((t) => t.name).join(', ') : '—'}</dd>
        <dt>Proxy</dt>
        <dd>
          {p.proxy_label ?? 'None assigned'}
          <span className="muted small"> (proxy settings arrive in a later update)</span>
        </dd>
        <dt>Sync</dt>
        <dd>Local only (this device)</dd>
        <dt>Browser</dt>
        <dd>{p.runtime_version ?? 'Not opened yet'}</dd>
        <dt>Last opened</dt>
        <dd>{when(p.last_started_at)}</dd>
        <dt>Last closed normally</dt>
        <dd>{when(p.last_clean_shutdown_at)}</dd>
        <dt>Backup</dt>
        <dd>{backup ? new Date(backup.created_at_unix * 1000).toLocaleString() : 'None yet'}</dd>
        {template && (
          <>
            <dt>Template</dt>
            <dd>{template.name}</dd>
          </>
        )}
      </dl>
      {problem && (
        <p className="warn" role="status">
          {problem}
          {p.crash_count > 1 ? ` (${p.crash_count} times in a row)` : ''}
        </p>
      )}
      {!trashed && (
        <button
          type="button"
          className="pb-button"
          data-variant={action === 'open' ? 'primary' : action === 'force' ? 'danger' : undefined}
          disabled={action === 'wait'}
          onClick={() => props.onToggle(p)}
        >
          {
            { open: 'Open profile', close: 'Close profile', force: 'Force close', wait: 'Please wait…' }[
              action
            ]
          }
        </button>
      )}
      {action === 'force' && (
        <p className="muted small">
          The browser did not close when asked. Force closing ends it immediately; pages may lose unsaved
          work.
        </p>
      )}

      {closed && !trashed && (
        <fieldset>
          <legend>Recover</legend>
          {p.state === 'crashed' && (
            <p className="small">
              {status?.suggested_recovery === 'restore_backup'
                ? 'This profile keeps closing unexpectedly. Restoring the last good copy is recommended.'
                : status?.suggested_recovery === 'start_fresh'
                  ? 'There is no backup. You can start this profile with empty browser data.'
                  : 'You can open it again. If it keeps failing, restore the last good copy.'}
            </p>
          )}
          <div className="row">
            <button
              type="button"
              className="pb-button"
              disabled={!backup}
              onClick={() => recover('restore_backup')}
            >
              Restore last good copy
            </button>
            <button type="button" className="pb-button" onClick={() => setConfirmFresh(true)}>
              Start with empty data…
            </button>
            <button type="button" className="pb-button" onClick={() => recover('backup_now')}>
              Back up now
            </button>
          </div>
          <p className="muted small">
            Recovery never deletes the current data: it is moved aside first. Sign-ins may need to be
            repeated.
          </p>
        </fieldset>
      )}

      <form className="stack" onSubmit={save} aria-label="Edit profile">
        <fieldset className="plain" disabled={trashed}>
          <label>
            Name
            <input required maxLength={120} value={form.name} onChange={(e) => set('name', e.target.value)} />
          </label>
          <label>
            Client
            <select value={form.client} onChange={(e) => set('client', e.target.value)}>
              <option value="">No client</option>
              {library?.clients
                .filter((c) => !c.archived_at || c.id === p.client_id)
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              <option value={NEW_CLIENT}>New client…</option>
            </select>
          </label>
          {form.client === NEW_CLIENT && (
            <label>
              New client name
              <input
                required
                maxLength={120}
                value={form.newClient}
                list="drawer-client-names"
                onChange={(e) => set('newClient', e.target.value)}
              />
              <datalist id="drawer-client-names">
                {clientNames.map((n) => (
                  <option key={n} value={n} />
                ))}
              </datalist>
            </label>
          )}
          <TagEditor
            value={form.tags}
            onChange={(t) => set('tags', t)}
            suggestions={library?.tags.map((t) => t.name) ?? []}
          />
          <label>
            Start pages (one address per line, up to 10)
            <textarea
              rows={3}
              value={form.urls}
              placeholder="https://"
              spellCheck={false}
              onChange={(e) => set('urls', e.target.value)}
            />
          </label>
          <fieldset>
            <legend>Website permissions</legend>
            {PERMISSIONS.map(([key, label]) => (
              <label key={key}>
                {label}
                <select
                  value={form.perms[key]}
                  onChange={(e) => set('perms', { ...form.perms, [key]: e.target.value as Permission })}
                >
                  {(Object.keys(PERMISSION_LABEL) as Permission[]).map((v) => (
                    <option key={v} value={v}>
                      {PERMISSION_LABEL[v]}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </fieldset>
          <label>
            Notes
            <textarea
              maxLength={2000}
              rows={3}
              value={form.notes}
              aria-describedby={notesHelp}
              aria-invalid={notesWarning ? true : undefined}
              onChange={(e) => set('notes', e.target.value)}
            />
          </label>
          <p id={notesHelp} className={notesWarning ? 'warn small' : 'muted small'}>
            {notesWarning ??
              'Plain text, up to 2,000 characters. Notes are not encrypted: never store passwords or keys here.'}
          </p>
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
          <button type="submit" className="pb-button" data-variant="primary">
            Save changes
          </button>
        </fieldset>
      </form>

      {!trashed && (
        <fieldset>
          <legend>Downloads</legend>
          <p className="mono small">{p.download_dir ?? 'Same as the app setting'}</p>
          <div className="row">
            <button type="button" className="pb-button" onClick={chooseDownloads}>
              Choose folder…
            </button>
            {p.download_dir && (
              <button type="button" className="pb-button" onClick={useDefaultDownloads}>
                Use app setting
              </button>
            )}
          </div>
        </fieldset>
      )}

      {!trashed && (
        <fieldset>
          <legend>More actions</legend>
          <div className="row">
            <button type="button" className="pb-button" onClick={() => setDialog('duplicate')}>
              Duplicate…
            </button>
            <button type="button" className="pb-button" onClick={() => setDialog('template')}>
              Save as template…
            </button>
            <button
              type="button"
              className="pb-button"
              onClick={() => props.onBulk({ action: p.archived_at ? 'unarchive' : 'archive' }, p)}
            >
              {p.archived_at ? 'Unarchive' : 'Archive'}
            </button>
            <button
              type="button"
              className="pb-button"
              disabled={!closed}
              onClick={() => props.onBulk({ action: 'trash' }, p)}
            >
              Move to trash
            </button>
          </div>
          {!closed && <p className="muted small">Close the profile before moving it to the trash.</p>}
        </fieldset>
      )}

      <p className="muted small">
        Separate profiles keep stored website data apart. They do not make profiles look like different
        devices or networks to websites.
      </p>

      {confirmFresh && (
        <Dialog
          role="alertdialog"
          title="Start with empty browser data?"
          description="The current browser data is moved aside (not deleted) and the profile opens like new. You will need to sign in to websites again."
          onClose={() => setConfirmFresh(false)}
          initialFocus="[data-cancel]"
        >
          <div className="row row--end">
            <button type="button" className="pb-button" data-cancel onClick={() => setConfirmFresh(false)}>
              Cancel
            </button>
            <button
              type="button"
              className="pb-button"
              data-variant="danger"
              onClick={() => {
                setConfirmFresh(false);
                void recover('start_fresh');
              }}
            >
              Start with empty data
            </button>
          </div>
        </Dialog>
      )}
      {dialog === 'duplicate' && (
        <NameDialog
          title="Duplicate profile"
          description="The copy gets the same client, tags, start pages and website permissions. Sign-ins, cookies and history are never copied: the copy starts with empty browser storage."
          label="Name of the copy"
          initial={`${p.name} (copy)`}
          submit="Duplicate"
          onClose={() => setDialog(null)}
          onSubmit={async (name) => {
            const copy = await backend.profiles.duplicate(p.id, name);
            notify(`Created “${copy.name}” with empty browser storage.`);
            props.onCreated(copy);
          }}
        />
      )}
      {dialog === 'template' && (
        <NameDialog
          title="Save as template"
          description="A template keeps the start pages, website permissions and tags. Browser storage, sign-ins and notes are never part of a template."
          label="Template name"
          initial={p.name}
          submit="Save template"
          onClose={() => setDialog(null)}
          onSubmit={async (name) => {
            const t = await backend.library.saveTemplate(p.id, name);
            notify(`Template “${t.name}” saved.`);
            props.onLibraryChanged();
          }}
        />
      )}
    </aside>
  );
}

/** Tag chips with remove buttons and an input (with suggestions) to add more. */
export function TagEditor(props: {
  value: string[];
  onChange: (tags: string[]) => void;
  suggestions: string[];
}) {
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const listId = useId();
  const inputId = useId();
  const add = () => {
    const t = text.trim();
    if (!t) return;
    if ([...t].length > 40) return setError('Tags can be at most 40 characters.');
    if (props.value.length >= 20) return setError('A profile can have at most 20 tags.');
    setError(null);
    setText('');
    if (props.value.some((x) => nameKey(x) === nameKey(t))) return;
    // Reuse the existing spelling of a known tag.
    props.onChange([...props.value, props.suggestions.find((s) => nameKey(s) === nameKey(t)) ?? t]);
  };
  return (
    <div className="tag-editor">
      <label htmlFor={inputId}>Tags</label>
      {props.value.length > 0 && (
        <ul className="chips" aria-label="Tags on this profile">
          {props.value.map((t) => (
            <li key={t} className="chip">
              {t}
              <button
                type="button"
                aria-label={`Remove tag ${t}`}
                onClick={() => props.onChange(props.value.filter((x) => x !== t))}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="row">
        <input
          id={inputId}
          value={text}
          maxLength={40}
          list={listId}
          placeholder="Add a tag"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add();
            }
          }}
        />
        <button type="button" className="pb-button" onClick={add} disabled={!text.trim()}>
          Add tag
        </button>
      </div>
      <datalist id={listId}>
        {props.suggestions
          .filter((s) => !props.value.some((v) => nameKey(v) === nameKey(s)))
          .map((s) => (
            <option key={s} value={s} />
          ))}
      </datalist>
      {error && (
        <p role="alert" className="error small">
          {error}
        </p>
      )}
    </div>
  );
}

/** A dialog asking for one name, with the error from the action shown inline. */
export function NameDialog(props: {
  title: string;
  description?: string;
  label: string;
  initial?: string;
  maxLength?: number;
  submit: string;
  onClose: () => void;
  onSubmit: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState(props.initial ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <Dialog title={props.title} description={props.description} onClose={props.onClose} initialFocus="input">
      <form
        className="stack"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            await props.onSubmit(name);
            props.onClose();
          } catch (err) {
            setError(errorMessage(err));
            setBusy(false);
          }
        }}
      >
        <label>
          {props.label}
          <input
            required
            maxLength={props.maxLength ?? 120}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <div className="row row--end">
          <button type="button" className="pb-button" onClick={props.onClose}>
            Cancel
          </button>
          <button type="submit" className="pb-button" data-variant="primary" disabled={busy || !name.trim()}>
            {props.submit}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
