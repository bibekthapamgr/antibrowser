/**
 * Shared sessions (milestone 08): one person at a time works in an organization profile. The drawer's team section
 * (who has it, asking for it, the note left for the next person, close and hand off, what happens when the
 * connection drops or access ends), the forced-takeover dialog for admins, and the organization's recovery copies.
 * The shell holds the lease and its fencing token; this window only sees phases and plain-language reasons.
 */
import type { RecoveryCopy, Role, SessionLease } from '@pb/contracts/resources';
import { type FormEvent, useCallback, useEffect, useId, useState } from 'react';
import type { Backend, ProfileView, TeamPhase, TeamRequest, TeamStatus } from './backend/types.ts';
import { errorMessage } from './backend/types.ts';
import { ApiFailure, can, get, send } from './cloud.ts';
import { Dialog, formatBytes } from './components.tsx';
import { secretHint } from './notes.ts';
import { day, type Notify, relative } from './status.tsx';

interface Page<T> {
  items: T[];
  next_cursor: string | null;
}

/** Short labels for the profile list and badges. */
export const TEAM_LABEL: Record<TeamPhase, string> = {
  opening: 'Opening…',
  running: 'Open here',
  closing: 'Closing…',
  handing_off: 'Handing off…',
  pending: 'Needs attention',
  lost: 'Connection lost',
  taken_over: 'Taken over',
  revoked: 'Access removed',
};

/** Why a session waits or ended, in words. */
export const TEAM_CODE: Record<string, string> = {
  CONNECTION_LOST:
    'The connection to your organization’s server was lost, so the profile was closed before anyone else could open it. Its closing backup continues when the connection is back.',
  PROFILE_CLOSED_UNCLEANLY:
    'The browser did not close normally, so nothing was uploaded. Open the profile again to let it recover, or give the handoff up and keep this copy here.',
  UPLOAD_CANCELED:
    'The closing backup was canceled. Try again, or give the handoff up and keep this copy here.',
  UPLOAD_FAILED:
    'The closing backup did not finish. Try again, or give the handoff up and keep this copy here.',
  HANDOFF_STALLED:
    'The closing backup has not finished for a long time. Try again, or give the handoff up and keep this copy here.',
  RELEASE_PENDING: 'The backup is saved; letting go of the profile is being retried.',
  VERSION_CONFLICT:
    'A newer version exists that this computer’s copy is not based on. Give the handoff up (your copy stays here) and resolve it in Backups.',
  TAKEN_OVER:
    'An admin took this profile over. It was closed here, and your copy was kept aside on this computer. Nothing is merged.',
  ACCESS_REMOVED:
    'Your access to this profile was removed. It was closed here; the data already on this computer was kept aside, not deleted.',
  RECOVERY_COPY_KEPT:
    'An admin took this profile over. Your copy was kept aside and uploaded as a recovery copy that admins can restore separately. Nothing is merged.',
};

/** Why an open was refused (operation errors), for notices. */
export const OPEN_REFUSED: Record<string, string> = {
  PROFILE_IN_USE_ELSEWHERE: 'Someone else has this profile open.',
  PROFILE_SESSION_UNCERTAIN: 'The last session on another computer did not close properly.',
  SHARED_OFFLINE: 'Organization profiles open only while this computer is online.',
  NO_ACCESS: 'You do not have access to open this profile.',
};

const LEASED: TeamPhase[] = ['opening', 'running', 'closing', 'handing_off', 'pending', 'lost'];
const CAPABILITY_TEXT: Record<string, string> = {
  launch: 'open it',
  edit: 'change its settings',
  backup_download: 'restore its backups',
};

/** The profile list's "Shared" column. */
export function SharedCell({ p }: { p: ProfileView }) {
  if (p.sync_status !== 'shared') return <span className="muted small">Local</span>;
  if (!p.team_phase) return <span className="small">Shared</span>;
  const tone =
    p.team_phase === 'taken_over' || p.team_phase === 'revoked'
      ? ' badge--error'
      : p.team_phase === 'pending' || p.team_phase === 'lost'
        ? ' badge--warn'
        : '';
  return <span className={`badge${tone}`}>{TEAM_LABEL[p.team_phase]}</span>;
}

/** The drawer's section for a profile shared with the organization. */
export function TeamSection(props: {
  backend: Backend;
  profile: ProfileView;
  refreshKey: number;
  notify: Notify;
  onOpen: () => void;
}) {
  const { backend, profile: p, notify } = props;
  const [t, setT] = useState<TeamStatus | null>(null);
  const [ids, setIds] = useState<{ org: string; prf: string } | null>(null);
  const [role, setRole] = useState<Role | null>(null);
  const [lease, setLease] = useState<SessionLease | null>(null);
  const [mine, setMine] = useState<TeamRequest | null>(null);
  const [dialog, setDialog] = useState<'handoff' | 'request' | 'takeover' | 'abort' | null>(null);

  const load = useCallback(async () => {
    try {
      const status = await backend.team.status(p.id);
      setT(status);
      if (!status.shared) return;
      const sync = await backend.sync.status(p.id);
      if (!sync.org_id || !sync.org_profile_id) return;
      const next = { org: sync.org_id, prf: sync.org_profile_id };
      setIds(next);
      const [org, current, requests] = await Promise.all([
        get<{ role: Role }>(backend, `/v1/orgs/${next.org}`).catch(() => null),
        status.phase
          ? Promise.resolve(null)
          : get<{ lease: SessionLease | null }>(
              backend,
              `/v1/orgs/${next.org}/profiles/${next.prf}/leases/current`,
            ).catch(() => null),
        status.phase
          ? Promise.resolve(null)
          : get<Page<TeamRequest>>(
              backend,
              `/v1/orgs/${next.org}/profiles/${next.prf}/handoff-requests`,
            ).catch(() => null),
      ]);
      setRole(org?.data.role ?? null);
      setLease(current?.data.lease ?? null);
      setMine(
        requests?.data.items.find((r) => r.mine && (r.status === 'open' || r.status === 'declined')) ?? null,
      );
    } catch {
      // The section stays as it was; the next event reloads it.
    }
  }, [backend, p.id]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey reloads on profile events
  useEffect(() => {
    void load();
  }, [load, props.refreshKey]);
  useEffect(() => backend.on('team', (e) => e.profile_id === p.id && void load()), [backend, p.id, load]);
  // While someone else has it, or a handoff runs, it is checked again now and then.
  useEffect(() => {
    if (!t?.shared) return;
    const busy = (t.phase && t.phase !== 'running') || (lease && !t.phase);
    if (!busy) return;
    const timer = setInterval(() => void load(), 5000);
    return () => clearInterval(timer);
  }, [t, lease, load]);

  const act = async (f: () => Promise<TeamStatus>, done?: string) => {
    try {
      setT(await f());
      if (done) notify(done);
    } catch (e) {
      notify(errorMessage(e), 'error');
    }
  };
  const answer = async (r: TeamRequest, action: 'decline' | 'cancel') => {
    if (!ids) return;
    try {
      await send(
        backend,
        'POST',
        `/v1/orgs/${ids.org}/profiles/${ids.prf}/handoff-requests/${r.id}/${action}`,
      );
      notify(action === 'decline' ? `Told ${r.requested_by_name} not now.` : 'Request withdrawn.');
      void load();
    } catch (e) {
      notify(errorMessage(e), 'error');
    }
  };

  if (!t?.shared) return null;
  const phase = t.phase;
  const held = !phase && lease && lease.state !== 'released';
  const caps = t.capabilities;
  const ended = phase === 'taken_over' || phase === 'revoked';
  const holder = lease
    ? `${lease.holder_name || 'Someone'} on ${lease.device_name || 'another computer'}`
    : '';

  return (
    <fieldset aria-labelledby="team-legend">
      <legend id="team-legend">Shared with your organization</legend>
      <p className="small">
        One person at a time works in a shared profile. When it closes, its backup is saved and the next
        person gets this version.
      </p>
      {caps && (
        <p className="muted small">
          You can{' '}
          {caps.length ? caps.map((c) => CAPABILITY_TEXT[c] ?? c).join(', ') : 'only see it (no opening)'}.
        </p>
      )}

      {t.received_note && LEASED.includes(phase ?? 'running') && phase && (
        <div className="notice" role="note" aria-label="Handoff note">
          <p className="small">
            <strong>Note from {t.received_note.by_name || 'the last person'}</strong> (
            {relative(t.received_note.at).toLowerCase()}):
          </p>
          <p>{t.received_note.text}</p>
        </div>
      )}

      {!phase && !held && (
        <p className="small">
          <span className="badge">Free</span> Nobody has it open.
          {t.refusal ? '' : ' Opening it here gives you the newest version.'}
        </p>
      )}
      {held && lease && (
        <div className={`notice${lease.state === 'uncertain' ? ' notice--error' : ''}`} role="status">
          <p>
            {lease.state === 'uncertain' ? (
              <>
                <strong>Session not closed properly:</strong> it was open by {holder} (since{' '}
                {relative(lease.acquired_at).toLowerCase()}), and that computer stopped answering. Its browser
                may still be open, so nobody else can open the profile until that person opens the app again
                or an admin takes it over.
              </>
            ) : (
              <>
                <strong>In use:</strong> open by {holder} since {relative(lease.acquired_at).toLowerCase()}.
              </>
            )}
          </p>
          {mine?.status === 'open' && (
            <p className="small">
              You asked {relative(mine.created_at).toLowerCase()}. Waiting for an answer.
            </p>
          )}
          {mine?.status === 'declined' && <p className="small">They said not now.</p>}
          <div className="row">
            {mine?.status === 'open' ? (
              <button type="button" className="pb-button" onClick={() => answer(mine, 'cancel')}>
                Withdraw request
              </button>
            ) : (
              lease.state !== 'uncertain' &&
              caps?.includes('launch') && (
                <button type="button" className="pb-button" onClick={() => setDialog('request')}>
                  Ask for it…
                </button>
              )
            )}
            {can(role, 'lease.force_release') && (
              <button
                type="button"
                className="pb-button"
                data-variant="danger"
                onClick={() => setDialog('takeover')}
              >
                Take over…
              </button>
            )}
          </div>
        </div>
      )}

      {phase === 'running' && (
        <>
          <p className="small">
            <span className="badge">Open here</span> Others see that you have it open.
            {t.heartbeat_age_seconds !== null && t.heartbeat_age_seconds > 30
              ? ' Checking the connection…'
              : ''}
          </p>
          {t.requests.length > 0 && (
            <div className="notice" role="alert">
              {t.requests.map((r) => (
                <div key={r.id} className="stack">
                  <p>
                    <strong>{r.requested_by_name || 'A teammate'}</strong> asks for this profile
                    {r.note ? `: “${r.note}”` : '.'}
                  </p>
                  <div className="row">
                    <button
                      type="button"
                      className="pb-button"
                      data-variant="primary"
                      onClick={() => setDialog('handoff')}
                    >
                      Close and hand off…
                    </button>
                    <button type="button" className="pb-button" onClick={() => answer(r, 'decline')}>
                      Not now
                    </button>
                  </div>
                </div>
              ))}
              <p className="muted small">A request never closes your profile by itself.</p>
            </div>
          )}
          <button type="button" className="pb-button" onClick={() => setDialog('handoff')}>
            Close and hand off…
          </button>
        </>
      )}
      {(phase === 'opening' || phase === 'closing') && (
        <p className="small" role="status">
          {phase === 'opening' ? 'Opening: getting the newest version first…' : 'Closing…'}
        </p>
      )}
      {phase === 'handing_off' && (
        <div className="stack" role="status">
          <p className="small">
            <strong>Handing off:</strong> the closing backup is uploading. The profile is released for the
            next person once it is saved.
          </p>
          {t.error_code === 'CONNECTION_LOST' && <p className="warn small">{TEAM_CODE.CONNECTION_LOST}</p>}
          <progress aria-label="Handoff progress" />
          <div className="row">
            <button type="button" className="pb-button" onClick={() => act(() => backend.team.retry(p.id))}>
              Try again now
            </button>
            <button type="button" className="pb-button" onClick={() => setDialog('abort')}>
              Give the handoff up…
            </button>
          </div>
        </div>
      )}
      {(phase === 'pending' || phase === 'lost') && (
        <div className="notice" role="alert">
          <p>{TEAM_CODE[t.error_code ?? ''] ?? 'The handoff is waiting for your decision.'}</p>
          <div className="row">
            {t.error_code === 'PROFILE_CLOSED_UNCLEANLY' ? (
              <button type="button" className="pb-button" data-variant="primary" onClick={props.onOpen}>
                Open again
              </button>
            ) : (
              phase === 'pending' && (
                <button
                  type="button"
                  className="pb-button"
                  data-variant="primary"
                  onClick={() => act(() => backend.team.retry(p.id), 'Trying the handoff again…')}
                >
                  Try again
                </button>
              )
            )}
            <button type="button" className="pb-button" onClick={() => setDialog('abort')}>
              Give the handoff up…
            </button>
          </div>
          <p className="muted small">While this waits, the profile stays yours: nobody else can open it.</p>
        </div>
      )}
      {ended && (
        <div className="notice notice--error" role="alert">
          <p>
            {TEAM_CODE[t.error_code ?? ''] ??
              TEAM_CODE[phase === 'revoked' ? 'ACCESS_REMOVED' : 'TAKEN_OVER']}
          </p>
          {t.kept_aside && (
            <p className="muted small">
              The copy that was on this computer is kept in its recovery folder (not deleted, not merged).
            </p>
          )}
          <button type="button" className="pb-button" onClick={() => act(() => backend.team.dismiss(p.id))}>
            Dismiss
          </button>
        </div>
      )}
      {t.kept_aside && !ended && (
        <p className="muted small">
          Changes on this computer that were never uploaded were kept aside before the newest version was put
          here (nothing was merged).
        </p>
      )}

      {dialog === 'handoff' && (
        <HandoffDialog
          name={p.name}
          onClose={() => setDialog(null)}
          onConfirm={async (note) => {
            setDialog(null);
            await act(
              () => backend.team.close(p.id, note),
              'Closing. The profile is handed off once its backup is saved.',
            );
          }}
        />
      )}
      {dialog === 'request' && ids && lease && (
        <RequestDialog
          backend={backend}
          orgId={ids.org}
          profileId={ids.prf}
          holder={lease.holder_name || 'the person who has it'}
          notify={notify}
          onClose={() => setDialog(null)}
          onDone={() => {
            setDialog(null);
            void load();
          }}
        />
      )}
      {dialog === 'takeover' && ids && lease && (
        <TakeoverDialog
          backend={backend}
          orgId={ids.org}
          profileId={ids.prf}
          profileName={p.name}
          holder={holder}
          uncertain={lease.state === 'uncertain'}
          notify={notify}
          onClose={() => setDialog(null)}
          onDone={() => {
            setDialog(null);
            void load();
          }}
        />
      )}
      {dialog === 'abort' && (
        <Dialog
          role="alertdialog"
          title="Give the handoff up?"
          description="The organization keeps its newest backup as it was, and the profile is freed for others. This computer keeps its copy with your changes; they are not uploaded."
          onClose={() => setDialog(null)}
          initialFocus="[data-cancel]"
        >
          <div className="row row--end">
            <button type="button" className="pb-button" data-cancel onClick={() => setDialog(null)}>
              Keep waiting
            </button>
            <button
              type="button"
              className="pb-button"
              data-variant="danger"
              onClick={() => {
                setDialog(null);
                void act(
                  () => backend.team.abort(p.id),
                  'Handoff given up. Your copy stays on this computer.',
                );
              }}
            >
              Give up the handoff
            </button>
          </div>
        </Dialog>
      )}
    </fieldset>
  );
}

/** "Close and hand off": an optional note for the next person (never a password). */
function HandoffDialog(props: {
  name: string;
  onClose: () => void;
  onConfirm: (note: string | null) => Promise<void>;
}) {
  const [note, setNote] = useState('');
  const help = useId();
  const warning = secretHint(note);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (warning) return;
    void props.onConfirm(note.trim() || null);
  };
  return (
    <Dialog
      title={`Close and hand off ${props.name}?`}
      description="The browser closes, its backup is saved for your organization, and the profile is free for the next person. They see your note when they open it."
      onClose={props.onClose}
    >
      <form className="stack" onSubmit={submit}>
        <label>
          Note for the next person (optional)
          <textarea
            maxLength={500}
            rows={3}
            value={note}
            aria-describedby={help}
            aria-invalid={warning ? true : undefined}
            onChange={(e) => setNote(e.target.value)}
          />
        </label>
        <p id={help} className={warning ? 'warn small' : 'muted small'}>
          {warning
            ? `${warning} Remove it before handing off.`
            : 'For example what is half done. Never passwords or codes: notes are not encrypted.'}
        </p>
        <div className="row row--end">
          <button type="button" className="pb-button" onClick={props.onClose}>
            Cancel
          </button>
          <button type="submit" className="pb-button" data-variant="primary" disabled={!!warning}>
            Close and hand off
          </button>
        </div>
      </form>
    </Dialog>
  );
}

/** Asks the person who has a profile open for it. */
function RequestDialog(props: {
  backend: Backend;
  orgId: string;
  profileId: string;
  holder: string;
  notify: Notify;
  onClose: () => void;
  onDone: () => void;
}) {
  const [note, setNote] = useState('');
  const warning = secretHint(note);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (warning) return;
    try {
      await send(
        props.backend,
        'POST',
        `/v1/orgs/${props.orgId}/profiles/${props.profileId}/handoff-requests`,
        {
          ...(note.trim() ? { note: note.trim() } : {}),
        },
      );
      props.notify(
        `Asked ${props.holder}. Their answer shows here; the profile is yours to open once they hand it off.`,
      );
      props.onDone();
    } catch (err) {
      props.notify(errorMessage(err), 'error');
    }
  };
  return (
    <Dialog
      title="Ask for this profile"
      description={`${props.holder} sees your request in their app. Nothing closes until they hand it off.`}
      onClose={props.onClose}
    >
      <form className="stack" onSubmit={submit}>
        <label>
          Message (optional)
          <textarea maxLength={500} rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
        </label>
        {warning && <p className="warn small">{warning}</p>}
        <div className="row row--end">
          <button type="button" className="pb-button" onClick={props.onClose}>
            Cancel
          </button>
          <button type="submit" className="pb-button" data-variant="primary" disabled={!!warning}>
            Send request
          </button>
        </div>
      </form>
    </Dialog>
  );
}

/** Owners and admins: end someone's session (with a reason and a clear warning). */
export function TakeoverDialog(props: {
  backend: Backend;
  orgId: string;
  profileId: string;
  profileName: string;
  holder: string;
  uncertain: boolean;
  notify: Notify;
  onClose: () => void;
  onDone: () => void;
}) {
  const [reason, setReason] = useState('');
  const [understood, setUnderstood] = useState(false);
  const warning = secretHint(reason);
  const ok = reason.trim().length >= 3 && understood && !warning;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!ok) return;
    try {
      await send(
        props.backend,
        'POST',
        `/v1/orgs/${props.orgId}/profiles/${props.profileId}/force-takeover`,
        {
          reason: reason.trim(),
          confirm: true,
        },
      );
      props.notify(`Taken over. ${props.profileName} can be opened now; ${props.holder} was told it ended.`);
      props.onDone();
    } catch (err) {
      props.notify(
        err instanceof ApiFailure && err.code === 'PROFILE_NOT_IN_USE'
          ? 'Nobody has this profile open any more.'
          : errorMessage(err),
        'error',
      );
      props.onDone();
    }
  };
  return (
    <Dialog
      role="alertdialog"
      title={`Take over ${props.profileName}?`}
      description={
        props.uncertain
          ? `${props.holder} stopped answering without closing it. Their browser may still be open.`
          : `${props.holder} has it open right now.`
      }
      onClose={props.onClose}
      initialFocus="[data-cancel]"
    >
      <form className="stack" onSubmit={submit}>
        <div className="notice notice--error">
          <p>
            Their session ends: their app closes the profile, and nothing more from that computer is saved to
            the organization. Changes they have not saved yet are <strong>not merged</strong>: they stay on
            their computer and are kept as a recovery copy. This cannot stop activity on websites that is
            already happening there.
          </p>
        </div>
        <label>
          Reason (recorded in Activity and shown to them)
          <textarea
            required
            minLength={3}
            maxLength={500}
            rows={2}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </label>
        {warning && <p className="warn small">{warning}</p>}
        <label className="choice">
          <input type="checkbox" checked={understood} onChange={(e) => setUnderstood(e.target.checked)} />I
          understand their unsaved changes are not merged.
        </label>
        <div className="row row--end">
          <button type="button" className="pb-button" data-cancel onClick={props.onClose}>
            Cancel
          </button>
          <button type="submit" className="pb-button" data-variant="danger" disabled={!ok}>
            Take over
          </button>
        </div>
      </form>
    </Dialog>
  );
}

/** Uploads kept from computers that lost their session (organization Backups, owners and admins). */
export function RecoveryCopiesSection(props: {
  backend: Backend;
  orgId: string;
  role: Role;
  notify: Notify;
  offline: boolean;
}) {
  const { backend, orgId, notify } = props;
  const [rows, setRows] = useState<RecoveryCopy[] | null>(null);
  useEffect(() => {
    get<Page<RecoveryCopy>>(backend, `/v1/orgs/${orgId}/recovery-copies`, [['limit', '50']])
      .then((r) => setRows(r.data.items))
      .catch(() => setRows([]));
  }, [backend, orgId]);

  const restore = async (c: RecoveryCopy) => {
    try {
      const local = await backend.team.restoreRecoveryCopy(
        orgId,
        c.profile_id,
        c.id,
        `${c.profile_name} (recovery copy)`.slice(0, 120),
      );
      notify(
        `Restoring the recovery copy into “${local.name}” on this computer. It is a separate profile, not shared.`,
      );
    } catch (err) {
      notify(errorMessage(err), 'error');
    }
  };

  return (
    <>
      <h3 id="org-recovery-title">Recovery copies</h3>
      <p className="muted small">
        When a session is taken over, the copy from that computer is uploaded here instead of replacing
        anything. Restore one as a separate profile to compare or rescue work; they are erased after the trash
        period.
      </p>
      {rows === null ? (
        <p role="status">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="muted">No recovery copies.</p>
      ) : (
        <table className="simple records" aria-labelledby="org-recovery-title">
          <thead>
            <tr>
              <th scope="col">Profile</th>
              <th scope="col">From</th>
              <th scope="col">Kept</th>
              <th scope="col">Size</th>
              <th scope="col">Erased on</th>
              <th scope="col">
                <span className="pb-sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => (
              <tr key={c.id}>
                <th scope="row">{c.profile_name}</th>
                <td>{c.created_by_name || '—'}</td>
                <td>{relative(c.kept_at)}</td>
                <td>{formatBytes(c.plaintext_size ?? c.ciphertext_size)}</td>
                <td>{day(c.erase_after)}</td>
                <td>
                  <button
                    type="button"
                    className="pb-button"
                    disabled={props.offline || !can(props.role, 'backups.manage')}
                    onClick={() => restore(c)}
                  >
                    Restore as a new profile<span className="pb-sr-only"> from {c.profile_name}</span>
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
