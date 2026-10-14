/** Access requests (everyone: their own; support leads: all and decide), alerts and the platform audit. */
import type { AccessRequest, AuditExport, BillingAlert, PlatformAuditEntry } from '@pb/contracts/billing';
import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { href, PageTitle, Problem, useConsole } from './App.tsx';
import { ACCESS_LABEL, ALERT_LABEL, when } from './format.ts';

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
      <PageTitle>
        <span id="requests-title">Access requests</span>
      </PageTitle>
      <p className="muted">
        {lead
          ? 'Approve only with a reason that matches a customer request or ticket. You cannot decide on your own requests.'
          : 'Your requests. A support lead decides; approved access ends by itself.'}
      </p>
      <label className="choice">
        <input type="checkbox" checked={pendingOnly} onChange={(e) => setPendingOnly(e.target.checked)} />{' '}
        Waiting for approval only
      </label>
      {done && (
        <p className="ok" role="status">
          {done}
        </p>
      )}
      <Problem text={problem} />
      {items && items.length === 0 && <p className="muted">No requests.</p>}
      {items && items.length > 0 && (
        <table>
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
                  <td>
                    {ACCESS_LABEL[r.scope]}
                    <span className="muted small"> · {r.duration_minutes} min</span>
                  </td>
                  <td>{r.reason}</td>
                  <td>
                    {own ? 'You' : r.requested_by_name}
                    <span className="muted small"> · {when(r.created_at)}</span>
                  </td>
                  <td>
                    {STATE_TEXT[r.state]}
                    {r.state === 'approved' && r.expires_at && (
                      <span className="muted small"> until {when(r.expires_at)}</span>
                    )}
                  </td>
                  <td className="row-actions">
                    {lead && !own && r.state === 'pending' && (
                      <>
                        <button
                          type="button"
                          className="pb-button"
                          data-variant="primary"
                          aria-label={`Approve ${r.requested_by_name}’s request for ${ACCESS_LABEL[r.scope].toLowerCase()}`}
                          onClick={() => act(r, 'approve')}
                        >
                          Approve
                        </button>
                        <button
                          type="button"
                          className="pb-button"
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
      )}
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

  return (
    <section className="stack" aria-labelledby="alerts-title">
      <PageTitle>
        <span id="alerts-title">Reconciliation alerts</span>
      </PageTitle>
      <p className="muted">
        Raised by the billing worker when the payment provider and this server disagree, events fail or wait,
        or money moves back (refunds, disputes). Resolving records that someone handled it; it changes nothing
        else.
      </p>
      <label className="choice">
        <input type="checkbox" checked={openOnly} onChange={(e) => setOpenOnly(e.target.checked)} /> Open only
      </label>
      <Problem text={problem} />
      {items && items.length === 0 && <p className="muted">No alerts.</p>}
      {items && items.length > 0 && (
        <table>
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
                  {ALERT_LABEL[a.kind]}
                  {a.ref && <div className="mono small">{a.ref}</div>}
                </td>
                <td>
                  {a.org_id ? (
                    <a href={href.org(a.org_id)} className="mono">
                      {a.org_id}
                    </a>
                  ) : (
                    '—'
                  )}
                </td>
                <td>{a.detail}</td>
                <td>
                  {a.count}× · last {when(a.last_seen_at)}
                </td>
                <td>{a.resolved_at ? `Resolved ${when(a.resolved_at)}` : 'Open'}</td>
                {admin && (
                  <td>
                    {!a.resolved_at && (
                      <button
                        type="button"
                        className="pb-button"
                        aria-label={`Resolve ${ALERT_LABEL[a.kind]} alert`}
                        onClick={() => resolve(a)}
                      >
                        Resolve
                      </button>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
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
      <PageTitle>
        <span id="audit-title">Platform audit</span>
      </PageTitle>
      <p className="muted">
        Staff sign-ins, searches, views, access decisions, overrides and resyncs (newest 200). Entries cannot
        be changed from here.
      </p>
      <form className="row" onSubmit={apply}>
        <label htmlFor="audit-org">Organization id</label>
        <input
          id="audit-org"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          pattern="org_[0-9A-HJKMNP-TV-Z]{26}"
          placeholder="All organizations"
          spellCheck={false}
        />
        <button type="submit" className="pb-button">
          Filter
        </button>
      </form>
      {staff.roles.includes('support_lead') && (
        <div className="row">
          <button type="button" className="pb-button" onClick={() => void exportChain()}>
            Export a verifiable copy
          </button>
          {exported && <span role="status">{exported}</span>}
        </div>
      )}
      <Problem text={problem} />
      {items && items.length === 0 && <p className="muted">No entries.</p>}
      {items && items.length > 0 && (
        <table>
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
                <td>{when(e.at)}</td>
                <td className="mono">
                  {e.actor_user_id === staff.user_id ? 'You' : (e.actor_user_id ?? '—')}
                </td>
                <td className="mono">{e.action}</td>
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
      )}
    </section>
  );
}
