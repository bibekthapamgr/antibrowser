/**
 * One organization: the billing overview every staff role sees, sensitive information behind approved access, and
 * the billing admin's overrides and provider resync.
 */
import {
  type AccessRequest,
  BILLING_TIMING,
  OVERRIDE_SCOPES,
  type Override,
  type OverrideScope,
  PLAN_LIMIT_KEYS,
  SUPPORT_ACCESS_SCOPES,
  type SupportAccessScope,
  type SupportActivityEntry,
  type SupportMember,
  type SupportOrgOverview,
} from '@pb/contracts/billing';
import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { href, PageTitle, Problem, StateBadge, useConsole } from './App.tsx';
import {
  ACCESS_LABEL,
  ALERT_LABEL,
  day,
  LIMIT_LABEL,
  limitValue,
  money,
  OVERRIDE_LABEL,
  overrideValue,
  REASON_LABEL,
  STATE_LABEL,
  when,
} from './format.ts';

export function OrgPage({ orgId }: { orgId: string }) {
  const { api, explain, staff } = useConsole();
  const [org, setOrg] = useState<SupportOrgOverview | null>(null);
  const [mine, setMine] = useState<AccessRequest[]>([]);
  const [problem, setProblem] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [o, reqs] = await Promise.all([api.org(orgId), api.accessRequests(false)]);
      setOrg(o);
      setMine(reqs.filter((r) => r.org_id === orgId && r.requested_by === staff.user_id));
      setProblem(null);
    } catch (e) {
      setProblem(explain(e));
    }
  }, [api, orgId, staff.user_id, explain]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!org) {
    return (
      <section className="stack" aria-busy={!problem}>
        <p>
          <a href={href.search}>← Find an organization</a>
        </p>
        <Problem text={problem} />
        {!problem && <p>Loading…</p>}
      </section>
    );
  }

  const s = org.subscription;
  return (
    <article className="stack" aria-labelledby="org-title">
      <p>
        <a href={href.search}>← Find an organization</a>
      </p>
      <header className="org-head">
        <PageTitle>
          <span id="org-title">{org.name}</span>
        </PageTitle>
        <StateBadge state={s.state} />
      </header>
      <p className="muted">
        <span className="mono">{org.id}</span> · created {day(org.created_at)} · {org.member_count} member
        {org.member_count === 1 ? '' : 's'}
      </p>
      <Problem text={problem} />

      {org.break_glass_until && <BreakGlass org={org} />}
      <Subscription org={org} onChanged={load} />
      <Limits org={org} />
      <Sensitive org={org} mine={mine} onChanged={load} />
      <Overrides orgId={org.id} onChanged={load} />

      <section aria-labelledby="invoices-title">
        <h2 id="invoices-title">Invoices</h2>
        {org.invoices.length === 0 ? (
          <p className="muted">No invoices yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th scope="col">Number</th>
                <th scope="col">Status</th>
                <th scope="col">Due</th>
                <th scope="col">Paid</th>
                <th scope="col">Period</th>
                <th scope="col">Created</th>
              </tr>
            </thead>
            <tbody>
              {org.invoices.map((i) => (
                <tr key={i.id}>
                  <td className="mono">{i.number ?? i.id}</td>
                  <td>{i.status}</td>
                  <td>{money(i.amount_due_minor, i.currency)}</td>
                  <td>{money(i.amount_paid_minor, i.currency)}</td>
                  <td>
                    {day(i.period_start)} – {day(i.period_end)}
                  </td>
                  <td>{when(i.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section aria-labelledby="events-title">
        <h2 id="events-title">Payment provider events</h2>
        <p className="muted small">
          Only the event envelope is stored; the worker reads the current state from the provider, so order
          does not matter.
        </p>
        {org.events.length === 0 ? (
          <p className="muted">No events.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th scope="col">Event</th>
                <th scope="col">Type</th>
                <th scope="col">Status</th>
                <th scope="col">Attempts</th>
                <th scope="col">Received</th>
                <th scope="col">Processed</th>
              </tr>
            </thead>
            <tbody>
              {org.events.map((e) => (
                <tr key={e.provider_event_id}>
                  <td className="mono">{e.provider_event_id}</td>
                  <td className="mono">{e.type}</td>
                  <td>
                    {e.status}
                    {e.error && <span className="muted small"> — {e.error}</span>}
                  </td>
                  <td>{e.attempts}</td>
                  <td>{when(e.received_at)}</td>
                  <td>{when(e.processed_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section aria-labelledby="history-title">
        <h2 id="history-title">State history</h2>
        {org.history.length === 0 ? (
          <p className="muted">No changes recorded.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">Change</th>
                <th scope="col">Plan</th>
                <th scope="col">Cause</th>
              </tr>
            </thead>
            <tbody>
              {org.history.map((h) => (
                <tr key={`${h.at}-${h.to_state}-${h.cause}`}>
                  <td>{when(h.at)}</td>
                  <td>
                    {h.from_state ? STATE_LABEL[h.from_state] : 'New'} → {STATE_LABEL[h.to_state]}
                  </td>
                  <td className="mono">
                    {h.plan_id}@{h.plan_version}
                  </td>
                  <td>{h.cause}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section aria-labelledby="org-alerts-title">
        <h2 id="org-alerts-title">Alerts for this organization</h2>
        {org.alerts.length === 0 ? (
          <p className="muted">None.</p>
        ) : (
          <ul className="plain">
            {org.alerts.map((a) => (
              <li key={a.id}>
                <strong>{ALERT_LABEL[a.kind]}</strong> {a.resolved_at ? '(resolved)' : '(open)'} — {a.detail}{' '}
                <span className="muted small">last seen {when(a.last_seen_at)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </article>
  );
}

function Subscription({ org, onChanged }: { org: SupportOrgOverview; onChanged: () => Promise<void> }) {
  const { api, has, explain } = useConsole();
  const s = org.subscription;
  const [note, setNote] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const resync = async () => {
    setBusy(true);
    setProblem(null);
    try {
      const queued = await api.resync(org.id);
      setNote(
        queued
          ? 'Queued: the worker confirms the subscription with the payment provider within a few minutes.'
          : 'Nothing to confirm: this organization has no payment provider customer.',
      );
      await onChanged();
    } catch (e) {
      setProblem(explain(e));
    } finally {
      setBusy(false);
    }
  };
  const rows: [string, string][] = [
    ['Plan', `${s.plan.name} (${s.plan.id}@${s.plan.version})`],
    ['State', `${STATE_LABEL[s.state]} — ${REASON_LABEL[s.reason]}`],
    ['Until', when(s.until)],
    ['Trial ends', when(s.trial_ends_at)],
    ['Current period ends', when(s.current_period_end)],
    ['Cancels at period end', s.cancel_at_period_end ? 'Yes' : 'No'],
    ['Grace until', when(s.grace_until)],
    ['Payment customer', org.provider_customer_id ?? '—'],
    ['Payment subscription', org.provider_subscription_id ?? '—'],
    ['Last confirmed with provider', when(s.synced_at)],
    [
      'Data after cancellation',
      s.retention_days ? `Kept ${s.retention_days} days` : 'Kept until an owner deletes it',
    ],
  ];
  return (
    <section aria-labelledby="sub-title">
      <h2 id="sub-title">Subscription</h2>
      <dl className="facts">
        {rows.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd className={/^(cus|sub)_/.test(v) ? 'mono' : undefined}>{v}</dd>
          </div>
        ))}
      </dl>
      {has('billing_admin') && (
        <div className="actions">
          <button type="button" className="pb-button" disabled={busy} onClick={resync}>
            Confirm with the payment provider now
          </button>
        </div>
      )}
      {note && (
        <p className="ok" role="status">
          {note}
        </p>
      )}
      <Problem text={problem} />
    </section>
  );
}

function Limits({ org }: { org: SupportOrgOverview }) {
  const s = org.subscription;
  const used: Record<string, number> = {
    profiles: s.usage.profiles,
    seats: s.usage.seats,
    storage_bytes: s.usage.storage_bytes,
    automation_concurrency: s.usage.automation_running,
  };
  return (
    <section aria-labelledby="limits-title">
      <h2 id="limits-title">Limits and usage</h2>
      <table>
        <thead>
          <tr>
            <th scope="col">Limit</th>
            <th scope="col">Used</th>
            <th scope="col">Allowed</th>
          </tr>
        </thead>
        <tbody>
          {PLAN_LIMIT_KEYS.map((k) => (
            <tr key={k} data-over={s.over_limits.includes(k) ? 'true' : undefined}>
              <th scope="row">{LIMIT_LABEL[k]}</th>
              <td>{limitValue(k, used[k] ?? 0)}</td>
              <td>
                {limitValue(k, s.limits[k])}
                {s.over_limits.includes(k) && <strong className="over"> over the limit</strong>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted small">
        Features:{' '}
        {Object.entries(s.features)
          .map(([f, on]) => `${OVERRIDE_LABEL[`feature.${f}` as OverrideScope]} ${on ? 'on' : 'off'}`)
          .join(', ')}
        .
        {s.overrides.length > 0 &&
          ` Overrides in force: ${s.overrides.map((o) => `${OVERRIDE_LABEL[o.scope]} until ${day(o.expires_at)}`).join(', ')}.`}
      </p>
    </section>
  );
}

// ---------------------------------------------------------------- sensitive information
/**
 * Milestone 12: emergency access granted on the server (staff.ts break-glass), shown on every organization while it
 * lasts. Its one emergency action revokes the organization's API tokens; customer data is never touched.
 */
function BreakGlass({ org }: { org: SupportOrgOverview }) {
  const { api, explain } = useConsole();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const revoke = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setProblem(null);
    try {
      const n = await api.revokeApiTokens(org.id, reason.trim());
      setDone(
        `${n} API token${n === 1 ? '' : 's'} revoked. The organization’s owners see this in their activity log.`,
      );
      setReason('');
    } catch (err) {
      setProblem(explain(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="break-glass" role="alert" aria-labelledby="break-glass-title">
      <h2 id="break-glass-title">Break-glass access until {when(org.break_glass_until)}</h2>
      <p>
        Members and the activity log open without approval. Every view and action is recorded in the platform
        audit and in this organization’s own activity log, and raises an alert.
      </p>
      <form className="stack" onSubmit={revoke}>
        <label htmlFor="bg-reason">Revoke all of this organization’s API tokens (a leaked token): why?</label>
        <textarea
          id="bg-reason"
          value={reason}
          minLength={20}
          maxLength={500}
          required
          onChange={(e) => setReason(e.target.value)}
        />
        <div className="row">
          <button
            type="submit"
            className="pb-button"
            data-variant="danger"
            disabled={busy || reason.trim().length < 20}
          >
            Revoke all API tokens
          </button>
        </div>
      </form>
      {done && <p role="status">{done}</p>}
      <Problem text={problem} />
    </section>
  );
}

function Sensitive({
  org,
  mine,
  onChanged,
}: {
  org: SupportOrgOverview;
  mine: AccessRequest[];
  onChanged: () => Promise<void>;
}) {
  const { api, explain } = useConsole();
  const [scope, setScope] = useState<SupportAccessScope>('members');
  const [reason, setReason] = useState('');
  const [minutes, setMinutes] = useState(30);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  const [members, setMembers] = useState<SupportMember[] | null>(null);
  const [activity, setActivity] = useState<SupportActivityEntry[] | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setProblem(null);
    setSent(null);
    try {
      await api.requestAccess(org.id, { scope, reason: reason.trim(), duration_minutes: minutes });
      setSent(
        `Requested. A different support lead must approve it (Access requests); access then lasts ${minutes} minutes.`,
      );
      setReason('');
      await onChanged();
    } catch (err) {
      setProblem(explain(err));
    } finally {
      setBusy(false);
    }
  };
  const show = async (what: SupportAccessScope) => {
    setProblem(null);
    try {
      if (what === 'members') setMembers(await api.members(org.id));
      else setActivity(await api.activity(org.id));
    } catch (err) {
      setProblem(explain(err));
      await onChanged();
    }
  };
  const pending = mine.filter((r) => r.state === 'pending');
  const approved = mine.filter((r) => r.state === 'approved');
  const until = (s: SupportAccessScope) =>
    approved
      .filter((r) => r.scope === s && r.expires_at)
      .map((r) => r.expires_at as string)
      .sort()
      .at(-1) ?? null;

  return (
    <section aria-labelledby="sensitive-title" className="sensitive">
      <h2 id="sensitive-title">Members and activity</h2>
      <p className="muted">
        Hidden by default. Ask for time-bound access with a reason; a different support lead must approve it.
        Each approval and each view is recorded in the platform audit and in this organization’s own activity
        log, which its owners can read.
      </p>
      {SUPPORT_ACCESS_SCOPES.map((s) =>
        org.active_access.includes(s) ? (
          <div key={s} className="granted">
            <p>
              <strong>{ACCESS_LABEL[s]}:</strong>{' '}
              {org.break_glass_until
                ? `break-glass access until ${when(org.break_glass_until)}.`
                : `access approved until ${when(until(s))}.`}{' '}
              <button type="button" className="pb-button" onClick={() => show(s)}>
                Show {ACCESS_LABEL[s].toLowerCase()}
              </button>
            </p>
          </div>
        ) : null,
      )}
      {pending.length > 0 && (
        <p role="status">
          Waiting for approval:{' '}
          {pending.map((r) => `${ACCESS_LABEL[r.scope]} (${r.duration_minutes} min)`).join(', ')}.
        </p>
      )}
      {members && (
        <table aria-label="Members">
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">E-mail</th>
              <th scope="col">Role</th>
              <th scope="col">Joined</th>
            </tr>
          </thead>
          <tbody>
            {members.map((m) => (
              <tr key={m.user_id}>
                <td>{m.display_name}</td>
                <td>{m.email ?? '—'}</td>
                <td>{m.role}</td>
                <td>{day(m.joined_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {activity && (
        <table aria-label="Activity log">
          <thead>
            <tr>
              <th scope="col">When</th>
              <th scope="col">Action</th>
              <th scope="col">Outcome</th>
              <th scope="col">Actor</th>
              <th scope="col">Target</th>
            </tr>
          </thead>
          <tbody>
            {activity.map((a) => (
              <tr key={`${a.at}-${a.action}-${a.actor_user_id ?? ''}`}>
                <td>{when(a.at)}</td>
                <td className="mono">{a.action}</td>
                <td>{a.outcome}</td>
                <td className="mono">{a.actor_user_id ?? '—'}</td>
                <td>{a.target_type ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <form className="form" onSubmit={submit} aria-labelledby="request-title">
        <h3 id="request-title">Request access</h3>
        <fieldset>
          <legend>Information</legend>
          {SUPPORT_ACCESS_SCOPES.map((s) => (
            <label key={s} className="choice">
              <input type="radio" name="scope" value={s} checked={scope === s} onChange={() => setScope(s)} />{' '}
              {ACCESS_LABEL[s]}
              <span className="muted small">
                {s === 'members'
                  ? ' — names, e-mail addresses and roles'
                  : ' — the last 100 actions, without their details'}
              </span>
            </label>
          ))}
        </fieldset>
        <label htmlFor="access-reason">
          Reason (at least 20 characters; the ticket or what the customer asked)
        </label>
        <textarea
          id="access-reason"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          minLength={20}
          maxLength={500}
          required
          rows={3}
        />
        <label htmlFor="access-minutes">For how long</label>
        <select id="access-minutes" value={minutes} onChange={(e) => setMinutes(Number(e.target.value))}>
          {[15, 30, 60, 120, BILLING_TIMING.supportAccessMaxMinutes].map((m) => (
            <option key={m} value={m}>
              {m < 60 ? `${m} minutes` : `${m / 60} hour${m === 60 ? '' : 's'}`}
            </option>
          ))}
        </select>
        <div className="actions">
          <button type="submit" className="pb-button" data-variant="primary" disabled={busy}>
            Request access
          </button>
        </div>
        {sent && (
          <p className="ok" role="status">
            {sent}
          </p>
        )}
        <Problem text={problem} />
      </form>
    </section>
  );
}

// ---------------------------------------------------------------- overrides
const LIMIT_SCOPES = OVERRIDE_SCOPES.filter((s) => s.startsWith('limit.'));

function Overrides({ orgId, onChanged }: { orgId: string; onChanged: () => Promise<void> }) {
  const { api, has, explain } = useConsole();
  const admin = has('billing_admin');
  const [items, setItems] = useState<Override[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [scope, setScope] = useState<OverrideScope>('limit.seats');
  const [amount, setAmount] = useState('');
  const [noLimit, setNoLimit] = useState(false);
  const [on, setOn] = useState(true);
  const [reason, setReason] = useState('');
  const [days, setDays] = useState(30);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setItems(await api.overrides(orgId));
    } catch (e) {
      setProblem(explain(e));
    }
  }, [api, orgId, explain]);
  useEffect(() => {
    void load();
  }, [load]);

  const isLimit = (LIMIT_SCOPES as readonly string[]).includes(scope);
  const value = (): number | boolean | null => {
    if (scope === 'access.unrestricted') return true;
    if (!isLimit) return on;
    if (noLimit) return null;
    const n = Number(amount);
    if (scope === 'limit.storage_bytes') return Math.round(n * 1024 ** 3);
    return n;
  };
  const expires = new Date(Date.now() + days * 86_400_000);

  const add = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setProblem(null);
    setDone(null);
    try {
      const row = await api.addOverride(orgId, {
        scope,
        value: value() as never,
        reason: reason.trim(),
        expires_at: expires.toISOString(),
      });
      setDone(
        `Added: ${OVERRIDE_LABEL[row.scope]} ${overrideValue(row.scope, row.value)} until ${when(row.expires_at)}.`,
      );
      setReason('');
      setAmount('');
      await load();
      await onChanged();
    } catch (err) {
      setProblem(explain(err));
    } finally {
      setBusy(false);
    }
  };
  const revoke = async (id: string) => {
    setProblem(null);
    setDone(null);
    try {
      await api.revokeOverride(id);
      setDone('Override ended.');
      await load();
      await onChanged();
    } catch (err) {
      setProblem(explain(err));
    }
  };

  const live = (o: Override) => !o.revoked_at && Date.parse(o.expires_at) > Date.now();
  return (
    <section aria-labelledby="overrides-title">
      <h2 id="overrides-title">Entitlement overrides</h2>
      <p className="muted small">
        Each override has a reason and ends by itself (at most {BILLING_TIMING.overrideMaxDays} days). Only
        billing admins add or end them; the organization’s activity log shows that support changed something.
      </p>
      {items && items.length === 0 && <p className="muted">No overrides.</p>}
      {items && items.length > 0 && (
        <table>
          <thead>
            <tr>
              <th scope="col">Override</th>
              <th scope="col">Value</th>
              <th scope="col">Reason</th>
              <th scope="col">Ends</th>
              <th scope="col">State</th>
              {admin && (
                <th scope="col">
                  <span className="pb-sr-only">Actions</span>
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {items.map((o) => (
              <tr key={o.id}>
                <td>{OVERRIDE_LABEL[o.scope]}</td>
                <td>{overrideValue(o.scope, o.value)}</td>
                <td>{o.reason}</td>
                <td>{when(o.expires_at)}</td>
                <td>{o.revoked_at ? `Ended ${when(o.revoked_at)}` : live(o) ? 'In force' : 'Expired'}</td>
                {admin && (
                  <td>
                    {live(o) && (
                      <button
                        type="button"
                        className="pb-button"
                        aria-label={`End now: ${OVERRIDE_LABEL[o.scope]} override`}
                        onClick={() => revoke(o.id)}
                      >
                        End now
                      </button>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {admin && (
        <form className="form" onSubmit={add} aria-labelledby="override-add-title">
          <h3 id="override-add-title">Add an override</h3>
          <label htmlFor="ovr-scope">What</label>
          <select id="ovr-scope" value={scope} onChange={(e) => setScope(e.target.value as OverrideScope)}>
            {OVERRIDE_SCOPES.map((s) => (
              <option key={s} value={s}>
                {OVERRIDE_LABEL[s]}
              </option>
            ))}
          </select>
          {isLimit && (
            <>
              <label htmlFor="ovr-amount">{scope === 'limit.storage_bytes' ? 'Limit in GB' : 'Limit'}</label>
              <input
                id="ovr-amount"
                type="number"
                min={0}
                step={scope === 'limit.storage_bytes' ? 'any' : 1}
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                disabled={noLimit}
                required={!noLimit}
              />
              <label className="choice">
                <input type="checkbox" checked={noLimit} onChange={(e) => setNoLimit(e.target.checked)} /> No
                limit
              </label>
            </>
          )}
          {scope.startsWith('feature.') && (
            <>
              <label htmlFor="ovr-on">Feature</label>
              <select id="ovr-on" value={on ? 'on' : 'off'} onChange={(e) => setOn(e.target.value === 'on')}>
                <option value="on">On</option>
                <option value="off">Off</option>
              </select>
            </>
          )}
          {scope === 'access.unrestricted' && (
            <p className="warn small">
              Keeps full access whatever the payment state until it ends. Use it for a confirmed payment the
              provider has not reported yet, not as a discount.
            </p>
          )}
          <label htmlFor="ovr-reason">Reason (at least 20 characters)</label>
          <textarea
            id="ovr-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            minLength={20}
            maxLength={500}
            required
            rows={2}
          />
          <label htmlFor="ovr-days">Ends after (days, 1–{BILLING_TIMING.overrideMaxDays})</label>
          <input
            id="ovr-days"
            type="number"
            min={1}
            max={BILLING_TIMING.overrideMaxDays}
            value={days}
            onChange={(e) =>
              setDays(Math.max(1, Math.min(BILLING_TIMING.overrideMaxDays, Number(e.target.value) || 1)))
            }
            aria-describedby="ovr-days-at"
          />
          <p id="ovr-days-at" className="muted small">
            Ends {when(expires.toISOString())}.
          </p>
          <div className="actions">
            <button type="submit" className="pb-button" data-variant="primary" disabled={busy}>
              Add override
            </button>
          </div>
        </form>
      )}
      {done && (
        <p className="ok" role="status">
          {done}
        </p>
      )}
      <Problem text={problem} />
    </section>
  );
}
