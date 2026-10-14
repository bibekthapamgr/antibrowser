/** R4 portal overview: the workspace's plan and trial, usage, the desktop download, and where to go next. */
import type { Subscription } from '@pb/contracts/billing';
import type { PublicDownloads } from '@pb/contracts/portal';
import type { Organization } from '@pb/contracts/resources';
import type { PortalApi } from './api.ts';
import { STATE_TEXT, stateLine } from './billing.tsx';
import {
  Card,
  can,
  day,
  ErrorBox,
  Loading,
  limitText,
  ROLE_NAME,
  useLoad,
  usePageHeading,
} from './common.tsx';
import { planIntent } from './onboarding.tsx';

export function DownloadCard(props: { api: PortalApi }) {
  const d = useLoad(() => props.api.request<PublicDownloads>('GET', '/public/downloads'), [props.api]);
  return (
    <Card title="Get the desktop app" id="download-title">
      {d.loading && !d.data && <Loading what="Checking the latest release…" />}
      {d.error !== null && <ErrorBox error={d.error} retry={d.reload} />}
      {d.data && d.data.status !== 'available' && (
        <p className="notice">
          {d.data.status === 'paused'
            ? 'Downloads are paused while a release is checked. Please try again later.'
            : 'The desktop app is not yet available for download. We will e-mail you when it is.'}
        </p>
      )}
      {d.data?.status === 'available' && (
        <>
          <p>
            Version {d.data.version}, released {day(d.data.published_at)}
            {d.data.notes_url && (
              <>
                {' '}
                · <a href={d.data.notes_url}>release notes</a>
              </>
            )}
            . Install it, choose Sign in and use this same e-mail address: you land in your profiles.
          </p>
          <ul className="downloads">
            {d.data.platforms.map((p) => (
              <li key={p.platform}>
                <a className="button primary" href={p.url}>
                  Download for {p.platform === 'windows-x64' ? 'Windows' : 'Mac'}
                </a>
                <span className="muted small">{p.label}</span>
                {p.sha256 && <span className="mono small">SHA-256 {p.sha256}</span>}
              </li>
            ))}
          </ul>
          <p className="muted small">
            Other systems (Linux, Intel Macs, Windows on ARM) are not supported yet. Profiles run in a browser
            on your computer.
          </p>
        </>
      )}
    </Card>
  );
}

export function Overview(props: {
  api: PortalApi;
  org: Organization;
  outcome: string | null;
  go: (path: string) => void;
}) {
  const { api, org } = props;
  const h = usePageHeading(org.name);
  const read = can(org.role, 'billing.read');
  const sub = useLoad(
    () =>
      read ? api.request<Subscription>('GET', `/orgs/${org.id}/billing/subscription`) : Promise.resolve(null),
    [api, org.id, read],
  );
  const intent = planIntent();
  const s = sub.data;
  return (
    <>
      <h1 ref={h} tabIndex={-1}>
        {org.name}
      </h1>
      {props.outcome === 'joined' && (
        <p className="notice" role="status">
          You joined {org.name} as {ROLE_NAME[org.role]}. The profiles shared with you are waiting in the
          desktop app.
        </p>
      )}
      {props.outcome === 'created' && (
        <p className="notice" role="status">
          Your workspace is ready. Get the app below and create your first profile.
        </p>
      )}
      <div className="grid">
        <Card title="Plan" id="overview-plan">
          {!read && (
            <p>
              {org.billing?.plan_name ?? 'Workspace plan'} — managed by the workspace’s owners. You are{' '}
              {ROLE_NAME[org.role]}.
            </p>
          )}
          {read && sub.loading && !s && <Loading />}
          {read && sub.error !== null && <ErrorBox error={sub.error} retry={sub.reload} />}
          {s && (
            <>
              <p>
                <strong>{s.plan.name}</strong> · {STATE_TEXT[s.state]}
              </p>
              <p>{stateLine(s)}</p>
              <ul className="usage">
                <li>
                  {s.usage.profiles} of {limitText(s.limits.profiles, 'profiles')}
                </li>
                <li>
                  {s.usage.seats} of {limitText(s.limits.seats, 'seats')} (owner included)
                </li>
              </ul>
              {intent && s.state === 'trial' && can(org.role, 'billing.manage') && (
                <p className="notice">
                  You picked a plan on the website.{' '}
                  <button type="button" className="link" onClick={() => props.go('billing')}>
                    Continue to checkout
                  </button>{' '}
                  whenever you are ready — the trial keeps running until then.
                </p>
              )}
              <button type="button" onClick={() => props.go('billing')}>
                Open billing
              </button>
            </>
          )}
        </Card>
        <Card title="Team" id="overview-team">
          <p>Invite people and choose exactly which profiles each one can open.</p>
          {can(org.role, 'members.read') ? (
            <button type="button" onClick={() => props.go('team')}>
              Open team
            </button>
          ) : (
            <p className="muted small">Owners and admins manage the team.</p>
          )}
        </Card>
      </div>
      <DownloadCard api={api} />
    </>
  );
}
