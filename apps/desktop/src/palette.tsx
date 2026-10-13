/**
 * Command palette and keyboard shortcuts (milestone 09). Ctrl+K (⌘K on a Mac) finds screens, checks and profiles
 * by name or client; ? lists the shortcuts. Everything the palette does is also reachable with the mouse.
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { Backend, ProfileView } from './backend/types.ts';
import { Dialog, useDebounced } from './components.tsx';
import { withClient } from './status.tsx';

export interface Command {
  id: string;
  label: string;
  /** Extra words the search matches (not shown). */
  keywords?: string;
  hint?: string;
  run: () => void;
}

export const isMac = () =>
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
export const MOD = () => (isMac() ? '⌘' : 'Ctrl+');

const typing = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  return !!el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName));
};

/** Global shortcuts: Ctrl/⌘+K palette, Ctrl/⌘+1…9 screens, ? shortcuts (when not typing). */
export function useShortcuts(handlers: {
  palette: () => void;
  help: () => void;
  nav: (index: number) => void;
}) {
  const ref = useRef(handlers);
  ref.current = handlers;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = isMac() ? e.metaKey : e.ctrlKey;
      if (mod && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        ref.current.palette();
      } else if (mod && !e.altKey && !e.shiftKey && /^[1-9]$/.test(e.key)) {
        e.preventDefault();
        ref.current.nav(Number(e.key) - 1);
      } else if (
        e.key === '?' &&
        !mod &&
        !e.altKey &&
        !typing(e.target) &&
        !document.querySelector('.dialog')
      ) {
        e.preventDefault();
        ref.current.help();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

const match = (q: string, c: Command) => {
  const hay = `${c.label} ${c.keywords ?? ''}`.toLowerCase();
  return q
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((w) => hay.includes(w));
};

export function CommandPalette(props: {
  backend: Backend;
  commands: Command[];
  onOpenProfile: (p: ProfileView) => void;
  onShowProfile: (p: ProfileView) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState('');
  const query = useDebounced(q, 120);
  const [profiles, setProfiles] = useState<ProfileView[]>([]);
  const [active, setActive] = useState(0);
  const listId = useId();

  useEffect(() => {
    const t = query.trim();
    if (t.length < 2) {
      setProfiles([]);
      return;
    }
    let live = true;
    props.backend.profiles
      .query({ filter: { text: t }, limit: 8 })
      .then((page) => live && setProfiles(page.rows))
      .catch(() => live && setProfiles([]));
    return () => {
      live = false;
    };
  }, [query, props.backend]);

  const items = useMemo(() => {
    const cmds = props.commands.filter((c) => !q.trim() || match(q, c)).slice(0, 12);
    const profileItems: Command[] = profiles.flatMap((p) => [
      {
        id: `open-${p.id}`,
        label: `Open ${withClient(p)}`,
        hint: 'Profile',
        run: () => props.onOpenProfile(p),
      },
      {
        id: `show-${p.id}`,
        label: `Show settings of ${withClient(p)}`,
        hint: 'Profile',
        run: () => props.onShowProfile(p),
      },
    ]);
    return [...cmds, ...profileItems];
  }, [props, q, profiles]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new query starts at the top
  useEffect(() => setActive(0), [q]);

  const choose = (c: Command | undefined) => {
    if (!c) return;
    props.onClose();
    c.run();
  };
  const activeItem = items[Math.min(active, items.length - 1)];
  return (
    <Dialog title="Go to or do…" onClose={props.onClose} initialFocus="input">
      <div className="palette">
        <input
          type="text"
          role="combobox"
          aria-expanded="true"
          aria-controls={listId}
          aria-activedescendant={activeItem ? `${listId}-${activeItem.id}` : undefined}
          aria-label="Search commands and profiles"
          placeholder="Type a screen, a check, or a profile or client name"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setActive((a) => Math.min(items.length - 1, a + 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setActive((a) => Math.max(0, a - 1));
            } else if (e.key === 'Enter') {
              e.preventDefault();
              choose(activeItem);
            }
          }}
        />
        <div id={listId} role="listbox" aria-label="Results" className="palette__list">
          {items.map((c, i) => (
            // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard selection happens in the combobox input
            <div
              key={c.id}
              id={`${listId}-${c.id}`}
              role="option"
              tabIndex={-1}
              aria-selected={i === active}
              className={i === active ? 'palette__item palette__item--active' : 'palette__item'}
              onMouseEnter={() => setActive(i)}
              onClick={() => choose(c)}
            >
              <span className="grow">{c.label}</span>
              {c.hint && <span className="small palette__hint">{c.hint}</span>}
            </div>
          ))}
          {items.length === 0 && (
            <div
              role="option"
              tabIndex={-1}
              aria-selected="false"
              aria-disabled="true"
              className="muted palette__item"
            >
              Nothing matches.
            </div>
          )}
        </div>
        <p className="muted small">
          Up and Down choose, Enter runs, Escape closes. Profile names and clients are searched after two
          letters.
        </p>
      </div>
    </Dialog>
  );
}

export function ShortcutsHelp(props: { onClose: () => void; screens: string[] }) {
  const mod = MOD();
  const rows: [string, string][] = [
    [`${mod}K`, 'Command palette: screens, checks and profiles'],
    ...props.screens.slice(0, 9).map((s, i): [string, string] => [`${mod}${i + 1}`, `Go to ${s}`]),
    ['?', 'This list of shortcuts'],
    ['Up / Down, Page Up / Page Down, Home / End', 'Move in the profile list'],
    ['Space (Shift+Space)', 'Select a profile (a range)'],
    ['Enter', 'Open the settings of the profile in focus'],
    ['Escape', 'Close a dialog'],
  ];
  return (
    <Dialog title="Keyboard shortcuts" onClose={props.onClose}>
      <table className="simple">
        <caption className="pb-sr-only">Keyboard shortcuts</caption>
        <thead>
          <tr>
            <th scope="col">Keys</th>
            <th scope="col">Action</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([k, v]) => (
            <tr key={k}>
              <td>
                <kbd>{k}</kbd>
              </td>
              <td>{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="row row--end">
        <button type="button" className="pb-button" onClick={props.onClose}>
          Close
        </button>
      </div>
    </Dialog>
  );
}
