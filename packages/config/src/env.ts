/**
 * Environment configuration shared by the API and worker.
 *
 * Rules enforced here (milestone 01, step 3):
 *  - dev/test/staging/prod are distinct environments with distinct databases, buckets and identities.
 *  - Development-only authentication can never be enabled outside dev/test.
 *  - Fixture secrets that live in the repository can never be used outside dev/test.
 */

export const APP_ENVS = ['dev', 'test', 'staging', 'prod'] as const;
export type AppEnv = (typeof APP_ENVS)[number];

/** Secrets committed to the repo for local fixtures. Refused outside dev/test. */
export const FIXTURE_SECRETS: readonly string[] = ['dev-only-insecure-fixture-secret-change-me'];

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
  objectStore: { endpoint: string; bucket: string; region: string } | null;
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
  const trustProxyHops = Number(env.TRUST_PROXY_HOPS ?? '0');
  if (!Number.isInteger(trustProxyHops) || trustProxyHops < 0 || trustProxyHops > 5)
    problems.push('TRUST_PROXY_HOPS must be 0-5');

  let objectStore: AppConfig['objectStore'] = null;
  if (env.OBJECT_STORE_BUCKET) {
    objectStore = {
      endpoint: env.OBJECT_STORE_ENDPOINT ?? '',
      bucket: env.OBJECT_STORE_BUCKET,
      region: env.OBJECT_STORE_REGION ?? '',
    };
    if (!local && !objectStore.bucket.endsWith(`-${appEnv}`)) {
      problems.push(`OBJECT_STORE_BUCKET must end with "-${appEnv}" so environments never share a bucket`);
    }
  } else if (!local) {
    problems.push(`OBJECT_STORE_BUCKET is required in ${appEnv}`);
  }

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
    objectStore,
  };
}
