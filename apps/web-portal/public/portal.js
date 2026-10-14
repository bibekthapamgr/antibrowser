// R2 customer portal (ADR-0021): create an account, verify, accept invitations, finish onboarding and get the app.
// Plain modules, no build step. The page never holds a token: the API keeps the session in an HttpOnly cookie and
// gives this page a CSRF token for changes. Text is only ever set with textContent (no HTML from data).

const API = '/v1';
let csrf = null;
let config = { brand: 'Project Browser', terms_version: '', terms_url: null, download_url: null };

// ------------------------------------------------------------------ tiny DOM helpers
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v === null || v === undefined) continue;
    if (k === 'onclick') node.addEventListener('click', v);
    else if (k === 'onsubmit') node.addEventListener('submit', v);
    else if (k === 'class') node.className = v;
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.append(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}
const main = () => document.getElementById('main');
function show(...nodes) {
  main().replaceChildren(...nodes);
  const h = main().querySelector('h1');
  if (h) document.title = `${h.textContent} · ${config.brand}`;
}
const card = (...children) => el('div', { class: 'card' }, ...children);

// ------------------------------------------------------------------ API
async function api(method, path, body) {
  const headers = { accept: 'application/json' };
  if (method !== 'GET') {
    headers['content-type'] = 'application/json';
    if (csrf) headers['x-csrf-token'] = csrf;
  }
  const res = await fetch(`${API}${path}`, {
    method,
    headers,
    credentials: 'same-origin',
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error(data?.message ?? `Request failed (${res.status})`);
    err.code = data?.code ?? 'UNAVAILABLE';
    err.status = res.status;
    err.details = data?.safe_details ?? {};
    throw err;
  }
  return data;
}

async function loadSession() {
  try {
    const s = await api('GET', '/web/auth/session');
    csrf = s.csrf_token;
    document.getElementById('who').textContent = s.user.email ?? s.user.display_name;
    document.getElementById('account').hidden = false;
    return s;
  } catch (err) {
    if (err.status === 401) return null;
    throw err;
  }
}

const signInUrl = (mode, returnTo) =>
  `${API}/web/auth/login?mode=${mode}&return_to=${encodeURIComponent(returnTo)}`;

// ------------------------------------------------------------------ pages
function signedOut(returnTo = '/app/#/welcome', heading = `Welcome to ${config.brand}`, intro) {
  show(
    card(
      el('h1', {}, heading),
      el(
        'p',
        { class: 'muted' },
        intro ??
          'Create an account to get your own workspace with a free trial, or sign in if you already have one.',
      ),
      el(
        'div',
        { class: 'actions' },
        el('a', { class: 'button primary', href: signInUrl('signup', returnTo) }, 'Create account'),
        el('a', { class: 'button', href: signInUrl('signin', returnTo) }, 'Sign in'),
      ),
      el(
        'p',
        { class: 'muted' },
        'Forgot your password? Choose Sign in, then “Forgot password”. We e-mail you a link to set a new one.',
      ),
    ),
  );
}

const FAILURES = {
  cancelled: 'Sign-in was cancelled.',
  expired: 'That sign-in link has expired or was already used. Please try again.',
  invalid: 'The sign-in could not be verified. Please try again.',
  provider: 'The sign-in service could not be reached. Please try again in a moment.',
  disabled: 'This account is disabled. Contact support if you think this is a mistake.',
};

function signInFailed(reason) {
  show(
    card(
      el('h1', {}, 'Sign-in did not complete'),
      el('p', { class: 'error' }, FAILURES[reason] ?? FAILURES.invalid),
      el(
        'div',
        { class: 'actions' },
        el('a', { class: 'button primary', href: signInUrl('signin', '/app/#/welcome') }, 'Try again'),
      ),
    ),
  );
}

function verifyEmail() {
  show(
    card(
      el('h1', {}, 'Verify your e-mail'),
      el(
        'p',
        {},
        'We sent you a link to confirm your e-mail address. Open it, then sign in again here. If it did not arrive, check your spam folder; signing in again offers to send a new link.',
      ),
      el(
        'div',
        { class: 'actions' },
        el(
          'a',
          { class: 'button primary', href: signInUrl('signin', '/app/#/welcome') },
          'I have verified it — continue',
        ),
      ),
    ),
  );
}

function failure(err, retry) {
  const messages = {
    EMAIL_NOT_VERIFIED: 'Verify your e-mail address first (the link is in your inbox), then sign in again.',
    ACCOUNT_SUSPENDED: 'A workspace cannot be created for this address. Contact support.',
    RATE_LIMITED: 'Too many attempts. Please wait a few minutes and try again.',
    INVITATION_WRONG_ACCOUNT:
      'This invitation was sent to a different e-mail address. Sign out and sign in with the invited address.',
    INVITATION_EXPIRED: 'This invitation has expired or was withdrawn. Ask for a new one.',
    INVITATION_USED: 'This invitation was already used.',
    WORKSPACE_SUSPENDED: 'This workspace is suspended and cannot be joined.',
    PLAN_LIMIT_REACHED: 'This team has no free seat. Ask its owner to add seats, then try again.',
    TERMS_REQUIRED: 'The terms changed. Please review and accept them again.',
  };
  show(
    card(
      el('h1', {}, 'Something went wrong'),
      el('p', { class: 'error' }, messages[err.code] ?? err.message),
      el('p', { class: 'muted' }, 'Nothing was half-created: you can safely try again.'),
      el('div', { class: 'actions' }, el('button', { class: 'primary', onclick: retry }, 'Try again')),
    ),
  );
}

function planIntent() {
  try {
    return sessionStorage.getItem('pb.plan') || undefined;
  } catch {
    return undefined;
  }
}

async function completeOnboarding(body) {
  const plan = planIntent();
  const result = await api('POST', '/onboarding/complete', plan ? { plan_intent: plan, ...body } : body);
  // A new workspace or a joined team gives the session a new id: fetch the new CSRF token.
  await loadSession();
  return result;
}

async function welcome() {
  const session = await loadSession();
  if (!session) return signedOut();
  let status;
  try {
    status = await api('GET', '/onboarding/status');
  } catch (err) {
    return failure(err, welcome);
  }
  if (!status.email_verified) return verifyEmail();
  // Someone who opened an invitation link before signing in finishes that first.
  const pending = (() => {
    try {
      return sessionStorage.getItem('pb.invite');
    } catch {
      return null;
    }
  })();
  if (pending) return invitation(pending);
  if (status.default_org_id) return ready(status);
  let result;
  try {
    result = await completeOnboarding({});
  } catch (err) {
    return failure(err, welcome);
  }
  route(result);
}

function route(result) {
  const s = result.status;
  switch (result.outcome) {
    case 'terms_required':
      return termsPage(s);
    case 'invitations_pending':
      return invitationsWaiting(s);
    case 'choice_required':
      return choose(s);
    default:
      return ready(s, result.outcome);
  }
}

function termsPage(status, createOwn = false) {
  const terms = el('input', { type: 'checkbox', id: 'terms', required: true });
  const marketing = el('input', { type: 'checkbox', id: 'marketing' });
  const name = el('input', { type: 'text', id: 'ws-name', maxlength: 120, placeholder: 'My workspace' });
  const submit = el('button', { class: 'primary', type: 'submit' }, 'Create my workspace');
  const termsText = config.terms_url
    ? el(
        'span',
        {},
        'I accept the ',
        el('a', { href: config.terms_url, target: '_blank', rel: 'noopener' }, 'terms of service'),
        ` (version ${status.terms.current_version}).`,
      )
    : el('span', {}, `I accept the terms of service (version ${status.terms.current_version}).`);
  show(
    card(
      el('h1', {}, createOwn ? 'Create your own workspace' : 'Set up your workspace'),
      el(
        'p',
        { class: 'muted' },
        status.trial_available
          ? 'Your workspace starts with a free trial. No payment details are needed now.'
          : 'You already used your free trial with this address, so this workspace starts without one.',
      ),
      el(
        'form',
        {
          onsubmit: async (e) => {
            e.preventDefault();
            submit.disabled = true;
            try {
              const body = {
                accept_terms_version: status.terms.current_version,
                marketing_consent: marketing.checked,
                ...(name.value.trim() ? { workspace_name: name.value.trim() } : {}),
                ...(createOwn ? { create_own: true } : {}),
              };
              route(await completeOnboarding(body));
            } catch (err) {
              failure(err, () => termsPage(status, createOwn));
            }
          },
        },
        el('label', { for: 'ws-name' }, 'Workspace name (optional)'),
        name,
        el('label', { class: 'check' }, terms, termsText),
        el(
          'label',
          { class: 'check' },
          marketing,
          el('span', {}, 'Send me occasional product news (optional, you can stop at any time).'),
        ),
        el('div', { class: 'actions' }, submit),
      ),
    ),
  );
}

function invitationsWaiting(status) {
  show(
    card(
      el('h1', {}, 'You have been invited'),
      el(
        'p',
        {},
        'These teams invited this e-mail address. Open the invitation link from the e-mail to join one.',
      ),
      el(
        'ul',
        { class: 'choices' },
        status.pending_invitations.map((i) =>
          el(
            'li',
            {},
            el('span', {}, `${i.org_name} — ${roleName(i.role)}`),
            el('span', { class: 'muted' }, `until ${new Date(i.expires_at).toLocaleDateString()}`),
          ),
        ),
      ),
      el(
        'div',
        { class: 'actions' },
        el('button', { onclick: () => termsPage(status, true) }, 'Create my own workspace instead'),
      ),
    ),
  );
}

function choose(status) {
  show(
    card(
      el('h1', {}, 'Choose your workspace'),
      el(
        'p',
        { class: 'muted' },
        'You own several workspaces. Which one should open first? You can switch at any time.',
      ),
      el(
        'ul',
        { class: 'choices' },
        status.workspaces
          .filter((w) => !w.suspended)
          .map((w) =>
            el(
              'li',
              {},
              el('span', {}, w.name),
              el(
                'button',
                {
                  class: 'primary',
                  onclick: async () => {
                    try {
                      route(await completeOnboarding({ choose_org_id: w.org_id }));
                    } catch (err) {
                      failure(err, () => choose(status));
                    }
                  },
                },
                'Open this one',
              ),
            ),
          ),
      ),
    ),
  );
}

function roleName(role) {
  return (
    { owner: 'owner', admin: 'admin', operator: 'member', viewer: 'viewer', billing: 'billing' }[role] ?? role
  );
}

function ready(status, outcome) {
  const ws = status.workspaces.find((w) => w.org_id === status.default_org_id);
  const plan = status.plan_intent;
  const pendingMail = status.pending_tasks.find((t) => t.kind === 'welcome' && t.state === 'pending');
  show(
    card(
      el(
        'h1',
        {},
        outcome === 'joined' ? `You joined ${ws?.name ?? 'the team'}` : `Welcome${ws ? ` — ${ws.name}` : ''}`,
      ),
      el(
        'p',
        {},
        ws?.role === 'owner'
          ? 'Your workspace is ready.'
          : `You are ${roleName(ws?.role)} of this team. Your access is decided by the team’s owner and admins.`,
      ),
      plan
        ? el(
            'p',
            { class: 'muted' },
            `You chose the ${plan} plan. You can subscribe from the Subscription page in the app whenever you are ready; the trial keeps running until then.`,
          )
        : null,
      pendingMail ? el('p', { class: 'muted' }, 'A welcome e-mail is on its way.') : null,
    ),
    card(
      el('h2', {}, 'Get the desktop app'),
      el(
        'p',
        {},
        'Install the app, choose Sign in, and use this same e-mail address. You will land straight in your profiles.',
      ),
      el(
        'div',
        { class: 'actions' },
        config.download_url
          ? el('a', { class: 'button primary', href: config.download_url, rel: 'noopener' }, 'Download')
          : el('span', { class: 'muted' }, 'Ask your administrator for the download link.'),
      ),
    ),
    status.workspaces.length > 1
      ? card(
          el('h2', {}, 'Your workspaces'),
          el(
            'ul',
            { class: 'choices' },
            status.workspaces.map((w) =>
              el(
                'li',
                {},
                el('span', {}, `${w.name} — ${roleName(w.role)}${w.suspended ? ' (suspended)' : ''}`),
                w.org_id === status.default_org_id ? el('span', { class: 'ok' }, 'opens first') : null,
              ),
            ),
          ),
        )
      : null,
    card(
      el('h2', {}, 'Security'),
      el(
        'p',
        { class: 'muted' },
        'Signed in somewhere you no longer use? This signs your account out of every browser and every computer.',
      ),
      el(
        'button',
        {
          onclick: async () => {
            if (!window.confirm('Sign out of every browser and computer?')) return;
            await api('POST', '/web/auth/revoke-all').catch(() => undefined);
            location.assign('/app/');
          },
        },
        'Sign out everywhere',
      ),
    ),
  );
}

async function invitation(token) {
  try {
    sessionStorage.setItem('pb.invite', token);
  } catch {
    /* private mode: the link itself carries the token */
  }
  const session = await loadSession();
  const back = `/app/#/invite/${token}`;
  if (!session) {
    return signedOut(
      back,
      'You have been invited',
      'Create an account with the invited e-mail address, or sign in if you already have one. No payment is needed to join a team.',
    );
  }
  let preview;
  try {
    preview = await api('GET', `/invitations/${token}`);
  } catch (err) {
    forgetInvite();
    return failure(err, () => invitation(token));
  }
  if (preview.status !== 'open') {
    forgetInvite();
    return failure(
      { code: preview.status === 'accepted' ? 'INVITATION_USED' : 'INVITATION_EXPIRED', message: '' },
      welcome,
    );
  }
  if (!preview.for_this_account) {
    return show(
      card(
        el('h1', {}, `Join ${preview.org_name}`),
        el(
          'p',
          { class: 'error' },
          `This invitation is for a different e-mail address than ${session.user.email ?? 'this account'}${session.user.email_verified ? '' : ' (or this address is not verified yet)'}.`,
        ),
        el(
          'div',
          { class: 'actions' },
          el('button', { onclick: signOutAndBack(back) }, 'Sign in with another account'),
        ),
      ),
    );
  }
  show(
    card(
      el('h1', {}, `Join ${preview.org_name}`),
      el('p', {}, `You were invited as ${roleName(preview.role)}.`),
      el(
        'div',
        { class: 'actions' },
        el(
          'button',
          {
            class: 'primary',
            onclick: async () => {
              try {
                const r = await completeOnboarding({ invitation_token: token });
                forgetInvite();
                route(r);
              } catch (err) {
                if (['INVITATION_EXPIRED', 'INVITATION_USED', 'WORKSPACE_SUSPENDED'].includes(err.code))
                  forgetInvite();
                failure(err, () => invitation(token));
              }
            },
          },
          'Accept and join',
        ),
      ),
    ),
  );
}

function forgetInvite() {
  try {
    sessionStorage.removeItem('pb.invite');
  } catch {
    /* nothing stored */
  }
}

const signOutAndBack = (returnTo) => async () => {
  await api('POST', '/web/auth/logout').catch(() => undefined);
  location.assign(signInUrl('signin', returnTo));
};

// ------------------------------------------------------------------ router
async function render() {
  const hash = location.hash.replace(/^#\/?/, '');
  const [path, query = ''] = hash.split('?');
  const params = new URLSearchParams(query);
  try {
    if (params.get('plan')) sessionStorage.setItem('pb.plan', params.get('plan'));
  } catch {
    /* plan intent is optional */
  }
  if (path.startsWith('invite/')) return invitation(path.slice('invite/'.length));
  if (path === 'signin' && params.get('failed')) return signInFailed(params.get('failed'));
  if (path === 'welcome') return welcome();
  const session = await loadSession();
  return session ? welcome() : signedOut();
}

async function start() {
  try {
    config = { ...config, ...(await api('GET', '/web/config')) };
  } catch {
    /* defaults */
  }
  document.getElementById('brand').textContent = config.brand;
  if (config.terms_url) {
    const link = document.getElementById('terms-link');
    link.href = config.terms_url;
    link.hidden = false;
  }
  document.getElementById('sign-out').addEventListener('click', async () => {
    await api('POST', '/web/auth/logout').catch(() => undefined);
    location.assign('/app/');
  });
  window.addEventListener('hashchange', () => void render());
  await render();
}

void start();
