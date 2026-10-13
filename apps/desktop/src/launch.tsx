/**
 * Opening profiles (milestone 09): before the browser starts, the app checks free memory against what profiles
 * measured on this computer used, and whether the organization's extension policy will turn extensions off. Only
 * then is anything asked; otherwise the profile simply opens. The estimate is about this computer, never a promise
 * about what a website will use.
 */
import { useCallback, useState } from 'react';
import type { Backend, LaunchCheck, ProfileView } from './backend/types.ts';
import { errorMessage } from './backend/types.ts';
import { Dialog, formatBytes } from './components.tsx';
import { verdictText } from './health.tsx';
import { type Notify, plural, withClient } from './status.tsx';

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
