/**
 * In-memory backend used when the UI runs outside the desktop shell (plain `vite`, UI tests). It mimics the Rust
 * validation rules closely enough for UI development; it is never used inside the installed app.
 * Query parameters: `?demo=fresh` (first run), `?demo=rows:10000` (large list), `?demo=crash` (crash prompt),
 * `?demo=migration` (database recovery screen), `?demo=running` (a profile open, for the quit prompt).
 */
import type { EventName, EventPayload, Operation } from '@pb/contracts/ipc';
import type { AppView, Backend, IpcError, ProfileView, SettingValue, Workspace } from './types.ts';

const CROCK = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const id = (prefix: string) =>
  `${prefix}_${Array.from({ length: 26 }, () => CROCK[Math.floor(Math.random() * 32)]).join('')}`;
const now = () => new Date().toISOString();
const err = (code: string, message: string): IpcError => ({ code, message });

export function demoBackend(mode = ''): Backend {
  const listeners = new Map<string, Set<(p: unknown) => void>>();
  const emit = <E extends EventName>(e: E, p: EventPayload<E>) => {
    for (const l of listeners.get(e) ?? []) l(p);
  };

  const workspaces: Workspace[] = [];
  const profiles: ProfileView[] = [];
  const ops: Operation[] = [];
  let opSeq = 0;
  let crashed = mode === 'crash';
  let storeFailed = mode === 'migration';
  const settings: Record<string, SettingValue> = {
    'appearance.theme': { key: 'appearance.theme', value: 'system', version: 0, ui_settable: true },
    'manager.close_behavior': { key: 'manager.close_behavior', value: 'ask', version: 0, ui_settable: true },
    'privacy.crash_reports': { key: 'privacy.crash_reports', value: false, version: 0, ui_settable: true },
    'downloads.directory': { key: 'downloads.directory', value: null, version: 0, ui_settable: false },
    'workspace.active': { key: 'workspace.active', value: null, version: 0, ui_settable: true },
  };

  const addProfile = (name: string, client: string | null, wsId: string): ProfileView => {
    const p: ProfileView = {
      id: id('prf'),
      workspace_id: wsId,
      name,
      client_label: client,
      notes: '',
      version: 1,
      created_at: now(),
      updated_at: now(),
      status: 'closed',
      pid: null,
      adopted: false,
    };
    profiles.push(p);
    return p;
  };

  if (mode !== 'fresh' && mode !== 'migration') {
    const ws: Workspace = { id: id('wsp'), name: 'Demo agency', kind: 'local', created_at: now() };
    workspaces.push(ws);
    settings['workspace.active'] = {
      ...(settings['workspace.active'] as SettingValue),
      value: ws.id,
      version: 1,
    };
    const rows = mode.startsWith('rows:') ? Number(mode.slice(5)) : 3;
    const clients = ['Client North', 'Client South', 'Client East', null];
    for (let i = 0; i < rows; i++) {
      addProfile(
        rows === 3
          ? (['Shop admin', 'Ads QA', 'Support desk'][i] as string)
          : `Profile ${String(i).padStart(5, '0')}`,
        clients[i % clients.length] ?? null,
        ws.id,
      );
    }
    if (mode === 'running' && profiles[0]) {
      profiles[0] = { ...profiles[0], status: 'running', pid: 4242, adopted: true };
    }
  }

  const activeWs = () => settings['workspace.active']?.value as string | null;
  const running = () => profiles.filter((p) => p.status !== 'closed').length;
  const clean = (v: string, max: number, code: string, message: string) => {
    const t = v.trim();
    if (!t || [...t].length > max || /\p{Cc}/u.test(t)) throw err(code, message);
    return t;
  };
  const startOp = (kind: Operation['kind'], target: string | null): Operation => {
    const op: Operation = {
      operation_id: `op_${++opSeq}`,
      kind,
      status: 'running',
      progress: null,
      target,
      error_code: null,
      message: null,
    };
    ops.unshift(op);
    emit('operation', op);
    return op;
  };
  const finish = (op: Operation, patch: Partial<Operation>) => {
    Object.assign(op, patch);
    emit('operation', { ...op });
    emit('profiles-changed', { running: running() });
  };
  const requireStore = () => {
    if (storeFailed)
      throw err('STORE_UNAVAILABLE', 'Local data could not be opened. Use the recovery options to continue.');
  };

  return {
    kind: 'demo',
    workspaces: {
      async appState(): Promise<AppView> {
        return {
          app: { version: '0.2.0-demo', platform: 'demo', arch: 'demo' },
          store: storeFailed
            ? {
                status: 'failed',
                failure: { code: 'MIGRATION_FAILED', from_version: 1, to_version: 2, backup_available: true },
              }
            : { status: 'ready' },
          first_run: !storeFailed && workspaces.length === 0,
          workspaces: [...workspaces],
          active_workspace_id: activeWs(),
          settings: Object.values(settings),
          recovery: {
            previous_session_crashed: crashed,
            crash_reports: crashed ? 1 : 0,
            adopted_profiles: mode === 'running' ? 1 : 0,
            cleared_stale_processes: 0,
            interrupted_installs: 0,
          },
          keychain: { available: true, reason: null },
          running_count: running(),
        };
      },
      async createWorkspace(name) {
        requireStore();
        const ws: Workspace = {
          id: id('wsp'),
          name: clean(name, 80, 'INVALID_WORKSPACE_NAME', 'Workspace names must be 1-80 visible characters.'),
          kind: 'local',
          created_at: now(),
        };
        workspaces.push(ws);
        if (!activeWs())
          settings['workspace.active'] = { ...(settings['workspace.active'] as SettingValue), value: ws.id };
        return ws;
      },
      async setActiveWorkspace(wsId) {
        if (!workspaces.some((w) => w.id === wsId))
          throw err('UNKNOWN_WORKSPACE', 'That workspace does not exist.');
        settings['workspace.active'] = { ...(settings['workspace.active'] as SettingValue), value: wsId };
      },
    },
    profiles: {
      async list(query) {
        requireStore();
        const q = query?.trim().toLowerCase();
        if (q && q.length > 200) throw err('QUERY_TOO_LONG', 'Search text is too long.');
        return profiles
          .filter((p) => p.workspace_id === activeWs())
          .filter((p) => !q || `${p.name} ${p.client_label ?? ''}`.toLowerCase().includes(q))
          .sort((a, b) => a.name.localeCompare(b.name))
          .slice(0, 10000);
      },
      async create(name, clientLabel) {
        requireStore();
        const ws = activeWs();
        if (!ws) throw err('NO_WORKSPACE', 'Create a workspace first.');
        const n = clean(name, 120, 'INVALID_LABEL', 'Names must be 1-120 visible characters.');
        const c = clientLabel?.trim()
          ? clean(clientLabel, 120, 'INVALID_LABEL', 'Names must be 1-120 visible characters.')
          : null;
        return addProfile(n, c, ws);
      },
      async update(pid, c) {
        const i = profiles.findIndex((p) => p.id === pid);
        const p = profiles[i];
        if (!p) throw err('NOT_FOUND', 'That item no longer exists.');
        if (p.version !== c.expectedVersion) {
          throw {
            ...err('VERSION_CONFLICT', 'This was changed elsewhere. Reload and try again.'),
            current_version: p.version,
          };
        }
        if (c.notes !== undefined && [...c.notes].length > 2000)
          throw err('NOTES_TOO_LONG', 'Notes can be at most 2,000 characters.');
        const next: ProfileView = {
          ...p,
          name:
            c.name !== undefined
              ? clean(c.name, 120, 'INVALID_LABEL', 'Names must be 1-120 visible characters.')
              : p.name,
          client_label: c.clearClientLabel
            ? null
            : c.clientLabel !== undefined
              ? c.clientLabel.trim()
              : p.client_label,
          notes: c.notes ?? p.notes,
          version: p.version + 1,
          updated_at: now(),
        };
        profiles[i] = next;
        return next;
      },
      async launch(pid) {
        const p = profiles.find((x) => x.id === pid);
        if (!p) throw err('UNKNOWN_PROFILE', 'This profile does not exist on this device.');
        if (p.status !== 'closed') throw err('ALREADY_RUNNING', 'This profile is already open.');
        const op = startOp('launch_profile', pid);
        // The demo has no browser runtime, exactly like a fresh install before milestone 03.
        setTimeout(
          () =>
            finish(op, {
              status: 'failed',
              error_code: 'BROWSER_NOT_CONFIGURED',
              message: 'The browser runtime is not installed.',
            }),
          300,
        );
        return { operation_id: op.operation_id };
      },
      async stop(pid) {
        const i = profiles.findIndex((x) => x.id === pid);
        const p = profiles[i];
        if (!p || p.status === 'closed') throw err('NOT_RUNNING', 'This profile is not open.');
        profiles[i] = { ...p, status: 'stopping' };
        const op = startOp('stop_profile', pid);
        setTimeout(() => {
          profiles[i] = { ...(profiles[i] as ProfileView), status: 'closed', pid: null, adopted: false };
          finish(op, { status: 'succeeded', progress: 1 });
        }, 400);
        return { operation_id: op.operation_id };
      },
      async closeAll() {
        const op = startOp('close_all', null);
        setTimeout(() => {
          for (let i = 0; i < profiles.length; i++) {
            profiles[i] = { ...(profiles[i] as ProfileView), status: 'closed', pid: null, adopted: false };
          }
          finish(op, { status: 'succeeded', progress: 1 });
        }, 400);
        return { operation_id: op.operation_id };
      },
    },
    system: {
      async runtimeStatus() {
        return {
          browser: { configured: false, source: 'none', revision: null },
          installations: [],
          interrupted: [],
          quarantined: 0,
          running: profiles
            .filter((p) => p.status !== 'closed')
            .map((p) => ({
              profile_id: p.id,
              pid: p.pid ?? 0,
              adopted: p.adopted,
              stopping: p.status === 'stopping',
            })),
          operations: ops.slice(0, 50),
          manager_updates: {
            channel: 'internal',
            automatic: false,
            note: 'Signed update channels arrive in milestone 12.',
          },
        };
      },
      async updateSetting(key, value, expectedVersion) {
        const s = settings[key];
        if (!s) throw err('UNKNOWN_SETTING', 'That setting does not exist.');
        if (!s.ui_settable)
          throw err('SETTING_READ_ONLY', 'That setting is changed through its own control.');
        if (expectedVersion !== undefined && expectedVersion !== s.version) {
          throw {
            ...err('VERSION_CONFLICT', 'This was changed elsewhere. Reload and try again.'),
            current_version: s.version,
          };
        }
        const next = { ...s, value, version: s.version + 1 };
        settings[key] = next;
        return next;
      },
      async selectDownloadDirectory() {
        const path = '/Users/demo/Downloads';
        settings['downloads.directory'] = {
          ...(settings['downloads.directory'] as SettingValue),
          value: path,
          version: 1,
        };
        return { path };
      },
      async diagnostics() {
        return {
          app: { version: '0.2.0-demo', platform: 'demo', os: navigator.userAgent, arch: 'demo' },
          store: {
            status: storeFailed ? 'failed' : 'ready',
            schema_version: 2,
            journal_mode: 'wal',
            foreign_keys: true,
            integrity_ok: true,
          },
          keychain: { available: true, reason: null },
          manager: { uptime_s: Math.round(performance.now() / 1000), rss_bytes: null, startup_ms: null },
          browsers: { running: running(), main_process_rss_bytes: 0 },
          crash_reports: crashed ? 1 : 0,
        };
      },
      async exportDiagnostics() {
        return { path: '~/Downloads/project-browser-diagnostics.json' };
      },
      async reportUiReady() {
        return performance.now();
      },
      async recovery(action) {
        if (action === 'dismiss_crash') crashed = false;
        if (action === 'restore_backup' || action === 'retry_open') storeFailed = false;
      },
      async resolveQuit(choice) {
        if (choice === 'close_all') {
          for (let i = 0; i < profiles.length; i++) {
            profiles[i] = { ...(profiles[i] as ProfileView), status: 'closed', pid: null, adopted: false };
          }
          emit('profiles-changed', { running: 0 });
        }
      },
      async openExternal(url) {
        if (!/^https:\/\/github\.com\//.test(url))
          throw err('DISALLOWED_URL', 'Only https links to approved help sites can be opened.');
      },
      async removeLocalData(confirm) {
        if (confirm !== 'DELETE')
          throw err('CONFIRMATION_REQUIRED', 'Type DELETE to confirm removing all local data.');
        if (running() > 0) throw err('PROFILES_RUNNING', 'Close all open profiles before doing this.');
        profiles.length = 0;
        workspaces.length = 0;
        settings['workspace.active'] = { ...(settings['workspace.active'] as SettingValue), value: null };
      },
    },
    on(event, handler) {
      const set = listeners.get(event) ?? new Set();
      set.add(handler as (p: unknown) => void);
      listeners.set(event, set);
      return () => set.delete(handler as (p: unknown) => void);
    },
    /** Demo-only: lets UI tests trigger the quit prompt like the tray/window close would. */
    simulateQuitRequest() {
      emit('quit-requested', { running: running() });
    },
  } as Backend & { simulateQuitRequest(): void };
}
