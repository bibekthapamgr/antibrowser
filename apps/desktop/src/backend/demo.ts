/**
 * In-memory backend used when the UI runs outside the desktop shell (plain `vite`, UI tests). It mimics the Rust
 * validation rules and the run-state machine closely enough for UI development; it is never used inside the
 * installed app.
 *
 * Query parameters (`?demo=`): `fresh` (first run), `rows:N` (large list), `crash` (manager crash prompt),
 * `migration` (database recovery screen), `running` (a profile left open, for the quit prompt), `crashed` (a profile
 * that closed unexpectedly, with a backup), `stuck` (closing times out and offers a force close), `noruntime` (the
 * browser is not installed yet).
 */
import type { EventName, EventPayload, Operation, ProfileStatus } from '@pb/contracts/ipc';
import type {
  AppView,
  Backend,
  IpcError,
  ProfileView,
  RunState,
  RuntimeStatus,
  SettingValue,
  Workspace,
} from './types.ts';

const CROCK = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const id = (prefix: string) =>
  `${prefix}_${Array.from({ length: 26 }, () => CROCK[Math.floor(Math.random() * 32)]).join('')}`;
const now = () => new Date().toISOString();
const err = (code: string, message: string): IpcError => ({ code, message });
const RUNTIME_VERSION = '155.0.8059.39';
const STATUS: Record<RunState, ProfileView['status']> = {
  stopped: 'closed',
  starting: 'starting',
  running: 'running',
  stopping: 'stopping',
  crashed: 'crashed',
  recovering: 'recovering',
};
const validUrl = (u: string) => /^https?:\/\/\S{1,2040}$/i.test(u);

export function demoBackend(mode = ''): Backend {
  const listeners = new Map<string, Set<(p: unknown) => void>>();
  const emit = <E extends EventName>(e: E, p: EventPayload<E>) => {
    for (const l of listeners.get(e) ?? []) l(p);
  };

  const workspaces: Workspace[] = [];
  const profiles: ProfileView[] = [];
  const backups = new Map<string, { created_at_unix: number; files: number }>();
  const ops: Operation[] = [];
  let opSeq = 0;
  let crashed = mode === 'crash';
  let storeFailed = mode === 'migration';
  let runtimeInstalled = mode !== 'noruntime';
  let installing = false;
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
      client_colour: null,
      notes: '',
      version: 1,
      created_at: now(),
      updated_at: now(),
      status: 'closed',
      state: 'stopped',
      pid: null,
      adopted: false,
      ready: false,
      window_open: false,
      force_available: false,
      start_urls: [],
      download_dir: null,
      permissions: { camera: 'ask', microphone: 'ask', location: 'ask' },
      runtime_version: null,
      last_error: null,
      crash_count: 0,
      last_started_at: null,
      last_clean_shutdown_at: null,
      last_backup_at: null,
    };
    profiles.push(p);
    return p;
  };

  const set = (pid: string, patch: Partial<ProfileView>) => {
    const i = profiles.findIndex((x) => x.id === pid);
    const p = profiles[i];
    if (!p) return;
    const next = { ...p, ...patch };
    next.status = STATUS[next.state];
    profiles[i] = next;
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
    const first = profiles[0];
    if (first && (mode === 'running' || mode === 'stuck')) {
      set(first.id, {
        state: 'running',
        pid: 4242,
        adopted: mode === 'running',
        ready: true,
        window_open: true,
        runtime_version: RUNTIME_VERSION,
      });
    }
    if (first && mode === 'crashed') {
      set(first.id, {
        state: 'crashed',
        last_error: 'CRASHED',
        crash_count: 3,
        runtime_version: RUNTIME_VERSION,
        last_backup_at: now(),
      });
      backups.set(first.id, { created_at_unix: Math.floor(Date.now() / 1000) - 3600, files: 412 });
    }
  }

  const activeWs = () => settings['workspace.active']?.value as string | null;
  const isOpen = (p: ProfileView) =>
    p.state === 'starting' || p.state === 'running' || p.state === 'stopping';
  const running = () => profiles.filter(isOpen).length;
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
  const find = (pid: string) => {
    const p = profiles.find((x) => x.id === pid);
    if (!p) throw err('UNKNOWN_PROFILE', 'This profile does not exist on this device.');
    return p;
  };
  const stopNow = (pid: string, outcome: 'clean' | 'forced') => {
    set(pid, {
      state: 'stopped',
      pid: null,
      adopted: false,
      ready: false,
      window_open: false,
      force_available: false,
      ...(outcome === 'clean' ? { last_clean_shutdown_at: now(), crash_count: 0 } : {}),
    });
  };
  const launchOps = new Map<string, Operation>();

  const runtimeStatus = (): RuntimeStatus => ({
    browser: {
      configured: runtimeInstalled,
      source: runtimeInstalled ? 'manifest' : 'none',
      version: runtimeInstalled ? RUNTIME_VERSION : null,
      error: runtimeInstalled ? null : 'RUNTIME_NOT_INSTALLED',
      manifest_status: { status: 'verified', version: RUNTIME_VERSION },
      manifest: {
        version: RUNTIME_VERSION,
        channel: 'internal-alpha',
        distribution: 'Chrome for Testing',
        customer_distribution: false,
        platform_supported: true,
        size_bytes: 167_772_160,
      },
      installing,
    },
    installations: runtimeInstalled
      ? [
          {
            version: RUNTIME_VERSION,
            platform: 'macos-arm64',
            digest: 'a'.repeat(64),
            verified_at: now(),
            path: '/demo/runtimes/installed',
            status: 'verified',
            distribution: 'chrome-for-testing',
            executable:
              'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
          },
        ]
      : [],
    interrupted: [],
    quarantined: 0,
    running: profiles.filter(isOpen).map((p) => ({
      profile_id: p.id,
      run_id: null,
      pid: p.pid,
      state: p.state,
      adopted: p.adopted,
      ready: p.ready,
      window_open: p.window_open,
      helpers: p.ready ? 4 : 0,
      force_available: p.force_available,
    })),
    operations: ops.slice(0, 50),
    manager_updates: {
      channel: 'internal',
      automatic: false,
      note: 'Signed update channels arrive in milestone 12.',
    },
  });

  const backend = {
    kind: 'demo',
    workspaces: {
      async appState(): Promise<AppView> {
        return {
          app: { version: '0.3.0-demo', platform: 'demo', arch: 'demo' },
          store: storeFailed
            ? {
                status: 'failed',
                failure: { code: 'MIGRATION_FAILED', from_version: 2, to_version: 3, backup_available: true },
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
            interrupted_profiles: 0,
            interrupted_installs: 0,
          },
          keychain: { available: true, reason: null },
          running_count: running(),
        };
      },
      async createWorkspace(name: string) {
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
      async setActiveWorkspace(wsId: string) {
        if (!workspaces.some((w) => w.id === wsId))
          throw err('UNKNOWN_WORKSPACE', 'That workspace does not exist.');
        settings['workspace.active'] = { ...(settings['workspace.active'] as SettingValue), value: wsId };
      },
    },
    profiles: {
      async list(query?: string) {
        requireStore();
        const q = query?.trim().toLowerCase();
        if (q && q.length > 200) throw err('QUERY_TOO_LONG', 'Search text is too long.');
        return profiles
          .filter((p) => p.workspace_id === activeWs())
          .filter((p) => !q || `${p.name} ${p.client_label ?? ''}`.toLowerCase().includes(q))
          .sort((a, b) => a.name.localeCompare(b.name))
          .slice(0, 10000);
      },
      async create(name: string, clientLabel?: string) {
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
        const p = find(pid);
        if (p.version !== c.expectedVersion) {
          throw {
            ...err('VERSION_CONFLICT', 'This was changed elsewhere. Reload and try again.'),
            current_version: p.version,
          };
        }
        if (c.notes !== undefined && [...c.notes].length > 2000)
          throw err('NOTES_TOO_LONG', 'Notes can be at most 2,000 characters.');
        if (c.clientColour !== undefined && !/^#[0-9a-f]{6}$/.test(c.clientColour))
          throw err('INVALID_COLOUR', 'Colour must look like #7c3aed.');
        if (c.startUrls && (c.startUrls.length > 10 || !c.startUrls.every(validUrl)))
          throw err('BAD_START_URL', 'Start address must begin with http:// or https://.');
        set(pid, {
          name:
            c.name !== undefined
              ? clean(c.name, 120, 'INVALID_LABEL', 'Names must be 1-120 visible characters.')
              : p.name,
          client_label: c.clearClientLabel
            ? null
            : c.clientLabel !== undefined
              ? c.clientLabel.trim()
              : p.client_label,
          client_colour: c.clearClientColour ? null : (c.clientColour ?? p.client_colour),
          start_urls: c.startUrls ?? p.start_urls,
          download_dir: c.clearDownloadDir ? null : p.download_dir,
          permissions: {
            camera: c.camera ?? p.permissions.camera,
            microphone: c.microphone ?? p.permissions.microphone,
            location: c.location ?? p.permissions.location,
          },
          notes: c.notes ?? p.notes,
          version: p.version + 1,
          updated_at: now(),
        });
        return find(pid);
      },
      async launch(pid: string) {
        const p = find(pid);
        if (p.state === 'starting' || p.state === 'running') {
          const existing = launchOps.get(pid);
          if (existing) return { operation_id: existing.operation_id };
          const op = startOp('launch_profile', pid);
          finish(op, { status: 'succeeded', progress: 1 });
          return { operation_id: op.operation_id };
        }
        if (p.state === 'stopping') throw err('PROFILE_STOPPING', 'This profile is still closing.');
        if (p.state === 'recovering') throw err('PROFILE_BUSY', 'This profile is busy.');
        if (!runtimeInstalled)
          throw err(
            'RUNTIME_NOT_INSTALLED',
            'The browser is not installed yet. Install it from Downloads and updates.',
          );
        const op = startOp('launch_profile', pid);
        launchOps.set(pid, op);
        set(pid, { state: 'starting', last_error: null, last_started_at: now(), pid: 5000 + opSeq });
        emit('profiles-changed', { running: running() });
        setTimeout(() => {
          set(pid, { state: 'running', ready: true, window_open: true, runtime_version: RUNTIME_VERSION });
          launchOps.delete(pid);
          finish(op, { status: 'succeeded', progress: 1 });
        }, 700);
        return { operation_id: op.operation_id };
      },
      async stop(pid: string, force?: boolean) {
        const p = find(pid);
        if (!isOpen(p)) throw err('NOT_RUNNING', 'This profile is not open.');
        const op = startOp('stop_profile', pid);
        if (force) {
          setTimeout(() => {
            stopNow(pid, 'forced');
            finish(op, { status: 'succeeded', progress: 1 });
          }, 300);
          return { operation_id: op.operation_id };
        }
        set(pid, { state: 'stopping' });
        emit('profiles-changed', { running: running() });
        setTimeout(() => {
          if (mode === 'stuck') {
            set(pid, { force_available: true });
            finish(op, {
              status: 'failed',
              error_code: 'STOP_TIMED_OUT',
              message: 'The profile is not responding. You can force it to close.',
            });
            return;
          }
          stopNow(pid, 'clean');
          finish(op, { status: 'succeeded', progress: 1 });
        }, 500);
        return { operation_id: op.operation_id };
      },
      async closeAll(force?: boolean) {
        const op = startOp('close_all', null);
        setTimeout(() => {
          for (const p of profiles) {
            if (!isOpen(p)) continue;
            if (mode === 'stuck' && !force) set(p.id, { state: 'stopping', force_available: true });
            else stopNow(p.id, force ? 'forced' : 'clean');
          }
          finish(
            op,
            running() > 0
              ? {
                  status: 'failed',
                  error_code: 'STOP_TIMED_OUT',
                  message: 'Some profiles are not responding. You can force them to close.',
                }
              : { status: 'succeeded', progress: 1 },
          );
        }, 500);
        return { operation_id: op.operation_id };
      },
      async status(pid: string): Promise<ProfileStatus> {
        const p = find(pid);
        const backup = backups.get(pid);
        const ended = p.state === 'stopped' || p.state === 'crashed';
        return {
          profile: p,
          runs:
            p.last_started_at || p.state === 'crashed'
              ? [
                  {
                    run_id: `run_${'0'.repeat(24)}`,
                    profile_id: p.id,
                    pid: p.pid ?? 4242,
                    identity: { start_time: 1_760_000_000, exe: 'chrome' },
                    runtime_version: RUNTIME_VERSION,
                    exit_code: p.state === 'crashed' ? -11 : null,
                    outcome: p.state === 'crashed' ? 'crashed' : ended ? 'clean' : 'running',
                    started_at: p.last_started_at ?? now(),
                    ended_at: ended ? now() : null,
                  },
                ]
              : [],
          backup: backup
            ? {
                created_at_unix: backup.created_at_unix,
                runtime_version: RUNTIME_VERSION,
                bytes: 48_000_000,
                files: backup.files,
              }
            : null,
          evidence_count: 0,
          suggested_recovery:
            p.state === 'crashed' ? (backup && p.crash_count >= 3 ? 'restore_backup' : 'reopen') : null,
        };
      },
      async recover(
        pid: string,
        action: 'reopen' | 'restore_backup' | 'start_fresh' | 'backup_now',
      ): Promise<{ operation_id: string }> {
        const p = find(pid);
        if (action === 'reopen') return backend.profiles.launch(pid);
        if (p.state !== 'stopped' && p.state !== 'crashed')
          throw err('NOT_RECOVERABLE', 'Close the profile before recovering it.');
        if (action === 'restore_backup' && !backups.has(pid))
          throw err('NO_BACKUP', 'There is no backup of this profile yet.');
        const op = startOp(action === 'backup_now' ? 'backup_profile' : 'recover_profile', pid);
        if (action !== 'backup_now') set(pid, { state: 'recovering' });
        emit('profiles-changed', { running: running() });
        setTimeout(() => {
          if (action === 'backup_now') {
            backups.set(pid, { created_at_unix: Math.floor(Date.now() / 1000), files: 412 });
            set(pid, { last_backup_at: now() });
          } else {
            set(pid, { state: 'stopped', last_error: null, crash_count: 0 });
          }
          finish(op, { status: 'succeeded', progress: 1 });
        }, 600);
        return { operation_id: op.operation_id };
      },
      async selectDownloadDirectory(pid: string) {
        const p = find(pid);
        const path = `/Users/demo/Downloads/${p.name}`;
        set(pid, { download_dir: path, version: p.version + 1 });
        return { path };
      },
    },
    system: {
      async runtimeStatus() {
        return runtimeStatus();
      },
      async installRuntime(version: string) {
        if (version !== RUNTIME_VERSION)
          throw err('RUNTIME_NOT_IN_MANIFEST', 'That browser version is not approved for this build.');
        if (installing) throw err('INSTALL_IN_PROGRESS', 'A browser install is already in progress.');
        installing = true;
        const op = startOp('install_runtime', version);
        let progress = 0;
        const timer = setInterval(() => {
          progress = Math.min(1, progress + 0.2);
          if (progress < 1) {
            Object.assign(op, { progress });
            emit('operation', { ...op });
            return;
          }
          clearInterval(timer);
          installing = false;
          runtimeInstalled = true;
          finish(op, { status: 'succeeded', progress: 1 });
        }, 250);
        return { operation_id: op.operation_id };
      },
      async updateSetting(key: string, value: unknown, expectedVersion?: number) {
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
          app: { version: '0.3.0-demo', platform: 'demo', os: navigator.userAgent, arch: 'demo' },
          store: {
            status: storeFailed ? 'failed' : 'ready',
            schema_version: 3,
            journal_mode: 'wal',
            foreign_keys: true,
            integrity_ok: true,
          },
          keychain: { available: true, reason: null },
          runtime: { manifest_status: { status: 'verified', version: RUNTIME_VERSION }, platform: 'demo' },
          manager: { uptime_s: Math.round(performance.now() / 1000), rss_bytes: null, startup_ms: null },
          browsers: { running: running(), main_process_rss_bytes: 0 },
          crash_reports: crashed ? 1 : 0,
          recent_activity: [],
        };
      },
      async exportDiagnostics() {
        return { path: '~/Downloads/project-browser-diagnostics.json' };
      },
      async reportUiReady() {
        return performance.now();
      },
      async recovery(action: string) {
        if (action === 'dismiss_crash') crashed = false;
        if (action === 'restore_backup' || action === 'retry_open') storeFailed = false;
      },
      async resolveQuit(choice: string) {
        if (choice === 'close_all' || choice === 'force_close_all') {
          for (const p of profiles) {
            if (isOpen(p)) stopNow(p.id, 'clean');
          }
          emit('profiles-changed', { running: 0 });
        }
      },
      async openExternal(url: string) {
        if (!/^https:\/\/github\.com\//.test(url))
          throw err('DISALLOWED_URL', 'Only https links to approved help sites can be opened.');
      },
      async removeLocalData(confirm: string) {
        if (confirm !== 'DELETE')
          throw err('CONFIRMATION_REQUIRED', 'Type DELETE to confirm removing all local data.');
        if (running() > 0) throw err('PROFILES_RUNNING', 'Close all open profiles before doing this.');
        profiles.length = 0;
        workspaces.length = 0;
        settings['workspace.active'] = { ...(settings['workspace.active'] as SettingValue), value: null };
      },
    },
    on<E extends EventName>(event: E, handler: (payload: EventPayload<E>) => void) {
      const listenersFor = listeners.get(event) ?? new Set();
      listenersFor.add(handler as (p: unknown) => void);
      listeners.set(event, listenersFor);
      return () => listenersFor.delete(handler as (p: unknown) => void);
    },
    /** Demo-only: lets UI tests trigger the quit prompt like the tray/window close would. */
    simulateQuitRequest(unresponsive = 0) {
      emit('quit-requested', { running: running(), unresponsive });
    },
  } satisfies Backend & { simulateQuitRequest(unresponsive?: number): void };
  return backend;
}
