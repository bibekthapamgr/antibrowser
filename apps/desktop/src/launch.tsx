/**
 * Opening profiles (milestone 09): before the browser starts, the app checks free memory against what profiles
 * measured on this computer used, and whether the organization's extension policy will turn extensions off. Only
 * then is anything asked; otherwise the profile simply opens. The estimate is about this computer, never a promise
 * about what a website will use.
 */
import type { EventPayload } from '@pb/contracts/ipc';
import { useCallback, useState } from 'react';
import type { Backend, LaunchCheck, ProfileView } from './backend/types.ts';
import { errorMessage, isIpcError } from './backend/types.ts';
import { Dialog, formatBytes } from './components.tsx';
import { verdictText } from './health.tsx';
import { countryName, PROXY_ERROR_HELP, placeText } from './network.tsx';
import { type Notify, plural, when, withClient } from './status.tsx';

/** ADR-0029: the launch stopped until the person confirms; the details arrive in the warning of the same name. */
export const LOCATION_CHANGED = 'PROXY_LOCATION_CHANGED';
export type LocationWarning = Extract<
  EventPayload<'warning'>,
  { code: 'PROXY_LOCATION_CHANGED' | 'PROXY_LOCATION_NOTICE' }
>;

type Target = Pick<ProfileView, 'id' | 'name' | 'client_name'>;

export function useLauncher(backend: Backend, notify: Notify, onError?: (e: unknown, p: Target) => boolean) {
  const [pending, setPending] = useState<{ profiles: Target[]; check: LaunchCheck } | null>(null);

  const start = useCallback(
    async (profiles: Target[]) => {
      for (const p of profiles) {
        try {
          await backend.profiles.launch(p.id);
          notify(`Opening ${withClient(p)}…`);
        } catch (e) {
          if (onError?.(e, p)) continue;
          // The proxy location lock asks in its own dialog (App), from the warning sent with this error.
          if (isIpcError(e) && e.code === LOCATION_CHANGED) continue;
          notify(errorMessage(e), 'error');
        }
      }
    },
    [backend, notify, onError],
  );

  const open = useCallback(
    async (profiles: Target[]) => {
      if (!profiles.length) return;
      let check: LaunchCheck | null = null;
      try {
        check = await backend.agency.checkLaunch(profiles.map((p) => p.id));
      } catch {
        // The check is advice: if it cannot run, the profile still opens (the shell enforces the policy itself).
        check = null;
      }
      // Asked only when memory looks short or extensions will be turned off; "warn" policies are announced after
      // the profile opens instead of interrupting every open.
      if (check && (check.memory.warn || check.extensions.some((x) => x.disable))) {
        setPending({ profiles, check });
        return;
      }
      await start(profiles);
    },
    [backend, start],
  );

  const dialog = pending ? (
    <LaunchCheckDialog
      check={pending.check}
      profiles={pending.profiles}
      onClose={() => setPending(null)}
      onConfirm={async () => {
        const p = pending.profiles;
        setPending(null);
        await start(p);
      }}
    />
  ) : null;
  return { open, dialog };
}

function LaunchCheckDialog(props: {
  check: LaunchCheck;
  profiles: Target[];
  onClose: () => void;
  onConfirm: () => Promise<void>;
}) {
  const { check } = props;
  const m = check.memory;
  const what =
    props.profiles.length === 1 && props.profiles[0]
      ? withClient(props.profiles[0])
      : plural(check.to_open, 'profile');
  return (
    <Dialog title={`Open ${what}?`} onClose={props.onClose} role="alertdialog">
      <div className="stack">
        {m.warn && (
          <section aria-labelledby="lc-mem">
            <h3 id="lc-mem">Memory may run short</h3>
            <p>
              {formatBytes(m.available_bytes)} is free. Opening {plural(check.to_open, 'more profile')} needs
              about {formatBytes(m.needed_bytes)}
              {m.estimate.source === 'measured'
                ? ` (from ${plural(m.estimate.samples, 'measurement')} on this computer)`
                : ' (a default estimate: nothing was measured on this computer yet)'}
              , and about {formatBytes(m.reserve_bytes)} should stay free for the system. Real use depends on
              the sites. Closing profiles you are not using helps; nothing is closed for you.
            </p>
          </section>
        )}
        {check.extensions
          .filter((x) => x.disable)
          .map((x) => (
            <section key={x.profile_id} aria-labelledby={`lc-ext-${x.profile_id}`}>
              <h3 id={`lc-ext-${x.profile_id}`}>
                {x.disable ? 'Extensions will be turned off' : 'Extensions not approved'}: {x.name}
              </h3>
              <ul>
                {x.items.map((i) => (
                  <li key={i.id}>
                    <strong>{i.name}</strong> — {verdictText(i.verdict)}
                  </li>
                ))}
              </ul>
              <p className="small muted">
                {x.disable
                  ? 'Your organization requires approved extensions, so this session opens with all extensions turned off. Ask an admin to approve them.'
                  : 'Your organization has not approved these. They still run; an admin can approve or block them.'}
              </p>
            </section>
          ))}
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
            Open {check.to_open > 1 ? plural(check.to_open, 'profile') : 'anyway'}
          </button>
        </div>
      </div>
    </Dialog>
  );
}

/**
 * ADR-0029: the profile's proxy now exits from another country than at its last open (or its location could not be
 * checked). Nothing has started; "Open anyway" opens it this once and makes the new location the remembered one.
 */
export function LocationChangeDialog(props: {
  change: LocationWarning;
  name: string;
  onCancel: () => void;
  onOpenAnyway: () => void;
}) {
  const { change: w } = props;
  const prev = w.previous;
  const cur = w.current;
  const usual = prev ? placeText(prev.country, prev.city, prev.ip) : 'an earlier location';
  const country = cur?.country ? countryName(cur.country) : null;
  const unverified = w.verdict === 'unverified' || !cur;
  return (
    <Dialog
      title={
        unverified
          ? `Open ${props.name} without checking its location?`
          : `Open ${props.name} from ${country ?? 'a new country'}?`
      }
      onClose={props.onCancel}
      role="alertdialog"
    >
      <div className="stack location-change">
        <p>
          This profile usually opens from <strong>{usual}</strong>
          {w.previous_seen_at ? <span className="muted"> (last open {when(w.previous_seen_at)})</span> : null}
          .
        </p>
        {unverified ? (
          <p>
            Its proxy’s location could not be checked just now
            {w.reason ? `: ${PROXY_ERROR_HELP[w.reason] ?? 'the check did not work.'}` : '.'}
          </p>
        ) : (
          <p>
            Its proxy now exits from <strong>{placeText(cur?.country, cur?.city, cur?.ip)}</strong>.
          </p>
        )}
        <p className="warn small">
          Opening from a new country can trigger the site’s security checks (extra verification, a locked
          session). If you did not expect this, check the proxy first.
        </p>
        <div className="row row--end">
          <button type="button" className="pb-button" onClick={props.onCancel}>
            Cancel
          </button>
          <button type="button" className="pb-button" data-variant="primary" onClick={props.onOpenAnyway}>
            Open anyway
          </button>
        </div>
      </div>
    </Dialog>
  );
}

/** The non-blocking notice: same country, another city or exit address. */
export function locationNoticeText(name: string, w: LocationWarning): string {
  const prev = w.previous;
  const cur = w.current;
  const country = cur?.country ? countryName(cur.country) : null;
  const ip = prev?.ip && cur?.ip && prev.ip !== cur.ip ? ` IP changed from ${prev.ip} to ${cur.ip}.` : '';
  const city =
    w.verdict === 'city_changed' && prev?.city && cur?.city
      ? ` City changed from ${prev.city} to ${cur.city}.`
      : '';
  return `${name} opened from the same country${country ? ` (${country})` : ''}.${city}${ip}`;
}
