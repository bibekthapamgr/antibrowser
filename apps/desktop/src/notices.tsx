/**
 * Notifications (milestone 09): short-lived messages are de-duplicated (the same message again within a few seconds
 * counts up instead of stacking), and what needs the person — a failed or conflicting backup, a lost or ended shared
 * session, extensions turned off, a long-open profile, a full disk — stays in the notification centre until it is
 * resolved or dismissed. Screen readers hear each message once, politely; errors as alerts.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AccountView, Backend, HealthView } from './backend/types.ts';
import { errorMessage } from './backend/types.ts';
import { Dialog } from './components.tsx';
import { relative } from './status.tsx';

export interface Toast {
  id: number;
  text: string;
  tone: 'info' | 'error';
  count: number;
}

export interface Notice {
  /** Same key: the notice is updated, not repeated. */
  key: string;
  text: string;
  tone: 'info' | 'error';
  at: string;
  action?: { label: string; run: () => void | Promise<void> };
}

const MAX_TOASTS = 4;

/** Toasts with de-duplication, and persistent notices. */
export function useNotifications() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [notices, setNotices] = useState<Notice[]>([]);
  const seq = useRef(0);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const live = useRef(new Map<string, number>());

  const schedule = useCallback((id: number, key: string, tone: 'info' | 'error') => {
    const old = timers.current.get(id);
    if (old) clearTimeout(old);
    timers.current.set(
      id,
      setTimeout(
        () => {
          timers.current.delete(id);
          if (live.current.get(key) === id) live.current.delete(key);
          setToasts((t) => t.filter((x) => x.id !== id));
        },
        tone === 'error' ? 8000 : 4000,
      ),
    );
  }, []);

  /** A message already on screen counts up (and stays a little longer) instead of stacking. */
  const notify = useCallback(
    (text: string, tone: 'info' | 'error' = 'info') => {
      const key = `${tone}:${text}`;
      const existing = live.current.get(key);
      if (existing !== undefined) {
        setToasts((t) => t.map((x) => (x.id === existing ? { ...x, count: x.count + 1 } : x)));
        schedule(existing, key, tone);
        return;
      }
      const id = ++seq.current;
      live.current.set(key, id);
      setToasts((t) => {
        const kept = t.slice(-(MAX_TOASTS - 1));
        for (const dropped of t.slice(0, t.length - kept.length))
          for (const [k, v] of live.current) if (v === dropped.id) live.current.delete(k);
        return [...kept, { id, text, tone, count: 1 }];
      });
      schedule(id, key, tone);
    },
    [schedule],
  );

  const raise = useCallback((n: Omit<Notice, 'at'>) => {
    setNotices((list) =>
      [{ ...n, at: new Date().toISOString() }, ...list.filter((x) => x.key !== n.key)].slice(0, 50),
    );
  }, []);
  const resolve = useCallback((key: string) => {
    setNotices((list) => list.filter((x) => x.key !== key));
  }, []);

  useEffect(() => {
    const all = timers.current;
    return () => {
      for (const t of all.values()) clearTimeout(t);
    };
  }, []);

  return { toasts, notices, notify, raise, resolve };
}

/** Screen-reader announcements and the visible toasts (a repeated message shows ×N). */
export function Toasts({ toasts }: { toasts: Toast[] }) {
  const label = (t: Toast) => (t.count > 1 ? `${t.text} (×${t.count})` : t.text);
  return (
    <div className="toasts">
      <div className="pb-sr-only" role="status" aria-live="polite">
        {toasts.filter((m) => m.tone === 'info').at(-1)?.text}
      </div>
      <div className="pb-sr-only" role="alert">
        {toasts.filter((m) => m.tone === 'error').at(-1)?.text}
      </div>
      {toasts.map((m) => (
        <div key={m.id} className={`toast toast--${m.tone}`} aria-hidden="true">
          {label(m)}
        </div>
      ))}
    </div>
  );
}

export function NoticeCentre(props: {
  notices: Notice[];
  onDismiss: (key: string) => void;
  onClose: () => void;
}) {
  return (
    <Dialog
      title="Notifications"
      description="Things that need you stay here until they are resolved or you dismiss them."
      onClose={props.onClose}
    >
      {props.notices.length === 0 ? (
        <p className="muted">Nothing needs your attention.</p>
      ) : (
        <ul className="notice-list">
          {props.notices.map((n) => (
            <li key={n.key} className={n.tone === 'error' ? 'notice notice--error' : 'notice'}>
              <p>
                {n.tone === 'error' && <strong>Needs attention: </strong>}
                {n.text} <span className="muted small">({relative(n.at).toLowerCase()})</span>
              </p>
              <div className="row">
                {n.action && (
                  <button
                    type="button"
                    className="pb-button"
                    onClick={() => {
                      void n.action?.run();
                      props.onClose();
                    }}
                  >
                    {n.action.label}
                  </button>
                )}
                <button type="button" className="pb-button" onClick={() => props.onDismiss(n.key)}>
                  Dismiss
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <div className="row row--end">
        <button type="button" className="pb-button" onClick={props.onClose}>
          Close
        </button>
      </div>
    </Dialog>
  );
}

/**
 * Shown while the organization server cannot be reached or the session ended: organization profiles cannot open,
 * local ones are not affected. "Try again" checks the connection; nothing retries in a loop.
 */
export function ReconnectBanner(props: {
  backend: Backend;
  account: AccountView | null;
  refreshKey: number;
}) {
  const { backend, account } = props;
  const [server, setServer] = useState<HealthView['cards'][number] | null>(null);
  const [checking, setChecking] = useState(false);
  const signedIn = account?.status === 'signed_in';

  const read = useCallback(
    async (fresh: boolean) => {
      try {
        const h = fresh ? await backend.agency.runCheck('server') : await backend.agency.health();
        setServer(h.cards.find((c) => c.id === 'connectivity') ?? null);
      } catch {
        setServer(null);
      }
    },
    [backend],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey re-reads after app events
  useEffect(() => {
    if (!signedIn) {
      setServer(null);
      return;
    }
    void read(false);
    const t = setInterval(() => void read(true), 5 * 60_000);
    return () => clearInterval(t);
  }, [signedIn, read, props.refreshKey]);

  if (account?.status === 'expired')
    return (
      <div className="notice notice--error banner" role="status">
        <span className="grow">
          Your organization session ended. Organization profiles cannot open until you sign in again; local
          profiles are not affected.
        </span>
        <button
          type="button"
          className="pb-button"
          onClick={() => void backend.account.signIn(true).catch(() => undefined)}
        >
          Sign in again
        </button>
      </div>
    );
  if (!signedIn || !server || server.status !== 'problem') return null;
  return (
    <div className="notice notice--error banner" role="status">
      <span className="grow">
        The organization server cannot be reached
        {server.checked_at ? ` (checked ${relative(server.checked_at).toLowerCase()})` : ''}. Organization
        profiles cannot open and backups wait; local profiles work as usual.
      </span>
      <button
        type="button"
        className="pb-button"
        disabled={checking}
        onClick={async () => {
          setChecking(true);
          try {
            await read(true);
          } catch (e) {
            void errorMessage(e);
          } finally {
            setChecking(false);
          }
        }}
      >
        {checking ? 'Checking…' : 'Try again'}
      </button>
    </div>
  );
}
