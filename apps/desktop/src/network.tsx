/**
 * Milestone 05: proxies (list, add/edit, connection test, check history, expiry), per-profile routing and
 * privacy/environment settings, the credential prompt and the bulk "Set proxy" dialog.
 *
 * Wording rules: a proxy changes the network path a profile uses; presets are configuration and QA shortcuts.
 * Nothing here claims to make a profile undetectable or safe from bans.
 */
import { type FormEvent, useEffect, useId, useMemo, useState } from 'react';
import type {
  Backend,
  BulkAction,
  FieldReport,
  NetworkCheck,
  PrivacyConfig,
  PrivacyOptions,
  PrivacyValidation,
  ProfileView,
  ProxyEdit,
  ProxyInput,
  ProxyView,
} from './backend/types.ts';
import { errorMessage, isIpcError } from './backend/types.ts';
import { Dialog } from './components.tsx';
import { parseProxyLine } from './proxy-line.ts';
import { type Notify, when } from './status.tsx';

// ---------------------------------------------------------------------------------------------- shared
/** What went wrong, and what to do about it, for each error a proxy check or launch can report. */
export const PROXY_ERROR_HELP: Record<string, string> = {
  PROXY_DNS_FAILED: "The proxy's host name could not be found. Check the spelling, or use its IP address.",
  PROXY_UNREACHABLE:
    'Nothing answered at this address and port. Check them, and that the proxy is online and accepts connections from this computer.',
  PROXY_TIMEOUT: 'The proxy did not answer in time. It may be overloaded or blocking this computer.',
  PROXY_TLS_FAILED:
    "The proxy's certificate could not be verified. Check the type (HTTP or HTTPS) and that the address matches its certificate.",
  PROXY_AUTH_REQUIRED: 'The proxy needs a login. Add the username and password from your provider.',
  PROXY_AUTH_FAILED: 'The proxy rejected the username or password. Check them with your provider.',
  PROXY_AUTH_UNSUPPORTED:
    'The proxy only offers a login method this app does not support. HTTP proxies need Basic login; SOCKS5 needs username and password.',
  PROXY_PROTOCOL_ERROR:
    'The proxy answered in an unexpected way. Check the proxy type (HTTP, HTTPS or SOCKS5).',
  PROXY_TARGET_FAILED: 'The proxy works, but it could not reach the check service.',
  PROXY_TARGET_BLOCKED: 'The proxy works, but it refused to connect to the check service.',
  PROXY_PRIVATE_ADDRESS:
    'This proxy is on this computer or your local network. Allow local proxies in Settings to use it.',
  PROXY_FORBIDDEN_ADDRESS: 'This address can never be used for a proxy.',
  PROXY_CREDENTIALS_MISSING:
    "The saved login is missing from this computer's secure storage. Enter it again.",
  CHECK_FAILED: 'The check service answered in an unexpected way. Try again later.',
};
export const proxyErrorText = (code: string | null | undefined) =>
  (code && PROXY_ERROR_HELP[code]) ?? 'The proxy did not work.';

const TYPE_LABEL: Record<ProxyView['type'], string> = { http: 'HTTP', https: 'HTTPS', socks5: 'SOCKS5' };

const timeOf = (iso: string) => when(iso);

export function CheckResult({ check }: { check: NetworkCheck | null }) {
  if (!check) return <span className="muted">Not tested yet</span>;
  if (check.result === 'ok')
    return (
      <span className="check">
        <span>
          <span className="ok">Working</span> · {check.latency_ms} ms
        </span>{' '}
        <span>
          exit address <span className="mono">{check.egress_ip ?? 'unknown'}</span>
        </span>{' '}
        <span className="muted small">{timeOf(check.checked_at)}</span>
      </span>
    );
  return (
    <span className="check">
      <span>
        <span className="error">Failed</span> · {proxyErrorText(check.error_code)}
      </span>{' '}
      <span className="muted small">{timeOf(check.checked_at)}</span>
    </span>
  );
}

export function ExpiryBadge({ proxy }: { proxy: ProxyView }) {
  if (proxy.expiry === 'expired')
    return <span className="badge badge--error">Expired {proxy.expires_at}</span>;
  if (proxy.expiry === 'expires_soon')
    return (
      <span className="badge badge--warn">
        {proxy.days_left === 0 ? 'Expires today' : `Expires in ${proxy.days_left} d`}
      </span>
    );
  return proxy.expires_at ? <span className="muted small">Until {proxy.expires_at}</span> : null;
}

// ---------------------------------------------------------------------------------------------- proxies screen
export function ProxiesScreen(props: { backend: Backend; refreshKey: number; notify: Notify }) {
  const { backend, notify } = props;
  const [proxies, setProxies] = useState<ProxyView[] | null>(null);
  const [nonce, setNonce] = useState(0);
  const [editing, setEditing] = useState<ProxyView | 'new' | null>(null);
  const [history, setHistory] = useState<ProxyView | null>(null);
  const [deleting, setDeleting] = useState<ProxyView | null>(null);
  const [testing, setTesting] = useState<Set<string>>(new Set());
  const reload = () => setNonce((n) => n + 1);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey and nonce reload the list
  useEffect(() => {
    let live = true;
    backend.network
      .proxies()
      .then((p) => live && setProxies(p))
      .catch((e) => live && notify(errorMessage(e, 'Could not load proxies.'), 'error'));
    return () => {
      live = false;
    };
  }, [backend, notify, props.refreshKey, nonce]);

  const test = async (p: ProxyView) => {
    setTesting((t) => new Set(t).add(p.id));
    try {
      const c = await backend.network.testProxy(p.id);
      notify(
        c.result === 'ok'
          ? `${p.name} works: ${c.latency_ms} ms, exit address ${c.egress_ip ?? 'unknown'}.`
          : `${p.name}: ${proxyErrorText(c.error_code)}`,
        c.result === 'ok' ? 'info' : 'error',
      );
      if (c.error_code === 'PROXY_CREDENTIALS_MISSING') setEditing(p);
    } catch (e) {
      notify(errorMessage(e), 'error');
    }
    setTesting((t) => {
      const n = new Set(t);
      n.delete(p.id);
      return n;
    });
    reload();
  };

  return (
    <section className="screen proxies" aria-labelledby="proxies-title">
      <header className="toolbar">
        <div className="toolbar__title">
          <h1 id="proxies-title">Proxies</h1>
          <p className="muted small">
            A proxy changes the network path a profile uses. It does not make a profile undetectable.
          </p>
        </div>
        <button type="button" className="pb-button" data-variant="primary" onClick={() => setEditing('new')}>
          Add proxy
        </button>
      </header>
      <p className="muted small">
        Logins are kept in this computer's secure storage (Keychain or Credential Manager) and are never
        shown, exported or written to logs. Checks are started by you and contact a test service through the
        proxy to measure the delay and see the exit address; results are kept for 7 days.
      </p>

      {proxies === null ? (
        <p role="status">Loading…</p>
      ) : proxies.length === 0 ? (
        <div className="card">
          <h2>No proxies yet</h2>
          <p>
            Add the proxies your provider gave you, then assign them to profiles in each profile's settings.
          </p>
        </div>
      ) : (
        <table className="simple proxy-table">
          <caption className="pb-sr-only">Proxies in this workspace</caption>
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Address</th>
              <th scope="col">Login</th>
              <th scope="col">Profiles</th>
              <th scope="col">Last check</th>
              <th scope="col">Expiry</th>
              <th scope="col">
                <span className="pb-sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {proxies.map((p) => (
              <tr key={p.id}>
                <th scope="row">{p.name}</th>
                <td>
                  <span className="badge">{TYPE_LABEL[p.type]}</span>{' '}
                  <span className="mono address">
                    {p.host.includes(':') ? `[${p.host}]` : p.host}:{p.port}
                  </span>
                </td>
                <td>{p.has_login ? 'Saved' : <span className="muted">None</span>}</td>
                <td>{p.profiles}</td>
                <td>
                  <CheckResult check={p.last_check} />
                </td>
                <td>
                  <ExpiryBadge proxy={p} />
                </td>
                <td>
                  <div className="proxy-actions">
                    <button
                      type="button"
                      className="pb-button"
                      disabled={testing.has(p.id)}
                      onClick={() => void test(p)}
                    >
                      {testing.has(p.id) ? 'Testing…' : 'Test'}
                      <span className="pb-sr-only"> {p.name}</span>
                    </button>
                    <button type="button" className="pb-button" onClick={() => setEditing(p)}>
                      Edit<span className="pb-sr-only"> {p.name}</span>
                    </button>
                    <button type="button" className="pb-button" onClick={() => setHistory(p)}>
                      History<span className="pb-sr-only"> of {p.name}</span>
                    </button>
                    <button type="button" className="pb-button" onClick={() => setDeleting(p)}>
                      Delete<span className="pb-sr-only"> {p.name}</span>
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {editing && (
        <ProxyDialog
          backend={backend}
          proxy={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(p) => {
            notify(editing === 'new' ? `Proxy “${p.name}” added.` : `Proxy “${p.name}” saved.`);
            setEditing(null);
            reload();
          }}
        />
      )}
      {history && <ChecksDialog backend={backend} proxy={history} onClose={() => setHistory(null)} />}
      {deleting && (
        <Dialog
          role="alertdialog"
          title={`Delete “${deleting.name}”?`}
          description={
            deleting.profiles > 0
              ? `${deleting.profiles} profile(s) use this proxy. Give them another proxy (or none) first; a profile never loses its proxy silently.`
              : 'The proxy, its saved login and its check history are removed from this computer.'
          }
          onClose={() => setDeleting(null)}
          initialFocus="[data-cancel]"
        >
          <div className="row row--end">
            <button type="button" className="pb-button" data-cancel onClick={() => setDeleting(null)}>
              {deleting.profiles > 0 ? 'OK' : 'Cancel'}
            </button>
            {deleting.profiles === 0 && (
              <button
                type="button"
                className="pb-button"
                data-variant="danger"
                onClick={async () => {
                  try {
                    await backend.network.deleteProxy(deleting.id);
                    notify(`Proxy “${deleting.name}” deleted.`);
                  } catch (e) {
                    notify(errorMessage(e), 'error');
                  }
                  setDeleting(null);
                  reload();
                }}
              >
                Delete proxy
              </button>
            )}
          </div>
        </Dialog>
      )}
    </section>
  );
}

type LoginMode = 'keep' | 'set' | 'remove';

/** Add or edit a proxy. The password field is never filled from saved data. */
export function ProxyDialog(props: {
  backend: Backend;
  proxy: ProxyView | null;
  /** Only ask for the login again (the saved one is missing). */
  loginOnly?: boolean;
  onClose: () => void;
  onSaved: (p: ProxyView) => void;
}) {
  const p = props.proxy;
  const [name, setName] = useState(p?.name ?? '');
  const [type, setType] = useState<ProxyView['type']>(p?.type ?? 'http');
  const [host, setHost] = useState(p?.host ?? '');
  const [port, setPort] = useState(p ? String(p.port) : '');
  const [loginMode, setLoginMode] = useState<LoginMode>(p?.has_login && !props.loginOnly ? 'keep' : 'set');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [expires, setExpires] = useState(p?.expires_at ?? '');
  const [notes, setNotes] = useState(p?.notes ?? '');
  const [paste, setPaste] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pasteHelp = useId();

  const applyPaste = () => {
    const parsed = parseProxyLine(paste);
    if (!parsed) {
      setError('That line was not recognised. Enter the fields below instead.');
      return;
    }
    setError(null);
    if (parsed.type) setType(parsed.type);
    if (parsed.host) setHost(parsed.host);
    if (parsed.port) setPort(String(parsed.port));
    if (parsed.username !== undefined) {
      setLoginMode('set');
      setUsername(parsed.username);
      setPassword(parsed.password ?? '');
    }
    setPaste('');
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    const login = loginMode === 'set' && username ? { username, password } : undefined;
    try {
      if (p) {
        const changes: ProxyEdit = {
          ...(name !== p.name ? { name } : {}),
          ...(type !== p.type ? { type } : {}),
          ...(host !== p.host ? { host } : {}),
          ...(Number(port) !== p.port ? { port: Number(port) } : {}),
          ...(login ? { login } : {}),
          ...(loginMode === 'remove' ? { remove_login: true } : {}),
          ...(expires && expires !== p.expires_at ? { expires_at: expires } : {}),
          ...(!expires && p.expires_at ? { clear_expiry: true } : {}),
          ...(notes !== p.notes ? { notes } : {}),
        };
        props.onSaved(await props.backend.network.updateProxy(p.id, p.version, changes));
      } else {
        const input: ProxyInput = {
          name,
          type,
          host,
          port: Number(port),
          ...(login ? { login } : {}),
          ...(expires ? { expires_at: expires } : {}),
          ...(notes ? { notes } : {}),
        };
        props.onSaved(await props.backend.network.createProxy(input));
      }
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <Dialog
      title={props.loginOnly ? `Enter the login for “${p?.name}”` : p ? `Edit “${p.name}”` : 'Add proxy'}
      description={
        props.loginOnly
          ? "The saved login is missing from this computer's secure storage (it may have been removed there, or the system cleared it). Enter it again to keep using this proxy."
          : undefined
      }
      onClose={props.onClose}
      initialFocus="input"
      wide
    >
      <form className="stack" onSubmit={submit} aria-label={p ? 'Edit proxy' : 'Add proxy'}>
        {!props.loginOnly && (
          <>
            <div className="row">
              <label className="grow">
                Paste a proxy line (optional)
                <input
                  value={paste}
                  spellCheck={false}
                  autoComplete="off"
                  aria-describedby={pasteHelp}
                  placeholder="host:port:username:password"
                  onChange={(e) => setPaste(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      applyPaste();
                    }
                  }}
                />
              </label>
              <button type="button" className="pb-button" disabled={!paste.trim()} onClick={applyPaste}>
                Fill in
              </button>
            </div>
            <p id={pasteHelp} className="muted small">
              Fills the fields below from host:port, host:port:username:password or user:pass@host:port. The
              line itself is not saved.
            </p>
            <label>
              Name
              <input required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <div className="row">
              <label>
                Type
                <select value={type} onChange={(e) => setType(e.target.value as ProxyView['type'])}>
                  <option value="http">HTTP</option>
                  <option value="https">HTTPS (TLS to the proxy)</option>
                  <option value="socks5">SOCKS5</option>
                </select>
              </label>
              <label className="grow">
                Host name or IP address
                <input
                  required
                  maxLength={255}
                  spellCheck={false}
                  autoComplete="off"
                  value={host}
                  onChange={(e) => setHost(e.target.value)}
                />
              </label>
              <label>
                Port
                <input
                  required
                  inputMode="numeric"
                  pattern="[0-9]{1,5}"
                  maxLength={5}
                  size={6}
                  value={port}
                  onChange={(e) => setPort(e.target.value)}
                />
              </label>
            </div>
          </>
        )}
        <fieldset>
          <legend>Login</legend>
          {p?.has_login && !props.loginOnly && (
            <div className="row">
              {(
                [
                  ['keep', 'Keep the saved login'],
                  ['set', 'Replace it'],
                  ['remove', 'Remove it'],
                ] as const
              ).map(([v, label]) => (
                <label key={v} className="choice">
                  <input
                    type="radio"
                    name="login-mode"
                    checked={loginMode === v}
                    onChange={() => setLoginMode(v)}
                  />
                  {label}
                </label>
              ))}
            </div>
          )}
          {loginMode === 'set' && (
            <div className="row">
              <label className="grow">
                Username
                <input
                  autoComplete="off"
                  spellCheck={false}
                  maxLength={255}
                  required={Boolean(props.loginOnly)}
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                />
              </label>
              <label className="grow">
                Password
                <input
                  type="password"
                  autoComplete="new-password"
                  maxLength={255}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </label>
            </div>
          )}
          <p className="muted small">
            Stored only in this computer's secure storage. HTTP and HTTPS proxies use Basic login; SOCKS5 uses
            username and password. Leave empty for a proxy without a login.
          </p>
        </fieldset>
        {!props.loginOnly && (
          <>
            <label>
              Expires on (optional, for reminders)
              <input type="date" value={expires} onChange={(e) => setExpires(e.target.value)} />
            </label>
            <label>
              Notes
              <textarea rows={2} maxLength={500} value={notes} onChange={(e) => setNotes(e.target.value)} />
            </label>
          </>
        )}
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <div className="row row--end">
          <button type="button" className="pb-button" onClick={props.onClose}>
            Cancel
          </button>
          <button type="submit" className="pb-button" data-variant="primary" disabled={busy}>
            {props.loginOnly ? 'Save login' : p ? 'Save proxy' : 'Add proxy'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function ChecksDialog(props: { backend: Backend; proxy: ProxyView; onClose: () => void }) {
  const [checks, setChecks] = useState<NetworkCheck[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    props.backend.network
      .checks(props.proxy.id)
      .then(setChecks)
      .catch((e) => setError(errorMessage(e)));
  }, [props.backend, props.proxy.id]);
  return (
    <Dialog
      title={`Checks of “${props.proxy.name}”`}
      description="Checks you started in the last 7 days (older ones are deleted automatically)."
      onClose={props.onClose}
      wide
    >
      {error && <p className="error">{error}</p>}
      {checks === null ? (
        <p role="status">Loading…</p>
      ) : checks.length === 0 ? (
        <p className="muted">No checks yet.</p>
      ) : (
        <div className="scroll-box">
          <table className="simple">
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">Result</th>
                <th scope="col">Delay</th>
                <th scope="col">Exit address</th>
              </tr>
            </thead>
            <tbody>
              {checks.map((c) => (
                <tr key={c.id}>
                  <td>{timeOf(c.checked_at)}</td>
                  <td>
                    {c.result === 'ok' ? (
                      <span className="ok">Working</span>
                    ) : (
                      <span className="error">{proxyErrorText(c.error_code)}</span>
                    )}
                  </td>
                  <td>{c.latency_ms !== null ? `${c.latency_ms} ms` : '—'}</td>
                  <td className="mono">{c.egress_ip ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="row row--end">
        <button type="button" className="pb-button" onClick={props.onClose}>
          Close
        </button>
      </div>
    </Dialog>
  );
}

/** Asks for a proxy's login again after a launch failed with PROXY_CREDENTIALS_MISSING, then retries. */
export function CredentialPrompt(props: {
  backend: Backend;
  proxyId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [proxy, setProxy] = useState<ProxyView | null>(null);
  useEffect(() => {
    props.backend.network
      .proxies()
      .then((list) => setProxy(list.find((p) => p.id === props.proxyId) ?? null))
      .catch(() => setProxy(null));
  }, [props.backend, props.proxyId]);
  if (!proxy) return null;
  return (
    <ProxyDialog
      backend={props.backend}
      proxy={proxy}
      loginOnly
      onClose={props.onClose}
      onSaved={() => props.onSaved()}
    />
  );
}

// ---------------------------------------------------------------------------------------------- table cell
export function NetworkCell({ p }: { p: ProfileView }) {
  if (!p.proxy_label) return <span className="muted">—</span>;
  const s = p.network.status;
  const badges = [
    s === 'failing' && (
      <span key="f" className="badge badge--error">
        Blocked
      </span>
    ),
    s === 'bypassing' && (
      <span key="b" className="badge badge--warn">
        Direct
      </span>
    ),
    s === 'lost' && (
      <span key="l" className="badge badge--error">
        Reopen
      </span>
    ),
    p.network.restart_required && (
      <span key="r" className="badge">
        Restart
      </span>
    ),
  ].filter(Boolean);
  return (
    <span className="network-cell">
      {p.proxy_label}
      {badges}
    </span>
  );
}

const NETWORK_STATUS: Record<ProfileView['network']['status'], string> = {
  off: 'No proxy: the profile uses this computer’s own connection.',
  ready: 'Assigned. It is used when the profile opens.',
  active: 'In use. All of this profile’s traffic goes through the proxy.',
  failing: 'The proxy is not working. Traffic is blocked, not sent without the proxy.',
  bypassing:
    'The proxy is not working. Fail-closed is off, so traffic is going through this computer’s own connection.',
  lost: 'The manager restarted and could not restore this profile’s proxy connection. Close and reopen the profile.',
};

// ---------------------------------------------------------------------------------------------- drawer: network
export function NetworkSection(props: {
  backend: Backend;
  profile: ProfileView;
  notify: Notify;
  onSaved: (p: ProfileView) => void;
  onOpenProxies?: () => void;
}) {
  const { backend, profile: p, notify } = props;
  const [proxies, setProxies] = useState<ProxyView[] | null>(null);
  const [proxyId, setProxyId] = useState(p.proxy_id ?? '');
  const [failClosed, setFailClosed] = useState(p.fail_closed);
  const [error, setError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const help = useId();

  useEffect(() => {
    backend.network
      .proxies()
      .then(setProxies)
      .catch(() => setProxies([]));
  }, [backend]);
  useEffect(() => {
    setProxyId(p.proxy_id ?? '');
    setFailClosed(p.fail_closed);
  }, [p.proxy_id, p.fail_closed]);

  const dirty = proxyId !== (p.proxy_id ?? '') || failClosed !== p.fail_closed;
  const open = p.state !== 'stopped' && p.state !== 'crashed';
  const chosen = proxies?.find((x) => x.id === proxyId) ?? null;

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      const saved = await backend.network.assign(p.id, proxyId || null, failClosed, p.version);
      props.onSaved(saved);
      notify(
        open
          ? 'Network settings saved. They apply the next time the profile opens.'
          : 'Network settings saved.',
      );
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const test = async () => {
    if (!chosen) return;
    setTesting(true);
    try {
      const c = await backend.network.testProxy(chosen.id);
      notify(
        c.result === 'ok'
          ? `${chosen.name} works: ${c.latency_ms} ms, exit address ${c.egress_ip ?? 'unknown'}.`
          : `${chosen.name}: ${proxyErrorText(c.error_code)}`,
        c.result === 'ok' ? 'info' : 'error',
      );
      setProxies(await backend.network.proxies());
    } catch (err) {
      notify(errorMessage(err), 'error');
    }
    setTesting(false);
  };

  return (
    <form className="stack" onSubmit={save} aria-label="Network">
      <fieldset disabled={Boolean(p.trashed_at)}>
        <legend>Network</legend>
        <p className={p.network.status === 'failing' || p.network.status === 'lost' ? 'warn small' : 'small'}>
          {NETWORK_STATUS[p.network.status]}
          {p.network.last_error && p.network.status !== 'active' && (
            <> {proxyErrorText(p.network.last_error)}</>
          )}
        </p>
        {p.network.restart_required && (
          <p className="notice small" role="status">
            The settings changed while the profile was open. Close and reopen it to use them; until then it
            keeps its current connection.
          </p>
        )}
        <label>
          Proxy
          <select value={proxyId} onChange={(e) => setProxyId(e.target.value)}>
            <option value="">No proxy (this computer’s connection)</option>
            {proxies?.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name} · {TYPE_LABEL[x.type]}
                {x.expiry === 'expired' ? ' (expired)' : ''}
              </option>
            ))}
          </select>
        </label>
        {chosen && (
          <p className="small">
            <CheckResult check={chosen.last_check} />{' '}
            <button type="button" className="link-button" disabled={testing} onClick={() => void test()}>
              {testing ? 'Testing…' : 'Test now'}
            </button>
          </p>
        )}
        {proxies?.length === 0 && (
          <p className="muted small">
            No proxies yet.{' '}
            {props.onOpenProxies && (
              <button type="button" className="link-button" onClick={props.onOpenProxies}>
                Add one in Proxies
              </button>
            )}
          </p>
        )}
        <label className="choice">
          <input
            type="checkbox"
            checked={failClosed}
            aria-describedby={help}
            disabled={!proxyId}
            onChange={(e) => setFailClosed(e.target.checked)}
          />
          Fail closed: block traffic when the proxy does not work
        </label>
        <p id={help} className="muted small">
          {failClosed
            ? 'Recommended. If the proxy stops working, pages fail instead of loading through this computer’s own connection. WebRTC (calls) can then use only the proxy.'
            : 'If the proxy cannot be reached, pages load through this computer’s own connection and the profile shows “Direct”. Login, certificate and address problems still block.'}
        </p>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <button type="submit" className="pb-button" data-variant="primary" disabled={!dirty}>
          Save network settings
        </button>
      </fieldset>
    </form>
  );
}

// ---------------------------------------------------------------------------------------------- drawer: privacy
const fullConfig = (c: PrivacyConfig): Required<PrivacyConfig> => ({
  webrtc: c.webrtc ?? 'default',
  block_third_party_cookies: c.block_third_party_cookies ?? false,
  do_not_track: c.do_not_track ?? false,
  language: c.language ?? null,
  timezone: c.timezone ?? null,
  window: c.window ?? null,
  text_size: c.text_size ?? 'default',
  reduced_motion: c.reduced_motion ?? false,
  preset: c.preset ?? null,
});

const SUPPORT_LABEL: Record<FieldReport['support'], string> = {
  applied: '',
  partial: 'Partly applied: ',
  unavailable: 'Not available on this computer: ',
};

function FieldNote({ report, field }: { report: FieldReport[]; field: string }) {
  const r = report.find((x) => x.field === field);
  if (!r) return null;
  return (
    <p className={r.support === 'applied' ? 'muted small' : 'warn small'} data-support={r.support}>
      {SUPPORT_LABEL[r.support]}
      {r.message}
    </p>
  );
}

export function PrivacySection(props: {
  backend: Backend;
  profile: ProfileView;
  notify: Notify;
  onSaved: (p: ProfileView) => void;
}) {
  const { backend, profile: p, notify } = props;
  const [options, setOptions] = useState<PrivacyOptions | null>(null);
  const [config, setConfig] = useState(() => fullConfig(p.privacy));
  const [validation, setValidation] = useState<PrivacyValidation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const failClosedProxy = Boolean(p.proxy_id) && p.fail_closed;
  const saved = useMemo(() => JSON.stringify(fullConfig(p.privacy)), [p.privacy]);
  const dirty = JSON.stringify(config) !== saved;

  useEffect(() => {
    backend.network
      .privacyOptions()
      .then(setOptions)
      .catch(() => setOptions(null));
  }, [backend]);
  useEffect(() => setConfig(JSON.parse(saved) as Required<PrivacyConfig>), [saved]);
  useEffect(() => {
    let live = true;
    const t = setTimeout(() => {
      backend.network
        .validatePrivacy(config, failClosedProxy)
        .then((v) => live && setValidation(v))
        .catch(() => undefined);
    }, 150);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [backend, config, failClosedProxy]);

  const set = <K extends keyof PrivacyConfig>(k: K, v: Required<PrivacyConfig>[K]) =>
    setConfig((c) => ({ ...c, [k]: v, preset: null }));
  const report = validation?.report ?? [];

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      const updated = await backend.profiles.update(p.id, { expectedVersion: p.version, privacy: config });
      props.onSaved(updated);
      notify(
        p.state === 'stopped' || p.state === 'crashed'
          ? 'Privacy and environment settings saved.'
          : 'Saved. They apply the next time the profile opens.',
      );
    } catch (err) {
      setError(isIpcError(err) ? err.message : errorMessage(err));
    }
  };

  const windowText = config.window ? `${config.window.width}x${config.window.height}` : '';
  const presets = options?.presets ?? [];

  return (
    <form className="stack" onSubmit={save} aria-label="Privacy and environment">
      <fieldset disabled={Boolean(p.trashed_at)}>
        <legend>Privacy and environment</legend>
        <p className="muted small">
          Settings the browser itself supports, for privacy and for checking pages in a given language, time
          zone or window size. They do not make the profile look like a different device, and nothing is
          randomised.
        </p>
        <label>
          Preset
          <select
            value={config.preset ?? ''}
            onChange={(e) => {
              const pr = presets.find((x) => x.id === e.target.value);
              if (pr) setConfig(fullConfig(pr.config));
            }}
          >
            <option value="">{config.preset ? 'Custom' : 'Custom (choose a preset to fill in)'}</option>
            {presets.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
          </select>
        </label>
        {config.preset && (
          <p className="muted small">{presets.find((x) => x.id === config.preset)?.description}</p>
        )}
        <label>
          Page language
          <select value={config.language ?? ''} onChange={(e) => set('language', e.target.value || null)}>
            <option value="">Browser default</option>
            {options?.languages.map((l) => (
              <option key={l.tag} value={l.tag}>
                {l.name}
              </option>
            ))}
          </select>
        </label>
        <FieldNote report={report} field="language" />
        <label>
          Time zone
          <select value={config.timezone ?? ''} onChange={(e) => set('timezone', e.target.value || null)}>
            <option value="">This computer’s time zone</option>
            {options?.time_zones.map((z) => (
              <option key={z} value={z}>
                {z.replaceAll('_', ' ')}
              </option>
            ))}
          </select>
        </label>
        <FieldNote report={report} field="timezone" />
        <label>
          Window size when opening
          <select
            value={windowText}
            onChange={(e) => {
              const [w, h] = e.target.value.split('x').map(Number);
              set('window', w && h ? { width: w, height: h } : null);
            }}
          >
            <option value="">Browser default</option>
            {['1280x800', '1366x768', '1440x900', '1536x864', '1920x1080', '2560x1440']
              .concat(
                windowText &&
                  !['1280x800', '1366x768', '1440x900', '1536x864', '1920x1080', '2560x1440'].includes(
                    windowText,
                  )
                  ? [windowText]
                  : [],
              )
              .map((v) => (
                <option key={v} value={v}>
                  {v.replace('x', ' × ')}
                </option>
              ))}
          </select>
        </label>
        <FieldNote report={report} field="window" />
        <label>
          Text size
          <select
            value={config.text_size}
            onChange={(e) => set('text_size', e.target.value as Required<PrivacyConfig>['text_size'])}
          >
            <option value="default">Default</option>
            <option value="large">Large</option>
            <option value="larger">Larger</option>
          </select>
        </label>
        <label className="choice">
          <input
            type="checkbox"
            checked={config.reduced_motion}
            onChange={(e) => set('reduced_motion', e.target.checked)}
          />
          Tell pages to reduce motion
        </label>
        <label>
          WebRTC address sharing (calls and live video)
          <select
            value={failClosedProxy ? 'disable_non_proxied_udp' : config.webrtc}
            disabled={failClosedProxy}
            onChange={(e) => set('webrtc', e.target.value as Required<PrivacyConfig>['webrtc'])}
          >
            <option value="default">Browser default</option>
            <option value="public_interface_only">Only the public address</option>
            <option value="disable_non_proxied_udp">Only through the proxy</option>
          </select>
        </label>
        <FieldNote report={report} field="webrtc" />
        <label className="choice">
          <input
            type="checkbox"
            checked={config.block_third_party_cookies}
            onChange={(e) => set('block_third_party_cookies', e.target.checked)}
          />
          Block third-party cookies
        </label>
        <FieldNote report={report} field="block_third_party_cookies" />
        <label className="choice">
          <input
            type="checkbox"
            checked={config.do_not_track}
            onChange={(e) => set('do_not_track', e.target.checked)}
          />
          Send “Do Not Track”
        </label>
        <p className="muted small">
          Camera, microphone and location are under Website permissions above. Websites cannot use them unless
          you allow it: “Ask each time” shows a prompt, “Block” refuses without asking.
        </p>
        {(error || (validation && !validation.valid)) && (
          <p role="alert" className="error">
            {error ?? validation?.error?.message}
          </p>
        )}
        <button
          type="submit"
          className="pb-button"
          data-variant="primary"
          disabled={!dirty || validation?.valid === false}
        >
          Save privacy settings
        </button>
      </fieldset>
    </form>
  );
}

// ---------------------------------------------------------------------------------------------- bulk
export function SetProxyDialog(props: {
  backend: Backend;
  count: number;
  onClose: () => void;
  onSubmit: (a: BulkAction) => Promise<void>;
}) {
  const [proxies, setProxies] = useState<ProxyView[] | null>(null);
  const [choice, setChoice] = useState('');
  const [failClosed, setFailClosed] = useState(true);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    props.backend.network
      .proxies()
      .then((list) => {
        setProxies(list);
        setChoice(list[0]?.id ?? '');
      })
      .catch((e) => setError(errorMessage(e)));
  }, [props.backend]);
  return (
    <Dialog
      title={`Set the proxy of ${props.count.toLocaleString()} profile(s)`}
      description="Open profiles keep their current connection until they are reopened. You can undo this."
      onClose={props.onClose}
      initialFocus="select"
    >
      <form
        className="stack"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            await props.onSubmit({ action: 'set_proxy', proxy_id: choice || null, fail_closed: failClosed });
          } catch (err) {
            setError(errorMessage(err));
          }
        }}
      >
        <label>
          Proxy
          <select value={choice} onChange={(e) => setChoice(e.target.value)}>
            {proxies?.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name} · {TYPE_LABEL[x.type]}
              </option>
            ))}
            <option value="">No proxy</option>
          </select>
        </label>
        <label className="choice">
          <input
            type="checkbox"
            checked={failClosed}
            disabled={!choice}
            onChange={(e) => setFailClosed(e.target.checked)}
          />
          Fail closed: block traffic when the proxy does not work
        </label>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <div className="row row--end">
          <button type="button" className="pb-button" onClick={props.onClose}>
            Cancel
          </button>
          <button type="submit" className="pb-button" data-variant="primary" disabled={proxies === null}>
            Set proxy
          </button>
        </div>
      </form>
    </Dialog>
  );
}
