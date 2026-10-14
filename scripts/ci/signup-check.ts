/**
 * R2 end-to-end self-service check against a server set up by vps-setup.sh + keycloak-setup.sh with a mail server
 * (CI: scripts/ci/smtp-sink.ts on 127.0.0.1). A new person does everything a customer does, with no server command
 * and no owner action:
 *
 *   portal "Create account" -> the provider's registration page -> "verify your e-mail" -> the link from the e-mail
 *   -> back in the portal with a session cookie (no token in the browser) -> accept the terms -> one workspace with
 *   a trial (or, with PB_INVITE_LINK: the invited team only) -> the welcome e-mail arrives.
 *
 * Env: PB_API (default http://127.0.0.1:8080), PB_EMAIL, PB_PASSWORD (the new account), PB_MAIL_DIR (where the sink
 * writes .eml files), PB_INVITE_LINK (optional: an invitation link from an e-mail), PB_ORG_FILE (optional: the
 * default workspace id is written there). Passwords, links and cookies are never printed.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const api = process.env.PB_API ?? 'http://127.0.0.1:8080';
const origin = new URL(api).origin;
const email = need('PB_EMAIL').toLowerCase();
const password = need('PB_PASSWORD');
const mailDir = need('PB_MAIL_DIR');
const inviteLink = process.env.PB_INVITE_LINK ?? '';

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

// ------------------------------------------------------------------ a minimal browser: cookies per host + forms
const jars = new Map<string, Map<string, string>>();
async function browse(
  url: string,
  body?: URLSearchParams,
  headers: Record<string, string> = {},
): Promise<Response> {
  const host = new URL(url).host;
  const jar = jars.get(host) ?? new Map<string, string>();
  jars.set(host, jar);
  const res = await fetch(url, {
    method: body ? 'POST' : headers['x-method'] ? (headers['x-method'] as string) : 'GET',
    redirect: 'manual',
    headers: {
      cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '),
      ...(body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
      ...Object.fromEntries(Object.entries(headers).filter(([k]) => k !== 'x-method')),
    },
    body,
  });
  for (const c of res.headers.getSetCookie()) {
    const [pair = ''] = c.split(';');
    const i = pair.indexOf('=');
    if (i > 0) {
      const v = pair.slice(i + 1);
      if (v === '' || /max-age=0/i.test(c)) jar.delete(pair.slice(0, i));
      else jar.set(pair.slice(0, i), v);
    }
  }
  return res;
}
const attr = (tag: string, name: string) =>
  new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1]?.replaceAll('&amp;', '&');
function findForm(html: string) {
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

/** The newest e-mail to this address that contains `needle`, decoded (quoted-printable, folded headers). */
async function waitForMail(needle: RegExp, seconds = 60): Promise<string> {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    const files = readdirSync(mailDir)
      .filter((f) => f.endsWith('.eml'))
      .sort((a, b) => Number.parseInt(b, 10) - Number.parseInt(a, 10));
    for (const f of files) {
      const raw = readFileSync(join(mailDir, f), 'utf8');
      const text = raw
        .replace(/=\r?\n/g, '')
        .replace(/=([0-9A-F]{2})/g, (_, h: string) => String.fromCharCode(Number.parseInt(h, 16)))
        .replace(/\r?\n[ \t]+/g, ' ');
      if (new RegExp(`^To:.*${email.replace(/[.+]/g, '\\$&')}`, 'im').test(text) && needle.test(text))
        return text;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  fail(`no e-mail to ${email} matching ${needle} within ${seconds} s`);
}

// ------------------------------------------------------------------ 1. "Create account" in the portal
const returnTo = inviteLink ? new URL(inviteLink).pathname + new URL(inviteLink).hash : '/app/#/welcome';
let res = await browse(`${api}/v1/web/auth/login?mode=signup&return_to=${encodeURIComponent(returnTo)}`);
if (res.status !== 302) fail(`portal sign-up start answered ${res.status}`);
let landed: URL | null = null;
const pages: string[] = [];
let verifySent = false;
for (let step = 0; step < 15 && !landed; step++) {
  if (res.status === 302 || res.status === 303) {
    const location = new URL(res.headers.get('location') ?? '', res.url || api);
    if (location.origin === origin && location.pathname.startsWith('/app')) landed = location;
    else res = await browse(location.toString());
    continue;
  }
  if (res.status !== 200)
    fail(`provider page answered ${res.status} (after: ${pages.join(', ') || 'start'})`);
  const html = await res.text();
  const form = findForm(html);
  if (/login-actions\/.*verify|kc-verify-email|re-send|resend/i.test(html) && !verifySent) {
    // The provider waits for the address to be confirmed: open the link from the e-mail in this same browser.
    pages.push('verify your e-mail');
    verifySent = true;
    const mail = await waitForMail(/action-token|login-actions/);
    const link = /(https?:\/\/[^\s"<>]+(?:action-token|login-actions)[^\s"<>]*)/
      .exec(mail)?.[1]
      ?.replaceAll('&amp;', '&');
    if (!link) fail('the verification e-mail has no link');
    ok('verification e-mail received (link not shown)');
    res = await browse(link);
    continue;
  }
  if (!form) {
    // An information page ("your e-mail address was verified") with a link back to the application.
    const next = [...html.matchAll(/href="([^"]+)"/g)]
      .map((m) => (m[1] ?? '').replaceAll('&amp;', '&'))
      .find((h) => h.includes('login-actions') || h.startsWith(`${origin}/v1/web/auth/callback`));
    if (!next) fail(`no form on the provider page (after: ${pages.join(', ') || 'start'})`);
    pages.push('continue');
    res = await browse(new URL(next, res.url).toString());
    continue;
  }
  const f = form.fields;
  if (f.has('password-confirm') && f.has('email')) {
    f.set('email', email);
    if (f.has('username')) f.set('username', email);
    f.set('password', password);
    f.set('password-confirm', password);
    f.set('firstName', 'Signup');
    f.set('lastName', 'Check');
    pages.push('register');
  } else if (f.has('username') && f.has('password')) {
    // The registration page was not offered (prompt=create unsupported): use "Register" from the sign-in page.
    const reg = /href="([^"]*registrations[^"]*)"/.exec(html)?.[1]?.replaceAll('&amp;', '&');
    if (!reg)
      fail('the sign-in page offers no registration (self-registration off? is a mail server set up?)');
    pages.push('sign-in page -> register');
    res = await browse(new URL(reg, res.url).toString());
    continue;
  } else {
    const error = /class="[^"]*(?:kc-feedback-text|alert-error)[^"]*"[^>]*>([^<]+)/.exec(html)?.[1]?.trim();
    fail(`unexpected provider page "${form.id}"${error ? `: ${error}` : ''}`);
  }
  res = await browse(form.action, new URLSearchParams([...f]));
}
if (!landed) fail(`did not come back to the portal (pages: ${pages.join(' -> ')})`);
if (landed.hash.includes('failed')) fail(`the portal reports a failed sign-in: ${landed.hash}`);
if (!pages.includes('register') || !verifySent)
  fail(`expected registration and verification (pages: ${pages.join(' -> ')})`);
ok(`provider pages: ${pages.join(' -> ')} -> back in the portal (${landed.pathname})`);

// ------------------------------------------------------------------ 2. the portal session (cookie only)
const apiJar = jars.get(new URL(api).host);
const cookieName = [...(apiJar?.keys() ?? [])].find((k) => k === 'pb_web' || k === '__Host-pb_web');
if (!cookieName) fail('the portal set no session cookie');
const call = async (method: string, path: string, body?: object, csrf?: string) => {
  const r = await fetch(`${api}${path}`, {
    method,
    headers: {
      cookie: `${cookieName}=${apiJar?.get(cookieName)}`,
      accept: 'application/json',
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(csrf ? { 'x-csrf-token': csrf, origin } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  for (const c of r.headers.getSetCookie()) {
    const m = /^([^=]+)=([^;]*)/.exec(c);
    if (m?.[1] === cookieName && m[2]) apiJar?.set(cookieName, m[2]);
  }
  return { status: r.status, body: (await r.json().catch(() => null)) as Record<string, unknown> | null };
};
const session = await call('GET', '/v1/web/auth/session');
if (session.status !== 200) fail(`GET /v1/web/auth/session answered ${session.status}`);
const user = session.body?.user as { email: string; email_verified: boolean };
if (user.email !== email || !user.email_verified) fail('the portal session is not the new, verified account');
const csrf = session.body?.csrf_token as string;
ok(`portal session for ${email} (verified); the browser holds only an HttpOnly cookie`);
const refused = await call('POST', '/v1/onboarding/complete', {});
if (refused.status !== 403 || refused.body?.code !== 'CSRF_FAILED')
  fail('a change without the CSRF token was accepted');
ok('a change without the CSRF token and origin is refused');

// ------------------------------------------------------------------ 3. onboarding
const status = await call('GET', '/v1/onboarding/status');
const terms = (status.body?.terms as { current_version: string } | undefined)?.current_version;
if (!terms) fail('GET /v1/onboarding/status has no terms version');
let outcome: string;
let st: Record<string, unknown>;
if (inviteLink) {
  const token = /#\/invite\/([A-Za-z0-9_-]{43})/.exec(inviteLink)?.[1];
  if (!token) fail('the invitation link has no token');
  const r = await call('POST', '/v1/onboarding/complete', { invitation_token: token }, csrf);
  if (r.status !== 200) fail(`accepting the invitation answered ${r.status}: ${JSON.stringify(r.body)}`);
  outcome = r.body?.outcome as string;
  st = r.body?.status as Record<string, unknown>;
  const ws = st.workspaces as { role: string }[];
  if (outcome !== 'joined' || st.bootstrap_org_id !== null || ws.length !== 1 || ws[0]?.role === 'owner') {
    fail(
      `the invited person did not join only the invited team: ${outcome}, ${JSON.stringify(ws.map((w) => w.role))}`,
    );
  }
  ok(
    `invitation accepted: joined the invited team as ${ws[0]?.role}; no personal workspace, no trial, no payment`,
  );
} else {
  const r = await call(
    'POST',
    '/v1/onboarding/complete',
    { accept_terms_version: terms },
    (await call('GET', '/v1/web/auth/session')).body?.csrf_token as string,
  );
  if (r.status !== 200) fail(`onboarding answered ${r.status}: ${JSON.stringify(r.body)}`);
  outcome = r.body?.outcome as string;
  st = r.body?.status as Record<string, unknown>;
  if (outcome !== 'created' || st.state !== 'ready' || !st.default_org_id)
    fail(`onboarding outcome ${outcome}`);
  // Again (a retry, or the desktop finishing at the same time): the same workspace.
  const again = await call(
    'POST',
    '/v1/onboarding/complete',
    {},
    (await call('GET', '/v1/web/auth/session')).body?.csrf_token as string,
  );
  if (again.body?.outcome !== 'existing')
    fail(`a second onboarding call answered ${String(again.body?.outcome)}`);
  const org = await call('GET', `/v1/orgs/${st.default_org_id}`);
  const billing = org.body?.billing as { state: string } | undefined;
  if (org.status !== 200 || billing?.state !== 'trial')
    fail(`the new workspace is not on a trial (${org.status})`);
  ok('onboarding: one personal workspace, owner, trial; a second call changes nothing');
  await waitForMail(/Welcome to/);
  ok('welcome e-mail received');
}
if (process.env.PB_ORG_FILE)
  writeFileSync(process.env.PB_ORG_FILE, String(st.default_org_id), { mode: 0o600 });
const out = await call(
  'POST',
  '/v1/web/auth/logout',
  undefined,
  (await call('GET', '/v1/web/auth/session')).body?.csrf_token as string,
);
if (out.status !== 204) fail(`sign-out answered ${out.status}`);
ok('signed out of the portal');
