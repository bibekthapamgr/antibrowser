import { randomBytes } from 'node:crypto';
import { loadConfig } from '@pb/config/env';
import type { Session } from '@pb/contracts';
import pg from 'pg';
import { devToken } from '../scripts/dev-token.ts';
import { type App, buildApp } from '../src/app.ts';
import type { JobDeps } from '../src/backup/jobs.ts';
import { localKeyProvider, type RootKeyProvider } from '../src/backup/keys.ts';
import { MemoryObjectStore, type ObjectStore, s3ObjectStore } from '../src/backup/objects.ts';
import { createPool } from '../src/db.ts';
import { FIXTURES, type FixtureUserKey } from '../src/fixtures.ts';
import type { IdTokenVerifier } from '../src/oidc.ts';
import { nonce, TEST_CLIENT_ID, TEST_ISSUER, type TestIdp, testIdp } from './idp.ts';

export interface Harness {
  app: App;
  pool: pg.Pool;
  /** Schema-owner pool for test setup and inspection only (bypasses row-level security). */
  owner: pg.Pool;
  idp: TestIdp;
  /** Development token for a fixture user (dev principal: no device, no recent sign-in). */
  token: (user: FixtureUserKey) => Promise<string>;
  auth: (user: FixtureUserKey) => Promise<Record<string, string>>;
  /** Signs a person in through the test identity provider and enrolls a device. */
  signIn: (person?: Partial<Person>) => Promise<SignedIn>;
  /** Snapshot storage used by the app (in-memory unless the harness was built with storage: 's3'). */
  objects: ObjectStore;
  memory: MemoryObjectStore | null;
  kms: RootKeyProvider;
  /** The worker's database role and job dependencies (verification, retention, keys...). */
  worker: pg.Pool;
  jobs: JobDeps;
  close: () => Promise<void>;
}

export interface Person {
  sub: string;
  email: string;
  verified: boolean;
  name: string;
}

export interface SignedIn {
  person: Person;
  session: Session;
  headers: Record<string, string>;
}

export interface HarnessOptions {
  poolMax?: number;
  /** Captures every log line (the app logs at the configured level). */
  logLines?: string[];
  /** 'memory' (default): an in-memory object store; 's3': the configured S3-compatible store. */
  storage?: 'memory' | 's3';
  /** Milestone 11: extra environment for the configuration (billing provider, prices). */
  env?: Record<string, string>;
  /** Milestone 11: the support console's client id (its ID tokens are signed by the same test provider). */
  consoleClientId?: string;
  /** Milestone 12: another root key provider (an unavailable key service). */
  kms?: RootKeyProvider;
  /** R2: verifiers for another identity provider (the web portal tests run a local one over HTTP). */
  idTokens?: IdTokenVerifier;
  webIdTokens?: IdTokenVerifier;
}

export async function harness(opts: HarnessOptions = {}): Promise<Harness> {
  const config = loadConfig({
    ...process.env,
    OIDC_ISSUER: TEST_ISSUER,
    OIDC_CLIENT_ID: TEST_CLIENT_ID,
    ...(opts.consoleClientId ? { OIDC_CONSOLE_CLIENT_ID: opts.consoleClientId } : {}),
    ...(opts.env ?? {}),
  });
  const pool = createPool(config.databaseUrl, opts.poolMax ?? 20);
  const owner = new pg.Pool({
    connectionString: process.env.MIGRATION_DATABASE_URL,
    options: '-c search_path=app -c TimeZone=UTC',
    max: 2,
  });
  const idp = await testIdp();
  const lines = opts.logLines;
  if (!config.kms) throw new Error('the test environment needs KMS_LOCAL_KEYS (infra/env/test.env.example)');
  const kms = opts.kms ?? localKeyProvider(config.kms);
  const memory = opts.storage === 's3' ? null : new MemoryObjectStore();
  let objects: ObjectStore;
  if (memory) objects = memory;
  else if (config.objectStore) objects = s3ObjectStore(config.objectStore);
  else throw new Error('storage: s3 needs OBJECT_STORE_* in the test environment');
  const consoleIdTokens = {
    ...(opts.consoleClientId ? { consoleIdTokens: idp.verifierFor(opts.consoleClientId) } : {}),
    ...(opts.webIdTokens ? { webIdTokens: opts.webIdTokens } : {}),
  };
  const idTokens = opts.idTokens ?? idp.verifier;
  const app = await buildApp(
    lines ? { ...config, logLevel: 'info' } : config,
    pool,
    lines
      ? {
          idTokens,
          logStream: { write: (line) => void lines.push(line) },
          objects,
          kms,
          ...consoleIdTokens,
        }
      : { logger: false, idTokens, objects, kms, ...consoleIdTokens },
  );
  await app.ready();
  const worker = new pg.Pool({
    connectionString: config.workerDatabaseUrl,
    options: '-c search_path=app -c TimeZone=UTC',
    max: 4,
  });
  const jobs: JobDeps = { pool: worker, objects, kms };
  const secret = config.devAuth.enabled ? config.devAuth.secret : '';
  const token = (user: FixtureUserKey) => devToken(secret, FIXTURES.users[user].id);

  const signIn = async (partial: Partial<Person> = {}): Promise<SignedIn> => {
    const tag = randomBytes(6).toString('hex');
    const person: Person = {
      sub: `sub-${tag}`,
      email: `${tag}@people.test`,
      verified: true,
      name: `Person ${tag}`,
      ...partial,
    };
    // Tests sign many people in from one address; the sign-in rate limit is exercised in auth.test.ts.
    await owner.query("delete from rate_limit_counters where bucket = 'signin.ip'");
    const n = nonce();
    const idToken = await idp.idToken({
      sub: person.sub,
      nonce: n,
      email: person.email,
      email_verified: person.verified,
      name: person.name,
    });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/devices',
      payload: { id_token: idToken, nonce: n, name: 'Test device', platform: 'linux-x64' },
    });
    if (res.statusCode !== 201) throw new Error(`sign-in failed: ${res.statusCode} ${res.body}`);
    const session = res.json() as Session;
    return { person, session, headers: { authorization: `Bearer ${session.access_token}` } };
  };

  return {
    app,
    pool,
    owner,
    idp,
    token,
    auth: async (user) => ({ authorization: `Bearer ${await token(user)}` }),
    signIn,
    objects,
    memory,
    kms,
    worker,
    jobs,
    close: async () => {
      await app.close();
      await pool.end();
      await owner.end();
      await worker.end();
    },
  };
}

export const ERROR_KEYS = ['code', 'message', 'request_id', 'retryable', 'safe_details'].sort();

/** Unique idempotency key. */
export const idemKey = (): string => `k-${randomBytes(8).toString('hex')}`;

/**
 * Milestone 11: new organizations start a trial with trial limits. Test organizations that need many members or
 * profiles are moved to the internal plan (no limits), as the fixture organizations are.
 */
export async function internalPlan(owner: pg.Pool, orgId: string): Promise<void> {
  await owner.query(
    `update subscriptions set plan_id = 'internal', plan_version = 1, state = 'active', reason = 'complimentary',
            trial_ends_at = null, observed_state = 'active' where org_id = $1`,
    [orgId],
  );
}
