/**
 * R2 flows in the R4 portal: create an account or sign in (at the identity provider), verify the address, accept the
 * terms for a new workspace, join through an invitation, or choose which owned workspace opens first. The server
 * decides everything (POST /onboarding/complete); this page only asks what it needs and shows what happened.
 */
import type { OnboardingResult, OnboardingStatus } from '@pb/contracts/onboarding';
import { type FormEvent, useEffect, useId, useState } from 'react';
import { type PortalApi, signInUrl } from './api.ts';
import { Card, ErrorBox, Loading, ROLE_NAME, usePageHeading } from './common.tsx';

export interface WebConfig {
  brand: string;
  terms_version: string;
  terms_url: string | null;
  download_url: string | null;
  sign_in: boolean;
}

export function planIntent(): string | undefined {
  try {
    return sessionStorage.getItem('pb.plan') || undefined;
  } catch {
    return undefined;
  }
}
export function setPlanIntent(plan: string | null) {
  try {
    if (plan) sessionStorage.setItem('pb.plan', plan);
    else sessionStorage.removeItem('pb.plan');
  } catch {
    /* optional */
  }
}
function pendingInvite(): string | null {
  try {
    return sessionStorage.getItem('pb.invite');
  } catch {
    return null;
  }
}
function setPendingInvite(token: string | null) {
  try {
    if (token) sessionStorage.setItem('pb.invite', token);
    else sessionStorage.removeItem('pb.invite');
  } catch {
    /* the link itself carries the token */
  }
}

/** A link to the identity provider's sign-in (or registration) that returns to `back`. */
function SignInLink(props: {
  api: PortalApi;
  mode: 'signin' | 'signup';
  back: string;
  primary?: boolean;
  children: string;
}) {
  const href = signInUrl(props.mode, props.back);
  return (
    <a
      className={props.primary ? 'button primary' : 'button'}
      href={href}
      onClick={(e) => {
        e.preventDefault();
        props.api.navigate(href);
      }}
    >
      {props.children}
    </a>
  );
}

export function SignedOut(props: {
  api: PortalApi;
  config: WebConfig;
  returnTo?: string;
  heading?: string;
  intro?: string;
}) {
  const h = usePageHeading(props.heading ?? `Welcome to ${props.config.brand}`);
  const back = props.returnTo ?? '/app/#/welcome';
  return (
    <Card>
      <h1 ref={h} tabIndex={-1}>
        {props.heading ?? `Welcome to ${props.config.brand}`}
      </h1>
      <p className="muted">
        {props.intro ??
          'Create an account to get your own workspace with a free trial, or sign in if you already have one. No payment details are needed to start.'}
      </p>
      {props.config.sign_in ? (
        <div className="actions">
          <SignInLink api={props.api} mode="signup" back={back} primary>
            Create account
          </SignInLink>
          <SignInLink api={props.api} mode="signin" back={back}>
            Sign in
          </SignInLink>
        </div>
      ) : (
        <p className="notice">Sign-in is not available on this server yet.</p>
      )}
      <p className="muted small">
        Forgot your password? Choose Sign in, then “Forgot password”. We e-mail you a link to set a new one.
      </p>
    </Card>
  );
}

const FAILURES: Record<string, string> = {
  cancelled: 'Sign-in was cancelled.',
  expired: 'That sign-in link has expired or was already used. Please try again.',
  invalid: 'The sign-in could not be verified. Please try again.',
  provider: 'The sign-in service could not be reached. Please try again in a moment.',
  disabled: 'This account is disabled. Contact support if you think this is a mistake.',
};

export function SignInFailed({ api, reason }: { api: PortalApi; reason: string }) {
  const h = usePageHeading('Sign-in did not complete');
  return (
    <Card>
      <h1 ref={h} tabIndex={-1}>
        Sign-in did not complete
      </h1>
      <p className="error">{FAILURES[reason] ?? FAILURES.invalid}</p>
      <div className="actions">
        <SignInLink api={api} mode="signin" back="/app/#/welcome" primary>
          Try again
        </SignInLink>
      </div>
    </Card>
  );
}

function VerifyEmail({ api }: { api: PortalApi }) {
  const h = usePageHeading('Verify your e-mail');
  return (
    <Card>
      <h1 ref={h} tabIndex={-1}>
        Verify your e-mail
      </h1>
      <p>
        We sent you a link to confirm your e-mail address. Open it, then sign in again here. If it did not
        arrive, check your spam folder; signing in again offers to send a new link.
      </p>
      <div className="actions">
        <SignInLink api={api} mode="signin" back="/app/#/welcome" primary>
          I have verified it — continue
        </SignInLink>
      </div>
    </Card>
  );
}

/**
 * After sign-in: finishes onboarding (invitations first) and hands the default workspace to the portal, or asks for
 * the one decision the server needs.
 */
export function Welcome(props: {
  api: PortalApi;
  config: WebConfig;
  onReady: (orgId: string, outcome: string) => void;
  onSessionChanged: () => Promise<void>;
}) {
  const { api } = props;
  const [view, setView] = useState<
    | { kind: 'loading' }
    | { kind: 'verify' }
    | { kind: 'error'; error: unknown }
    | { kind: 'terms'; status: OnboardingStatus; createOwn: boolean }
    | { kind: 'invitations'; status: OnboardingStatus }
    | { kind: 'choose'; status: OnboardingStatus }
  >({ kind: 'loading' });
  const complete = async (body: Record<string, unknown>) => {
    const plan = planIntent();
    const r = await api.request<OnboardingResult>(
      'POST',
      '/onboarding/complete',
      plan ? { plan_intent: plan, ...body } : body,
    );
    // A new workspace or a joined team gives the session a new id: fetch the new CSRF token.
    await props.onSessionChanged();
    return r;
  };
  const route = (r: OnboardingResult) => {
    if (r.outcome === 'terms_required') setView({ kind: 'terms', status: r.status, createOwn: false });
    else if (r.outcome === 'invitations_pending') setView({ kind: 'invitations', status: r.status });
    else if (r.outcome === 'choice_required') setView({ kind: 'choose', status: r.status });
    else if (r.status.default_org_id) props.onReady(r.status.default_org_id, r.outcome);
    else setView({ kind: 'error', error: new Error('no workspace') });
  };
  const start = async () => {
    setView({ kind: 'loading' });
    try {
      const status = await api.request<OnboardingStatus>('GET', '/onboarding/status');
      if (!status.email_verified) return setView({ kind: 'verify' });
      if (status.default_org_id) return props.onReady(status.default_org_id, 'existing');
      route(await complete({}));
    } catch (error) {
      setView({ kind: 'error', error });
    }
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs once per mount
  useEffect(() => {
    void start();
  }, []);

  if (view.kind === 'loading') return <Loading what="Setting up…" />;
  if (view.kind === 'verify') return <VerifyEmail api={api} />;
  if (view.kind === 'error')
    return (
      <Card>
        <h1>Something went wrong</h1>
        <ErrorBox error={view.error} retry={() => void start()} />
        <p className="muted small">Nothing was half-created: you can safely try again.</p>
      </Card>
    );
  if (view.kind === 'terms')
    return (
      <Terms
        config={props.config}
        status={view.status}
        createOwn={view.createOwn}
        onSubmit={async (body) => route(await complete(body))}
      />
    );
  if (view.kind === 'invitations')
    return (
      <Card>
        <h1>You have been invited</h1>
        <p>These teams invited this e-mail address. Open the invitation link from the e-mail to join one.</p>
        <ul className="choices">
          {view.status.pending_invitations.map((i) => (
            <li key={`${i.org_name}-${i.expires_at}`}>
              <span>
                {i.org_name} — {ROLE_NAME[i.role]}
              </span>
              <span className="muted">until {new Date(i.expires_at).toLocaleDateString()}</span>
            </li>
          ))}
        </ul>
        <div className="actions">
          <button
            type="button"
            onClick={() => setView({ kind: 'terms', status: view.status, createOwn: true })}
          >
            Create my own workspace instead
          </button>
        </div>
      </Card>
    );
  return (
    <Card>
      <h1>Choose your workspace</h1>
      <p className="muted">
        You own several workspaces. Which one should open first? You can switch at any time.
      </p>
      <ul className="choices">
        {view.status.workspaces
          .filter((w) => !w.suspended)
          .map((w) => (
            <li key={w.org_id}>
              <span>{w.name}</span>
              <button
                type="button"
                className="primary"
                onClick={async () => {
                  try {
                    route(await complete({ choose_org_id: w.org_id }));
                  } catch (error) {
                    setView({ kind: 'error', error });
                  }
                }}
              >
                Open this one<span className="sr-only"> ({w.name})</span>
              </button>
            </li>
          ))}
      </ul>
    </Card>
  );
}

function Terms(props: {
  config: WebConfig;
  status: OnboardingStatus;
  createOwn: boolean;
  onSubmit: (body: Record<string, unknown>) => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [accept, setAccept] = useState(false);
  const [marketing, setMarketing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const nameId = useId();
  const h = usePageHeading(props.createOwn ? 'Create your own workspace' : 'Set up your workspace');
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await props.onSubmit({
        accept_terms_version: props.status.terms.current_version,
        marketing_consent: marketing,
        ...(name.trim() ? { workspace_name: name.trim() } : {}),
        ...(props.createOwn ? { create_own: true } : {}),
      });
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  };
  return (
    <Card>
      <h1 ref={h} tabIndex={-1}>
        {props.createOwn ? 'Create your own workspace' : 'Set up your workspace'}
      </h1>
      <p className="muted">
        {props.status.trial_available
          ? 'Your workspace starts with a free trial. No payment details are needed now.'
          : 'You already used your free trial with this address, so this workspace starts without one.'}
      </p>
      <form onSubmit={submit} className="stack">
        <label htmlFor={nameId}>Workspace name (optional)</label>
        <input id={nameId} maxLength={120} value={name} onChange={(e) => setName(e.target.value)} />
        <label className="check">
          <input type="checkbox" required checked={accept} onChange={(e) => setAccept(e.target.checked)} />
          <span>
            I accept the{' '}
            {props.config.terms_url ? (
              <a href={props.config.terms_url} target="_blank" rel="noopener">
                terms of service
              </a>
            ) : (
              'terms of service'
            )}{' '}
            (version {props.status.terms.current_version}).
          </span>
        </label>
        <label className="check">
          <input type="checkbox" checked={marketing} onChange={(e) => setMarketing(e.target.checked)} />
          <span>Send me occasional product news (optional, you can stop at any time).</span>
        </label>
        {error !== null && <ErrorBox error={error} />}
        <div className="actions">
          <button type="submit" className="primary" disabled={busy || !accept}>
            Create my workspace
          </button>
        </div>
      </form>
    </Card>
  );
}

/** An invitation link (#/invite/<token>): sign in or create the invited account, then join — no payment. */
export function Invitation(props: {
  api: PortalApi;
  config: WebConfig;
  token: string;
  signedIn: { email: string | null; email_verified: boolean } | null;
  onJoined: (orgId: string) => void;
  onSessionChanged: () => Promise<void>;
  onSignOut: (returnTo: string) => void;
}) {
  const { api, token } = props;
  const back = `/app/#/invite/${token}`;
  const [preview, setPreview] = useState<{
    org_id: string;
    org_name: string;
    role: keyof typeof ROLE_NAME;
    status: string;
    for_this_account: boolean;
    already_member: boolean;
  } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setPendingInvite(token);
    if (!props.signedIn) return;
    api
      .request<NonNullable<typeof preview>>('GET', `/invitations/${token}`)
      .then(setPreview)
      .catch((e) => {
        setPendingInvite(null);
        setError(e);
      });
  }, [api, token, props.signedIn]);
  if (!props.signedIn)
    return (
      <SignedOut
        api={api}
        config={props.config}
        returnTo={back}
        heading="You have been invited"
        intro="Create an account with the invited e-mail address, or sign in if you already have one. No payment is needed to join a team."
      />
    );
  if (error !== null)
    return (
      <Card>
        <h1>This invitation cannot be used</h1>
        <ErrorBox error={error} />
      </Card>
    );
  if (!preview) return <Loading />;
  // This account has already accepted the invitation / is already in the workspace: there is nothing left to
  // do, so confirm it and offer to continue instead of showing an error.
  if (preview.already_member && preview.for_this_account)
    return (
      <Card>
        <h1>You’re already a member of {preview.org_name}</h1>
        <p role="status">
          This invitation has already been accepted with this account, so there’s nothing more to do. The
          profiles shared with you open in the desktop app.
        </p>
        <div className="actions">
          <button type="button" className="primary" onClick={() => props.onJoined(preview.org_id)}>
            Open {preview.org_name}
          </button>
        </div>
      </Card>
    );
  if (preview.status !== 'open')
    return (
      <Card>
        <h1>This invitation cannot be used</h1>
        <p className="error">
          {preview.status === 'accepted'
            ? 'This invitation was already used.'
            : 'This invitation has expired or was withdrawn. Ask the team for a new one.'}
        </p>
      </Card>
    );
  if (!preview.for_this_account)
    return (
      <Card>
        <h1>Join {preview.org_name}</h1>
        <p className="error">
          This invitation is for a different e-mail address than {props.signedIn.email ?? 'this account'}
          {props.signedIn.email_verified ? '' : ' (or this address is not verified yet)'}.
        </p>
        <div className="actions">
          <button type="button" onClick={() => props.onSignOut(back)}>
            Sign in with another account
          </button>
        </div>
      </Card>
    );
  return (
    <Card>
      <h1>Join {preview.org_name}</h1>
      <p>
        You were invited as {ROLE_NAME[preview.role]}. The profiles shared with you open in the desktop app;
        no plan or payment of your own is needed.
      </p>
      {error !== null && <ErrorBox error={error} />}
      <div className="actions">
        <button
          type="button"
          className="primary"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              const r = await api.request<OnboardingResult>('POST', '/onboarding/complete', {
                invitation_token: token,
              });
              await props.onSessionChanged();
              setPendingInvite(null);
              if (r.status.default_org_id) props.onJoined(r.status.default_org_id);
            } catch (e) {
              setError(e);
              setBusy(false);
            }
          }}
        >
          Accept and join
        </button>
      </div>
    </Card>
  );
}

export { pendingInvite, setPendingInvite };
