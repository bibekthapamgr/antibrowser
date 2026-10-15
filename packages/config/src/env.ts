/**
 * Environment configuration shared by the API and worker.
 *
 * Rules enforced here (milestone 01, step 3):
 *  - dev/test/staging/prod are distinct environments with distinct databases, buckets and identities.
 *  - Development-only authentication can never be enabled outside dev/test.
 *  - Fixture secrets that live in the repository can never be used outside dev/test.
 */

import { readFileSync, statSync } from 'node:fs';

export const APP_ENVS = ['dev', 'test', 'staging', 'prod'] as const;
export type AppEnv = (typeof APP_ENVS)[number];

/** Secrets committed to the repo for local fixtures. Refused outside dev/test. */
export const FIXTURE_SECRETS: readonly string[] = [
  'dev-only-insecure-fixture-secret-change-me',
  'pb-local-fixture-secret-key',
];
/** Root key material committed to the repo (infra/env/*.example). Refused outside dev/test. */
export const FIXTURE_ROOT_KEYS: readonly string[] = ['ZGV2LW9ubHktaW5zZWN1cmUtcm9vdC1rZXktMzJieXQ='];

/**
 * Root keys of the `local` key provider (ADR-0014): AES-256 keys that wrap the organizations' keys. `active` wraps
 * new organization keys; the others stay only to unwrap (and re-wrap) older ones.
 */
export interface LocalKmsConfig {
  provider: 'local';
  activeKeyId: string;
  /** Key id -> 32 bytes, base64. */
  keys: Record<string, string>;
}

export interface AppConfig {
  appEnv: AppEnv;
  databaseUrl: string;
  /** Separate role used by the outbox worker. */
  workerDatabaseUrl: string;
  host: string;
  port: number;
  logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';
  devAuth: { enabled: true; secret: string } | { enabled: false };
  /** The identity provider (ADR-0004, ADR-0013): ID tokens are issued by `issuer` for the desktop `clientId`. */
  oidc: { issuer: string; clientId: string; redirectUri: string; scopes: string[] } | null;
  /** API session tokens (ADR-0013). Without a signing key (dev/test only) an ephemeral key is generated per process. */
  session: {
    issuer: string;
    signingKeyJwk: string | null;
    previousPublicKeysJwk: string | null;
    accessTtlSeconds: number;
    refreshIdleSeconds: number;
    refreshAbsoluteSeconds: number;
    recentAuthSeconds: number;
  };
  /** Number of trusted reverse-proxy hops for the client address (0 = use the socket address). */
  trustProxyHops: number;
  /**
   * Milestone 12: the lowest desktop app version allowed to use the API (null: any). Desktop requests below it, or
   * from a desktop too old to say its version, get CLIENT_UPDATE_REQUIRED.
   */
  minDesktopVersion: string | null;
  /** Private S3-compatible storage for encrypted snapshots (milestone 07). */
  objectStore: {
    /** API/worker endpoint ('' = the provider's default). */
    endpoint: string;
    /** Endpoint written into signed URLs for devices (defaults to `endpoint`). */
    publicEndpoint: string;
    bucket: string;
    region: string;
    accessKeyId: string | null;
    secretAccessKey: string | null;
    forcePathStyle: boolean;
  } | null;
  /** Root key provider for organization keys (milestone 07). Required whenever object storage is configured. */
  kms: LocalKmsConfig | null;
  /**
   * Webhooks (milestone 10). allowPrivateDestinations lets dev/test deliver to local receivers (refused elsewhere: in
   * staging and production only public HTTPS destinations are accepted and resolved addresses are checked again at
   * every delivery).
   */
  webhooks: { allowPrivateDestinations: boolean };
  /**
   * Billing (milestone 11, ADR-0018). `stripe` is null when no key is configured: billing routes answer
   * BILLING_UNAVAILABLE and nothing else is affected. Test keys only outside production, live keys only in production.
   */
  billing: {
    stripe: {
      secretKey: string;
      /** Endpoint signing secrets (several during a rotation). */
      webhookSecrets: string[];
      /** https://api.stripe.com, or a local fake/mock in dev/test. */
      apiBase: string;
      livemode: boolean;
    } | null;
    /** `plan@version` -> provider price id. A plan without a price is not offered. */
    prices: Record<string, string>;
    /** Where checkout and the portal send the person back (an informational page; never proof of payment). */
    returnUrl: string;
    /** Ask the provider to calculate tax (needs the merchant's tax registrations in the provider). */
    automaticTax: boolean;
    /** The owner's data retention policy after cancellation, if decided (null: kept until an owner deletes it). */
    retentionDays: number | null;
    /** The provider's customer portal configuration to use (bpc_…); null: the account's default. */
    portalConfiguration: string | null;
  };
  /** The internal support console (milestone 11): static files served at /console/ and its own OIDC client. */
  console: {
    dir: string | null;
    oidcClientId: string | null;
    /**
     * R5: `amr` values that count as a second factor at staff sign-in (STAFF_MFA_AMR, comma-separated; default
     * otp,hwk,swk,mfa). Admin routes need a console session whose sign-in carried one of them.
     */
    mfaAmr: string[];
  };
  /** R2 (ADR-0021): the terms a new workspace owner accepts (a version label; the text lives on the website). */
  onboarding: { termsVersion: string; termsUrl: string | null };
  /**
   * R2: the customer web portal (backend-for-frontend). `origin` is the exact public origin it is served from
   * (cookies, redirects and Origin checks use it); `oidcClientId` its own public OIDC client (PKCE). Null: no portal.
   */
  web: {
    origin: string | null;
    oidcClientId: string | null;
    dir: string | null;
    sessionIdleSeconds: number;
    sessionAbsoluteSeconds: number;
  };
  /**
   * R2: e-mail the worker sends (invitation links, welcome). `taskKey` (32 bytes, EMAIL_TASK_KEY in base64) encrypts
   * queued links; the database never holds it. `smtpUrl` is read by the worker only; null: tasks are marked skipped.
   */
  email: { taskKey: Buffer | null; smtpUrl: string | null; from: string | null };
  /**
   * R4 (ADR-0023): the public website. `dir`: its built pages, served at / (PUBLIC_DIR; staging serves site, portal
   * and API from one origin until R6 gives them their own hosts). `supportEmail` receives contact requests and
   * account deletion requests; `statusUrl` is linked as the service status page; `downloadChannelUrl` is the signed
   * stable update channel the download page reads; `releaseKeysFile` the public keys the app trusts.
   */
  site: {
    dir: string | null;
    supportEmail: string | null;
    statusUrl: string | null;
    downloadChannelUrl: string | null;
    releaseKeysFile: string | null;
  };
}

export class ConfigError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`Invalid configuration:\n - ${problems.join('\n - ')}`);
    this.problems = problems;
    this.name = 'ConfigError';
  }
}

type Env = Record<string, string | undefined>;

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace'] as const;

export function loadConfig(env: Env = process.env): AppConfig {
  const problems: string[] = [];
  const appEnvRaw = env.APP_ENV ?? 'dev';
  const appEnv = (APP_ENVS as readonly string[]).includes(appEnvRaw) ? (appEnvRaw as AppEnv) : undefined;
  if (!appEnv) problems.push(`APP_ENV must be one of ${APP_ENVS.join(', ')} (got "${appEnvRaw}")`);
  const local = appEnv === 'dev' || appEnv === 'test';

  const databaseUrl = env.DATABASE_URL ?? '';
  if (!databaseUrl) problems.push('DATABASE_URL is required');
  const workerDatabaseUrl = env.WORKER_DATABASE_URL ?? '';
  if (!workerDatabaseUrl) problems.push('WORKER_DATABASE_URL is required');

  const port = Number(env.PORT ?? '8080');
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    problems.push('PORT must be 0-65535 (0 = ephemeral)');

  const logLevelRaw = env.LOG_LEVEL ?? 'info';
  const logLevel = (LOG_LEVELS as readonly string[]).includes(logLevelRaw)
    ? (logLevelRaw as AppConfig['logLevel'])
    : 'info';

  let devAuth: AppConfig['devAuth'] = { enabled: false };
  if (env.DEV_AUTH_ENABLED === 'true') {
    if (!local) {
      problems.push('DEV_AUTH_ENABLED is only permitted when APP_ENV is dev or test');
    } else {
      const secret = env.DEV_AUTH_SECRET ?? '';
      if (secret.length < 32) problems.push('DEV_AUTH_SECRET must be at least 32 characters');
      devAuth = { enabled: true, secret };
    }
  }

  if (!local) {
    for (const [key, value] of Object.entries(env)) {
      if (value && FIXTURE_SECRETS.includes(value)) {
        problems.push(`${key} contains a repository fixture secret; refusing to start in ${appEnv}`);
      }
    }
    for (const url of [databaseUrl, workerDatabaseUrl]) {
      if (/@(localhost|127\.0\.0\.1)[:/]/.test(url)) {
        problems.push(`database URL points at localhost in ${appEnv}`);
      }
    }
  }

  let oidc: AppConfig['oidc'] = null;
  if (env.OIDC_ISSUER) {
    oidc = {
      issuer: env.OIDC_ISSUER,
      clientId: env.OIDC_CLIENT_ID ?? '',
      redirectUri: env.OIDC_REDIRECT_URI ?? 'projectbrowser://auth/callback',
      scopes: (env.OIDC_SCOPES ?? 'openid email profile').split(/\s+/).filter(Boolean),
    };
    if (!oidc.clientId) problems.push('OIDC_CLIENT_ID is required when OIDC_ISSUER is set');
    if (!local && !oidc.issuer.startsWith('https://')) problems.push('OIDC_ISSUER must use https');
    if (!oidc.scopes.includes('openid')) problems.push('OIDC_SCOPES must include openid');
  } else if (!local) {
    problems.push(`OIDC_ISSUER is required in ${appEnv}`);
  }

  const seconds = (key: string, fallback: number, min: number, max: number): number => {
    const value = Number(env[key] ?? fallback);
    if (!Number.isInteger(value) || value < min || value > max) {
      problems.push(`${key} must be an integer between ${min} and ${max}`);
      return fallback;
    }
    return value;
  };
  const session: AppConfig['session'] = {
    issuer: env.SESSION_ISSUER ?? `pb-api-${appEnvRaw}`,
    signingKeyJwk: env.SESSION_SIGNING_KEY ?? null,
    previousPublicKeysJwk: env.SESSION_PREVIOUS_PUBLIC_KEYS ?? null,
    accessTtlSeconds: seconds('SESSION_ACCESS_TTL_SECONDS', 600, 60, 3600),
    refreshIdleSeconds: seconds('SESSION_REFRESH_IDLE_SECONDS', 14 * 86400, 3600, 90 * 86400),
    refreshAbsoluteSeconds: seconds('SESSION_REFRESH_ABSOLUTE_SECONDS', 30 * 86400, 3600, 365 * 86400),
    recentAuthSeconds: seconds('SESSION_RECENT_AUTH_SECONDS', 600, 60, 3600),
  };
  if (!local && !session.signingKeyJwk) problems.push(`SESSION_SIGNING_KEY is required in ${appEnv}`);
  const minDesktopVersion = env.MIN_DESKTOP_VERSION?.trim() || null;
  if (minDesktopVersion && !/^\d+\.\d+\.\d+$/.test(minDesktopVersion))
    problems.push('MIN_DESKTOP_VERSION must be a plain version such as 0.12.0');
  const trustProxyHops = Number(env.TRUST_PROXY_HOPS ?? '0');
  if (!Number.isInteger(trustProxyHops) || trustProxyHops < 0 || trustProxyHops > 5)
    problems.push('TRUST_PROXY_HOPS must be 0-5');

  let objectStore: AppConfig['objectStore'] = null;
  if (env.OBJECT_STORE_BUCKET) {
    const endpoint = env.OBJECT_STORE_ENDPOINT ?? '';
    objectStore = {
      endpoint,
      publicEndpoint: env.OBJECT_STORE_PUBLIC_ENDPOINT ?? endpoint,
      bucket: env.OBJECT_STORE_BUCKET,
      region: env.OBJECT_STORE_REGION || 'us-east-1',
      accessKeyId: env.OBJECT_STORE_ACCESS_KEY_ID || null,
      secretAccessKey: env.OBJECT_STORE_SECRET_ACCESS_KEY || null,
      forcePathStyle: env.OBJECT_STORE_FORCE_PATH_STYLE === 'true',
    };
    if (!local && !objectStore.bucket.endsWith(`-${appEnv}`)) {
      problems.push(`OBJECT_STORE_BUCKET must end with "-${appEnv}" so environments never share a bucket`);
    }
    if (Boolean(objectStore.accessKeyId) !== Boolean(objectStore.secretAccessKey)) {
      problems.push('OBJECT_STORE_ACCESS_KEY_ID and OBJECT_STORE_SECRET_ACCESS_KEY go together');
    }
    for (const [name, url] of [
      ['OBJECT_STORE_ENDPOINT', objectStore.endpoint],
      ['OBJECT_STORE_PUBLIC_ENDPOINT', objectStore.publicEndpoint],
    ] as const) {
      if (url && !secureOrLoopback(url, local)) problems.push(`${name} must use https`);
    }
  } else if (!local) {
    problems.push(`OBJECT_STORE_BUCKET is required in ${appEnv}`);
  }

  const allowPrivateDestinations = env.WEBHOOK_ALLOW_PRIVATE_DESTINATIONS === 'true';
  if (allowPrivateDestinations && !local) {
    problems.push('WEBHOOK_ALLOW_PRIVATE_DESTINATIONS is only permitted when APP_ENV is dev or test');
  }

  const billing = loadBilling(env, appEnv, local, problems);
  const consoleDir = env.CONSOLE_DIR || null;
  const consoleClient = env.OIDC_CONSOLE_CLIENT_ID || null;
  if (consoleClient && !oidc) problems.push('OIDC_CONSOLE_CLIENT_ID needs OIDC_ISSUER');
  const mfaAmr = (env.STAFF_MFA_AMR || 'otp,hwk,swk,mfa')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
  if (mfaAmr.length === 0 || mfaAmr.some((v) => !/^[a-z]{2,16}$/.test(v)) || mfaAmr.includes('pwd')) {
    problems.push('STAFF_MFA_AMR must list second-factor amr values (e.g. otp), never pwd');
  }

  const termsVersion = env.TERMS_VERSION || '2026-10-14';
  if (!/^[A-Za-z0-9._-]{1,32}$/.test(termsVersion))
    problems.push('TERMS_VERSION must be 1-32 of A-Z a-z 0-9 . _ -');
  const webOrigin = env.WEB_ORIGIN?.replace(/\/$/, '') || null;
  if (webOrigin) {
    let parsed: URL | null = null;
    try {
      parsed = new URL(webOrigin);
    } catch {
      problems.push('WEB_ORIGIN must be an origin such as https://app.example.com');
    }
    if (parsed && (parsed.origin !== webOrigin || !secureOrLoopback(webOrigin, local)))
      problems.push('WEB_ORIGIN must be an https origin (scheme://host[:port], nothing after it)');
  }
  const webClient = env.OIDC_WEB_CLIENT_ID || null;
  if (webClient && (!oidc || !webOrigin))
    problems.push('OIDC_WEB_CLIENT_ID needs OIDC_ISSUER and WEB_ORIGIN');
  const web: AppConfig['web'] = {
    origin: webOrigin,
    oidcClientId: webClient,
    dir: env.WEB_DIR || null,
    sessionIdleSeconds: seconds('WEB_SESSION_IDLE_SECONDS', 1800, 300, 86400),
    sessionAbsoluteSeconds: seconds('WEB_SESSION_ABSOLUTE_SECONDS', 12 * 3600, 3600, 7 * 86400),
  };
  let taskKey: Buffer | null = null;
  if (env.EMAIL_TASK_KEY) {
    taskKey = Buffer.from(env.EMAIL_TASK_KEY, 'base64');
    if (taskKey.length !== 32) {
      problems.push('EMAIL_TASK_KEY must be 32 bytes in base64');
      taskKey = null;
    }
  }
  const smtpUrl = env.SMTP_URL || null;
  if (smtpUrl && !/^smtps?:\/\//.test(smtpUrl)) problems.push('SMTP_URL must start with smtp:// or smtps://');
  const emailFrom = env.EMAIL_FROM || null;
  if (smtpUrl && !emailFrom) problems.push('EMAIL_FROM is required with SMTP_URL');

  const supportEmail = env.SUPPORT_EMAIL?.trim().toLowerCase() || null;
  if (supportEmail && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(supportEmail))
    problems.push('SUPPORT_EMAIL must be an e-mail address');
  const statusUrl = env.STATUS_URL || null;
  if (statusUrl && !secureOrLoopback(statusUrl, local)) problems.push('STATUS_URL must use https');
  const channelUrl =
    env.DOWNLOAD_CHANNEL_URL === 'none'
      ? null
      : env.DOWNLOAD_CHANNEL_URL ||
        'https://github.com/bibekthapamgr/antibrowser/releases/download/channel-stable/stable.json';
  if (channelUrl && !secureOrLoopback(channelUrl, local))
    problems.push('DOWNLOAD_CHANNEL_URL must use https (or "none")');
  const site: AppConfig['site'] = {
    dir: env.PUBLIC_DIR || null,
    supportEmail,
    statusUrl,
    downloadChannelUrl: channelUrl,
    releaseKeysFile: env.RELEASE_KEYS_FILE || null,
  };

  const kms = loadKms(env, local, problems);
  if (objectStore && !kms)
    problems.push('a key provider (KMS_LOCAL_KEY_FILE) is required with object storage');

  if (problems.length > 0 || !appEnv) throw new ConfigError(problems);

  return {
    appEnv,
    databaseUrl,
    workerDatabaseUrl,
    host: env.HOST ?? (local ? '127.0.0.1' : '0.0.0.0'),
    port,
    logLevel,
    devAuth,
    oidc,
    session,
    trustProxyHops,
    minDesktopVersion,
    objectStore,
    kms,
    webhooks: { allowPrivateDestinations: allowPrivateDestinations && local },
    billing,
    console: { dir: consoleDir, oidcClientId: consoleClient, mfaAmr },
    onboarding: { termsVersion, termsUrl: env.TERMS_URL || null },
    web,
    email: { taskKey, smtpUrl, from: emailFrom },
    site,
  };
}

/** `plan@version`, or (R4) `plan@version/month` and `plan@version/year`. */
const PLAN_KEY = /^[a-z][a-z0-9_]{1,31}@[1-9][0-9]{0,5}(\/(month|year))?$/;
const PRICE_ID = /^price_[A-Za-z0-9]{1,64}$/;

/**
 * STRIPE_SECRET_KEY (sk_/rk_ test keys outside prod, live keys only in prod), STRIPE_WEBHOOK_SECRETS (whsec_…,
 * comma-separated), STRIPE_API_BASE (dev/test only), BILLING_STRIPE_PRICES (JSON {"team@1": "price_…"}),
 * BILLING_RETURN_URL, BILLING_AUTOMATIC_TAX, BILLING_RETENTION_DAYS.
 */
function loadBilling(
  env: Env,
  appEnv: AppEnv | undefined,
  local: boolean,
  problems: string[],
): AppConfig['billing'] {
  const key = env.STRIPE_SECRET_KEY ?? '';
  let stripe: AppConfig['billing']['stripe'] = null;
  if (key) {
    const live = /^(sk|rk)_live_[A-Za-z0-9]{8,}$/.test(key);
    const test = /^(sk|rk)_test_[A-Za-z0-9]{8,}$/.test(key);
    if (!live && !test) problems.push('STRIPE_SECRET_KEY is not a Stripe secret or restricted key');
    if (live && appEnv !== 'prod') problems.push('a live Stripe key is only permitted when APP_ENV is prod');
    if (test && appEnv === 'prod') problems.push('a Stripe test key is not permitted when APP_ENV is prod');
    const webhookSecrets = (env.STRIPE_WEBHOOK_SECRETS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (webhookSecrets.length === 0)
      problems.push('STRIPE_WEBHOOK_SECRETS is required with STRIPE_SECRET_KEY');
    if (webhookSecrets.some((s) => !/^whsec_[A-Za-z0-9+/=_-]{16,}$/.test(s))) {
      problems.push('STRIPE_WEBHOOK_SECRETS must be whsec_… values');
    }
    const apiBase = env.STRIPE_API_BASE || 'https://api.stripe.com';
    if (apiBase !== 'https://api.stripe.com' && !local) {
      problems.push('STRIPE_API_BASE can only be changed when APP_ENV is dev or test');
    } else if (!secureOrLoopback(apiBase, local)) {
      problems.push('STRIPE_API_BASE must use https');
    }
    stripe = { secretKey: key, webhookSecrets, apiBase: apiBase.replace(/\/+$/, ''), livemode: live };
  }
  const prices: Record<string, string> = {};
  if (env.BILLING_STRIPE_PRICES) {
    try {
      const parsed = JSON.parse(env.BILLING_STRIPE_PRICES) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
      for (const [plan, price] of Object.entries(parsed as Record<string, unknown>)) {
        if (!PLAN_KEY.test(plan) || typeof price !== 'string' || !PRICE_ID.test(price)) {
          problems.push(
            'BILLING_STRIPE_PRICES maps "plan@version" (or "plan@version/year") to "price_…" ids',
          );
          break;
        }
        prices[plan] = price;
      }
    } catch {
      problems.push('BILLING_STRIPE_PRICES must be a JSON object');
    }
  }
  const returnUrl = env.BILLING_RETURN_URL || 'http://127.0.0.1:8080/v1/billing/return';
  if (!secureOrLoopback(returnUrl, local)) problems.push('BILLING_RETURN_URL must use https');
  const retention = env.BILLING_RETENTION_DAYS ? Number(env.BILLING_RETENTION_DAYS) : null;
  if (retention !== null && (!Number.isInteger(retention) || retention < 30 || retention > 3650)) {
    problems.push('BILLING_RETENTION_DAYS must be an integer between 30 and 3650');
  }
  const portal = env.STRIPE_PORTAL_CONFIGURATION || null;
  if (portal !== null && !/^bpc_[A-Za-z0-9]{8,64}$/.test(portal)) {
    problems.push('STRIPE_PORTAL_CONFIGURATION must be a bpc_… id');
  }
  return {
    stripe,
    prices,
    returnUrl,
    automaticTax: env.BILLING_AUTOMATIC_TAX === 'true',
    retentionDays: retention,
    portalConfiguration: portal,
  };
}

function secureOrLoopback(raw: string, local: boolean): boolean {
  try {
    const u = new URL(raw);
    if (u.protocol === 'https:') return true;
    const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
    return u.protocol === 'http:' && (local || loopback);
  } catch {
    return false;
  }
}

/**
 * The `local` key provider: KMS_LOCAL_KEY_FILE (a root-only JSON file `{"active": "<id>", "keys": {"<id>": "<base64
 * of 32 bytes>"}}`) or, in dev/test only, the same JSON in KMS_LOCAL_KEYS.
 */
function loadKms(env: Env, local: boolean, problems: string[]): LocalKmsConfig | null {
  let raw: string | undefined;
  if (env.KMS_LOCAL_KEY_FILE) {
    try {
      const stat = statSync(env.KMS_LOCAL_KEY_FILE);
      if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
        problems.push('KMS_LOCAL_KEY_FILE must be readable by its owner only (chmod 600)');
      }
      raw = readFileSync(env.KMS_LOCAL_KEY_FILE, 'utf8');
    } catch {
      problems.push('KMS_LOCAL_KEY_FILE cannot be read');
      return null;
    }
  } else if (env.KMS_LOCAL_KEYS) {
    if (!local) {
      problems.push('KMS_LOCAL_KEYS is only permitted in dev/test; use KMS_LOCAL_KEY_FILE');
      return null;
    }
    raw = env.KMS_LOCAL_KEYS;
  } else {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    problems.push('the local key file is not valid JSON');
    return null;
  }
  const p = parsed as { active?: unknown; keys?: unknown };
  const keys = p.keys && typeof p.keys === 'object' ? (p.keys as Record<string, unknown>) : {};
  const out: Record<string, string> = {};
  for (const [id, value] of Object.entries(keys)) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id) || typeof value !== 'string') {
      problems.push('local root keys need ids [A-Za-z0-9_-] and base64 values');
      return null;
    }
    if (Buffer.from(value, 'base64').length !== 32) {
      problems.push(`local root key "${id}" must be 32 bytes (base64)`);
      return null;
    }
    if (!local && FIXTURE_ROOT_KEYS.includes(value)) {
      problems.push(`local root key "${id}" is a repository fixture; refusing to start outside dev/test`);
    }
    out[id] = value;
  }
  if (typeof p.active !== 'string' || !(p.active in out)) {
    problems.push('the local key file must name an "active" key that it contains');
    return null;
  }
  return { provider: 'local', activeKeyId: p.active, keys: out };
}
