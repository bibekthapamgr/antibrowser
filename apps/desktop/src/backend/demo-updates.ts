/**
 * In-memory stand-in for the manager's own updates (milestone 12; UI development and UI tests only). Each channel
 * "publishes" a version; checking, downloading with progress, stopping, and the install refusals (open profiles)
 * behave like the shell. Demo modes: `update-blocked` (this version revoked), `update-minimum` (below the
 * channel's minimum), `update-paused` (distribution paused), `update-bad-signature` (the manifest fails its
 * signature check), `updates-off` (a build without a release key).
 */
import type { EventName, EventPayload, Operation, UpdateStatus } from '@pb/contracts/ipc';
import type { IpcError, UpdatesRepository } from './types.ts';

export const DEMO_APP_VERSION = '0.12.0';

const PUBLISHED: Record<UpdateStatus['channel'], { version: string; size: number }> = {
  stable: { version: '0.12.1', size: 14_680_064 },
  canary: { version: '0.13.0-beta.1', size: 14_942_208 },
  dev: { version: '0.13.0-dev.4', size: 15_073_280 },
};

const notes = (v: string) => `https://github.com/bibekthapamgr/antibrowser/releases/tag/desktop-v${v}`;

export interface DemoUpdatesContext {
  mode: string;
  emit: <E extends EventName>(e: E, p: EventPayload<E>) => void;
  startOp: (kind: Operation['kind'], target: string | null) => Operation;
  finish: (op: Operation, patch: Partial<Operation>) => void;
  setting: (key: string) => unknown;
  running: () => number;
  /** Speeds up the simulated download in tests (ms per step). */
  stepMs?: number;
}

export function demoUpdates(ctx: DemoUpdatesContext): UpdatesRepository & {
  snapshot(): UpdateStatus;
  installed: string[];
} {
  const { mode } = ctx;
  const configured = mode !== 'updates-off';
  let checkedChannel: string | null = null;
  let phase: UpdateStatus['phase'] = 'idle';
  let checkedAt: string | null = null;
  let error: UpdateStatus['error'] = null;
  let received = 0;
  let readyVersion: string | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let currentOp: Operation | null = null;
  const installed: string[] = [];

  const channel = (): UpdateStatus['channel'] => {
    const c = ctx.setting('updates.channel');
    return c === 'canary' || c === 'dev' ? c : 'stable';
  };
  const paused = () => mode === 'update-paused';
  const blocked = (): UpdateStatus['blocked'] =>
    mode === 'update-blocked'
      ? { reason: 'revoked' }
      : mode === 'update-minimum'
        ? { reason: 'below_minimum', minimum_version: '0.12.1' }
        : null;

  const status = (): UpdateStatus => {
    const ch = channel();
    const base: UpdateStatus = {
      configured,
      install_supported: true,
      current_version: DEMO_APP_VERSION,
      platform: 'macos-arm64',
      channel: ch,
      automatic: ctx.setting('updates.automatic') !== false,
      phase: 'idle',
      checked_at: null,
      latest_version: null,
      available: null,
      paused: false,
      blocked: null,
      manifest_expires_at: null,
      progress: null,
      error: null,
    };
    if (checkedChannel !== ch && phase !== 'checking') return base;
    const pub = PUBLISHED[ch];
    const good = phase !== 'failed' || error?.code === 'UPDATE_DOWNLOAD_FAILED';
    return {
      ...base,
      phase,
      checked_at: checkedAt,
      latest_version: good ? pub.version : null,
      available:
        good && !paused() && phase !== 'up_to_date'
          ? { version: pub.version, notes_url: notes(pub.version), size_bytes: pub.size }
          : null,
      paused: good && paused(),
      blocked: good ? blocked() : null,
      manifest_expires_at: good ? '2026-12-31T00:00:00Z' : null,
      progress: phase === 'downloading' ? { received, total: pub.size } : null,
      error,
    };
  };
  const changed = () => ctx.emit('update', status());
  const fail = (code: string, message: string): IpcError => ({ code, message });

  return {
    installed,
    snapshot: status,
    async get() {
      return status();
    },
    async check() {
      if (!configured)
        throw fail(
          'UPDATES_NOT_CONFIGURED',
          'This build has no release key, so it cannot check for updates. Install new versions manually.',
        );
      if (phase === 'checking' || phase === 'downloading')
        throw fail('UPDATE_BUSY', 'An update check or download is already running.');
      phase = 'checking';
      checkedChannel = channel();
      changed();
      await new Promise((r) => setTimeout(r, 150));
      checkedAt = new Date().toISOString();
      if (mode === 'update-bad-signature') {
        phase = 'failed';
        readyVersion = null;
        error = {
          code: 'UPDATE_SIGNATURE_INVALID',
          message: 'The update was not signed with the Project Browser release key. Nothing was installed.',
        };
      } else {
        error = null;
        const pub = PUBLISHED[checkedChannel as UpdateStatus['channel']];
        if (readyVersion !== pub.version) readyVersion = null;
        phase = paused() ? 'up_to_date' : readyVersion ? 'ready' : 'available';
        if (paused()) readyVersion = null;
      }
      changed();
      return status();
    },
    async download() {
      const s = status();
      if (phase === 'checking' || phase === 'downloading')
        throw fail('UPDATE_BUSY', 'An update check or download is already running.');
      if (!s.available)
        throw fail('UPDATE_NOT_AVAILABLE', 'There is no update to download. Check for updates first.');
      if (phase === 'ready') return s;
      const total = s.available.size_bytes;
      const version = s.available.version;
      phase = 'downloading';
      error = null;
      currentOp = ctx.startOp('download_update', version);
      changed();
      const op = currentOp;
      timer = setInterval(() => {
        received = Math.min(total, received + Math.ceil(total / 8));
        Object.assign(op, { progress: received / total });
        ctx.emit('operation', { ...op });
        if (received >= total) {
          if (timer) clearInterval(timer);
          timer = null;
          received = 0;
          readyVersion = version;
          phase = 'ready';
          ctx.finish(op, { status: 'succeeded', progress: 1 });
        }
        changed();
      }, ctx.stepMs ?? 200);
      return status();
    },
    async cancel() {
      if (timer && currentOp) {
        clearInterval(timer);
        timer = null;
        phase = 'available';
        error = {
          code: 'UPDATE_CANCELLED',
          message: 'The download was stopped. It continues where it stopped next time.',
        };
        ctx.finish(currentOp, { status: 'failed', error_code: error.code, message: error.message });
        changed();
      }
      return status();
    },
    async install() {
      if (!readyVersion || checkedChannel !== channel())
        throw fail('UPDATE_NOT_READY', 'There is no downloaded update to install. Check for updates first.');
      if (ctx.running() > 0)
        throw fail(
          'UPDATE_PROFILES_OPEN',
          'Close the open profiles first: the app restarts to install the update.',
        );
      installed.push(readyVersion);
      return null;
    },
  };
}
