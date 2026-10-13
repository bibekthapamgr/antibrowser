/**
 * End-to-end sign-in check for a server set up by scripts/deploy/vps-setup.sh + keycloak-setup.sh (run by
 * .github/workflows/deploy-scripts.yml). Does what the desktop does, against the DEPLOYED API and Keycloak: reads
 * /v1/auth/config, discovers the provider, Authorization Code + PKCE (S256) with state and nonce, fills in the
 * provider's pages like a person would (sign in, replace the temporary password, enter a name), checks the callback
 * (state and the RFC 9207 `iss`), exchanges the code and enrolls a device at /v1/devices.
 *
 * Env: PB_API (default http://127.0.0.1:8080), PB_EMAIL, PB_PASSWORD, PB_NEW_PASSWORD (needed when the password is
 * temporary), PB_EXPECT_PASSWORD_CHANGE (1/0, optional), PB_HEADER_FILE (optional: the API access token as an
 * `authorization` header line, mode 0600, for later checks). Passwords and tokens are never printed.
 */
import { createHash, randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const REDIRECT = 'projectbrowser://auth/callback';
const api = process.env.PB_API ?? 'http://127.0.0.1:8080';
const email = need('PB_EMAIL');
const password = need('PB_PASSWORD');
const newPassword = process.env.PB_NEW_PASSWORD ?? '';
const random = (n = 32) => randomBytes(n).toString('base64url');

function need(name: string): string {
  const value = process.env[name];
  if (!value) fail(`${name} is not set`);
  return value;
}
function fail(message: string): never {
  console.error(`FAILED: ${message}`);
  process.exit(1);
}
const ok = (message: string) => console.log(`ok  ${message}`);

// ------------------------------------------------------------------ a minimal browser: cookies + forms
const jar = new Map<string, string>();
async function browse(url: string, body?: URLSearchParams): Promise<Response> {
  const res = await fetch(url, {
    method: body ? 'POST' : 'GET',
    redirect: 'manual',
    headers: {
      cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '),
      ...(body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
    },
    body,
  });
  for (const c of res.headers.getSetCookie()) {
    const [pair = ''] = c.split(';');
    const i = pair.indexOf('=');
    if (i > 0) jar.set(pair.slice(0, i), pair.slice(i + 1));
  }
  return res;
}

const attr = (tag: string, name: string) =>
  new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1]?.replaceAll('&amp;', '&');

interface Form {
  id: string;
  action: string;
  fields: Map<string, string>;
}
/** The provider's main form (Keycloak ids start with kc-) with the default values of its inputs. */
function findForm(html: string): Form | null {
  for (const m of html.matchAll(/<form\b[^>]*>([\s\S]*?)<\/form>/g)) {
    const open = /<form\b[^>]*>/.exec(m[0])?.[0] ?? '';
    const id = attr(open, 'id') ?? '';
    const action = attr(open, 'action');
    if (!action || !id.startsWith('kc-') || id === 'kc-select-try-another-way-form') continue;
    const fields = new Map<string, string>();
    for (const input of (m[1] ?? '').matchAll(/<input\b[^>]*>/g)) {
      const name = attr(input[0], 'name');
      const type = attr(input[0], 'type') ?? 'text';
      if (!name || type === 'submit' || (type === 'checkbox' && !/\schecked\b/.test(input[0]))) continue;
      fields.set(name, attr(input[0], 'value') ?? '');
    }
    return { id, action, fields };
  }
  return null;
}

// ------------------------------------------------------------------ what the desktop does
const configRes = await fetch(`${api}/v1/auth/config`);
if (!configRes.ok) fail(`GET /v1/auth/config answered ${configRes.status}`);
const config = (await configRes.json()) as {
  issuer: string;
  client_id: string;
  redirect_uri: string;
  scopes: string[];
};
if (config.redirect_uri !== REDIRECT || !config.scopes.includes('openid')) fail('unexpected /v1/auth/config');
ok(`API sign-in configuration: ${config.issuer}, client ${config.client_id}`);

const discovery = (await (await fetch(`${config.issuer}/.well-known/openid-configuration`)).json()) as {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  code_challenge_methods_supported?: string[];
};
if (discovery.issuer !== config.issuer) fail('discovery names another issuer');
if (!discovery.code_challenge_methods_supported?.includes('S256')) fail('no PKCE S256');

const state = random();
const nonce = random(24);
const verifier = random();
const auth = new URL(discovery.authorization_endpoint);
auth.search = new URLSearchParams({
  response_type: 'code',
  client_id: config.client_id,
  redirect_uri: REDIRECT,
  scope: config.scopes.join(' '),
  state,
  nonce,
  code_challenge: createHash('sha256').update(verifier).digest('base64url'),
  code_challenge_method: 'S256',
}).toString();

let res = await browse(auth.toString());
let callback: URL | null = null;
const pages: string[] = [];
for (let step = 0; step < 10 && !callback; step++) {
  if (res.status === 302 || res.status === 303) {
    const location = res.headers.get('location') ?? '';
    if (location.startsWith(REDIRECT)) callback = new URL(location);
    else res = await browse(new URL(location, discovery.authorization_endpoint).toString());
    continue;
  }
  if (res.status !== 200) fail(`provider page answered ${res.status}`);
  const html = await res.text();
  const form = findForm(html);
  if (!form) fail(`no form on the provider page (after: ${pages.join(', ') || 'start'})`);
  const f = form.fields;
  if (form.id.includes('totp') || f.has('totp')) fail('the account must set up an authenticator app first');
  if (f.has('username') && f.has('password')) {
    f.set('username', email);
    f.set('password', password);
    pages.push('sign in');
  } else if (f.has('password-new')) {
    if (!newPassword) fail('the provider asks for a new password but PB_NEW_PASSWORD is not set');
    f.set('password-new', newPassword);
    f.set('password-confirm', newPassword);
    pages.push('new password');
  } else if (f.has('firstName') || f.has('lastName')) {
    if (!f.get('firstName')) f.set('firstName', 'Deploy');
    if (!f.get('lastName')) f.set('lastName', 'Check');
    if (f.has('email') && !f.get('email')) f.set('email', email);
    pages.push('profile');
  } else {
    const error = /class="[^"]*(?:kc-feedback-text|alert-error)[^"]*"[^>]*>([^<]+)/.exec(html)?.[1]?.trim();
    fail(`unexpected provider page "${form.id}"${error ? `: ${error}` : ''}`);
  }
  res = await browse(form.action, new URLSearchParams([...f]));
}
if (!callback) fail(`no redirect to ${REDIRECT} (pages: ${pages.join(', ')})`);
if (callback.searchParams.get('error')) fail(`the provider answered ${callback.searchParams.get('error')}`);
if (callback.searchParams.get('state') !== state) fail('state mismatch');
if (callback.searchParams.get('iss') !== config.issuer)
  fail('the callback does not name the issuer (RFC 9207)');
const expectChange = process.env.PB_EXPECT_PASSWORD_CHANGE;
if (expectChange === '1' && !pages.includes('new password')) fail('expected to replace a temporary password');
if (expectChange === '0' && pages.includes('new password')) fail('was asked for a new password again');
ok(`provider pages: ${pages.join(' -> ')} -> ${REDIRECT} (state and iss match)`);

const token = await fetch(discovery.token_endpoint, {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    grant_type: 'authorization_code',
    code: callback.searchParams.get('code') ?? '',
    redirect_uri: REDIRECT,
    client_id: config.client_id,
    code_verifier: verifier,
  }),
});
if (token.status !== 200) fail(`code exchange answered ${token.status}`);
const { id_token } = (await token.json()) as { id_token?: string };
if (!id_token) fail('no ID token');
ok('code exchanged with the PKCE verifier');

const enroll = await fetch(`${api}/v1/devices`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ id_token, nonce, name: 'Deploy check', platform: 'linux-x64' }),
});
if (enroll.status !== 201) fail(`POST /v1/devices answered ${enroll.status}: ${await enroll.text()}`);
const session = (await enroll.json()) as {
  access_token: string;
  user: { email: string; email_verified: boolean };
};
if (session.user.email !== email || !session.user.email_verified) fail('unexpected user in the API session');
const me = await fetch(`${api}/v1/me`, { headers: { authorization: `Bearer ${session.access_token}` } });
if (me.status !== 200) fail(`GET /v1/me answered ${me.status}`);
ok(`API session for ${email} (e-mail verified), device enrolled, /v1/me 200`);
if (process.env.PB_HEADER_FILE) {
  writeFileSync(process.env.PB_HEADER_FILE, `authorization: Bearer ${session.access_token}\n`, {
    mode: 0o600,
  });
}
