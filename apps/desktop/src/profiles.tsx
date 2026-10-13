/**
 * Profile manager (milestone 04): client folders and views in the sidebar, a virtualized table that loads pages as
 * they scroll into view, search/filter/sort and saved views, explicit selection (rows, or "all N matching" checked
 * against the count the user saw), bulk actions with per-profile results and undo, the trash with a typed
 * confirmation for permanent deletion, and entry points for import and export.
 */
import { ClientBadge, clientColor } from '@pb/ui';
import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type {
  Backend,
  BulkAction,
  BulkResult,
  Library,
  ProfileFilter,
  ProfileView,
  RunState,
  Selection,
  SelectionSummary,
  Sort,
} from './backend/types.ts';
import { errorMessage, isIpcError } from './backend/types.ts';
import { ClientOverviewDialog } from './clients.tsx';
import { Cell, Dialog, useDebounced, useElementHeight, VirtualList } from './components.tsx';
import { NameDialog, ProfileDrawer } from './drawer.tsx';
import { ExportDialog, ImportDialog } from './importer.tsx';
import { useLauncher } from './launch.tsx';
import { CredentialPrompt, NetworkCell, SetProxyDialog } from './network.tsx';
import { nameKey } from './notes.ts';
import {
  ACTION_LABEL,
  day,
  type Notify,
  plural,
  primaryAction,
  relative,
  StatusText,
  withClient,
} from './status.tsx';
import { SharedCell } from './team.tsx';

const ROW_HEIGHT = 48;
const PAGE = 200;
const OPEN_STATES: RunState[] = ['starting', 'running', 'stopping'];

export type Folder =
  | { kind: 'all' | 'favourites' | 'open' | 'no_client' | 'archived' | 'trash' }
  | { kind: 'client'; id: string }
  | { kind: 'saved'; id: string };
type StateFilter = 'any' | 'open' | 'closed' | 'problem';
const STATE_FILTERS: Record<StateFilter, { label: string; states?: RunState[] }> = {
  any: { label: 'Any status' },
  open: { label: 'Open', states: OPEN_STATES },
  closed: { label: 'Closed', states: ['stopped'] },
  problem: { label: 'Closed unexpectedly', states: ['crashed'] },
};
const SORTS: { id: string; label: string; sort: Sort }[] = [
  { id: 'name', label: 'Name (A–Z)', sort: { key: 'name', descending: false } },
  { id: 'name-desc', label: 'Name (Z–A)', sort: { key: 'name', descending: true } },
  { id: 'client', label: 'Client', sort: { key: 'client', descending: false } },
  { id: 'last-used', label: 'Recently used', sort: { key: 'last_used', descending: true } },
  { id: 'created', label: 'Newest first', sort: { key: 'created', descending: true } },
  { id: 'state', label: 'Status (open first)', sort: { key: 'state', descending: false } },
];
const sortId = (s: Sort) =>
  SORTS.find((x) => x.sort.key === s.key && x.sort.descending === s.descending)?.id ?? 'name';

function folderFilter(folder: Folder, library: Library | null): ProfileFilter {
  switch (folder.kind) {
    case 'favourites':
      return { favourites_only: true };
    case 'open':
      return { states: OPEN_STATES };
    case 'no_client':
      return { client: { kind: 'none' } };
    case 'archived':
      return { view: 'archived' };
    case 'trash':
      return { view: 'trash' };
    case 'client':
      return { client: { kind: 'ids', ids: [folder.id] } };
    case 'saved':
      return { ...(library?.saved_filters.find((f) => f.id === folder.id)?.filter.filter ?? {}) };
    default:
      return {};
  }
}

function folderTitle(folder: Folder, library: Library | null): string {
  switch (folder.kind) {
    case 'all':
      return 'All profiles';
    case 'favourites':
      return 'Favourites';
    case 'open':
      return 'Open now';
    case 'no_client':
      return 'No client';
    case 'archived':
      return 'Archived';
    case 'trash':
      return 'Trash';
    case 'client':
      return library?.clients.find((c) => c.id === folder.id)?.name ?? 'Client';
    case 'saved':
      return `Saved view: ${library?.saved_filters.find((f) => f.id === folder.id)?.name ?? ''}`;
  }
}

const sameFolder = (a: Folder, b: Folder) =>
  a.kind === b.kind && ('id' in a ? a.id : '') === ('id' in b ? b.id : '');

/** Page numbers covering rows `start..end`. */
function pagesIn([s, e]: [number, number]): number[] {
  const out: number[] = [];
  for (let p = Math.floor(s / PAGE); p <= Math.floor(Math.max(s, e - 1) / PAGE); p++) out.push(p);
  return out;
}

/**
 * Loads the pages of the table that are on screen. A refresh re-reads them in place, and a new filter keeps the old
 * rows visible until its first page arrives, so the table never flashes or reloads.
 */
function useProfilePages(
  backend: Backend,
  filter: ProfileFilter,
  sort: Sort,
  key: string,
  refreshKey: number,
  notify: Notify,
) {
  const [data, setData] = useState<{ key: string; total: number | null; pages: Map<number, ProfileView[]> }>({
    key: '',
    total: null,
    pages: new Map(),
  });
  const dataRef = useRef(data);
  dataRef.current = data;
  const keyRef = useRef(key);
  keyRef.current = key;
  const args = useRef({ filter, sort });
  args.current = { filter, sort };
  const range = useRef<[number, number]>([0, 40]);
  const inflight = useRef(new Set<string>());
  const generation = useRef(0);

  const load = useCallback(
    async (page: number) => {
      const k = keyRef.current;
      const tag = `${k}|${page}|${generation.current}`;
      if (inflight.current.has(tag)) return;
      inflight.current.add(tag);
      try {
        const res = await backend.profiles.query({ ...args.current, offset: page * PAGE, limit: PAGE });
        if (keyRef.current !== k) return;
        setData((d) => {
          const pages = d.key === k ? new Map(d.pages) : new Map<number, ProfileView[]>();
          pages.set(page, res.rows);
          return { key: k, total: res.total, pages };
        });
      } catch (e) {
        if (keyRef.current === k) notify(errorMessage(e, 'Could not load profiles.'), 'error');
      } finally {
        inflight.current.delete(tag);
      }
    },
    [backend, notify],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new key starts a new list
  useEffect(() => {
    range.current = [0, 40];
    void load(0);
  }, [key, load]);

  const first = useRef(true);
  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey re-reads the visible pages on profile events
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    generation.current++;
    const wanted = new Set(pagesIn(range.current));
    // Pages out of view are dropped and reloaded when they scroll back in.
    setData((d) => ({ ...d, pages: new Map([...d.pages].filter(([p]) => wanted.has(p))) }));
    for (const p of wanted) void load(p);
  }, [refreshKey]);

  const ensure = useCallback(
    (start: number, end: number) => {
      range.current = [start, end];
      const d = dataRef.current;
      for (const p of pagesIn([start, end])) if (d.key !== keyRef.current || !d.pages.has(p)) void load(p);
    },
    [load],
  );

  const getItem = useCallback((i: number) => data.pages.get(Math.floor(i / PAGE))?.[i % PAGE], [data.pages]);
  const loaded = useMemo(() => [...data.pages.values()].flat(), [data.pages]);
  const patch = (p: ProfileView) =>
    setData((d) => ({
      ...d,
      pages: new Map([...d.pages].map(([k, rows]) => [k, rows.map((r) => (r.id === p.id ? p : r))])),
    }));
  return { total: data.total, listKey: data.key, getItem, ensure, loaded, patch };
}

function useLibrary(backend: Backend, refreshKey: number, notify: Notify) {
  const [library, setLibrary] = useState<Library | null>(null);
  const [nonce, setNonce] = useState(0);
  const debounced = useDebounced(refreshKey, 150);
  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey/nonce trigger a reload
  useEffect(() => {
    let live = true;
    backend.library
      .library()
      .then((l) => live && setLibrary(l))
      .catch((e) => live && notify(errorMessage(e, 'Could not load clients and tags.'), 'error'));
    return () => {
      live = false;
    };
  }, [backend, debounced, nonce, notify]);
  return [library, useCallback(() => setNonce((n) => n + 1), [])] as const;
}

const ACTION_DONE: Record<
  BulkAction['action'],
  (n: number, a: BulkAction, library: Library | null) => string
> = {
  add_tag: (n, a) =>
    `Tagged ${plural(n, 'profile')}${a.action === 'add_tag' && a.tag_name ? ` “${a.tag_name}”` : ''}.`,
  remove_tag: (n) => `Removed the tag from ${plural(n, 'profile')}.`,
  move: (n, a, l) =>
    a.action === 'move' && a.client_id
      ? `Moved ${plural(n, 'profile')} to ${l?.clients.find((c) => c.id === a.client_id)?.name ?? 'the client'}.`
      : `Removed the client from ${plural(n, 'profile')}.`,
  archive: (n) => `Archived ${plural(n, 'profile')}.`,
  unarchive: (n) => `Unarchived ${plural(n, 'profile')}.`,
  favourite: (n, a) =>
    a.action === 'favourite' && a.value
      ? `Added ${plural(n, 'profile')} to favourites.`
      : `Removed ${plural(n, 'profile')} from favourites.`,
  trash: (n) => `Moved ${plural(n, 'profile')} to the trash.`,
  restore: (n) => `Restored ${plural(n, 'profile')} from the trash.`,
  set_proxy: (n, a) =>
    a.action === 'set_proxy' && a.proxy_id
      ? `Set the proxy of ${plural(n, 'profile')}. Open profiles use it after they are reopened.`
      : `Removed the proxy from ${plural(n, 'profile')}.`,
};

/** What a confirmation names before a bulk action that changes or removes profiles (milestone 09). */
const CONFIRM_TEXT: Partial<
  Record<BulkAction['action'], (a: BulkAction, library: Library | null) => string>
> = {
  trash: () => 'Move to the trash',
  archive: () => 'Archive',
  move: (a, l) =>
    a.action === 'move' && a.client_id
      ? `Move to the client “${l?.clients.find((c) => c.id === a.client_id)?.name ?? 'another client'}”`
      : 'Remove the client',
  set_proxy: (a) => (a.action === 'set_proxy' && a.proxy_id ? 'Set a different proxy' : 'Remove the proxy'),
};

type BulkDialog =
  | { kind: 'add_tag' | 'remove_tag' | 'move' | 'export' | 'delete' | 'set_proxy' }
  | { kind: 'confirm'; action: BulkAction }
  | { kind: 'client_overview'; clientId: string }
  | { kind: 'credentials'; proxyId: string; profile: ProfileView }
  | { kind: 'failures'; title: string; result: BulkResult };

export function ProfilesScreen(props: {
  backend: Backend;
  refreshKey: number;
  notify: Notify;
  runningCount: number;
  folderSlot: HTMLElement | null;
  /** Opens the settings of this profile (from the command palette). */
  showProfile?: { id: string; nonce: number } | null;
}) {
  const { backend, notify, refreshKey } = props;
  const [library, reloadLibrary] = useLibrary(backend, refreshKey, notify);
  const [folder, setFolder] = useState<Folder>({ kind: 'all' });
  const [text, setText] = useState('');
  const debouncedText = useDebounced(text, 150);
  const [tagId, setTagId] = useState('');
  const [stateFilter, setStateFilter] = useState<StateFilter>('any');
  const [sort, setSort] = useState<Sort>({ key: 'name', descending: false });

  const filter = useMemo<ProfileFilter>(() => {
    const f = folderFilter(folder, library);
    const t = debouncedText.trim();
    if (t) f.text = t;
    if (tagId) f.tags = [...new Set([...(f.tags ?? []), tagId])];
    const s = STATE_FILTERS[stateFilter].states;
    if (s) f.states = s;
    return f;
  }, [folder, library, debouncedText, tagId, stateFilter]);
  const filterKey = JSON.stringify(filter);
  const key = `${filterKey}|${JSON.stringify(sort)}`;
  const pages = useProfilePages(backend, filter, sort, key, refreshKey, notify);
  const total = pages.total;

  const [active, setActive] = useState(0);
  const [drawer, setDrawer] = useState<ProfileView | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [allMatching, setAllMatching] = useState(false);
  const anchor = useRef<number | null>(null);
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  const [savingView, setSavingView] = useState(false);
  const [dialog, setDialog] = useState<BulkDialog | null>(null);
  const [undo, setUndo] = useState<{ token: string; text: string } | null>(null);
  const [listRef, listHeight] = useElementHeight<HTMLDivElement>(420);

  // A new filter is a new list: selection and position start over (sorting keeps the selection).
  // biome-ignore lint/correctness/useExhaustiveDependencies: filterKey identifies the filter
  useEffect(() => {
    setSelected(new Set());
    setAllMatching(false);
    setActive(0);
    anchor.current = null;
  }, [filterKey]);

  // The command palette asked for a profile's settings.
  const show = props.showProfile;
  useEffect(() => {
    if (!show) return;
    backend.profiles
      .status(show.id)
      .then((s) => setDrawer(s.profile))
      .catch((e) => notify(errorMessage(e), 'error'));
  }, [show, backend, notify]);

  // The drawer follows the row it shows when the table refreshes.
  useEffect(() => {
    setDrawer((d) => (d ? (pages.loaded.find((r) => r.id === d.id) ?? d) : d));
  }, [pages.loaded]);

  // A folder whose client or saved view disappeared falls back to all profiles.
  useEffect(() => {
    if (!library) return;
    if (folder.kind === 'client' && !library.clients.some((c) => c.id === folder.id))
      setFolder({ kind: 'all' });
    if (folder.kind === 'saved' && !library.saved_filters.some((f) => f.id === folder.id))
      setFolder({ kind: 'all' });
  }, [library, folder]);

  const view = filter.view ?? 'active';
  const count = allMatching ? (total ?? 0) : selected.size;
  const selection: Selection = allMatching
    ? { kind: 'filter', filter, expected_total: total ?? 0 }
    : { kind: 'ids', ids: [...selected] };

  const chooseFolder = (f: Folder) => {
    setFolder(f);
    setDrawer(null);
    if (f.kind === 'saved') {
      const saved = library?.saved_filters.find((x) => x.id === f.id);
      setText('');
      setTagId('');
      setStateFilter('any');
      if (saved) setSort(saved.filter.sort);
    }
  };

  const toggleRow = (p: ProfileView, index: number, range: boolean) => {
    if (allMatching) {
      // Leaving "all matching" for an explicit list keeps what is visible selected except this row.
      setAllMatching(false);
      setSelected(new Set(pages.loaded.filter((r) => r.id !== p.id).map((r) => r.id)));
      anchor.current = index;
      return;
    }
    setSelected((s) => {
      const next = new Set(s);
      if (range && anchor.current !== null) {
        const [a, b] = [Math.min(anchor.current, index), Math.max(anchor.current, index)];
        for (let i = a; i <= b; i++) {
          const r = pages.getItem(i);
          if (r) next.add(r.id);
        }
      } else if (next.has(p.id)) next.delete(p.id);
      else next.add(p.id);
      return next;
    });
    anchor.current = index;
  };
  const allShownSelected =
    allMatching || (pages.loaded.length > 0 && pages.loaded.every((r) => selected.has(r.id)));
  const clearSelection = () => {
    setSelected(new Set());
    setAllMatching(false);
  };

  // Opening goes through the memory and extension check first (milestone 09).
  const launcher = useLauncher(backend, notify, (e, target) => {
    const p = pages.loaded.find((r) => r.id === target.id);
    if (isIpcError(e) && e.code === 'PROXY_CREDENTIALS_MISSING' && p?.proxy_id) {
      setDialog({ kind: 'credentials', proxyId: p.proxy_id, profile: p });
      return true;
    }
    return false;
  });

  const toggleOpen = async (p: ProfileView) => {
    const action = primaryAction(p);
    try {
      if (action === 'open') {
        await launcher.open([p]);
      } else if (action === 'close') {
        await backend.profiles.stop(p.id);
        notify(`Closing ${withClient(p)}…`);
      } else if (action === 'force') {
        await backend.profiles.stop(p.id, true);
        notify(`Force closing ${withClient(p)}…`);
      }
    } catch (e) {
      // The proxy's login is gone from the keychain: ask for it again, then open the profile.
      if (isIpcError(e) && e.code === 'PROXY_CREDENTIALS_MISSING' && p.proxy_id) {
        setDialog({ kind: 'credentials', proxyId: p.proxy_id, profile: p });
        return;
      }
      notify(errorMessage(e), 'error');
    }
  };

  const report = (r: BulkResult, a: BulkAction) => {
    const parts = [r.changed > 0 ? ACTION_DONE[a.action](r.changed, a, library) : 'Nothing changed.'];
    if (r.unchanged > 0) parts.push(`${plural(r.unchanged, 'profile')} already matched.`);
    const text = parts.join(' ');
    if (r.failed.length)
      setDialog({
        kind: 'failures',
        title: `${plural(r.failed.length, 'profile')} could not be changed`,
        result: r,
      });
    else notify(text);
    setUndo(r.undo_token ? { token: r.undo_token, text } : null);
  };

  /** Actions that change or remove several profiles are confirmed with the clients and profiles they touch. */
  const confirmOrRun = (a: BulkAction) => {
    if (CONFIRM_TEXT[a.action]) setDialog({ kind: 'confirm', action: a });
    else void runBulk(a);
  };

  const runBulk = async (a: BulkAction, sel: Selection = selection) => {
    try {
      const r = await backend.profiles.bulk(a, sel);
      report(r, a);
      if (sel === selection) clearSelection();
      reloadLibrary();
    } catch (e) {
      notify(errorMessage(e), 'error');
    }
  };

  const runUndo = async () => {
    if (!undo) return;
    try {
      const r = await backend.profiles.undo(undo.token);
      notify(
        r.skipped
          ? `Undone for ${plural(r.restored, 'profile')}. ${plural(r.skipped, 'profile')} changed since and ${r.skipped === 1 ? 'was' : 'were'} left as ${r.skipped === 1 ? 'it is' : 'they are'}.`
          : `Undone for ${plural(r.restored, 'profile')}.`,
      );
      reloadLibrary();
    } catch (e) {
      notify(errorMessage(e), 'error');
    }
    setUndo(null);
  };

  const noRefinement = !debouncedText.trim() && !tagId && stateFilter === 'any';
  const workspaceEmpty =
    library !== null && library.counts.active + library.counts.archived + library.counts.trash === 0;
  const empty = total === 0 && folder.kind === 'all' && noRefinement && workspaceEmpty;
  const title = folderTitle(folder, library);
  const rowLabel = (n: number) =>
    `${title}, ${plural(n, 'profile')}. Arrow keys move, Space selects, Enter opens settings.`;

  const folders =
    props.folderSlot &&
    createPortal(
      <Folders
        library={library}
        folder={folder}
        onChoose={chooseFolder}
        onChanged={reloadLibrary}
        backend={backend}
        notify={notify}
      />,
      props.folderSlot,
    );

  return (
    <section className="screen profiles" aria-labelledby="profiles-title">
      {folders}
      <header className="toolbar">
        <div className="toolbar__title">
          <h1 id="profiles-title">Profiles</h1>
          <p className="muted small" aria-live="polite">
            {title}
            {total !== null ? ` · ${plural(total, 'profile')}` : ''}
          </p>
        </div>
        {props.runningCount > 0 && (
          <button
            type="button"
            className="pb-button"
            onClick={() => backend.profiles.closeAll().catch((e) => notify(errorMessage(e), 'error'))}
          >
            Close all ({props.runningCount})
          </button>
        )}
        {folder.kind === 'client' && (
          <button
            type="button"
            className="pb-button"
            onClick={() => setDialog({ kind: 'client_overview', clientId: folder.id })}
          >
            Client overview
          </button>
        )}
        <button type="button" className="pb-button" onClick={() => setImporting(true)}>
          Import…
        </button>
        <button type="button" className="pb-button" data-variant="primary" onClick={() => setCreating(true)}>
          New profile
        </button>
      </header>

      <search className="filters" aria-label="Find profiles">
        <label className="search">
          <span className="pb-sr-only">Search profiles</span>
          <input
            type="search"
            placeholder="Search name, client or tag"
            value={text}
            maxLength={200}
            onChange={(e) => setText(e.target.value)}
          />
        </label>
        <label>
          <span className="pb-sr-only">Tag</span>
          <select value={tagId} onChange={(e) => setTagId(e.target.value)}>
            <option value="">Any tag</option>
            {library?.tags.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name} ({t.profiles})
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className="pb-sr-only">Status</span>
          <select value={stateFilter} onChange={(e) => setStateFilter(e.target.value as StateFilter)}>
            {(Object.keys(STATE_FILTERS) as StateFilter[]).map((k) => (
              <option key={k} value={k}>
                {STATE_FILTERS[k].label}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className="pb-sr-only">Sort</span>
          <select
            value={sortId(sort)}
            onChange={(e) =>
              setSort(SORTS.find((s) => s.id === e.target.value)?.sort ?? { key: 'name', descending: false })
            }
          >
            {SORTS.map((s) => (
              <option key={s.id} value={s.id}>
                Sort: {s.label}
              </option>
            ))}
          </select>
        </label>
        <button type="button" className="pb-button" onClick={() => setSavingView(true)}>
          Save view…
        </button>
        {view === 'trash' && (total ?? 0) > 0 && (
          <button
            type="button"
            className="pb-button"
            data-variant="danger"
            onClick={() => {
              setAllMatching(true);
              setDialog({ kind: 'delete' });
            }}
          >
            Empty trash…
          </button>
        )}
      </search>

      {view === 'trash' && (
        <p className="muted small trash-note">
          Profiles in the trash are deleted permanently after {library?.trash_retention_days ?? 30} days, with
          their sign-ins and site data. Open profiles cannot be moved here.
        </p>
      )}

      {undo && (
        <div className="undo-bar" role="status">
          <span>{undo.text}</span>
          <button type="button" className="pb-button" onClick={runUndo}>
            Undo
          </button>
          <button type="button" className="pb-button" aria-label="Dismiss" onClick={() => setUndo(null)}>
            ×
          </button>
        </div>
      )}

      {count > 0 && (
        <BulkBar
          count={count}
          total={total ?? 0}
          allMatching={allMatching}
          view={view}
          onSelectAll={() => setAllMatching(true)}
          onClear={clearSelection}
          onAction={confirmOrRun}
          onDialog={(kind) => setDialog({ kind })}
        />
      )}

      {total === null ? (
        <p role="status">Loading profiles…</p>
      ) : empty ? (
        <div className="empty-state">
          <h2>No profiles yet</h2>
          <p className="muted">
            Create a profile for each account you manage. Each one keeps its own sign-ins.
          </p>
          <div className="row">
            <button
              type="button"
              className="pb-button"
              data-variant="primary"
              onClick={() => setCreating(true)}
            >
              Create your first profile
            </button>
            <button type="button" className="pb-button" onClick={() => setImporting(true)}>
              Import from a file…
            </button>
          </div>
        </div>
      ) : (
        <div className="table ptable" ref={listRef}>
          <div className="table__head trow-grid">
            <span className="col-check">
              <input
                type="checkbox"
                aria-label={allShownSelected ? 'Clear the selection' : 'Select all shown profiles'}
                checked={allShownSelected && count > 0}
                disabled={total === 0}
                onChange={() => {
                  if (allShownSelected) clearSelection();
                  else setSelected(new Set(pages.loaded.map((r) => r.id)));
                }}
              />
            </span>
            <span aria-hidden="true" />
            <SortHead label="Name" k="name" sort={sort} onSort={setSort} />
            <SortHead label="Client" k="client" sort={sort} onSort={setSort} />
            <span className="col-tags" aria-hidden="true">
              Tags
            </span>
            <SortHead label="Status" k="state" sort={sort} onSort={setSort} />
            <span className="col-used">
              <SortHead label="Last used" k="last_used" sort={sort} onSort={setSort} desc />
            </span>
            <span className="col-proxy" aria-hidden="true">
              Proxy
            </span>
            <span className="col-sync" aria-hidden="true">
              Shared
            </span>
            <span aria-hidden="true" />
          </div>
          {total === 0 ? (
            <p className="empty">
              {debouncedText.trim() ? `No profiles match “${debouncedText.trim()}”.` : `Nothing in ${title}.`}
            </p>
          ) : (
            <VirtualList<ProfileView>
              key={pages.listKey}
              count={total}
              getItem={pages.getItem}
              rowHeight={ROW_HEIGHT}
              height={Math.max(160, listHeight - 40)}
              label={rowLabel(total)}
              getKey={(p, i) => (p ? p.id : `pending-${i}`)}
              activeIndex={Math.min(active, total - 1)}
              onActiveIndexChange={setActive}
              onActivate={(p) => setDrawer(p)}
              onToggle={toggleRow}
              isSelected={(p) => Boolean(p && (allMatching || selected.has(p.id)))}
              onRangeChange={pages.ensure}
              renderRow={(p, i, isActive) =>
                p ? (
                  <ProfileRow
                    p={p}
                    active={isActive}
                    checked={allMatching || selected.has(p.id)}
                    onOpen={() => {
                      setActive(i);
                      setDrawer(p);
                    }}
                    onCheck={(range) => toggleRow(p, i, range)}
                    onFavourite={() =>
                      void runBulk({ action: 'favourite', value: !p.favourite }, { kind: 'ids', ids: [p.id] })
                    }
                    onPrimary={() =>
                      p.trashed_at
                        ? void runBulk({ action: 'restore' }, { kind: 'ids', ids: [p.id] })
                        : void toggleOpen(p)
                    }
                  />
                ) : (
                  <div className="trow trow-grid trow--loading">
                    <Cell className="col-check"> </Cell>
                    <Cell className="muted">Loading…</Cell>
                  </div>
                )
              }
            />
          )}
        </div>
      )}

      {drawer && (
        <ProfileDrawer
          key={drawer.id}
          backend={backend}
          profile={drawer}
          library={library}
          refreshKey={refreshKey}
          notify={notify}
          onToggle={toggleOpen}
          onSaved={(p) => {
            setDrawer(p);
            pages.patch(p);
          }}
          onBulk={(a, p) => void runBulk(a, { kind: 'ids', ids: [p.id] })}
          onCreated={(p) => {
            reloadLibrary();
            setDrawer(p);
          }}
          onLibraryChanged={reloadLibrary}
          onClose={() => setDrawer(null)}
        />
      )}
      {creating && (
        <CreateProfileDialog
          backend={backend}
          library={library}
          defaultClient={
            folder.kind === 'client' ? (library?.clients.find((c) => c.id === folder.id)?.name ?? '') : ''
          }
          onCancel={() => setCreating(false)}
          onCreated={(p) => {
            setCreating(false);
            reloadLibrary();
            notify(`Profile “${withClient(p)}” created.`);
          }}
        />
      )}
      {importing && (
        <ImportDialog
          backend={backend}
          notify={notify}
          library={library}
          refreshKey={refreshKey}
          onClose={() => setImporting(false)}
          onImported={reloadLibrary}
        />
      )}
      {savingView && (
        <NameDialog
          title="Save this view"
          description={`Saves the folder “${title}”, the search, filters and sort so you can come back to them from the sidebar.`}
          label="View name"
          maxLength={60}
          submit="Save view"
          onClose={() => setSavingView(false)}
          onSubmit={async (name) => {
            const f = await backend.library.saveFilter(name, filter, sort);
            reloadLibrary();
            setFolder({ kind: 'saved', id: f.id });
            setText('');
            setTagId('');
            setStateFilter('any');
            notify(`View “${f.name}” saved.`);
          }}
        />
      )}
      {dialog?.kind === 'add_tag' && (
        <TagDialog
          mode="add"
          count={count}
          library={library}
          onClose={() => setDialog(null)}
          onSubmit={async (a) => {
            setDialog(null);
            await runBulk(a);
          }}
        />
      )}
      {dialog?.kind === 'remove_tag' && (
        <TagDialog
          mode="remove"
          count={count}
          library={library}
          onClose={() => setDialog(null)}
          onSubmit={async (a) => {
            setDialog(null);
            await runBulk(a);
          }}
        />
      )}
      {dialog?.kind === 'move' && (
        <MoveDialog
          backend={backend}
          count={count}
          library={library}
          onClose={() => setDialog(null)}
          onSubmit={async (a) => {
            setDialog({ kind: 'confirm', action: a });
          }}
        />
      )}
      {dialog?.kind === 'confirm' && (
        <ConfirmSelectionDialog
          backend={backend}
          selection={selection}
          operation={CONFIRM_TEXT[dialog.action.action]?.(dialog.action, library) ?? 'Change'}
          onClose={() => setDialog(null)}
          onConfirm={async () => {
            const a = dialog.action;
            setDialog(null);
            await runBulk(a);
          }}
        />
      )}
      {dialog?.kind === 'client_overview' && (
        <ClientOverviewDialog
          backend={backend}
          clientId={dialog.clientId}
          notify={notify}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'export' && (
        <ExportDialog
          backend={backend}
          notify={notify}
          selection={selection}
          count={count}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'delete' && (
        <DeleteDialog
          backend={backend}
          selection={selection}
          count={count}
          onClose={() => {
            setDialog(null);
            if (allMatching && view === 'trash' && selected.size === 0) setAllMatching(false);
          }}
          onConfirm={async () => {
            const r = await backend.profiles.deletePermanently(selection, count);
            clearSelection();
            setUndo(null);
            reloadLibrary();
            if (r.failed.length)
              setDialog({
                kind: 'failures',
                title: `${plural(r.changed, 'profile')} deleted; ${plural(r.failed.length, 'profile')} could not be deleted`,
                result: r,
              });
            else {
              setDialog(null);
              notify(`Deleted ${plural(r.changed, 'profile')} permanently.`);
            }
          }}
        />
      )}
      {dialog?.kind === 'set_proxy' && (
        <SetProxyDialog
          backend={backend}
          count={count}
          onClose={() => setDialog(null)}
          onSubmit={async (a) => {
            setDialog({ kind: 'confirm', action: a });
          }}
        />
      )}
      {launcher.dialog}
      {dialog?.kind === 'credentials' && (
        <CredentialPrompt
          backend={backend}
          proxyId={dialog.proxyId}
          onClose={() => setDialog(null)}
          onSaved={() => {
            const p = dialog.profile;
            setDialog(null);
            notify('Login saved.');
            void toggleOpen(p);
          }}
        />
      )}
      {dialog?.kind === 'failures' && (
        <FailuresDialog title={dialog.title} result={dialog.result} onClose={() => setDialog(null)} />
      )}
    </section>
  );
}

function SortHead(props: {
  label: string;
  k: Sort['key'];
  sort: Sort;
  onSort: (s: Sort) => void;
  desc?: boolean;
}) {
  const active = props.sort.key === props.k;
  return (
    <button
      type="button"
      tabIndex={-1}
      aria-hidden="true"
      className={`sort-head${active ? ' sort-head--active' : ''}`}
      onClick={() =>
        props.onSort({ key: props.k, descending: active ? !props.sort.descending : Boolean(props.desc) })
      }
    >
      {props.label}
      {active ? (props.sort.descending ? ' ↓' : ' ↑') : ''}
    </button>
  );
}

function ProfileRow(props: {
  p: ProfileView;
  active: boolean;
  checked: boolean;
  onOpen: () => void;
  onCheck: (range: boolean) => void;
  onFavourite: () => void;
  onPrimary: () => void;
}) {
  const { p } = props;
  const action = primaryAction(p);
  const extraTags = p.tags.length - 2;
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard users press Enter on the grid (VirtualList)
    // biome-ignore lint/a11y/noStaticElementInteractions: mouse convenience; the keyboard path is the grid itself
    <div
      className={`trow trow-grid${props.active ? ' trow--active' : ''}${props.checked ? ' trow--checked' : ''}`}
      onClick={props.onOpen}
    >
      <Cell className="col-check">
        <input
          type="checkbox"
          tabIndex={-1}
          checked={props.checked}
          aria-label={`Select ${p.name}`}
          onClick={(e) => {
            e.stopPropagation();
            props.onCheck(e.shiftKey);
          }}
          onChange={() => undefined}
        />
      </Cell>
      <Cell>
        <button
          type="button"
          tabIndex={-1}
          className="star"
          aria-pressed={p.favourite}
          aria-label={`Favourite: ${p.name}`}
          disabled={Boolean(p.trashed_at)}
          onClick={(e) => {
            e.stopPropagation();
            props.onFavourite();
          }}
        >
          {p.favourite ? '★' : '☆'}
        </button>
      </Cell>
      <Cell className="trow__name">{p.name}</Cell>
      <Cell className="trow__client">
        {p.client_name ? (
          <ClientBadge label={p.client_name} colour={p.client_colour} />
        ) : (
          <span className="muted">—</span>
        )}
      </Cell>
      <Cell className="col-tags trow__tags">
        {p.tags.slice(0, 2).map((t) => (
          <span key={t.id} className="chip chip--small">
            {t.name}
          </span>
        ))}
        {extraTags > 0 && <span className="muted small">+{extraTags}</span>}
      </Cell>
      <Cell>
        {p.trashed_at ? (
          <span className="muted small">Deletes {day(p.purge_after)}</span>
        ) : (
          <StatusText p={p} />
        )}
      </Cell>
      <Cell className="col-used small">{relative(p.last_started_at)}</Cell>
      <Cell className="col-proxy">
        <NetworkCell p={p} />
      </Cell>
      <Cell className="col-sync">
        <SharedCell p={p} />
      </Cell>
      <Cell className="trow__actions">
        <button
          type="button"
          tabIndex={-1}
          className="pb-button"
          data-variant={action === 'force' && !p.trashed_at ? 'danger' : undefined}
          disabled={!p.trashed_at && action === 'wait'}
          onClick={(e) => {
            e.stopPropagation();
            props.onPrimary();
          }}
        >
          {p.trashed_at ? 'Restore' : ACTION_LABEL[action]}
          <span className="pb-sr-only"> {p.name}</span>
        </button>
      </Cell>
    </div>
  );
}

function BulkBar(props: {
  count: number;
  total: number;
  allMatching: boolean;
  view: 'active' | 'archived' | 'trash';
  onSelectAll: () => void;
  onClear: () => void;
  onAction: (a: BulkAction) => void;
  onDialog: (kind: 'add_tag' | 'remove_tag' | 'move' | 'export' | 'delete' | 'set_proxy') => void;
}) {
  const { count, view } = props;
  const n = count.toLocaleString();
  return (
    <section className="bulk-bar" aria-label={`Actions for ${plural(count, 'selected profile')}`}>
      <p className="bulk-bar__count" role="status">
        <strong>
          {props.allMatching
            ? count === 1
              ? 'The 1 matching profile is selected'
              : `All ${plural(count, 'matching profile')} selected`
            : `${n} selected`}
        </strong>
        {!props.allMatching && props.total > count && (
          <>
            {' '}
            of {props.total.toLocaleString()}.{' '}
            <button type="button" className="link-button" onClick={props.onSelectAll}>
              Select all {props.total.toLocaleString()} matching
            </button>
          </>
        )}
        {' · '}
        <button type="button" className="link-button" onClick={props.onClear}>
          Clear selection
        </button>
      </p>
      <div className="row">
        {view === 'trash' ? (
          <>
            <button type="button" className="pb-button" onClick={() => props.onAction({ action: 'restore' })}>
              Restore {n}
            </button>
            <button
              type="button"
              className="pb-button"
              data-variant="danger"
              onClick={() => props.onDialog('delete')}
            >
              Delete {n} permanently…
            </button>
          </>
        ) : (
          <>
            <button type="button" className="pb-button" onClick={() => props.onDialog('add_tag')}>
              Add tag…
            </button>
            <button type="button" className="pb-button" onClick={() => props.onDialog('remove_tag')}>
              Remove tag…
            </button>
            <button type="button" className="pb-button" onClick={() => props.onDialog('move')}>
              Move to client…
            </button>
            <button type="button" className="pb-button" onClick={() => props.onDialog('set_proxy')}>
              Set proxy…
            </button>
            <button
              type="button"
              className="pb-button"
              onClick={() => props.onAction({ action: 'favourite', value: true })}
            >
              Favourite
            </button>
            <button
              type="button"
              className="pb-button"
              onClick={() => props.onAction({ action: view === 'archived' ? 'unarchive' : 'archive' })}
            >
              {view === 'archived' ? `Unarchive ${n}` : `Archive ${n}`}
            </button>
            <button type="button" className="pb-button" onClick={() => props.onDialog('export')}>
              Export…
            </button>
            <button type="button" className="pb-button" onClick={() => props.onAction({ action: 'trash' })}>
              Move {n} to trash
            </button>
          </>
        )}
      </div>
    </section>
  );
}

/** Sidebar folders: views, clients (with counts) and saved views. Rendered into the app sidebar. */
function Folders(props: {
  backend: Backend;
  library: Library | null;
  folder: Folder;
  onChoose: (f: Folder) => void;
  onChanged: () => void;
  notify: Notify;
}) {
  const { library, folder } = props;
  const [find, setFind] = useState('');
  const c = library?.counts;
  const views: [Folder, string, number | undefined][] = [
    [{ kind: 'all' }, 'All profiles', c?.active],
    [{ kind: 'favourites' }, 'Favourites', c?.favourites],
    [{ kind: 'open' }, 'Open now', c?.running],
    [{ kind: 'no_client' }, 'No client', c?.without_client],
    [{ kind: 'archived' }, 'Archived', c?.archived],
    [{ kind: 'trash' }, 'Trash', c?.trash],
  ];
  const clients = (library?.clients ?? []).filter(
    (x) => !x.archived_at || (folder.kind === 'client' && folder.id === x.id),
  );
  const shown = find.trim() ? clients.filter((x) => nameKey(x.name).includes(nameKey(find))) : clients;
  const item = (f: Folder, label: string, n: number | undefined, colour?: string | null) => (
    <li key={'id' in f ? f.id : f.kind}>
      <button
        type="button"
        className="folder"
        aria-current={sameFolder(f, folder) ? 'true' : undefined}
        onClick={() => props.onChoose(f)}
      >
        {colour !== undefined && (
          <span
            className="folder__dot"
            style={{ background: colour ?? clientColor(label) }}
            aria-hidden="true"
          />
        )}
        <span className="folder__label">{label}</span>
        {n !== undefined && <span className="folder__count">{n.toLocaleString()}</span>}
      </button>
    </li>
  );
  return (
    <nav className="folders" aria-label="Profile folders">
      <ul>{views.map(([f, label, n]) => item(f, label, n))}</ul>
      <h2 className="sidebar__label">Clients</h2>
      {clients.length > 10 && (
        <label className="folders__find">
          <span className="pb-sr-only">Find a client</span>
          <input
            type="search"
            placeholder="Find a client"
            value={find}
            onChange={(e) => setFind(e.target.value)}
          />
        </label>
      )}
      {clients.length === 0 ? (
        <p className="sidebar__hint">Clients you add to profiles appear here.</p>
      ) : (
        <ul className="folders__clients">
          {shown.map((x) => item({ kind: 'client', id: x.id }, x.name, x.profiles, x.colour))}
        </ul>
      )}
      {(library?.saved_filters.length ?? 0) > 0 && (
        <>
          <h2 className="sidebar__label">Saved views</h2>
          <ul>
            {library?.saved_filters.map((f) => (
              <li key={f.id} className="folders__saved">
                <button
                  type="button"
                  className="folder"
                  aria-current={folder.kind === 'saved' && folder.id === f.id ? 'true' : undefined}
                  onClick={() => props.onChoose({ kind: 'saved', id: f.id })}
                >
                  <span className="folder__label">{f.name}</span>
                </button>
                <button
                  type="button"
                  className="folder__remove"
                  aria-label={`Delete saved view ${f.name}`}
                  onClick={async () => {
                    try {
                      await props.backend.library.deleteFilter(f.id);
                      props.onChanged();
                      props.notify(`Saved view “${f.name}” deleted.`);
                    } catch (e) {
                      props.notify(errorMessage(e), 'error');
                    }
                  }}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </nav>
  );
}

function CreateProfileDialog(props: {
  backend: Backend;
  library: Library | null;
  defaultClient: string;
  onCancel: () => void;
  onCreated: (p: ProfileView) => void;
}) {
  const [name, setName] = useState('');
  const [client, setClient] = useState(props.defaultClient);
  const [template, setTemplate] = useState('');
  const [error, setError] = useState<string | null>(null);
  const templates = props.library?.templates ?? [];
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      props.onCreated(
        await props.backend.profiles.create(name, client.trim() || undefined, template || undefined),
      );
    } catch (err) {
      setError(errorMessage(err, 'Could not create the profile.'));
    }
  };
  return (
    <Dialog title="New profile" onClose={props.onCancel} initialFocus="input">
      <form className="stack" onSubmit={submit}>
        <label>
          Name
          <input required maxLength={120} value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label>
          Client (optional)
          <input
            maxLength={120}
            value={client}
            list="new-profile-clients"
            onChange={(e) => setClient(e.target.value)}
          />
          <datalist id="new-profile-clients">
            {props.library?.clients
              .filter((c) => !c.archived_at)
              .map((c) => (
                <option key={c.id} value={c.name} />
              ))}
          </datalist>
        </label>
        {templates.length > 0 && (
          <label>
            Template (optional)
            <select value={template} onChange={(e) => setTemplate(e.target.value)}>
              <option value="">No template</option>
              {templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <p className="muted small">
          A new client name creates the client. New profiles always start with empty browser storage.
        </p>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <div className="row row--end">
          <button type="button" className="pb-button" onClick={props.onCancel}>
            Cancel
          </button>
          <button type="submit" className="pb-button" data-variant="primary">
            Create
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function TagDialog(props: {
  mode: 'add' | 'remove';
  count: number;
  library: Library | null;
  onClose: () => void;
  onSubmit: (a: BulkAction) => Promise<void>;
}) {
  const tags = props.library?.tags ?? [];
  const [name, setName] = useState('');
  const [tagId, setTagId] = useState(tags[0]?.id ?? '');
  const what = plural(props.count, 'selected profile');
  return (
    <Dialog
      title={props.mode === 'add' ? `Add a tag to ${what}` : `Remove a tag from ${what}`}
      onClose={props.onClose}
      initialFocus={props.mode === 'add' ? 'input' : 'select'}
    >
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          if (props.mode === 'add') {
            const known = tags.find((t) => nameKey(t.name) === nameKey(name));
            void props.onSubmit(
              known ? { action: 'add_tag', tag_id: known.id } : { action: 'add_tag', tag_name: name.trim() },
            );
          } else if (tagId) void props.onSubmit({ action: 'remove_tag', tag_id: tagId });
        }}
      >
        {props.mode === 'add' ? (
          <label>
            Tag (new or existing)
            <input
              required
              maxLength={40}
              value={name}
              list="bulk-tags"
              onChange={(e) => setName(e.target.value)}
            />
            <datalist id="bulk-tags">
              {tags.map((t) => (
                <option key={t.id} value={t.name} />
              ))}
            </datalist>
          </label>
        ) : tags.length ? (
          <label>
            Tag
            <select value={tagId} onChange={(e) => setTagId(e.target.value)}>
              {tags.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <p>There are no tags in this workspace yet.</p>
        )}
        <div className="row row--end">
          <button type="button" className="pb-button" onClick={props.onClose}>
            Cancel
          </button>
          <button
            type="submit"
            className="pb-button"
            data-variant="primary"
            disabled={props.mode === 'add' ? !name.trim() : !tagId}
          >
            {props.mode === 'add'
              ? `Add to ${props.count.toLocaleString()}`
              : `Remove from ${props.count.toLocaleString()}`}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function MoveDialog(props: {
  backend: Backend;
  count: number;
  library: Library | null;
  onClose: () => void;
  onSubmit: (a: BulkAction) => Promise<void>;
}) {
  const clients = (props.library?.clients ?? []).filter((c) => !c.archived_at);
  const [choice, setChoice] = useState(clients[0]?.id ?? '');
  const [newName, setNewName] = useState('');
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog
      title={`Move ${plural(props.count, 'selected profile')} to a client`}
      onClose={props.onClose}
      initialFocus="select"
    >
      <form
        className="stack"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            let id: string | null = choice === '' ? null : choice;
            if (choice === 'new') {
              try {
                id = (await props.backend.library.createClient(newName)).id;
              } catch (err) {
                const existing = clients.find((c) => nameKey(c.name) === nameKey(newName));
                if (!(isIpcError(err) && err.code === 'DUPLICATE_NAME' && existing)) throw err;
                id = existing.id;
              }
            }
            await props.onSubmit({ action: 'move', client_id: id });
          } catch (err) {
            setError(errorMessage(err));
          }
        }}
      >
        <label>
          Client
          <select value={choice} onChange={(e) => setChoice(e.target.value)}>
            {clients.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
            <option value="new">New client…</option>
            <option value="">No client</option>
          </select>
        </label>
        {choice === 'new' && (
          <label>
            New client name
            <input required maxLength={120} value={newName} onChange={(e) => setNewName(e.target.value)} />
          </label>
        )}
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <div className="row row--end">
          <button type="button" className="pb-button" onClick={props.onClose}>
            Cancel
          </button>
          <button type="submit" className="pb-button" data-variant="primary">
            Move {props.count.toLocaleString()}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

/** The clients, profiles and operation a bulk action will touch, loaded from the shell (milestone 09). */
function SelectionSummaryView(props: { backend: Backend; selection: Selection }) {
  const [s, setS] = useState<SelectionSummary | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const { backend, selection } = props;
  const key = JSON.stringify(selection);
  // biome-ignore lint/correctness/useExhaustiveDependencies: key stands for the selection
  useEffect(() => {
    let live = true;
    backend.agency
      .selectionSummary(selection)
      .then((x) => live && setS(x))
      .catch((e) => live && setFailed(errorMessage(e)));
    return () => {
      live = false;
    };
  }, [backend, key]);
  if (failed)
    return (
      <p role="alert" className="error">
        {failed}
      </p>
    );
  if (!s) return <p role="status">Checking which profiles this touches…</p>;
  return (
    <div className="stack selection-summary">
      <p>
        <strong>{plural(s.total, 'profile')}</strong>
        {' in '}
        {plural(s.clients.filter((c) => c.client_name).length, 'client')}
        {s.clients.some((c) => !c.client_name) ? ' (and some without a client)' : ''}:
      </p>
      <ul>
        {s.clients.map((c) => (
          <li key={c.client_id ?? 'none'}>
            <strong>{c.client_name ?? 'No client'}</strong> — {plural(c.count, 'profile')}:{' '}
            {c.names.join(', ')}
            {c.count > c.names.length ? ` and ${c.count - c.names.length} more` : ''}
          </li>
        ))}
      </ul>
      {s.running > 0 && (
        <p className="warn">{plural(s.running, 'of them is', 'of them are')} open right now.</p>
      )}
      {s.shared > 0 && (
        <p className="muted small">
          {plural(s.shared, 'is', 'are')} shared with an organization: this changes the copy on this computer
          only.
        </p>
      )}
    </div>
  );
}

function ConfirmSelectionDialog(props: {
  backend: Backend;
  selection: Selection;
  operation: string;
  onClose: () => void;
  onConfirm: () => Promise<void>;
}) {
  return (
    <Dialog role="alertdialog" title={`${props.operation}?`} onClose={props.onClose}>
      <div className="stack">
        <SelectionSummaryView backend={props.backend} selection={props.selection} />
        <p className="muted small">
          Only what this app controls changes. Nothing is done on websites, and actions inside open browser
          windows are not intercepted.
        </p>
        <div className="row row--end">
          <button type="button" className="pb-button" onClick={props.onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="pb-button"
            data-variant="primary"
            onClick={() => void props.onConfirm()}
          >
            {props.operation}
          </button>
        </div>
      </div>
    </Dialog>
  );
}

function DeleteDialog(props: {
  backend: Backend;
  selection: Selection;
  count: number;
  onClose: () => void;
  onConfirm: () => Promise<void>;
}) {
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const what = plural(props.count, 'profile');
  return (
    <Dialog
      role="alertdialog"
      title={`Delete ${what} permanently?`}
      description={`This removes ${props.count === 1 ? 'its' : 'their'} sign-ins, cookies, history and site data from this device. It cannot be undone. Type DELETE to confirm.`}
      onClose={props.onClose}
      initialFocus="input"
    >
      <SelectionSummaryView backend={props.backend} selection={props.selection} />
      <form
        className="stack"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            await props.onConfirm();
          } catch (err) {
            setError(errorMessage(err));
            setBusy(false);
          }
        }}
      >
        <label>
          Confirmation
          <input value={text} onChange={(e) => setText(e.target.value)} autoComplete="off" />
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
          <button
            type="submit"
            className="pb-button"
            data-variant="danger"
            disabled={text !== 'DELETE' || busy}
          >
            Delete {what}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function FailuresDialog(props: { title: string; result: BulkResult; onClose: () => void }) {
  const r = props.result;
  return (
    <Dialog
      title={props.title}
      description={`${plural(r.changed, 'profile')} changed${r.unchanged ? `, ${r.unchanged.toLocaleString()} already matched` : ''}. The others are listed below with the reason.`}
      onClose={props.onClose}
      wide
    >
      <div className="scroll-box">
        <table className="simple">
          <thead>
            <tr>
              <th scope="col">Profile</th>
              <th scope="col">Why</th>
            </tr>
          </thead>
          <tbody>
            {r.failed.slice(0, 500).map((f) => (
              <tr key={f.id}>
                <td>{f.name ?? <span className="mono">{f.id}</span>}</td>
                <td>{f.message}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="row row--end">
        <button type="button" className="pb-button" data-variant="primary" onClick={props.onClose}>
          OK
        </button>
      </div>
    </Dialog>
  );
}
