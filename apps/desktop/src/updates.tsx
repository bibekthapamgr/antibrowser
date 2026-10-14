/**
 * Manager updates (milestone 12, ADR-0019): the "App updates" card on the Downloads screen and the banner shown
 * when this version must be updated. The shell checks a signed manifest for the chosen channel, downloads and
 * verifies the installer, and installs only on a click with profiles closed.
 */
import type { UpdateStatus } from '@pb/contracts/ipc';
import { useCallback, useEffect, useState } from 'react';
import { type Backend, errorMessage } from './backend/types.ts';
import { formatBytes } from './components.tsx';
import { type Notify, when } from './status.tsx';

const CHANNELS: [UpdateStatus['channel'], string, string][] = [
  ['stable', 'Stable', 'Releases after they have been used on the earlier channels.'],
  ['canary', 'Canary', 'Releases a few days earlier, for people who want to try them first.'],
  ['dev', 'Dev', 'Internal test builds. Expect problems.'],
];

/** Live update status: the first read, then the `update` events. */
export function useUpdateStatus(backend: Backend, refreshKey = 0) {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const reload = useCallback(async () => {
    try {
      setStatus(await backend.updates.get());
    } catch {
      setStatus(null);
    }
  }, [backend]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey re-reads after app events
  useEffect(() => {
    void reload();
    return backend.on('update', (s) => setStatus(s));
  }, [backend, reload, refreshKey]);
  return { status, setStatus, reload };
}

function blockedText(s: UpdateStatus): string | null {
  if (!s.blocked) return null;
  return s.blocked.reason === 'revoked'
    ? `This version (${s.current_version}) was withdrawn because of a security or data problem.`
    : `This version (${s.current_version}) is older than the minimum safe version, ${s.blocked.minimum_version}.`;
}

/** Shown above every screen while this version must be updated. */
export function UpdateBanner(props: { backend: Backend; refreshKey: number; onOpen: () => void }) {
  const { status } = useUpdateStatus(props.backend, props.refreshKey);
  if (!status?.blocked) return null;
  return (
    <div className="notice notice--error banner" role="alert">
      <span className="grow">{blockedText(status)} Update now; your profiles and data are not affected.</span>
      <button type="button" className="pb-button" onClick={props.onOpen}>
        Update
      </button>
    </div>
  );
}

export function AppUpdatesCard(props: {
  backend: Backend;
  notify: Notify;
  refreshKey: number;
  runningCount: number;
}) {
  const { backend, notify } = props;
  const { status, setStatus } = useUpdateStatus(backend, props.refreshKey);
  const [busy, setBusy] = useState(false);
  if (!status) return <p role="status">Loading…</p>;

  const act = async (f: () => Promise<UpdateStatus | null>, done?: string) => {
    setBusy(true);
    try {
      const s = await f();
      if (s) setStatus(s);
      if (done) notify(done);
    } catch (e) {
      notify(errorMessage(e), 'error');
    } finally {
      setBusy(false);
    }
  };
  const setChannel = (channel: string) =>
    act(async () => {
      await backend.system.updateSetting('updates.channel', channel);
      return await backend.updates.check();
    });
  const setAutomatic = (on: boolean) =>
    act(async () => {
      await backend.system.updateSetting('updates.automatic', on);
      return await backend.updates.get();
    });

  const a = status.available;
  const pct = status.progress
    ? Math.round((status.progress.received / Math.max(1, status.progress.total)) * 100)
    : 0;
  const working = busy || status.phase === 'checking' || status.phase === 'downloading';

  return (
    <section className="card updates" aria-labelledby="updates-title">
      <h2 id="updates-title">App updates</h2>
      <p>
        Project Browser {status.current_version}
        {status.checked_at ? <span className="muted"> · last checked {when(status.checked_at)}</span> : null}
      </p>

      {!status.configured ? (
        <p className="muted">
          This build has no release key, so it never checks for updates. Install new versions manually.
        </p>
      ) : (
        <>
          {status.blocked && (
            <p className="notice notice--error" role="alert">
              {blockedText(status)} Install the update below.
            </p>
          )}
          <UpdateBody status={status} pct={pct} runningCount={props.runningCount} />
          <div className="row">
            {(status.phase === 'idle' ||
              status.phase === 'up_to_date' ||
              status.phase === 'failed' ||
              status.phase === 'checking') && (
              <button
                type="button"
                className="pb-button"
                disabled={working}
                onClick={() => act(() => backend.updates.check())}
              >
                {status.phase === 'checking' ? 'Checking…' : 'Check now'}
              </button>
            )}
            {a && (status.phase === 'available' || status.phase === 'failed') && (
              <button
                type="button"
                className="pb-button"
                data-variant="primary"
                disabled={working}
                onClick={() => act(() => backend.updates.download())}
              >
                {status.phase === 'failed' ? 'Try the download again' : `Download ${a.version}`}
              </button>
            )}
            {status.phase === 'downloading' && (
              <button type="button" className="pb-button" onClick={() => act(() => backend.updates.cancel())}>
                Stop
              </button>
            )}
            {status.phase === 'ready' && a && (
              <button
                type="button"
                className="pb-button"
                data-variant="primary"
                disabled={busy || !status.install_supported || props.runningCount > 0}
                onClick={() =>
                  act(async () => {
                    await backend.updates.install();
                    return null;
                  }, 'Installing the update. The app restarts in a moment.')
                }
              >
                Restart and install {a.version}
              </button>
            )}
            {a && (
              <button
                type="button"
                className="pb-button"
                onClick={() => void backend.system.openExternal(a.notes_url).catch(() => undefined)}
              >
                Release notes
              </button>
            )}
          </div>

          <fieldset className="updates__settings">
            <legend>Update channel</legend>
            {CHANNELS.map(([id, label, hint]) => (
              <label key={id} className="choice">
                <input
                  type="radio"
                  name="update-channel"
                  checked={status.channel === id}
                  disabled={working}
                  onChange={() => void setChannel(id)}
                />
                {label} <span className="muted small">— {hint}</span>
              </label>
            ))}
            <label className="choice">
              <input
                type="checkbox"
                checked={status.automatic}
                disabled={working}
                onChange={(e) => void setAutomatic(e.target.checked)}
              />
              Check for updates and download them automatically
            </label>
            <p className="muted small">
              Installing always waits for you. Every update is signed by the publisher and checked on this
              computer before it is installed; an older version is never installed over a newer one.
            </p>
          </fieldset>
        </>
      )}
    </section>
  );
}

function UpdateBody(props: { status: UpdateStatus; pct: number; runningCount: number }) {
  const { status: s, pct } = props;
  const a = s.available;
  switch (s.phase) {
    case 'idle':
      return <p className="muted">Not checked yet on this channel.</p>;
    case 'checking':
      return <p role="status">Checking for updates…</p>;
    case 'up_to_date':
      return (
        <p role="status">
          <span className="ok">Up to date.</span>
          {s.paused ? ' New releases on this channel are paused by the publisher for now.' : ''}
          {s.latest_version && s.latest_version !== s.current_version && !s.paused
            ? ` The newest version on this channel is ${s.latest_version}.`
            : ''}
        </p>
      );
    case 'available':
      return a ? (
        <p role="status">
          Version {a.version} is available ({formatBytes(a.size_bytes)}).
          {s.error?.code === 'UPDATE_CANCELLED'
            ? ' The download was stopped; it continues where it stopped.'
            : ''}
        </p>
      ) : null;
    case 'downloading':
      return (
        <p role="status">
          Downloading {a?.version}… <progress aria-label="Update download progress" value={pct} max={100} />{' '}
          {pct}%
        </p>
      );
    case 'ready':
      return (
        <p role="status">
          <span className="ok">Version {a?.version} is downloaded and verified.</span>{' '}
          {!s.install_supported
            ? 'This system has no automatic installer: install it manually.'
            : props.runningCount > 0
              ? 'Close the open profiles first: the app restarts to install it.'
              : 'The app restarts to install it; profiles and settings are kept.'}
        </p>
      );
    case 'failed':
      return (
        <p className="error" role="alert">
          {s.error?.message ?? 'The update check failed.'}
        </p>
      );
  }
}
