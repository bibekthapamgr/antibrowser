/**
 * Account screen (milestone 06): the organization server, sign-in through the system browser, the signed-in person,
 * creating and joining organizations, and this account's devices. Local profiles never need an account.
 */
import type { Device, Organization } from '@pb/contracts/resources';
import { type FormEvent, useCallback, useEffect, useId, useState } from 'react';
import type { AccountView, Backend } from './backend/types.ts';
import { errorMessage } from './backend/types.ts';
import { ApiFailure, get, ROLE_LABEL, send } from './cloud.ts';
import { Dialog } from './components.tsx';
import { type Notify, relative, when } from './status.tsx';

interface Preview {
  org_name: string;
  role: 'admin' | 'operator' | 'viewer' | 'billing';
  expires_at: string;
  status: 'open' | 'accepted' | 'expired' | 'revoked';
  for_this_account: boolean;
}

const PLATFORM: Record<string, string> = {
  'windows-x64': 'Windows',
  'macos-arm64': 'Mac (Apple silicon)',
  'macos-x64': 'Mac (Intel)',
  'linux-x64': 'Linux',
};

/** Accepts the bare invitation code or any text that ends with it (a pasted link or message). */
export function invitationCode(text: string): string | null {
  const m = /([A-Za-z0-9_-]{43})\s*$/.exec(text.trim());
  return m?.[1] ?? null;
}

export function AccountScreen(props: {
  backend: Backend;
  account: AccountView | null;
  refreshKey: number;
  onChanged: () => void;
  onOpenOrganization: (orgId: string) => void;
  notify: Notify;
}) {
  const { backend, account, notify, onChanged } = props;
  const [server, setServer] = useState(account?.server_url ?? '');
  const [busy, setBusy] = useState(false);
  const [confirmServer, setConfirmServer] = useState<string | null | undefined>(undefined);
  const serverHelp = useId();

  useEffect(() => {
    setServer(account?.server_url ?? '');
  }, [account?.server_url]);

  const saveServer = async (url: string | null) => {
    setBusy(true);
    try {
      await backend.account.setServer(url);
      notify(url ? 'Server saved.' : 'Disconnected from the server.');
      onChanged();
    } catch (e) {
      notify(errorMessage(e), 'error');
    }
    setBusy(false);
  };

  const submitServer = (e: FormEvent) => {
    e.preventDefault();
    const next = server.trim() || null;
    if (account?.status !== 'signed_out' && next !== account?.server_url) setConfirmServer(next);
    else void saveServer(next);
  };

  const signIn = async () => {
    setBusy(true);
    try {
      await backend.account.signIn();
      onChanged();
    } catch (e) {
      notify(errorMessage(e), 'error');
    }
    setBusy(false);
  };

  const signOut = async () => {
    setBusy(true);
    try {
      await backend.account.signOut();
      notify('Signed out. Your local profiles are unchanged.');
      onChanged();
    } catch (e) {
      notify(errorMessage(e), 'error');
    }
    setBusy(false);
  };

  if (!account) {
    return (
      <p role="status" className="loading">
        Loading…
      </p>
    );
  }
  const signedIn = account.status === 'signed_in';

  return (
    <section className="screen account" aria-labelledby="account-title">
      <header className="toolbar">
        <div className="toolbar__title">
          <h1 id="account-title">Account</h1>
          <p className="muted small">
            Sign in to work with your team in organizations. Profiles on this computer work without an account
            and stay on this computer.
          </p>
        </div>
      </header>

      <form className="card stack" onSubmit={submitServer} aria-labelledby="server-title">
        <h2 id="server-title">Organization server</h2>
        <div className="row">
          <label className="grow">
            Server address
            <input
              type="url"
              value={server}
              placeholder="https://browser.example.com"
              spellCheck={false}
              autoComplete="url"
              aria-describedby={serverHelp}
              onChange={(e) => setServer(e.target.value)}
            />
          </label>
          <button
            type="submit"
            className="pb-button"
            disabled={busy || server.trim() === (account.server_url ?? '')}
          >
            Save
          </button>
          {account.server_url && (
            <button
              type="button"
              className="pb-button"
              disabled={busy}
              onClick={() =>
                account.status === 'signed_out' ? void saveServer(null) : setConfirmServer(null)
              }
            >
              Disconnect
            </button>
          )}
        </div>
        <p id={serverHelp} className="muted small">
          Your administrator gives you this address. It must start with https:// (http:// only for a server on
          this computer).
        </p>
      </form>

      <section className="card stack" aria-labelledby="signin-title">
        <h2 id="signin-title">Sign-in</h2>
        {account.signing_in && account.status !== 'signed_in' ? (
          <>
            <p role="status">
              Continue in your browser. When you have signed in, your browser sends you back here
              automatically.
            </p>
            <div className="row">
              <button
                type="button"
                className="pb-button"
                onClick={async () => {
                  await backend.account.cancelSignIn().catch(() => undefined);
                  onChanged();
                }}
              >
                Cancel sign-in
              </button>
            </div>
          </>
        ) : signedIn && account.user ? (
          <>
            <p>
              Signed in as <strong>{account.user.display_name}</strong>
              {account.user.email && <> ({account.user.email})</>}.
            </p>
            {account.user.email_verified ? (
              <p className="ok small">E-mail address verified.</p>
            ) : (
              <p className="notice" role="note">
                Your e-mail address is not verified yet. Verify it with your sign-in service (check your
                inbox), then sign in again. Until then you cannot create organizations or accept invitations.
              </p>
            )}
            {!account.session_saved && (
              <p className="notice" role="note">
                This computer's secure storage is not available, so you will need to sign in again the next
                time you open Project Browser.
              </p>
            )}
            <div className="row">
              {!account.user.email_verified && (
                <button type="button" className="pb-button" disabled={busy} onClick={signIn}>
                  Sign in again
                </button>
              )}
              <button type="button" className="pb-button" disabled={busy} onClick={signOut}>
                Sign out
              </button>
            </div>
          </>
        ) : (
          <>
            {account.status === 'expired' ? (
              <p className="notice" role="note">
                Your session has ended (you signed out elsewhere, this device was removed from your account,
                or it was unused for a long time). Sign in again. Your local profiles are not affected.
              </p>
            ) : (
              <p>You are not signed in.</p>
            )}
            <div className="row">
              <button
                type="button"
                className="pb-button"
                data-variant="primary"
                disabled={busy || !account.server_url}
                onClick={signIn}
              >
                Sign in or create an account
              </button>
            </div>
            <p className="muted small">
              {account.server_url
                ? 'Sign-in opens in your web browser. Project Browser never sees your password.'
                : 'Save the organization server address first.'}
            </p>
          </>
        )}
      </section>

      {signedIn && account.user && (
        <>
          <CreateOrganization
            backend={backend}
            verified={account.user.email_verified}
            notify={notify}
            onCreated={(id) => {
              onChanged();
              props.onOpenOrganization(id);
            }}
          />
          <JoinOrganization
            backend={backend}
            verified={account.user.email_verified}
            notify={notify}
            onJoined={(id) => {
              onChanged();
              props.onOpenOrganization(id);
            }}
          />
          <Devices backend={backend} refreshKey={props.refreshKey} notify={notify} />
        </>
      )}

      {confirmServer !== undefined && (
        <Dialog
          title={confirmServer ? 'Change the server?' : 'Disconnect from the server?'}
          description="You will be signed out on this computer, and organization information saved here for offline use is removed. Your local profiles are not affected."
          role="alertdialog"
          onClose={() => setConfirmServer(undefined)}
        >
          <div className="row row--end">
            <button type="button" className="pb-button" onClick={() => setConfirmServer(undefined)}>
              Cancel
            </button>
            <button
              type="button"
              className="pb-button"
              data-variant="primary"
              onClick={() => {
                const next = confirmServer;
                setConfirmServer(undefined);
                void saveServer(next);
              }}
            >
              {confirmServer ? 'Change server' : 'Disconnect'}
            </button>
          </div>
        </Dialog>
      )}
    </section>
  );
}

function CreateOrganization(props: {
  backend: Backend;
  verified: boolean;
  notify: Notify;
  onCreated: (orgId: string) => void;
}) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const org = await send<Organization>(props.backend, 'POST', '/v1/organizations', { name: name.trim() });
      props.notify(`Created ${org.data.name}. You are its owner.`);
      setName('');
      props.onCreated(org.data.id);
    } catch (err) {
      props.notify(errorMessage(err), 'error');
    }
    setBusy(false);
  };
  return (
    <form className="card stack" onSubmit={submit} aria-labelledby="create-org-title">
      <h2 id="create-org-title">Create an organization</h2>
      <div className="row">
        <label className="grow">
          Organization name
          <input
            required
            maxLength={120}
            value={name}
            disabled={!props.verified}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <button type="submit" className="pb-button" disabled={busy || !props.verified || !name.trim()}>
          Create
        </button>
      </div>
      <p className="muted small">
        You become its owner and can invite people. Profiles on this computer stay local until you choose to
        copy them into the organization.
      </p>
    </form>
  );
}

function JoinOrganization(props: {
  backend: Backend;
  verified: boolean;
  notify: Notify;
  onJoined: (orgId: string) => void;
}) {
  const { backend, notify } = props;
  const [text, setText] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const help = useId();
  const code = invitationCode(text);

  const check = async (e: FormEvent) => {
    e.preventDefault();
    if (!code) return;
    setBusy(true);
    setPreview(null);
    try {
      setPreview((await get<Preview>(backend, `/v1/invitations/${code}`)).data);
    } catch (err) {
      notify(
        err instanceof ApiFailure && err.status === 404
          ? 'That invitation code was not found. Check that you copied all of it.'
          : errorMessage(err),
        'error',
      );
    }
    setBusy(false);
  };

  const accept = async () => {
    if (!code) return;
    setBusy(true);
    try {
      const res = await send<{ org_id: string; role: string }>(
        backend,
        'POST',
        `/v1/invitations/${code}/accept`,
      );
      notify(`You joined ${preview?.org_name ?? 'the organization'}.`);
      setText('');
      setPreview(null);
      props.onJoined(res.data.org_id);
    } catch (err) {
      notify(errorMessage(err), 'error');
    }
    setBusy(false);
  };

  return (
    <form className="card stack" onSubmit={check} aria-labelledby="join-title">
      <h2 id="join-title">Join an organization</h2>
      <div className="row">
        <label className="grow">
          Invitation code
          <input
            value={text}
            spellCheck={false}
            autoComplete="off"
            aria-describedby={help}
            onChange={(e) => {
              setText(e.target.value);
              setPreview(null);
            }}
          />
        </label>
        <button type="submit" className="pb-button" disabled={busy || !code}>
          Check
        </button>
      </div>
      <p id={help} className="muted small">
        Paste the code from your invitation. It works once, only for the e-mail address it was sent to.
      </p>
      {preview && (
        <div className="notice" role="status">
          <p>
            <strong>{preview.org_name}</strong> invites you as {ROLE_LABEL[preview.role]}.{' '}
            {preview.status === 'open' ? `Valid until ${when(preview.expires_at)}.` : null}
          </p>
          {preview.status !== 'open' ? (
            <p className="error">
              {preview.status === 'expired'
                ? 'This invitation has expired. Ask for a new one.'
                : preview.status === 'accepted'
                  ? 'This invitation was already used.'
                  : 'This invitation was withdrawn.'}
            </p>
          ) : !preview.for_this_account ? (
            <p className="error">
              This invitation is for a different e-mail address. Sign in with the invited account to accept
              it.
            </p>
          ) : !props.verified ? (
            <p className="error">Verify your e-mail address first.</p>
          ) : (
            <button
              type="button"
              className="pb-button"
              data-variant="primary"
              disabled={busy}
              onClick={accept}
            >
              Join {preview.org_name}
            </button>
          )}
        </div>
      )}
    </form>
  );
}

function Devices(props: { backend: Backend; refreshKey: number; notify: Notify }) {
  const { backend, notify } = props;
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [stale, setStale] = useState(false);
  const [removing, setRemoving] = useState<Device | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await get<{ items: Device[] }>(backend, '/v1/devices');
      setDevices(res.data.items);
      setStale(res.stale);
    } catch (e) {
      notify(errorMessage(e, 'Could not load your devices.'), 'error');
    }
  }, [backend, notify]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey reloads the list
  useEffect(() => {
    void load();
  }, [load, props.refreshKey]);

  const remove = async (d: Device) => {
    setRemoving(null);
    try {
      await send(backend, 'POST', `/v1/devices/${d.id}/revoke`);
      notify(
        d.current
          ? 'This computer was signed out. Its local profiles are unchanged.'
          : `${d.name} was signed out. It can no longer use your account; data already on it stays there.`,
      );
      await load();
    } catch (e) {
      notify(errorMessage(e), 'error');
    }
  };

  return (
    <section className="card stack" aria-labelledby="devices-title">
      <h2 id="devices-title">Your devices</h2>
      {stale && <p className="notice">Offline: showing the list saved earlier.</p>}
      {devices === null ? (
        <p role="status">Loading…</p>
      ) : (
        <table className="simple records">
          <caption className="pb-sr-only">Devices signed in to your account</caption>
          <thead>
            <tr>
              <th scope="col">Device</th>
              <th scope="col">System</th>
              <th scope="col">Last used</th>
              <th scope="col">
                <span className="pb-sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {devices.map((d) => (
              <tr key={d.id}>
                <th scope="row">
                  {d.name}
                  {d.current && <span className="badge">This computer</span>}
                </th>
                <td>{PLATFORM[d.platform] ?? d.platform}</td>
                <td>
                  {d.revoked_at ? (
                    <span className="muted">Signed out</span>
                  ) : (
                    relative(d.last_seen_at ?? d.created_at)
                  )}
                </td>
                <td>
                  {!d.revoked_at && (
                    <button
                      type="button"
                      className="pb-button"
                      disabled={stale}
                      onClick={() => setRemoving(d)}
                    >
                      Sign out device
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="muted small">
        Signing out a device stops it from using your account right away. It cannot delete what is already
        stored on that device.
      </p>
      {removing && (
        <Dialog
          title={`Sign out ${removing.name}?`}
          description={
            removing.current
              ? 'This computer will be signed out. Its local profiles stay as they are.'
              : 'That device can no longer use your account or your organizations. Anything already stored on it stays there.'
          }
          role="alertdialog"
          onClose={() => setRemoving(null)}
        >
          <div className="row row--end">
            <button type="button" className="pb-button" onClick={() => setRemoving(null)}>
              Cancel
            </button>
            <button
              type="button"
              className="pb-button"
              data-variant="danger"
              onClick={() => remove(removing)}
            >
              Sign out device
            </button>
          </div>
        </Dialog>
      )}
    </section>
  );
}
