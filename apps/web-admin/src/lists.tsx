/** Access requests (everyone: their own; support leads: all and decide), alerts and the platform audit. */
import type { AccessRequest, AuditExport, BillingAlert, PlatformAuditEntry } from '@pb/contracts/billing';
import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { href, PageTitle, Problem, useConsole } from './App.tsx';
import { Scroll, SeverityPill } from './admin.tsx';
import { ACCESS_LABEL, ALERT_LABEL, ALERT_SEVERITY, initials, when } from './format.ts';
import { EmptyState, Icon, PageHeader, Pill, Skeleton, Toast, type Tone } from './ui.tsx';

const STATE_TONE: Record<AccessRequest['state'], Tone> = {
  pending: 'warn',
  approved: 'good',
  denied: 'bad',
  revoked: 'neutral',
  expired: 'neutral',
};

const STATE_TEXT: Record<AccessRequest['state'], string> = {
  pending: 'Waiting for approval',
  approved: 'Approved',
  denied: 'Denied',
  revoked: 'Ended early',
  expired: 'Expired',
};

export function RequestsPage() {
  const { api, staff, has, explain } = useConsole();
  const lead = has('support_lead');
  const [pendingOnly, setPendingOnly] = useState(lead);
  const [items, setItems] = useState<AccessRequest[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setItems(await api.accessRequests(pendingOnly));
    } catch (e) {
      setProblem(explain(e));
    }
  }, [api, pendingOnly, explain]);
  useEffect(() => {
    void load();
  }, [load]);

  const act = async (r: AccessRequest, what: 'approve' | 'deny' | 'revoke') => {
    setProblem(null);
    setDone(null);
    try {
      if (what === 'revoke') await api.revokeAccess(r.id);
      else await api.decide(r.id, what);
      setDone(
        what === 'approve'
          ? `Approved: ${r.requested_by_name} can see ${ACCESS_LABEL[r.scope].toLowerCase()} for ${r.duration_minutes} minutes.`
          : what === 'deny'
            ? 'Denied.'
            : 'Access ended.',
      );
      await load();
    } catch (e) {
      setProblem(explain(e));
    }
  };

  return (
    <section className="stack" aria-labelledby="requests-title">
      <PageHeader
        title={
          <PageTitle>
            <span id="requests-title">Access requests</span>
          </PageTitle>
        }
        description={
          lead
            ? 'Approve only with a reason that matches a customer request or ticket. You cannot decide on your own requests.'
            : 'Your requests. A support lead decides; approved access ends by itself.'
        }
      />
      <Toast text={done} onDismiss={() => setDone(null)} />
      <Problem text={problem} />
      <div className="card card--flush">
        <div className="toolbar">
          <label className="choice switch">
            <input type="checkbox" checked={pendingOnly} onChange={(e) => setPendingOnly(e.target.checked)} />{' '}
            Waiting for approval only
          </label>
          {items && (
            <span className="muted small">
              {items.length === 1 ? '1 request' : `${items.length} requests`}
            </span>
          )}
        </div>
        {!items && !problem && <Skeleton variant="rows" />}
        {items && items.length === 0 && (
          <EmptyState icon="key" title="No requests.">
            {pendingOnly
              ? 'Nothing is waiting for a decision. Clear the filter to see earlier requests.'
              : 'Requests appear here when someone asks to see an organization’s members or activity.'}
          </EmptyState>
        )}
        {items && items.length > 0 && (
          <Scroll>
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Organization</th>
                  <th scope="col">Information</th>
                  <th scope="col">Reason</th>
                  <th scope="col">Requested by</th>
                  <th scope="col">State</th>
                  <th scope="col">
                    <span className="pb-sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {items.map((r) => {
                  const own = r.requested_by === staff.user_id;
                  return (
                    <tr key={r.id}>
                      <td>
                        <a href={href.org(r.org_id)} className="mono">
                          {r.org_id}
                        </a>
                      </td>
                      <td className="nowrap">
                        {ACCESS_LABEL[r.scope]}
                        <span className="muted small"> · {r.duration_minutes} min</span>
                      </td>
                      <td className="cell-text">{r.reason}</td>
                      <td>
                        <span className="cell-entity">
                          <span className="avatar avatar--sm" aria-hidden="true">
                            {initials(own ? staff.display_name : r.requested_by_name)}
                          </span>
                          <span className="stacked">
                            <span>{own ? 'You' : r.requested_by_name}</span>
                            <span className="muted small">{when(r.created_at)}</span>
                          </span>
                        </span>
                      </td>
                      <td>
                        <span className="stacked">
                          <Pill tone={STATE_TONE[r.state]}>{STATE_TEXT[r.state]}</Pill>
                          {r.state === 'approved' && r.expires_at && (
                            <span className="muted small"> until {when(r.expires_at)}</span>
                          )}
                        </span>
                      </td>
                      <td className="row-actions">
                        {lead && !own && r.state === 'pending' && (
                          <>
                            <button
                              type="button"
                              className="pb-button"
                              data-variant="primary"
                              data-size="sm"
                              aria-label={`Approve ${r.requested_by_name}’s request for ${ACCESS_LABEL[r.scope].toLowerCase()}`}
                              onClick={() => act(r, 'approve')}
                            >
                              Approve
                            </button>
                            <button
                              type="button"
                              className="pb-button"
                              data-size="sm"
                              aria-label={`Deny ${r.requested_by_name}’s request for ${ACCESS_LABEL[r.scope].toLowerCase()}`}
                              onClick={() => act(r, 'deny')}
                            >
                              Deny
                            </button>
                          </>
                        )}
                        {(own || lead) && (r.state === 'pending' || r.state === 'approved') && (
                          <button
                            type="button"
                            className="pb-button"
                            data-size="sm"
                            data-variant="ghost"
                            aria-label={`End the request for ${ACCESS_LABEL[r.scope].toLowerCase()} by ${own ? 'you' : r.requested_by_name}`}
                            onClick={() => act(r, 'revoke')}
                          >
                            End
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </Scroll>
        )}
      </div>
    </section>
  );
}

export function AlertsPage() {
  const { api, has, explain } = useConsole();
  const admin = has('billing_admin');
  const [openOnly, setOpenOnly] = useState(true);
  const [items, setItems] = useState<BillingAlert[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setItems(await api.alerts(openOnly));
    } catch (e) {
      setProblem(explain(e));
    }
  }, [api, openOnly, explain]);
  useEffect(() => {
    void load();
  }, [load]);

  const resolve = async (a: BillingAlert) => {
    setProblem(null);
    try {
      await api.resolveAlert(a.id);
      await load();
    } catch (e) {
      setProblem(explain(e));
    }
  };
  const open = items?.filter((a) => !a.resolved_at).length ?? 0;

  return (
    <section className="stack" aria-labelledby="alerts-title">
      <PageHeader
        title={
          <PageTitle>
            <span id="alerts-title">Reconciliation alerts</span>
          </PageTitle>
        }
        description="Raised by the billing worker when the payment provider and this server disagree, events fail or wait, or money moves back (refunds, disputes). Resolving records that someone handled it; it changes nothing else."
      />
      <Problem text={problem} />
      <div className="card card--flush">
        <div className="toolbar">
          <label className="choice switch">
            <input type="checkbox" checked={openOnly} onChange={(e) => setOpenOnly(e.target.checked)} /> Open
            only
          </label>
          {items && <span className="muted small">{open === 1 ? '1 open' : `${open} open`}</span>}
        </div>
        {!items && !problem && <Skeleton variant="rows" />}
        {items && items.length === 0 && (
          <EmptyState icon="check" title="No alerts.">
            {openOnly
              ? 'Everything the worker raised has been handled. Clear “Open only” to see resolved alerts.'
              : 'The billing worker has not raised any alerts.'}
          </EmptyState>
        )}
        {items && items.length > 0 && (
          <Scroll>
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Alert</th>
                  <th scope="col">Organization</th>
                  <th scope="col">Detail</th>
                  <th scope="col">Seen</th>
                  <th scope="col">State</th>
                  {admin && (
                    <th scope="col">
                      <span className="pb-sr-only">Actions</span>
                    </th>
                  )}
                </tr>
              </thead>
              <tbody>
                {items.map((a) => (
                  <tr key={a.id} data-open={a.resolved_at ? undefined : 'true'}>
                    <td>
                      <span className="alert-cell">
                        <SeverityPill severity={ALERT_SEVERITY[a.kind] ?? 'warning'} />
                        <span>
                          <span className="alert-cell__name">{ALERT_LABEL[a.kind]}</span>
                          {a.ref && <span className="mono small muted alert-cell__ref">{a.ref}</span>}
                        </span>
                      </span>
                    </td>
                    <td>
                      {a.org_id ? (
                        <a href={href.org(a.org_id)} className="mono">
                          {a.org_id}
                        </a>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td className="cell-text">{a.detail}</td>
                    <td className="nowrap">
                      <span className="count">{a.count}×</span>{' '}
                      <span className="muted small">last {when(a.last_seen_at)}</span>
                    </td>
                    <td className="nowrap">
                      {a.resolved_at ? (
                        <Pill tone="neutral">Resolved {when(a.resolved_at)}</Pill>
                      ) : (
                        <Pill tone="warn">Open</Pill>
                      )}
                    </td>
                    {admin && (
                      <td className="row-actions">
                        {!a.resolved_at && (
                          <button
                            type="button"
                            className="pb-button"
                            data-size="sm"
                            aria-label={`Resolve ${ALERT_LABEL[a.kind]} alert`}
                            onClick={() => resolve(a)}
                          >
                            <Icon name="check" size={14} />
                            Resolve
                          </button>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </Scroll>
        )}
      </div>
    </section>
  );
}

/** Recomputes the audit's hash chain (the server's rule, src/audit-chain.ts in the API) with the browser's SHA-256. */
async function verifyChain(
  rows: AuditExport['items'],
): Promise<{ ok: boolean; brokenAt: string | null; lastSeq: string | null }> {
  let prev = '';
  const bytes = (hex: string) => new Uint8Array((hex.match(/../g) ?? []).map((h) => Number.parseInt(h, 16)));
  const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
  for (const r of rows) {
    const text = [
      r.seq,
      r.id,
      r.at_us,
      r.actor_user_id ?? '',
      r.action,
      r.org_id ?? '',
      r.target ?? '',
      r.details_text,
      r.request_id ?? '',
    ].join('\u001f');
    const data = new Uint8Array([...bytes(prev), ...new TextEncoder().encode(text)]);
    const hash = hex(await crypto.subtle.digest('SHA-256', data));
    if (r.prev_hash !== prev || hash !== r.hash) return { ok: false, brokenAt: r.seq, lastSeq: null };
    prev = hash;
  }
  return { ok: true, brokenAt: null, lastSeq: rows.at(-1)?.seq ?? null };
}

export function AuditPage({ org }: { org: string | null }) {
  const { api, staff, explain } = useConsole();
  const [items, setItems] = useState<PlatformAuditEntry[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [filter, setFilter] = useState(org ?? '');

  useEffect(() => {
    let live = true;
    api
      .audit(org ?? undefined)
      .then((r) => live && setItems(r))
      .catch((e: unknown) => live && setProblem(explain(e)));
    return () => {
      live = false;
    };
  }, [api, org, explain]);

  const apply = (e: FormEvent) => {
    e.preventDefault();
    window.location.hash = href.audit(filter.trim() || undefined);
  };

  // Milestone 12: a verifiable copy of the whole hash-chained audit, checked here before it is saved.
  const [exported, setExported] = useState<string | null>(null);
  const exportChain = async () => {
    setProblem(null);
    try {
      const all: AuditExport['items'] = [];
      let head: AuditExport['head'] = { seq: '0', hash: '' };
      for (let page = 0; page < 200; page++) {
        const r = await api.auditExport(all.at(-1)?.seq);
        all.push(...r.items);
        head = r.head;
        if (r.items.length === 0 || all.at(-1)?.seq === r.head.seq) break;
      }
      const check = await verifyChain(all);
      if (!check.ok) {
        setProblem(
          `The audit chain does not verify at entry ${check.brokenAt}. Report this to the security contact.`,
        );
        return;
      }
      const lines = [...all.map((e) => JSON.stringify(e)), JSON.stringify({ head })].join('\n');
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([`${lines}\n`], { type: 'application/x-ndjson' }));
      a.download = `platform-audit-${new Date().toISOString().slice(0, 10)}.ndjson`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      setExported(
        `Exported ${all.length} entries; the chain verifies up to entry ${check.lastSeq}. Keep the file outside this server.`,
      );
    } catch (e) {
      setProblem(explain(e));
    }
  };

  return (
    <section className="stack" aria-labelledby="audit-title">
      <PageHeader
        title={
          <PageTitle>
            <span id="audit-title">Platform audit</span>
          </PageTitle>
        }
        description="Staff sign-ins, searches, views, access decisions, overrides and resyncs (newest 200). Entries cannot be changed from here."
        actions={
          staff.roles.includes('support_lead') && (
            <button type="button" className="pb-button" onClick={() => void exportChain()}>
              <Icon name="download" size={15} />
              Export a verifiable copy
            </button>
          )
        }
      />
      <Toast text={exported} onDismiss={() => setExported(null)} />
      <Problem text={problem} />
      <div className="card card--flush">
        <form className="toolbar" onSubmit={apply}>
          <label htmlFor="audit-org" className="toolbar__label">
            Organization id
          </label>
          <span className="input-icon toolbar__grow">
            <Icon name="search" size={16} />
            <input
              id="audit-org"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              pattern="org_[0-9A-HJKMNP-TV-Z]{26}"
              placeholder="All organizations"
              spellCheck={false}
            />
          </span>
          <button type="submit" className="pb-button">
            Filter
          </button>
          {items && (
            <span className="muted small">{items.length === 1 ? '1 entry' : `${items.length} entries`}</span>
          )}
        </form>
        {!items && !problem && <Skeleton variant="rows" />}
        {items && items.length === 0 && (
          <EmptyState icon="audit" title="No entries.">
            {org ? 'Nothing has been recorded for this organization yet.' : 'Nothing has been recorded yet.'}
          </EmptyState>
        )}
        {items && items.length > 0 && (
          <Scroll tall>
            <table className="table table--audit">
              <thead>
                <tr>
                  <th scope="col">When</th>
                  <th scope="col">Who</th>
                  <th scope="col">Action</th>
                  <th scope="col">Organization</th>
                  <th scope="col">Details</th>
                </tr>
              </thead>
              <tbody>
                {items.map((e) => (
                  <tr key={e.id}>
                    <td className="nowrap">{when(e.at)}</td>
                    <td className="mono">
                      {e.actor_user_id === staff.user_id ? 'You' : (e.actor_user_id ?? '—')}
                    </td>
                    <td>
                      <code className="code">{e.action}</code>
                    </td>
                    <td className="mono">{e.org_id ?? '—'}</td>
                    <td className="mono small details">
                      {[e.target, Object.keys(e.details).length ? JSON.stringify(e.details) : null]
                        .filter(Boolean)
                        .join(' ')
                        .slice(0, 240) || '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Scroll>
        )}
      </div>
    </section>
  );
}
