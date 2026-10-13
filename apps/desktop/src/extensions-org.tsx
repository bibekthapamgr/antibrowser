/**
 * Organization extension policy (milestone 09, ADR-0016): owners and admins decide which browser extensions may be
 * used in organization profiles, see what members' computers reported, and approve updates that ask for more
 * access. The desktop applies the policy when a profile opens (warn, or enforce: extensions turned off for that
 * session). Installation always goes through the browser's supported paths; nothing here installs anything.
 */
import {
  EXTENSION_MODES,
  type ExtensionInventoryItem,
  type ExtensionMode,
  type ExtensionPolicy,
  type ExtensionRule,
  isSensitivePermission,
  judgeExtension,
  validVersionRange,
} from '@pb/contracts/agency';
import type { Role } from '@pb/contracts/resources';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Backend } from './backend/types.ts';
import { errorMessage } from './backend/types.ts';
import { can, get, send } from './cloud.ts';
import { verdictText } from './health.tsx';
import { type Notify, plural, relative } from './status.tsx';

const MODE_HELP: Record<ExtensionMode, string> = {
  off: 'Off: extensions are listed here, nothing is restricted.',
  warn: 'Warn: people are told when a profile has an extension you have not approved; it still runs.',
  enforce:
    'Enforce: a profile with an extension you have not approved (or an update asking for more access) opens with all extensions turned off until you approve it.',
};

const SOURCE_TEXT: Record<string, string> = {
  web_store: 'Chrome Web Store',
  policy: 'computer policy',
  external: 'another program',
  unpacked: 'developer folder',
  other: 'other',
};

export function OrgExtensionsSection(props: {
  backend: Backend;
  orgId: string;
  role: Role;
  notify: Notify;
  offline: boolean;
}) {
  const { backend, orgId, role, notify, offline } = props;
  const manage = can(role, 'extensions.manage');
  const [policy, setPolicy] = useState<ExtensionPolicy | null>(null);
  const [draft, setDraft] = useState<{ mode: ExtensionMode; rules: ExtensionRule[] } | null>(null);
  const [inventory, setInventory] = useState<ExtensionInventoryItem[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [nonce, setNonce] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: nonce reloads
  useEffect(() => {
    let live = true;
    get<ExtensionPolicy>(backend, `/v1/orgs/${orgId}/extension-policy`)
      .then((r) => {
        if (!live) return;
        setPolicy(r.data);
        setDraft({ mode: r.data.mode, rules: r.data.extensions });
      })
      .catch((e) => live && notify(errorMessage(e), 'error'));
    if (manage)
      get<{ items: ExtensionInventoryItem[] }>(backend, `/v1/orgs/${orgId}/extension-inventory`)
        .then((r) => live && setInventory(r.data.items))
        .catch((e) => live && notify(errorMessage(e), 'error'));
    return () => {
      live = false;
    };
  }, [backend, orgId, manage, nonce, notify]);

  const dirty = useMemo(
    () =>
      !!policy &&
      !!draft &&
      JSON.stringify({ mode: policy.mode, rules: policy.extensions }) !== JSON.stringify(draft),
    [policy, draft],
  );
  const invalid = draft?.rules.find(
    (r) => r.approved_version_range !== null && !validVersionRange(r.approved_version_range),
  );

  const setRule = useCallback(
    (id: string, change: Partial<ExtensionRule> | null, item?: ExtensionInventoryItem) => {
      setDraft((d) => {
        if (!d) return d;
        const rest = d.rules.filter((r) => r.extension_id !== id);
        if (change === null) return { ...d, rules: rest };
        const old = d.rules.find((r) => r.extension_id === id) ?? {
          extension_id: id,
          name: item?.name ?? '',
          decision: 'allowed' as const,
          source: 'web_store' as const,
          approved_version_range: null,
          permissions: item?.sensitive ?? [],
        };
        return { ...d, rules: [...rest, { ...old, ...change }].sort((a, b) => a.name.localeCompare(b.name)) };
      });
    },
    [],
  );

  const save = async () => {
    if (!policy || !draft) return;
    setSaving(true);
    try {
      const r = await send<ExtensionPolicy>(
        backend,
        'PUT',
        `/v1/orgs/${orgId}/extension-policy`,
        { mode: draft.mode, extensions: draft.rules },
        policy.version,
      );
      setPolicy(r.data);
      setDraft({ mode: r.data.mode, rules: r.data.extensions });
      notify('Extension policy saved. Computers apply it the next time a profile opens.');
    } catch (e) {
      notify(errorMessage(e), 'error');
      setNonce((n) => n + 1);
    } finally {
      setSaving(false);
    }
  };

  if (!policy || !draft) return <p role="status">Loading the extension policy…</p>;
  const ruleOf = (id: string) => draft.rules.find((r) => r.extension_id === id);
  const listed = new Set((inventory ?? []).map((i) => i.id));
  return (
    <section className="stack" aria-labelledby="org-extensions-title">
      <h2 id="org-extensions-title">Browser extensions</h2>
      <p className="muted small">
        Version {policy.version}
        {policy.updated_at ? `, changed ${relative(policy.updated_at).toLowerCase()}` : ''}. Extensions are
        installed the usual way (the Chrome Web Store, or a folder in developer mode); this app never installs
        them or bypasses the browser's checks. Each profile keeps its extensions and their data separate.
      </p>
      <fieldset disabled={!manage || offline}>
        <legend>Mode</legend>
        {EXTENSION_MODES.map((m) => (
          <label key={m} className="choice">
            <input
              type="radio"
              name="ext-mode"
              checked={draft.mode === m}
              onChange={() => setDraft({ ...draft, mode: m })}
            />
            <span>{MODE_HELP[m]}</span>
          </label>
        ))}
      </fieldset>

      {manage && inventory && (
        <section aria-labelledby="org-ext-inv">
          <h3 id="org-ext-inv">Reported by members' computers</h3>
          {inventory.length === 0 ? (
            <p className="muted small">
              Nothing reported yet. Computers report when organization profiles open and close.
            </p>
          ) : (
            <table className="simple records">
              <caption className="pb-sr-only">Extensions in organization profiles</caption>
              <thead>
                <tr>
                  <th scope="col">Extension</th>
                  <th scope="col">Where</th>
                  <th scope="col">Access</th>
                  <th scope="col">Policy</th>
                  <th scope="col">
                    <span className="pb-sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {inventory.map((i) => {
                  const rule = ruleOf(i.id);
                  const verdicts = i.versions.map((v) =>
                    judgeExtension(draft.rules, {
                      id: i.id,
                      version: v,
                      source: (i.sources[0] ?? 'other') as 'web_store',
                      permissions: i.permissions,
                    }),
                  );
                  const worst = verdicts.find((v) => v.status !== 'approved') ?? verdicts[0];
                  return (
                    <tr key={i.id}>
                      <th scope="row">
                        {i.name}
                        <div className="muted small mono">{i.id}</div>
                        <div className="muted small">
                          {i.versions.join(', ')} · {i.sources.map((s) => SOURCE_TEXT[s] ?? s).join(', ')}
                        </div>
                      </th>
                      <td>
                        {plural(i.profiles, 'profile')} on {plural(i.devices, 'computer')}
                        <div className="muted small">
                          reported {relative(i.last_reported_at).toLowerCase()}
                        </div>
                      </td>
                      <td>
                        {i.sensitive.length ? (
                          i.sensitive.join(', ')
                        ) : (
                          <span className="muted">Nothing sensitive</span>
                        )}
                      </td>
                      <td>{worst ? verdictText(worst) : '—'}</td>
                      <td>
                        <div className="cell-actions">
                          <button
                            type="button"
                            className="pb-button"
                            disabled={!manage || offline}
                            onClick={() =>
                              setRule(
                                i.id,
                                {
                                  decision: 'allowed',
                                  name: i.name,
                                  permissions: [...new Set([...(rule?.permissions ?? []), ...i.sensitive])],
                                  source: i.sources.every((s) => s === 'web_store') ? 'web_store' : 'any',
                                },
                                i,
                              )
                            }
                          >
                            {rule?.decision === 'allowed' ? 'Approve its access' : 'Allow'}
                            <span className="pb-sr-only"> {i.name}</span>
                          </button>
                          <button
                            type="button"
                            className="pb-button"
                            disabled={!manage || offline}
                            onClick={() => setRule(i.id, { decision: 'blocked', name: i.name }, i)}
                          >
                            Block<span className="pb-sr-only"> {i.name}</span>
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </section>
      )}

      <section aria-labelledby="org-ext-rules">
        <h3 id="org-ext-rules">Rules</h3>
        {draft.rules.length === 0 ? (
          <p className="muted small">
            No rules: in warn and enforce mode every extension counts as not approved.
          </p>
        ) : (
          <ul className="rule-list">
            {draft.rules.map((r) => (
              <li key={r.extension_id}>
                <strong>{r.name || r.extension_id}</strong>
                {!listed.has(r.extension_id) && (
                  <span className="muted small"> (not reported by any computer)</span>
                )}
                <div className="row wrap small">
                  <label>
                    Decision
                    <select
                      value={r.decision}
                      disabled={!manage || offline}
                      onChange={(e) =>
                        setRule(r.extension_id, { decision: e.target.value as 'allowed' | 'blocked' })
                      }
                    >
                      <option value="allowed">Allowed</option>
                      <option value="blocked">Blocked</option>
                    </select>
                  </label>
                  <label>
                    From
                    <select
                      value={r.source}
                      disabled={!manage || offline || r.decision === 'blocked'}
                      onChange={(e) =>
                        setRule(r.extension_id, { source: e.target.value as 'web_store' | 'any' })
                      }
                    >
                      <option value="web_store">Chrome Web Store only</option>
                      <option value="any">Any supported source</option>
                    </select>
                  </label>
                  <label>
                    Approved versions
                    <input
                      value={r.approved_version_range ?? ''}
                      placeholder="any (e.g. >=4 <5, 4.2.*)"
                      maxLength={64}
                      disabled={!manage || offline || r.decision === 'blocked'}
                      aria-invalid={
                        r.approved_version_range !== null && !validVersionRange(r.approved_version_range)
                      }
                      onChange={(e) =>
                        setRule(r.extension_id, {
                          approved_version_range: e.target.value.trim() ? e.target.value : null,
                        })
                      }
                    />
                  </label>
                  {manage && (
                    <button
                      type="button"
                      className="link-button"
                      disabled={offline}
                      onClick={() => setRule(r.extension_id, null)}
                    >
                      Remove rule<span className="pb-sr-only"> ({r.name || r.extension_id})</span>
                    </button>
                  )}
                </div>
                {r.decision === 'allowed' && (
                  <div className="muted small">
                    Approved access:{' '}
                    {r.permissions.filter(isSensitivePermission).join(', ') || 'nothing sensitive'}. An update
                    asking for more waits for your approval.
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
      {manage && (
        <div className="row">
          {invalid && (
            <p role="alert" className="error small grow">
              The version range for {invalid.name || invalid.extension_id} is not valid. Use forms like 1.2.3,
              1.2.* or &gt;=1.2 &lt;2.
            </p>
          )}
          <button
            type="button"
            className="pb-button"
            data-variant="primary"
            disabled={!dirty || saving || offline || !!invalid}
            onClick={() => void save()}
          >
            {saving ? 'Saving…' : 'Save policy'}
          </button>
          <button
            type="button"
            className="pb-button"
            disabled={!dirty || saving}
            onClick={() => setDraft({ mode: policy.mode, rules: policy.extensions })}
          >
            Undo changes
          </button>
        </div>
      )}
    </section>
  );
}
