/**
 * R6 (ADR-0025): the production preflight, run by scripts/deploy/preflight.sh on a staging or production server.
 * Prints one line per named check (PASS / FAIL / WARN) and, with --json, the report as JSON. Never prints secret
 * values: details name hosts, counts and file names only, and the report is passed through a redaction of every
 * configured secret before it is printed. Exit code 1 when a check FAILED.
 *
 * Usage (as the pb user, with the API's environment):
 *   node --env-file=<combined env> scripts/preflight.ts --facts <facts.json> --repo <checkout> [--json <out.json>]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type AppConfig, loadConfig } from '@pb/config/env';
import pg from 'pg';
import {
  type CheckResult,
  checkArtifact,
  checkBackups,
  checkDatabase,
  checkDevAuth,
  checkEmail,
  checkFiles,
  checkPrivatePorts,
  checkReleaseKeys,
  checkRuntime,
  checkStaff,
  checkTlsMode,
  checkWebhook,
  type MachineFacts,
  redactReport,
} from '../src/preflight.ts';

type Facts = MachineFacts & { hosts: { site: string; admin: string; id: string; files: string } };

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const factsPath = arg('--facts');
const repo = arg('--repo') ?? join(import.meta.dirname, '../../..');
const jsonOut = arg('--json');
if (!factsPath) throw new Error('--facts is required');
const facts = JSON.parse(readFileSync(factsPath, 'utf8')) as Facts;

const results: CheckResult[] = [];
const add = (c: CheckResult) => results.push(c);
const fail = (id: string, name: string, detail: string) => add({ id, name, status: 'fail', detail });

/** GET or HEAD over the real public address (DNS, TLS verification as a customer's computer would do it). */
async function probe(
  url: string,
  init: RequestInit = {},
): Promise<{ status: number; headers: Headers; body: string } | { error: string }> {
  try {
    const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(15_000), ...init });
    const body = res.status === 204 ? '' : (await res.text()).slice(0, 200_000);
    return { status: res.status, headers: res.headers, body };
  } catch (e) {
    const cause = (e as { cause?: { code?: string } }).cause?.code;
    return { error: cause ?? (e instanceof Error ? e.name : 'error') };
  }
}
const statusOf = (p: Awaited<ReturnType<typeof probe>>) => ('status' in p ? p.status : null);

let config: AppConfig | null = null;
try {
  config = loadConfig();
} catch (e) {
  const problems = (e as { problems?: string[] }).problems ?? ['the configuration does not load'];
  fail('configuration', 'The API configuration is valid', problems.join('; '));
}

const { site, admin, id: idHost, files } = facts.hosts;
const siteUrl = `https://${site}`;

// ----------------------------------------------------------------------------- HTTPS, issuer, public surface
if (config) {
  const issuer = config.oidc?.issuer ?? '';
  const name = 'HTTPS everywhere; the sign-in issuer is correct';
  if (!issuer.startsWith('https://')) fail('https_issuer', name, 'OIDC_ISSUER is not https');
  else {
    const disc = await probe(`${issuer}/.well-known/openid-configuration`);
    const discIssuer =
      'status' in disc && disc.status === 200 ? (JSON.parse(disc.body) as { issuer?: string }).issuer : null;
    const problems: string[] = [];
    if (discIssuer !== issuer)
      problems.push(
        `discovery at ${new URL(issuer).host} ${'error' in disc ? `failed (${disc.error})` : `names ${discIssuer ?? 'nothing'}`}`,
      );
    if (new URL(issuer).host !== idHost) problems.push(`the issuer is not on ${idHost}`);
    for (const h of [site, admin, idHost, files]) {
      const p = await probe(`https://${h}/`);
      if ('error' in p) problems.push(`https://${h}/ ${p.error}`);
      else if (!/max-age=\d{7,}/.test(p.headers.get('strict-transport-security') ?? ''))
        problems.push(`https://${h}/ sends no HSTS`);
      const plain = await probe(`http://${h}/`);
      const loc = 'status' in plain ? (plain.headers.get('location') ?? '') : '';
      if (!('status' in plain) || ![301, 302, 307, 308].includes(plain.status) || !loc.startsWith('https://'))
        problems.push(`http://${h}/ does not redirect to https`);
    }
    if (problems.length) fail('https_issuer', name, problems.join('; '));
    else
      add({
        id: 'https_issuer',
        name,
        status: 'pass',
        detail: `issuer ${issuer}; 4 addresses verified TLS, HSTS, http→https`,
      });
  }
}
add(checkTlsMode(facts));

if (config) {
  const me = await probe(`${siteUrl}/v1/me`, {
    headers: { authorization: 'Bearer dev.preflight-made-up-token' },
  });
  add(checkDevAuth(config, statusOf(me)));
}

// Public registration: the portal's "create account" leads to the provider's registration form.
{
  const name = 'Public registration works';
  const login = await probe(`${siteUrl}/v1/web/auth/login?mode=signup&return_to=%2Fapp%2F`);
  const loc = 'status' in login ? (login.headers.get('location') ?? '') : '';
  if (!loc.startsWith(`https://${idHost}/`))
    fail('public_registration', name, `${siteUrl}/v1/web/auth/login does not lead to ${idHost}`);
  else {
    const page = await probe(loc);
    if ('status' in page && page.status === 200 && /kc-register-form/.test(page.body))
      add({
        id: 'public_registration',
        name,
        status: 'pass',
        detail: 'the registration form opens from the portal',
      });
    else
      fail(
        'public_registration',
        name,
        'the provider shows no registration form (self-registration is off until the mail server is set up)',
      );
  }
}

// Customer / staff separation on the public addresses.
{
  const name = 'Customer and staff surfaces are separate';
  const expect404 = [
    `${siteUrl}/console/`,
    `${siteUrl}/v1/admin/me`,
    `${siteUrl}/v1/support/auth/config`,
    `https://${admin}/v1/orgs`,
    `https://${admin}/app/`,
    `https://${admin}/v1/web/config`,
    `https://${idHost}/admin/`,
    `https://${idHost}/realms/master/.well-known/openid-configuration`,
    `https://${files}/`,
    `${siteUrl}/v1/openapi.json`,
    `${siteUrl}/metrics`,
  ];
  const wrong: string[] = [];
  for (const u of expect404) {
    const s = statusOf(await probe(u));
    if (s !== 404) wrong.push(`${u} → ${s ?? 'no answer'}`);
  }
  const consoleOk = statusOf(await probe(`https://${admin}/console/`)) === 200;
  if (!consoleOk) wrong.push(`https://${admin}/console/ is not served`);
  const clients = config ? [config.oidc?.clientId, config.console.oidcClientId, config.web.oidcClientId] : [];
  if (config && new Set(clients.filter(Boolean)).size !== 3)
    wrong.push('desktop, staff console and portal do not use three separate sign-in clients');
  if (wrong.length) fail('customer_admin_separation', name, wrong.join('; '));
  else
    add({
      id: 'customer_admin_separation',
      name,
      status: 'pass',
      detail: `staff only on ${admin}; 11 private paths answer 404; separate clients`,
    });
}

// The only public status endpoint says only safe words.
{
  const name = 'Only a safe readiness endpoint is public';
  const p = await probe(`${siteUrl}/v1/ready`);
  if (!('status' in p)) fail('readiness', name, `no answer (${p.error})`);
  else {
    let body: { status?: string; checks?: Record<string, string> } = {};
    try {
      body = JSON.parse(p.body);
    } catch {}
    const keys = Object.keys(body).sort().join(',');
    if (p.status !== 200 || body.status !== 'ready')
      fail('readiness', name, `HTTP ${p.status}: ${p.body.slice(0, 120)}`);
    else if (keys !== 'checks,status' || /version|host|postgres|secret|key/i.test(p.body))
      fail('readiness', name, 'the readiness answer says more than status words');
    else
      add({
        id: 'readiness',
        name,
        status: body.checks?.worker === 'ok' ? 'pass' : 'warn',
        detail: `ready (database ${body.checks?.database}, schema ${body.checks?.schema}, worker ${body.checks?.worker})`,
      });
  }
}

// ----------------------------------------------------------------------------- database, e-mail, billing, staff
if (config) {
  const app = new pg.Client({ connectionString: config.databaseUrl });
  const ownerUrl = process.env.MIGRATION_DATABASE_URL;
  const owner = ownerUrl ? new pg.Client({ connectionString: ownerUrl }) : null;
  try {
    await app.connect();
    add(await checkDatabase(app));
    if (owner) {
      await owner.connect();
      add(await checkEmail(owner, config));
      add(await checkWebhook(owner, config));
      add(await checkStaff(owner, config));
    } else {
      fail(
        'email_delivery',
        'E-mail is delivered through the real provider',
        'MIGRATION_DATABASE_URL missing',
      );
    }
  } catch (e) {
    fail(
      'database_rls',
      'Database reachable; row-level security enforced',
      `database error (${(e as { code?: string }).code ?? 'connect'})`,
    );
  } finally {
    await app.end().catch(() => undefined);
    await owner?.end().catch(() => undefined);
  }
}

// ----------------------------------------------------------------------------- machine, backups, release
add(checkPrivatePorts(facts));
add(checkFiles(facts));
add(checkBackups(facts));
const readJson = (path: string): unknown => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
};
add(checkReleaseKeys(readJson(join(repo, 'apps/desktop/src-tauri/release-keys.json'))));
add(checkRuntime(readJson(join(repo, 'runtimes/manifest.json'))));
{
  const p = await probe(`${siteUrl}/v1/public/downloads`);
  add(checkArtifact('status' in p && p.status === 200 ? JSON.parse(p.body) : null));
}

// ----------------------------------------------------------------------------- report
const order = ['fail', 'warn', 'pass'];
const report = redactReport(
  {
    generated_at: new Date().toISOString(),
    environment: facts.env,
    hosts: facts.hosts,
    result: results.some((c) => c.status === 'fail') ? 'fail' : 'pass',
    counts: Object.fromEntries(order.map((s) => [s, results.filter((c) => c.status === s).length])),
    checks: results,
  },
  process.env,
);
for (const c of report.checks) {
  const tag =
    c.status === 'pass'
      ? '\x1b[32mPASS\x1b[0m'
      : c.status === 'warn'
        ? '\x1b[33mWARN\x1b[0m'
        : '\x1b[31mFAIL\x1b[0m';
  console.log(`  ${tag}  ${c.id.padEnd(26)} ${c.detail}`);
}
console.log(
  `\n  ${report.result === 'pass' ? 'every required check passed' : 'NOT READY'}: ${report.counts.pass} pass, ${report.counts.warn} warn, ${report.counts.fail} fail`,
);
if (jsonOut) writeFileSync(jsonOut, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o640 });
process.exitCode = report.result === 'pass' ? 0 : 1;
