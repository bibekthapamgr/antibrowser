/** Settings › Clients, tags and templates: rename, recolour, archive, delete (milestone 04). */
import { clientColor } from '@pb/ui';
import { useEffect, useState } from 'react';
import type { Backend, ClientView, Library, Tag, Template } from './backend/types.ts';
import { errorMessage } from './backend/types.ts';
import { Dialog } from './components.tsx';
import { type Notify, plural } from './status.tsx';

export function LibraryManager(props: { backend: Backend; notify: Notify; refreshKey: number }) {
  const { backend, notify } = props;
  const [library, setLibrary] = useState<Library | null>(null);
  const [nonce, setNonce] = useState(0);
  const [confirm, setConfirm] = useState<
    { kind: 'tag'; tag: Tag } | { kind: 'template'; template: Template } | null
  >(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey/nonce reload the library
  useEffect(() => {
    backend.library
      .library()
      .then(setLibrary)
      .catch((e) => notify(errorMessage(e), 'error'));
  }, [backend, notify, props.refreshKey, nonce]);
  const reload = () => setNonce((n) => n + 1);
  if (!library) return <p role="status">Loading clients and tags…</p>;

  return (
    <>
      <fieldset>
        <legend>Clients</legend>
        {library.clients.length === 0 ? (
          <p className="muted small">No clients yet. Add a client when you create or edit a profile.</p>
        ) : (
          <ul className="manage-list">
            {library.clients.map((c) => (
              <ClientItem
                key={`${c.id}-${c.version}`}
                client={c}
                backend={backend}
                notify={notify}
                onSaved={reload}
              />
            ))}
          </ul>
        )}
        <p className="muted small">
          Archived clients are hidden from the sidebar and pickers; their profiles stay.
        </p>
      </fieldset>

      <fieldset>
        <legend>Tags</legend>
        {library.tags.length === 0 ? (
          <p className="muted small">No tags yet.</p>
        ) : (
          <ul className="manage-list">
            {library.tags.map((t) => (
              <TagItem
                key={`${t.id}-${t.name}`}
                tag={t}
                backend={backend}
                notify={notify}
                onSaved={reload}
                onDelete={() => setConfirm({ kind: 'tag', tag: t })}
              />
            ))}
          </ul>
        )}
      </fieldset>

      <fieldset>
        <legend>Templates</legend>
        {library.templates.length === 0 ? (
          <p className="muted small">
            No templates yet. Use “Save as template” in a profile’s settings. Templates keep start pages,
            website permissions and tags — never sign-ins or browser data.
          </p>
        ) : (
          <ul className="manage-list">
            {library.templates.map((t) => (
              <li key={t.id}>
                <span className="manage-list__name">{t.name}</span>
                <span className="muted small">
                  {plural(t.config.start_urls.length, 'start page')} · camera {t.config.camera} · microphone{' '}
                  {t.config.microphone} · location {t.config.location}
                  {t.config.tags.length ? ` · tags: ${t.config.tags.join(', ')}` : ''}
                </span>
                <button
                  type="button"
                  className="pb-button"
                  onClick={() => setConfirm({ kind: 'template', template: t })}
                >
                  Delete<span className="pb-sr-only"> template {t.name}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </fieldset>

      {confirm && (
        <Dialog
          role="alertdialog"
          title={
            confirm.kind === 'tag'
              ? `Delete the tag “${confirm.tag.name}”?`
              : `Delete “${confirm.template.name}”?`
          }
          description={
            confirm.kind === 'tag'
              ? `It is removed from ${plural(confirm.tag.profiles, 'profile')}. The profiles themselves are not changed otherwise.`
              : 'Profiles created from this template keep their settings.'
          }
          onClose={() => setConfirm(null)}
          initialFocus="[data-cancel]"
        >
          <div className="row row--end">
            <button type="button" className="pb-button" data-cancel onClick={() => setConfirm(null)}>
              Cancel
            </button>
            <button
              type="button"
              className="pb-button"
              data-variant="danger"
              onClick={async () => {
                try {
                  if (confirm.kind === 'tag') await backend.library.deleteTag(confirm.tag.id);
                  else await backend.library.deleteTemplate(confirm.template.id);
                  notify(confirm.kind === 'tag' ? 'Tag deleted.' : 'Template deleted.');
                  reload();
                } catch (e) {
                  notify(errorMessage(e), 'error');
                }
                setConfirm(null);
              }}
            >
              Delete
            </button>
          </div>
        </Dialog>
      )}
    </>
  );
}

function ClientItem(props: { client: ClientView; backend: Backend; notify: Notify; onSaved: () => void }) {
  const c = props.client;
  const [name, setName] = useState(c.name);
  const [colour, setColour] = useState<string | null>(c.colour);
  const update = async (changes: {
    name?: string;
    colour?: string;
    clearColour?: boolean;
    archived?: boolean;
  }) => {
    try {
      await props.backend.library.updateClient(c.id, c.version, changes);
      props.onSaved();
    } catch (e) {
      props.notify(errorMessage(e), 'error');
    }
  };
  const changed = name.trim() !== c.name || colour !== c.colour;
  return (
    <li>
      <input
        type="color"
        aria-label={`Colour for ${c.name}`}
        value={colour ?? clientColor(c.name)}
        onChange={(e) => setColour(e.target.value.toLowerCase())}
      />
      <input
        aria-label={`Name of client ${c.name}`}
        value={name}
        maxLength={120}
        onChange={(e) => setName(e.target.value)}
      />
      <span className="muted small">
        {plural(c.profiles, 'profile')}
        {c.archived_at ? ' · archived' : ''}
      </span>
      {changed && (
        <button
          type="button"
          className="pb-button"
          data-variant="primary"
          onClick={() =>
            update({
              ...(name.trim() !== c.name ? { name } : {}),
              ...(colour !== c.colour ? (colour ? { colour } : { clearColour: true }) : {}),
            })
          }
        >
          Save<span className="pb-sr-only"> {c.name}</span>
        </button>
      )}
      {c.colour && !changed && (
        <button type="button" className="pb-button" onClick={() => update({ clearColour: true })}>
          Automatic colour<span className="pb-sr-only"> for {c.name}</span>
        </button>
      )}
      <button type="button" className="pb-button" onClick={() => update({ archived: !c.archived_at })}>
        {c.archived_at ? 'Unarchive' : 'Archive'}
        <span className="pb-sr-only"> {c.name}</span>
      </button>
    </li>
  );
}

function TagItem(props: {
  tag: Tag;
  backend: Backend;
  notify: Notify;
  onSaved: () => void;
  onDelete: () => void;
}) {
  const t = props.tag;
  const [name, setName] = useState(t.name);
  return (
    <li>
      <input
        aria-label={`Name of tag ${t.name}`}
        value={name}
        maxLength={40}
        onChange={(e) => setName(e.target.value)}
      />
      <span className="muted small">{plural(t.profiles, 'profile')}</span>
      {name.trim() !== t.name && (
        <button
          type="button"
          className="pb-button"
          data-variant="primary"
          onClick={async () => {
            try {
              await props.backend.library.renameTag(t.id, name);
              props.onSaved();
            } catch (e) {
              props.notify(errorMessage(e), 'error');
            }
          }}
        >
          Rename<span className="pb-sr-only"> {t.name}</span>
        </button>
      )}
      <button type="button" className="pb-button" onClick={props.onDelete}>
        Delete<span className="pb-sr-only"> tag {t.name}</span>
      </button>
    </li>
  );
}
