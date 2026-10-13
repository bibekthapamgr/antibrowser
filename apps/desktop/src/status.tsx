import type { ProfileView } from './backend/types.ts';

export type Notify = (text: string, tone?: 'info' | 'error') => void;

export type Action = 'open' | 'close' | 'force' | 'wait';
export const ACTION_LABEL: Record<Action, string> = {
  open: 'Open',
  close: 'Close',
  force: 'Force close',
  wait: 'Wait…',
};

export function primaryAction(p: ProfileView): Action {
  switch (p.state) {
    case 'stopped':
    case 'crashed':
      return 'open';
    case 'starting':
    case 'running':
      return 'close';
    case 'stopping':
      return p.force_available ? 'force' : 'wait';
    default:
      return 'wait';
  }
}

/** Plain-language text for the machine codes stored in `last_error` (never shown raw). */
export const LAST_ERROR: Record<string, string> = {
  CRASHED: 'The browser closed unexpectedly.',
  EXITED_EARLY: 'The browser closed right after starting.',
  START_INTERRUPTED: 'The last start was interrupted because the manager closed. Open it again.',
  CRASHED_WHILE_MANAGER_CLOSED: 'The browser closed unexpectedly while the manager was closed.',
  RECOVERY_INTERRUPTED: 'A recovery was interrupted. Run it again.',
  PROFILE_DATA_UNREADABLE: 'This profile’s browser data looks damaged.',
  SLOW_START: 'The browser took unusually long to start.',
  LOW_DISK_SPACE: 'There was not enough free disk space.',
  BACKUP_FAILED: 'A safety copy could not be made.',
  SPAWN_FAILED: 'The browser program could not be started.',
  NO_BACKUP: 'There is no backup to restore.',
  BACKUP_IO_ERROR: 'The backup could not be read or written.',
};

export function StatusText({ p }: { p: ProfileView }) {
  if (p.trashed_at) return <span className="muted">In the trash</span>;
  switch (p.state) {
    case 'stopped':
      return <span className="muted">{p.archived_at ? 'Archived' : 'Closed'}</span>;
    case 'starting':
      return <span className="warn">Opening…</span>;
    case 'stopping':
      return <span className="warn">{p.force_available ? 'Not responding' : 'Closing…'}</span>;
    case 'crashed':
      return <span className="error">Closed unexpectedly</span>;
    case 'recovering':
      return <span className="warn">Recovering…</span>;
    default:
      return (
        <span className="ok" title={p.adopted ? 'Opened before the manager restarted' : undefined}>
          {p.window_open ? 'Open' : 'Running (no window)'}
          {p.adopted ? ' · kept open while the manager was closed' : ''}
        </span>
      );
  }
}

export function when(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString();
}

export function day(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString();
}

/** "3 hours ago", "yesterday", or a date: compact enough for a table column. */
export function relative(iso: string | null | undefined): string {
  if (!iso) return 'Never';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '—';
  const mins = Math.round((Date.now() - t) / 60_000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days} days ago`;
  return new Date(t).toLocaleDateString();
}

export const plural = (n: number, one: string, many = `${one}s`) =>
  `${n.toLocaleString()} ${n === 1 ? one : many}`;

/** "Shop admin (Client North)": the client stays visible wherever a profile is confirmed or announced. */
export const withClient = (p: Pick<ProfileView, 'name' | 'client_name'>) =>
  p.client_name ? `${p.name} (${p.client_name})` : p.name;
