/**
 * R4 portal Account page: the signed-in person's computers (sign one out), signing out everywhere, the password (at
 * the identity provider), which optional e-mails they get, and asking for the account to be deleted (with the
 * policy shown first).
 */
import type { DeletionStatus, NotificationSettings } from '@pb/contracts/portal';
import type { Device } from '@pb/contracts/resources';
import { useState } from 'react';
import type { PortalApi } from './api.ts';
import { Card, day, ErrorBox, Loading, useLoad, usePageHeading } from './common.tsx';

const PLATFORM: Record<string, string> = {
  'windows-x64': 'Windows',
  'macos-arm64': 'Mac (Apple silicon)',
  'macos-x64': 'Mac (Intel)',
  'linux-x64': 'Linux',
};

export function AccountPage(props: {
  api: PortalApi;
  user: { display_name: string; email: string | null };
  accountUrl: string | null;
  onSignedOutEverywhere: () => void;
}) {
  const { api } = props;
  const h = usePageHeading('Account');
  const devices = useLoad(() => api.request<{ items: Device[] }>('GET', '/devices'), [api]);
  const prefs = useLoad(() => api.request<NotificationSettings>('GET', '/me/notifications'), [api]);
  const deletion = useLoad(() => api.request<DeletionStatus>('GET', '/me/deletion-request'), [api]);
  const [error, setError] = useState<unknown>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [note, setNote] = useState('');

  const setPref = async (patch: Partial<NotificationSettings>) => {
    setError(null);
    try {
      await api.request('PUT', '/me/notifications', patch);
      prefs.reload();
      setMessage('E-mail settings saved.');
    } catch (e) {
      setError(e);
    }
  };
  const pending = deletion.data?.request?.state === 'pending';
  return (
    <>
      <h1 ref={h} tabIndex={-1}>
        Account
      </h1>
      {message && (
        <p className="notice" role="status">
          {message}
        </p>
      )}
      {error !== null && <ErrorBox error={error} />}
      <Card title="You" id="you-title">
        <p>
          <strong>{props.user.display_name}</strong>
          <br />
          {props.user.email}
        </p>
        {props.accountUrl ? (
          <p>
            <a href={props.accountUrl} rel="noopener">
              Change password or sign-in settings
            </a>{' '}
            <span className="muted small">(on the sign-in service’s own page)</span>
          </p>
        ) : (
          <p className="muted small">To change your password, choose “Forgot password” when you sign in.</p>
        )}
      </Card>
      <Card title="Your computers" id="devices-title">
        {devices.loading && !devices.data && <Loading />}
        {devices.error !== null && <ErrorBox error={devices.error} retry={devices.reload} />}
        {devices.data && devices.data.items.length === 0 && (
          <p className="muted">No computer has signed in with the desktop app yet.</p>
        )}
        <ul className="people">
          {(devices.data?.items ?? []).map((d) => (
            <li key={d.id}>
              <div>
                <strong>{d.name}</strong>
                <div className="muted small">
                  {PLATFORM[d.platform] ?? d.platform} · last seen {day(d.last_seen_at)}
                  {d.revoked_at ? ' · signed out' : ''}
                </div>
              </div>
              {!d.revoked_at && (
                <button
                  type="button"
                  onClick={async () => {
                    setError(null);
                    try {
                      await api.request('POST', `/devices/${d.id}/revoke`);
                      setMessage(
                        `${d.name} was signed out. Profiles it had open were released; data already on it stays there.`,
                      );
                      devices.reload();
                    } catch (e) {
                      setError(e);
                    }
                  }}
                >
                  Sign out<span className="sr-only"> {d.name}</span>
                </button>
              )}
            </li>
          ))}
        </ul>
        <div className="actions">
          <button
            type="button"
            onClick={async () => {
              if (!window.confirm('Sign out of every browser and computer?')) return;
              await api.request('POST', '/web/auth/revoke-all').catch(() => undefined);
              props.onSignedOutEverywhere();
            }}
          >
            Sign out everywhere
          </button>
        </div>
      </Card>
      <Card title="E-mails" id="emails-title">
        {prefs.loading && !prefs.data && <Loading />}
        {prefs.error !== null && <ErrorBox error={prefs.error} retry={prefs.reload} />}
        {prefs.data && (
          <div className="stack">
            <label className="check">
              <input
                type="checkbox"
                checked={prefs.data.billing_reminders}
                onChange={(e) => void setPref({ billing_reminders: e.target.checked })}
              />
              <span>Trial-ending reminders for workspaces I pay for</span>
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={prefs.data.marketing}
                onChange={(e) => void setPref({ marketing: e.target.checked })}
              />
              <span>Occasional product news</span>
            </label>
            <p className="muted small">
              Security messages, invitations and payment results are always sent: they are about your account.
            </p>
          </div>
        )}
      </Card>
      <Card title="Delete your account" id="delete-title">
        {deletion.loading && !deletion.data && <Loading />}
        {deletion.error !== null && <ErrorBox error={deletion.error} retry={deletion.reload} />}
        {deletion.data && (
          <div className="stack">
            <p>
              Deleting your account removes your sign-in and your membership in every workspace. It is done by
              our support team within 30 days of your request. Invoices and payment records are kept as the
              law requires. Profiles on your computers are not touched.
            </p>
            {deletion.data.sole_owner_of.length > 0 && (
              <p className="notice">
                You are the only owner of {deletion.data.sole_owner_of.map((o) => o.name).join(', ')}. Give
                another member the owner role (in the desktop app) or ask us to close the workspace; otherwise
                its team loses its owner.
              </p>
            )}
            {pending ? (
              <>
                <p role="status">
                  <strong>Requested on {day(deletion.data.request?.created_at)}.</strong> We will confirm by
                  e-mail.
                </p>
                <button
                  type="button"
                  onClick={async () => {
                    try {
                      await api.request('DELETE', '/me/deletion-request');
                      deletion.reload();
                      setMessage('Your deletion request was withdrawn.');
                    } catch (e) {
                      setError(e);
                    }
                  }}
                >
                  Withdraw the request
                </button>
              </>
            ) : confirmDelete ? (
              <form
                className="stack"
                onSubmit={async (e) => {
                  e.preventDefault();
                  try {
                    await api.request('POST', '/me/deletion-request', {
                      confirm: true,
                      ...(note.trim() ? { note: note.trim() } : {}),
                    });
                    setConfirmDelete(false);
                    deletion.reload();
                    setMessage('Your request was sent. Nothing has been deleted yet.');
                  } catch (err) {
                    setError(err);
                  }
                }}
              >
                <label>
                  Anything we should know? (optional)
                  <textarea
                    maxLength={1000}
                    rows={3}
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                  />
                </label>
                <div className="actions">
                  <button type="button" onClick={() => setConfirmDelete(false)}>
                    Cancel
                  </button>
                  <button type="submit" className="danger">
                    Request deletion
                  </button>
                </div>
              </form>
            ) : (
              <div className="actions">
                <button type="button" className="danger" onClick={() => setConfirmDelete(true)}>
                  Ask to delete my account…
                </button>
              </div>
            )}
          </div>
        )}
      </Card>
    </>
  );
}
