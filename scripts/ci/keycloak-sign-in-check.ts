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
 *
 * Milestone 11, PB_CONSOLE=1: the same as the support console page does it instead — /v1/support/auth/config, its own
 * client, redirect to <API>/console/, max_age, the code exchange from the console's origin (CORS must allow exactly
 * it), then POST /v1/support/sessions. PB_EXPECT_STAFF=0 expects the refusal of a non-staff account, 1 a staff session.
 */
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { freshCode, saveSecret, totp } from './totp.ts';

const api = process.env.PB_API ?? 'http://127.0.0.1:8080';
const consoleMode = process.env.PB_CONSOLE === '1';
const REDIRECT = consoleMode ? `${new URL(api).origin}/console/` : 'projectbrowser://auth/callback';
const email = need('PB_EMAIL');
const password = need('PB_PASSWORD');
const newPassword = process.env.PB_NEW_PASSWORD ?? '';
const random = (n = 32) => randomBytes(n).toString('base64url');
// R2: where one-time-code secrets of test accounts are kept between steps (staff sign in with a code).
const totpDir = process.env.PB_TOTP_DIR ?? '';
if (totpDir) mkdirSync(totpDir, { recursive: true, mode: 0o700 });

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
const configPath = consoleMode ? '/v1/support/auth/config' : '/v1/auth/config';
const configRes = await fetch(`${api}${configPath}`);
if (!configRes.ok) fail(`GET ${configPath} answered ${configRes.status}`);
const config = (await configRes.json()) as {
  issuer: string;
  client_id: string;
  redirect_uri?: string;
  scopes: string[];
};
if ((!consoleMode && config.redirect_uri !== REDIRECT) || !config.scopes.includes('openid')) {
  fail(`unexpected ${configPath}`);
}
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
  ...(consoleMode ? { max_age: '600' } : {}),
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
  if (f.has('totpSecret')) {
    // R2: the staff flow asks to set up an authenticator app; do what a person does with their phone.
    if (!totpDir)
      fail('the account must set up an authenticator app (set PB_TOTP_DIR to let this check do it)');
    const secret = f.get('totpSecret') ?? '';
    const step = Math.floor(Date.now() / 30_000);
    f.set('totp', totp(secret, step));
    if (f.has('userLabel')) f.set('userLabel', 'deploy check');
    saveSecret(totpDir, email, secret, step);
    pages.push('set up one-time codes');
    res = await browse(form.action, new URLSearchParams([...f]));
    continue;
  }
  if (f.has('otp')) {
    const code = totpDir ? await freshCode(totpDir, email) : null;
    if (!code) fail('the provider asks for a one-time code but this account has no saved secret');
    f.set('otp', code);
    pages.push('one-time code');
    res = await browse(form.action, new URLSearchParams([...f]));
    continue;
  }
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
// R2: the support console always asks for a one-time code (or to set one up first).
if (consoleMode && !pages.some((p) => p === 'one-time code' || p === 'set up one-time codes')) {
  fail('the support console signed in without a one-time code');
}
ok(`provider pages: ${pages.join(' -> ')} -> ${REDIRECT} (state and iss match)`);

const consoleOrigin = new URL(api).origin;
const token = await fetch(discovery.token_endpoint, {
  method: 'POST',
  headers: {
    'content-type': 'application/x-www-form-urlencoded',
    // The console page calls the token endpoint from its own origin; the desktop is not a browser page.
    ...(consoleMode ? { origin: consoleOrigin } : {}),
  },
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

if (consoleMode) {
  if (token.headers.get('access-control-allow-origin') !== consoleOrigin) {
    fail(`the provider does not allow the console origin ${consoleOrigin} (CORS) on its token endpoint`);
  }
  ok(`token endpoint allows the console page's origin ${consoleOrigin} (CORS)`);
  const staff = await fetch(`${api}/v1/support/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id_token, nonce }),
  });
  const body = (await staff.json()) as {
    access_token?: string;
    staff?: { roles: string[] };
    safe_details?: { reason?: string };
  };
  if (process.env.PB_EXPECT_STAFF === '0') {
    if (staff.status !== 401 || body.safe_details?.reason !== 'not_staff') {
      fail(`a non-staff account was not refused (HTTP ${staff.status})`);
    }
    ok(`support console: ${email} is refused until a staff role is given on the server`);
    process.exit(0);
  }
  if (staff.status !== 201 || !body.access_token) fail(`POST /v1/support/sessions answered ${staff.status}`);
  const headers = { authorization: `Bearer ${body.access_token}` };
  const alerts = await fetch(`${api}/v1/support/alerts`, { headers });
  if (alerts.status !== 200) fail(`GET /v1/support/alerts answered ${alerts.status}`);
  const meWithStaff = await fetch(`${api}/v1/me`, { headers });
  if (meWithStaff.status !== 401)
    fail(`a staff token reached an organization route (HTTP ${meWithStaff.status})`);
  // R5: the staff flow reports its second factor in the ID token (amr), and the API recorded it for this session.
  const claims = JSON.parse(Buffer.from(id_token.split('.')[1] ?? '', 'base64url').toString('utf8')) as {
    amr?: string[];
  };
  if (!claims.amr?.includes('otp'))
    fail(`the console ID token has no one-time-code amr (${JSON.stringify(claims.amr)})`);
  const adminMe = await fetch(`${api}/v1/admin/me`, { headers });
  const adminBody = (await adminMe.json()) as { mfa?: boolean; permissions?: string[] };
  if (adminMe.status !== 200 || adminBody.mfa !== true) {
    fail(
      `the console session was not recorded with a second factor (HTTP ${adminMe.status}, mfa ${adminBody.mfa})`,
    );
  }
  // PB_EXPECT_ADMIN=1: a platform owner reaches the business screens' data.
  if (process.env.PB_EXPECT_ADMIN === '1') {
    for (const path of [
      '/v1/admin/metrics',
      '/v1/admin/customers?limit=5',
      '/v1/admin/catalog',
      '/v1/admin/operations',
    ]) {
      const r = await fetch(`${api}${path}`, { headers });
      if (r.status !== 200) fail(`GET ${path} answered ${r.status}: ${(await r.text()).slice(0, 200)}`);
    }
    ok(
      'admin console: metrics, customers, catalog and operations answer for the platform owner (MFA session)',
    );
  }
  await fetch(`${api}/v1/support/sign-out`, { method: 'POST', headers });
  ok(
    `support console: staff session (${body.staff?.roles.join(', ')}), amr ${claims.amr?.join('+')}, alerts 200, organization routes refused`,
  );
  process.exit(0);
}

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
