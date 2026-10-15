/**
 * Account gate: Project Browser is used with an account and a workspace plan (trial or paid). Before that, the app
 * shows only these full-window screens: sign in or create an account, finish setting up the workspace, or choose a
 * plan when no workspace of the person has a usable one. Profiles and every other screen open after that.
 */
import type { BillingSummary } from '@pb/contracts/billing';
import type { Organization } from '@pb/contracts/resources';
import { type FormEvent, type ReactNode, useEffect, useState } from 'react';
import type { AccountView, Backend } from './backend/types.ts';
import { errorMessage } from './backend/types.ts';
import { can } from './cloud.ts';
import type { Notify } from './status.tsx';
import { SubscriptionScreen } from './workspace.tsx';

/** Plan states in which the workspace can be used (a failed payment keeps working through its grace period). */
export const USABLE_PLAN: ReadonlySet<BillingSummary['state']> = new Set([
  'trial',
  'active',
  'past_due',
  'grace',
]);

/** How long a computer that cannot reach the server keeps working after the last confirmed plan. */
export const OFFLINE_GRACE_MS = 7 * 86_400_000;
const PLAN_OK_KEY = 'pb.plan_ok_at';

export function rememberPlanOk(): void {
  try {
    localStorage.setItem(PLAN_OK_KEY, String(Date.now()));
  } catch {
    // Not kept: an offline start asks for the server again.
  }
}
export function recentPlanOk(now = Date.now()): boolean {
  try {
    const at = Number(localStorage.getItem(PLAN_OK_KEY) ?? 0);
    return at > 0 && now - at < OFFLINE_GRACE_MS;
  } catch {
    return false;
  }
}

const FEATURES = [
  ['Separate browser profiles', 'Each profile keeps its own cookies, storage and proxy.'],
  ['Work as a team', 'Share profiles safely and hand sessions over without logging out.'],
  ['Encrypted backups', 'Profiles are saved to your workspace and restored on any computer.'],
] as const;

function Shell(props: { children: ReactNode; labelledBy: string }) {
  return (
    <div className="gate">
      <aside className="gate__brand" aria-hidden="true">
        <div className="gate__logo">
          <span className="gate__mark" />
          Project Browser
        </div>
        <div className="gate__pitch">
          <p className="gate__headline">Every account in its own browser. One place to manage them all.</p>
          <ul className="gate__features">
            {FEATURES.map(([t, d]) => (
              <li key={t}>
                <strong>{t}</strong>
                <span>{d}</span>
              </li>
            ))}
          </ul>
        </div>
        <p className="gate__foot">
          Your passwords are entered only on the secure sign-in page, never in this app.
        </p>
      </aside>
      <main className="gate__main" id="main" aria-labelledby={props.labelledBy}>
        <div className="gate__card">{props.children}</div>
      </main>
    </div>
  );
}

function hostOf(url: string | null): string {
  if (!url) return '';
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** Signed out (or the session ended): sign in or create an account. */
export function SignInGate(props: {
  backend: Backend;
  account: AccountView;
  notify: Notify;
  onChanged: () => void;
}) {
  const { backend, account, notify, onChanged } = props;
  const [busy, setBusy] = useState(false);
  const [editServer, setEditServer] = useState(!account.server_url);
  const [server, setServer] = useState(account.server_url ?? '');
  useEffect(() => {
    setServer(account.server_url ?? '');
    setEditServer(!account.server_url);
  }, [account.server_url]);

  const start = async (create: boolean) => {
    setBusy(true);
    try {
      await backend.account.signIn(false, create);
      onChanged();
    } catch (e) {
      notify(errorMessage(e), 'error');
    }
    setBusy(false);
  };
  const saveServer = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await backend.account.setServer(server.trim() || null);
      onChanged();
    } catch (err) {
      notify(errorMessage(err), 'error');
    }
    setBusy(false);
  };

  return (
    <Shell labelledBy="gate-title">
      {account.signing_in ? (
        <div className="stack gate__stack">
          <span className="gate__spinner" aria-hidden="true" />
          <h1 id="gate-title">Continue in your browser</h1>
          <p className="muted" role="status">
            We opened the sign-in page in your web browser. When you are done there, you come back here
            automatically.
          </p>
          <button
            type="button"
            className="pb-button gate__wide"
            onClick={async () => {
              await backend.account.cancelSignIn().catch(() => undefined);
              onChanged();
            }}
          >
            Cancel
          </button>
        </div>
      ) : (
        <div className="stack gate__stack">
          <h1 id="gate-title">{account.status === 'expired' ? 'Sign in again' : 'Welcome'}</h1>
          <p className="muted">
            {account.status === 'expired'
              ? 'Your session ended. Sign in again to continue; nothing on this computer was removed.'
              : 'Sign in to your account to continue, or create one. New accounts start with a free trial.'}
          </p>
          <button
            type="button"
            className="pb-button gate__wide"
            data-variant="primary"
            disabled={busy || !account.server_url}
            onClick={() => void start(false)}
          >
            Sign in
          </button>
          <button
            type="button"
            className="pb-button gate__wide"
            disabled={busy || !account.server_url}
            onClick={() => void start(true)}
          >
            Create account
          </button>
          {editServer ? (
            <form className="stack gate__server" onSubmit={saveServer} aria-labelledby="gate-server-title">
              <h2 id="gate-server-title" className="gate__small-title">
                Server address
              </h2>
              <div className="row">
                <input
                  className="grow"
                  type="url"
                  aria-label="Server address"
                  placeholder="https://browser.example.com"
                  spellCheck={false}
                  value={server}
                  onChange={(e) => setServer(e.target.value)}
                />
                <button
                  type="submit"
                  className="pb-button"
                  disabled={busy || server.trim() === (account.server_url ?? '')}
                >
                  Save
                </button>
              </div>
              {!account.server_url && (
                <p className="muted small">Enter the address you were given, then sign in.</p>
              )}
            </form>
          ) : (
            <p className="muted small gate__server-line">
              Server: {hostOf(account.server_url)} ·{' '}
              <button type="button" className="linklike" onClick={() => setEditServer(true)}>
                Change
              </button>
            </p>
          )}
        </div>
      )}
    </Shell>
  );
}

/** Signed in but no workspace yet: onboarding (terms, invitation) finishes it. */
export function SetupGate(props: { busy: boolean; onContinue: () => void; onSignOut: () => void }) {
  return (
    <Shell labelledBy="gate-title">
      <div className="stack gate__stack">
        <h1 id="gate-title">Set up your workspace</h1>
        <p className="muted">
          Your account is ready. Create your workspace (it starts with a free trial) or accept the invitation
          you received to continue.
        </p>
        <button
          type="button"
          className="pb-button gate__wide"
          data-variant="primary"
          disabled={props.busy}
          onClick={props.onContinue}
        >
          Continue
        </button>
        <button type="button" className="pb-button gate__wide" onClick={props.onSignOut}>
          Sign out
        </button>
      </div>
    </Shell>
  );
}

/** Signed in, but the server cannot be reached and the plan was not confirmed recently. */
export function OfflineGate(props: { onRetry: () => void; onSignOut: () => void }) {
  return (
    <Shell labelledBy="gate-title">
      <div className="stack gate__stack">
        <h1 id="gate-title">Can’t reach the server</h1>
        <p className="muted">
          Check your internet connection. Project Browser needs to confirm your plan at least once every 7
          days.
        </p>
        <button type="button" className="pb-button gate__wide" data-variant="primary" onClick={props.onRetry}>
          Try again
        </button>
        <button type="button" className="pb-button gate__wide" onClick={props.onSignOut}>
          Sign out
        </button>
      </div>
    </Shell>
  );
}

/** Signed in, but no workspace has a usable plan: choose one (owners) or ask an owner. */
export function PlanGate(props: {
  backend: Backend;
  org: Organization;
  me: string;
  notify: Notify;
  onChanged: () => void;
  onSignOut: () => void;
}) {
  const { org } = props;
  const manage = can(org.role, 'billing.manage');
  const ended = org.billing?.state === 'canceled' || org.billing?.state === 'restricted';
  return (
    <div className="gate gate--plan">
      <main className="gate__main gate__main--wide" id="main" aria-labelledby="gate-title">
        <div className="gate__plan-head">
          <div className="gate__logo gate__logo--dark">
            <span className="gate__mark" />
            Project Browser
          </div>
          <button type="button" className="pb-button" onClick={props.onSignOut}>
            Sign out
          </button>
        </div>
        <div className="gate__card gate__card--wide stack">
          <h1 id="gate-title">{ended ? 'Your plan has ended' : 'Choose a plan to continue'}</h1>
          <p className="muted">
            {manage
              ? `Choose a plan for ${org.name} to keep using your profiles. Nothing was deleted; everything opens again as soon as the plan is active.`
              : `${org.name} has no active plan. Ask the workspace owner to choose one; everything opens again as soon as it is active.`}
          </p>
          {manage && (
            <SubscriptionScreen
              backend={props.backend}
              orgId={org.id}
              role={org.role}
              notify={props.notify}
              offline={false}
              me={props.me}
              org={org}
              onChanged={props.onChanged}
            />
          )}
        </div>
      </main>
    </div>
  );
}
