/**
 * R2 (ADR-0021): after signing in, the app finishes onboarding by itself and lands on Profiles. Only when the
 * server needs a decision does a dialog appear: accept the terms for a new workspace, an invitation that is waiting,
 * or which of several owned workspaces opens first. The server decides everything else (one workspace per person,
 * invitations first, no fresh trial for returning people); the app never names a user, role or e-mail.
 */
import type { OnboardingResult, OnboardingStatus } from '@pb/contracts/onboarding';
import { type FormEvent, useState } from 'react';
import { invitationCode } from './account.tsx';
import type { Backend } from './backend/types.ts';
import { errorMessage } from './backend/types.ts';
import { ApiFailure, ROLE_LABEL, send } from './cloud.ts';
import { Dialog } from './components.tsx';

export type OnboardingNeed =
  | { kind: 'terms'; status: OnboardingStatus; createOwn: boolean }
  | { kind: 'invitations'; status: OnboardingStatus }
  | { kind: 'choose'; status: OnboardingStatus }
  | { kind: 'verify' };

/** Asks the server to complete onboarding; returns what the person must decide, or null when it is done. */
export async function completeOnboarding(
  backend: Backend,
  body: Record<string, unknown> = {},
): Promise<{ done: OnboardingResult | null; need: OnboardingNeed | null }> {
  try {
    const res = await send<OnboardingResult>(backend, 'POST', '/v1/onboarding/complete', body);
    const r = res.data;
    if (r.outcome === 'terms_required')
      return { done: null, need: { kind: 'terms', status: r.status, createOwn: body.create_own === true } };
    if (r.outcome === 'invitations_pending')
      return { done: null, need: { kind: 'invitations', status: r.status } };
    if (r.outcome === 'choice_required') return { done: null, need: { kind: 'choose', status: r.status } };
    return { done: r, need: null };
  } catch (err) {
    if (err instanceof ApiFailure && err.code === 'EMAIL_NOT_VERIFIED')
      return { done: null, need: { kind: 'verify' } };
    throw err;
  }
}

/** A short line for the toast after onboarding finished. */
export function onboardingMessage(r: OnboardingResult): string {
  const ws = r.status.workspaces.find((w) => w.org_id === r.status.default_org_id);
  const name = ws?.name ?? 'your workspace';
  switch (r.outcome) {
    case 'created':
      return `Welcome! ${name} is ready.`;
    case 'joined':
      return `You joined ${name}.`;
    default:
      return `Signed in. ${name} opens first.`;
  }
}

export function OnboardingDialog(props: {
  backend: Backend;
  need: OnboardingNeed;
  onDone: (r: OnboardingResult) => void;
  onNeed: (n: OnboardingNeed) => void;
  onClose: () => void;
  onSignInAgain: () => void;
}) {
  const { backend, need } = props;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [accepted, setAccepted] = useState(false);
  const [marketing, setMarketing] = useState(false);
  const [name, setName] = useState('');
  const [code, setCode] = useState('');

  const run = async (body: Record<string, unknown>) => {
    setBusy(true);
    setError(null);
    try {
      const r = await completeOnboarding(backend, body);
      if (r.done) props.onDone(r.done);
      else if (r.need) props.onNeed(r.need);
    } catch (err) {
      setError(errorMessage(err));
    }
    setBusy(false);
  };

  if (need.kind === 'verify') {
    return (
      <Dialog
        title="Verify your e-mail address"
        description="We sent you a link to confirm your e-mail address. Open it, then sign in again here."
        onClose={props.onClose}
      >
        <p className="muted small">
          If it did not arrive, check your spam folder. Signing in again offers to send a new link.
        </p>
        <div className="row row--end">
          <button type="button" className="pb-button" onClick={props.onClose}>
            Later
          </button>
          <button type="button" className="pb-button" data-variant="primary" onClick={props.onSignInAgain}>
            Sign in again
          </button>
        </div>
      </Dialog>
    );
  }

  if (need.kind === 'terms') {
    const s = need.status;
    const submit = (e: FormEvent) => {
      e.preventDefault();
      void run({
        accept_terms_version: s.terms.current_version,
        marketing_consent: marketing,
        ...(name.trim() ? { workspace_name: name.trim() } : {}),
        ...(need.createOwn ? { create_own: true } : {}),
      });
    };
    return (
      <Dialog
        title={need.createOwn ? 'Create your own workspace' : 'Set up your workspace'}
        description={
          s.trial_available
            ? 'Your workspace starts with a free trial. No payment details are needed now.'
            : 'You already used your free trial with this address, so this workspace starts without one.'
        }
        onClose={props.onClose}
      >
        <form className="stack" onSubmit={submit}>
          <label>
            Workspace name (optional)
            <input
              maxLength={120}
              value={name}
              placeholder="My workspace"
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label className="check">
            <input type="checkbox" checked={accepted} onChange={(e) => setAccepted(e.target.checked)} />I
            accept the terms of service (version {s.terms.current_version}).
          </label>
          <label className="check">
            <input type="checkbox" checked={marketing} onChange={(e) => setMarketing(e.target.checked)} />
            Send me occasional product news (optional).
          </label>
          {error && (
            <p className="error" role="alert">
              {error} Nothing was half-created; you can try again.
            </p>
          )}
          <div className="row row--end">
            <button type="button" className="pb-button" onClick={props.onClose}>
              Not now
            </button>
            <button type="submit" className="pb-button" data-variant="primary" disabled={busy || !accepted}>
              Create workspace
            </button>
          </div>
        </form>
      </Dialog>
    );
  }

  if (need.kind === 'invitations') {
    const token = invitationCode(code);
    return (
      <Dialog
        title="You have been invited"
        description="These teams invited your e-mail address. Paste the invitation link from the e-mail to join, or create your own workspace."
        onClose={props.onClose}
      >
        <ul className="stack">
          {need.status.pending_invitations.map((i) => (
            <li key={`${i.org_name}-${i.expires_at}`}>
              <strong>{i.org_name}</strong> — {ROLE_LABEL[i.role] ?? i.role}
            </li>
          ))}
        </ul>
        <label>
          Invitation link or code
          <input value={code} spellCheck={false} onChange={(e) => setCode(e.target.value)} />
        </label>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="row row--end">
          <button
            type="button"
            className="pb-button"
            disabled={busy}
            onClick={() => props.onNeed({ kind: 'terms', status: need.status, createOwn: true })}
          >
            Create my own workspace
          </button>
          <button
            type="button"
            className="pb-button"
            data-variant="primary"
            disabled={busy || !token}
            onClick={() => void run({ invitation_token: token })}
          >
            Join
          </button>
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog
      title="Choose your workspace"
      description="You own several workspaces. Which one should open first? You can switch at any time."
      onClose={props.onClose}
    >
      <ul className="stack">
        {need.status.workspaces
          .filter((w) => !w.suspended)
          .map((w) => (
            <li key={w.org_id} className="row">
              <span className="grow">{w.name}</span>
              <button
                type="button"
                className="pb-button"
                disabled={busy}
                onClick={() => void run({ choose_org_id: w.org_id })}
              >
                Open this one
              </button>
            </li>
          ))}
      </ul>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </Dialog>
  );
}
