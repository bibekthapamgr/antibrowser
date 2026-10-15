/**
 * R6 (ADR-0025): the production preflight. Named checks, each PASS, FAIL or WARN with a one-line detail that never
 * contains a secret value. scripts/preflight.ts runs them on a staging/production server (with facts about the
 * machine collected by scripts/deploy/preflight.sh as root); the pure and database parts live here so they are tested.
 *
 * A FAIL in a required check means "not ready for customers". WARN is advice. The report is the evidence kept with
 * the release (docs/r6/preflight-report.md).
 */
import type { AppConfig } from '@pb/config/env';
import type pg from 'pg';

export type CheckStatus = 'pass' | 'fail' | 'warn';
export interface CheckResult {
  id: string;
  name: string;
  status: CheckStatus;
  detail: string;
}

/**
 * Tables without row-level security by design (platform data with no organization context, reached only through
 * staff routes, definer functions or the worker). Shared with the database tests, which prove the list is exact.
 */
export const RLS_EXEMPT_TABLES = [
  'account_restrictions',
  'billing_alerts',
  'billing_webhook_events',
  'break_glass_grants',
  'catalog_publications',
  'catalog_state',
  'contact_requests',
  'email_tasks',
  'outbox_events',
  'plan_drafts',
  'plan_prices',
  'plans',
  'platform_audit',
  'platform_audit_head',
  'platform_staff',
  'processed_events',
  'recovery_markers',
  'release_action_requests',
  'staff_role_permissions',
  'staff_sessions',
  'support_access_requests',
  'support_notes',
  'trial_claims',
  'web_auth_requests',
  'worker_heartbeats',
] as const;

/** Facts about the machine, collected as root by scripts/deploy/preflight.sh (no secret values in them). */
export interface MachineFacts {
  env: string;
  tls_mode: string;
  /** Listening TCP sockets as "address:port". */
  listeners: string[];
  /** Ports of this deployment that must never be public. */
  private_ports: number[];
  /** Ports that may be public: SSH and the TLS proxy. */
  public_ports: number[];
  files: { path: string; mode: string; owner: string; expect: string }[];
  backup: {
    configured: boolean;
    newest_backup_epoch: number | null;
    newest_backup_type: string | null;
    last_archived_epoch: number | null;
    last_failed_epoch: number | null;
    objects_copied_epoch: number | null;
  };
  proxy_active: boolean;
  now_epoch: number;
}

const r = (id: string, name: string, status: CheckStatus, detail: string): CheckResult => ({
  id,
  name,
  status,
  detail,
});

export function checkPrivatePorts(f: MachineFacts): CheckResult {
  const name = 'Private ports stay private';
  const exposed: string[] = [];
  const unknown: string[] = [];
  for (const l of f.listeners) {
    const m = /^(.*):(\d+)$/.exec(l);
    if (!m) continue;
    const [, addr = '', portText = ''] = m;
    const port = Number(portText);
    const loopback = /^(127\.\d+\.\d+\.\d+|\[::1\]|::1|\[::ffff:127\.\d+\.\d+\.\d+\]|localhost)$/.test(addr);
    if (loopback) continue;
    if (f.private_ports.includes(port)) exposed.push(`${port}`);
    else if (!f.public_ports.includes(port)) unknown.push(`${port}`);
  }
  if (exposed.length)
    return r('private_ports', name, 'fail', `listening publicly: ${[...new Set(exposed)].join(', ')}`);
  if (!f.proxy_active) return r('private_ports', name, 'fail', 'the TLS proxy (pb-proxy) is not running');
  if (unknown.length)
    return r(
      'private_ports',
      name,
      'warn',
      `database, storage, sign-in administration and service ports on 127.0.0.1 only; other public ports on this server (not Project Browser's): ${[...new Set(unknown)].join(', ')}`,
    );
  return r('private_ports', name, 'pass', 'only SSH and the TLS proxy (80, 443) listen publicly');
}

export function checkBackups(f: MachineFacts): CheckResult {
  const name = 'Off-site backups are recent';
  const b = f.backup;
  if (!b.configured) return r('backup_recency', name, 'fail', 'off-site backups are not set up (backup.env)');
  const age = (epoch: number | null) => (epoch === null ? Number.POSITIVE_INFINITY : f.now_epoch - epoch);
  const hours = (s: number) => (Number.isFinite(s) ? `${Math.round(s / 360) / 10} h` : 'never');
  const problems: string[] = [];
  let warn = false;
  const backupAge = age(b.newest_backup_epoch);
  if (backupAge > 8 * 86400)
    problems.push(`newest database backup ${hours(backupAge)} old (weekly full + daily expected)`);
  else if (backupAge > 26 * 3600) warn = true;
  if (
    b.last_failed_epoch !== null &&
    (b.last_archived_epoch === null || b.last_failed_epoch > b.last_archived_epoch)
  )
    problems.push('log archiving to R2 is failing now (newest attempt failed)');
  const objectsAge = age(b.objects_copied_epoch);
  if (objectsAge > 15 * 60)
    problems.push(`snapshot objects last copied ${hours(objectsAge)} ago (every 2 minutes expected)`);
  if (problems.length) return r('backup_recency', name, 'fail', problems.join('; '));
  const detail = `database backup ${hours(backupAge)} old (${b.newest_backup_type ?? '?'}), log archiving working, objects copied ${Math.round(objectsAge / 60)} min ago`;
  return r('backup_recency', name, warn ? 'warn' : 'pass', detail);
}

export function checkFiles(f: MachineFacts): CheckResult {
  const name = 'Secret files are private';
  const wrong = f.files.filter((x) => x.mode !== 'missing' && `${x.mode} ${x.owner}` !== x.expect);
  if (wrong.length)
    return r(
      'env_files',
      name,
      'fail',
      wrong.map((x) => `${x.path} is ${x.mode} ${x.owner} (expected ${x.expect})`).join('; '),
    );
  return r('env_files', name, 'pass', `${f.files.filter((x) => x.mode !== 'missing').length} files checked`);
}

export function checkTlsMode(f: MachineFacts): CheckResult {
  const name = 'Publicly trusted certificates';
  if (f.tls_mode === 'public')
    return r('tls_mode', name, 'pass', 'certificates from a public authority (ACME)');
  return r(
    'tls_mode',
    name,
    f.env === 'prod' ? 'fail' : 'warn',
    'TLS_MODE=internal: certificates from a private authority (tests only)',
  );
}

export function checkReleaseKeys(json: unknown): CheckResult {
  const name = 'Release keys installed';
  const keys = (json as { keys?: unknown[] } | null)?.keys;
  if (!Array.isArray(keys) || keys.length === 0)
    return r(
      'release_keys',
      name,
      'fail',
      'apps/desktop/src-tauri/release-keys.json is empty: apps would trust no update (owner: generate the release key)',
    );
  return r('release_keys', name, 'pass', `${keys.length} trusted release key(s) compiled into the app`);
}

export function checkRuntime(manifest: unknown): CheckResult {
  const name = 'Browser runtime may be given to customers';
  const d = (manifest as { distribution?: { name?: string; customer_distribution?: boolean } } | null)
    ?.distribution;
  if (d?.customer_distribution === true)
    return r(
      'runtime_eligibility',
      name,
      'pass',
      `${d.name ?? 'runtime'} is approved for customer distribution`,
    );
  return r(
    'runtime_eligibility',
    name,
    'fail',
    `${d?.name ?? 'the runtime'} is not approved for customer distribution (ADR-0010 gate; updater tests do not resolve licensing)`,
  );
}

export function checkArtifact(downloads: { status?: string; version?: string | null } | null): CheckResult {
  const name = 'A verified signed release is offered';
  if (downloads?.status === 'available')
    return r(
      'artifact_eligibility',
      name,
      'pass',
      `stable ${downloads.version ?? ''} verified against the release keys`,
    );
  return r(
    'artifact_eligibility',
    name,
    'fail',
    `the download page offers no verified stable release (${downloads?.status ?? 'unreachable'})`,
  );
}

export function checkDevAuth(config: AppConfig, probeStatus: number | null): CheckResult {
  const name = 'Development sign-in is off';
  if (config.appEnv === 'dev' || config.appEnv === 'test')
    return r('dev_auth_disabled', name, 'fail', `APP_ENV is ${config.appEnv}`);
  if (config.devAuth.enabled) return r('dev_auth_disabled', name, 'fail', 'DEV_AUTH_ENABLED is on');
  if (probeStatus !== null && probeStatus !== 401)
    return r('dev_auth_disabled', name, 'fail', `a made-up development token got HTTP ${probeStatus}`);
  return r(
    'dev_auth_disabled',
    name,
    probeStatus === null ? 'warn' : 'pass',
    probeStatus === null
      ? 'configuration OK; the public API did not answer the probe'
      : 'off; a made-up development token is refused (401)',
  );
}

/** The application role cannot bypass row-level security, sees nothing without a tenant, and every table but the
 *  platform ones has row-level security. */
export async function checkDatabase(app: pg.ClientBase): Promise<CheckResult> {
  const name = 'Database reachable; row-level security enforced';
  const role = await app.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
    'select rolsuper, rolbypassrls from pg_roles where rolname = current_user',
  );
  const rr = role.rows[0];
  if (!rr || rr.rolsuper || rr.rolbypassrls)
    return r(
      'database_rls',
      name,
      'fail',
      'the application role is a superuser or bypasses row-level security',
    );
  const open = await app.query<{ relname: string }>(
    `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'app' and c.relkind = 'r' and not c.relrowsecurity order by 1`,
  );
  const unexpected = open.rows
    .map((x) => x.relname)
    .filter((t) => !(RLS_EXEMPT_TABLES as readonly string[]).includes(t));
  if (unexpected.length)
    return r('database_rls', name, 'fail', `tables without row-level security: ${unexpected.join(', ')}`);
  await app.query('begin');
  try {
    await app.query("select set_config('app.org_id', '', true), set_config('app.user_id', '', true)");
    const seen = await app.query<{ n: number }>(
      'select (select count(*) from app.profiles) + (select count(*) from app.memberships) as n',
    );
    if (Number(seen.rows[0]?.n ?? 0) !== 0)
      return r('database_rls', name, 'fail', 'without a tenant the application role still sees rows');
  } finally {
    await app.query('rollback');
  }
  return r(
    'database_rls',
    name,
    'pass',
    'connected as the application role; no tenant, no rows; policies on every tenant table',
  );
}

/** Real provider delivery: an e-mail the worker handed to the mail server recently. */
export async function checkEmail(owner: pg.ClientBase, config: AppConfig): Promise<CheckResult> {
  const name = 'E-mail is delivered through the real provider';
  if (!config.email.smtpUrl) return r('email_delivery', name, 'fail', 'no mail server configured (smtp.env)');
  const { rows } = await owner.query<{ sent: number; failed: number }>(
    `select count(*) filter (where state = 'sent' and sent_at > now() - interval '30 days')::int as sent,
            count(*) filter (where state = 'failed' and created_at > now() - interval '1 day')::int as failed
       from app.email_tasks`,
  );
  const x = rows[0] ?? { sent: 0, failed: 0 };
  if (x.sent === 0)
    return r(
      'email_delivery',
      name,
      'fail',
      'mail server configured, but nothing delivered in 30 days: send a message through the website contact form',
    );
  if (x.failed > 0)
    return r(
      'email_delivery',
      name,
      'warn',
      `${x.sent} delivered in 30 days; ${x.failed} failed in the last day`,
    );
  return r(
    'email_delivery',
    name,
    'pass',
    `${x.sent} e-mail(s) delivered in 30 days, none failed in the last day`,
  );
}

/** The verified webhook is the entitlement authority: signing secrets set, a verified event received, no recent
 *  signature failures. */
export async function checkWebhook(owner: pg.ClientBase, config: AppConfig): Promise<CheckResult> {
  const name = 'Billing webhook signature verified';
  const stripe = config.billing.stripe;
  if (!stripe) return r('webhook_signature', name, 'fail', 'billing is not configured (billing.env)');
  if (config.appEnv === 'prod' && !stripe.livemode)
    return r('webhook_signature', name, 'fail', 'production uses a Stripe test key');
  const { rows } = await owner.query<{ verified: number; wrong_mode: number; failures: number }>(
    `select (select count(*)::int from app.billing_webhook_events
              where livemode = $1 and received_at > now() - interval '30 days') as verified,
            (select count(*)::int from app.billing_webhook_events
              where livemode <> $1 and received_at > now() - interval '30 days') as wrong_mode,
            (select coalesce(sum(count), 0)::int from app.billing_alerts
              where kind = 'signature_failures' and resolved_at is null and last_seen_at > now() - interval '1 day') as failures`,
    [stripe.livemode],
  );
  const x = rows[0] ?? { verified: 0, wrong_mode: 0, failures: 0 };
  if (x.verified === 0)
    return r(
      'webhook_signature',
      name,
      'fail',
      `no signed ${stripe.livemode ? 'live' : 'test'}-mode event received in 30 days: send one from the Stripe Dashboard webhook page`,
    );
  if (x.failures > 0 || x.wrong_mode > 0)
    return r(
      'webhook_signature',
      name,
      'warn',
      `${x.verified} verified event(s); ${x.failures} signature failure(s) in the last day; ${x.wrong_mode} of the other mode`,
    );
  return r(
    'webhook_signature',
    name,
    'pass',
    `${x.verified} signature-verified event(s) in 30 days, no failures`,
  );
}

export async function checkStaff(owner: pg.ClientBase, config: AppConfig): Promise<CheckResult> {
  const name = 'Staff need a second factor; an owner exists';
  if (!config.console.requireMfa) return r('staff_mfa', name, 'fail', 'STAFF_REQUIRE_MFA is off');
  const { rows } = await owner.query<{ owners: number }>(
    `select count(*)::int as owners from app.platform_staff
      where 'platform_owner' = any(roles) and disabled_at is null`,
  );
  if ((rows[0]?.owners ?? 0) === 0)
    return r(
      'staff_mfa',
      name,
      'fail',
      'no platform owner yet (services/api/scripts/staff.ts bootstrap-owner)',
    );
  return r(
    'staff_mfa',
    name,
    'pass',
    `every staff sign-in needs a one-time code; ${rows[0]?.owners} platform owner(s)`,
  );
}

/** Defence in depth: never print a configured secret, even by accident in a detail line. */
export function redactReport<T>(report: T, env: Record<string, string | undefined>): T {
  let text = JSON.stringify(report);
  const secretish = /(KEY|SECRET|PASSWORD|TOKEN|PASS|_URL|DSN)$/;
  const values = Object.entries(env)
    .filter(([k, v]) => v && v.length >= 12 && secretish.test(k))
    .map(([, v]) => v as string)
    .sort((a, b) => b.length - a.length);
  for (const v of values) {
    const escaped = JSON.stringify(v).slice(1, -1);
    text = text.split(escaped).join('[redacted]');
  }
  return JSON.parse(text) as T;
}
