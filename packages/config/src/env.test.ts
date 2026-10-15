import { randomBytes } from 'node:crypto';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, FIXTURE_ROOT_KEYS, FIXTURE_SECRETS, loadConfig } from './env.ts';

const dir = mkdtempSync(join(tmpdir(), 'pb-config-'));
function keyFile(keys: Record<string, string>, active: string, mode = 0o600): string {
  const path = join(dir, `${randomBytes(4).toString('hex')}.json`);
  writeFileSync(path, JSON.stringify({ active, keys }));
  chmodSync(path, mode);
  return path;
}
const realKey = randomBytes(32).toString('base64');

const fixture = FIXTURE_SECRETS[0] ?? '';
const base = {
  DATABASE_URL: 'postgres://app@db.internal:5432/pb',
  WORKER_DATABASE_URL: 'postgres://worker@db.internal:5432/pb',
};

describe('loadConfig', () => {
  it('accepts a dev config with fixture dev auth', () => {
    const cfg = loadConfig({ ...base, APP_ENV: 'dev', DEV_AUTH_ENABLED: 'true', DEV_AUTH_SECRET: fixture });
    expect(cfg.devAuth.enabled).toBe(true);
    expect(cfg.host).toBe('127.0.0.1');
  });

  it('refuses dev auth in staging and prod', () => {
    for (const appEnv of ['staging', 'prod']) {
      expect(() =>
        loadConfig({
          ...base,
          APP_ENV: appEnv,
          DEV_AUTH_ENABLED: 'true',
          DEV_AUTH_SECRET: 'x'.repeat(40),
          OIDC_ISSUER: 'https://id.example',
          OIDC_CLIENT_ID: 'pb-desktop',
          SESSION_SIGNING_KEY: '{"kty":"EC"}',
          OBJECT_STORE_BUCKET: `pb-snapshots-${appEnv}`,
        }),
      ).toThrow(/DEV_AUTH_ENABLED is only permitted/);
    }
  });

  it('refuses repository fixture secrets in prod', () => {
    expect(() =>
      loadConfig({
        ...base,
        APP_ENV: 'prod',
        SOME_SECRET: fixture,
        OIDC_ISSUER: 'https://id.example',
        OIDC_CLIENT_ID: 'pb-desktop',
        SESSION_SIGNING_KEY: '{"kty":"EC"}',
        OBJECT_STORE_BUCKET: 'pb-snapshots-prod',
      }),
    ).toThrow(/fixture secret/);
  });

  it('refuses a bucket shared across environments', () => {
    expect(() =>
      loadConfig({
        ...base,
        APP_ENV: 'prod',
        OIDC_ISSUER: 'https://id.example',
        OIDC_CLIENT_ID: 'pb-desktop',
        SESSION_SIGNING_KEY: '{"kty":"EC"}',
        OBJECT_STORE_BUCKET: 'pb-snapshots-staging',
      }),
    ).toThrow(ConfigError);
  });

  const prod = {
    ...base,
    APP_ENV: 'prod',
    OIDC_ISSUER: 'https://id.example',
    OIDC_CLIENT_ID: 'pb-desktop',
    SESSION_SIGNING_KEY: '{"kty":"EC"}',
    OBJECT_STORE_BUCKET: 'pb-snapshots-prod',
    OBJECT_STORE_ENDPOINT: 'https://s3.example',
  };

  it('allows a same-server database only when it is named for the environment (R6)', () => {
    const key = { KMS_LOCAL_KEY_FILE: keyFile({ 'root-1': realKey }, 'root-1') };
    const local = (db: string) => ({
      DATABASE_URL: `postgres://app@127.0.0.1:5432/${db}`,
      WORKER_DATABASE_URL: `postgres://worker@localhost:5432/${db}?sslmode=disable`,
    });
    expect(() => loadConfig({ ...prod, ...key, ...local('pb_prod') })).not.toThrow();
    expect(() => loadConfig({ ...prod, ...key, ...local('pb_dev') })).toThrow(/points at localhost/);
    expect(() => loadConfig({ ...prod, ...key, ...local('pb') })).toThrow(/points at localhost/);
  });

  it('requires public https addresses for the portal, storage links and billing return in prod (R6)', () => {
    const key = { KMS_LOCAL_KEY_FILE: keyFile({ 'root-1': realKey }, 'root-1') };
    expect(() => loadConfig({ ...prod, ...key, WEB_ORIGIN: 'http://127.0.0.1:8080' })).toThrow(
      /WEB_ORIGIN must use https/,
    );
    expect(() =>
      loadConfig({ ...prod, ...key, OBJECT_STORE_PUBLIC_ENDPOINT: 'http://127.0.0.1:8333' }),
    ).toThrow(/OBJECT_STORE_PUBLIC_ENDPOINT must be a public https address/);
    const stripe = {
      STRIPE_SECRET_KEY: ['sk', 'live', 'a'.repeat(24)].join('_'),
      STRIPE_WEBHOOK_SECRETS: `whsec_${'b'.repeat(24)}`,
    };
    expect(() => loadConfig({ ...prod, ...key, ...stripe })).toThrow(
      /BILLING_RETURN_URL must be the public https/,
    );
    expect(() =>
      loadConfig({
        ...prod,
        ...key,
        ...stripe,
        BILLING_RETURN_URL: 'https://browser.example/v1/billing/return',
      }),
    ).not.toThrow();
  });

  it('keeps the staff second factor on outside dev/test (R6)', () => {
    const key = { KMS_LOCAL_KEY_FILE: keyFile({ 'root-1': realKey }, 'root-1') };
    expect(loadConfig({ ...prod, ...key }).console.requireMfa).toBe(true);
    expect(() => loadConfig({ ...prod, ...key, STAFF_REQUIRE_MFA: 'false' })).toThrow(/cannot be turned off/);
    expect(loadConfig({ ...base, APP_ENV: 'dev' }).console.requireMfa).toBe(false);
  });

  it('accepts a complete prod config', () => {
    const cfg = loadConfig({ ...prod, KMS_LOCAL_KEY_FILE: keyFile({ 'root-1': realKey }, 'root-1') });
    expect(cfg.devAuth.enabled).toBe(false);
    expect(cfg.host).toBe('0.0.0.0');
    expect(cfg.kms).toEqual({ provider: 'local', activeKeyId: 'root-1', keys: { 'root-1': realKey } });
    expect(cfg.objectStore).toMatchObject({ publicEndpoint: 'https://s3.example', forcePathStyle: false });
  });

  it('webhooks reach private destinations only in dev/test (milestone 10)', () => {
    const key = keyFile({ 'root-1': realKey }, 'root-1');
    expect(loadConfig({ ...prod, KMS_LOCAL_KEY_FILE: key }).webhooks.allowPrivateDestinations).toBe(false);
    expect(() =>
      loadConfig({ ...prod, KMS_LOCAL_KEY_FILE: key, WEBHOOK_ALLOW_PRIVATE_DESTINATIONS: 'true' }),
    ).toThrow(/WEBHOOK_ALLOW_PRIVATE_DESTINATIONS is only permitted/);
    const dev = loadConfig({ ...base, APP_ENV: 'test', WEBHOOK_ALLOW_PRIVATE_DESTINATIONS: 'true' });
    expect(dev.webhooks.allowPrivateDestinations).toBe(true);
  });

  it('snapshot storage needs a root key provider, kept in an owner-only file outside dev/test', () => {
    expect(() => loadConfig(prod)).toThrow(/key provider/);
    expect(() =>
      loadConfig({ ...prod, KMS_LOCAL_KEYS: JSON.stringify({ active: 'a', keys: { a: realKey } }) }),
    ).toThrow(/only permitted in dev\/test/);
    if (process.platform !== 'win32') {
      expect(() => loadConfig({ ...prod, KMS_LOCAL_KEY_FILE: keyFile({ a: realKey }, 'a', 0o644) })).toThrow(
        /owner only/,
      );
    }
    expect(() =>
      loadConfig({ ...prod, KMS_LOCAL_KEY_FILE: keyFile({ a: FIXTURE_ROOT_KEYS[0] ?? '' }, 'a') }),
    ).toThrow(/repository fixture/);
    expect(() => loadConfig({ ...prod, KMS_LOCAL_KEY_FILE: keyFile({ a: 'c2hvcnQ=' }, 'a') })).toThrow(
      /32 bytes/,
    );
    expect(() => loadConfig({ ...prod, KMS_LOCAL_KEY_FILE: keyFile({ a: realKey }, 'b') })).toThrow(/active/);
  });

  it('refuses plain http storage endpoints outside dev/test (except loopback)', () => {
    const file = keyFile({ a: realKey }, 'a');
    expect(() =>
      loadConfig({ ...prod, KMS_LOCAL_KEY_FILE: file, OBJECT_STORE_PUBLIC_ENDPOINT: 'http://s3.example' }),
    ).toThrow(/must use https/);
    expect(
      loadConfig({
        ...prod,
        KMS_LOCAL_KEY_FILE: file,
        OBJECT_STORE_ENDPOINT: 'http://127.0.0.1:8333',
        OBJECT_STORE_PUBLIC_ENDPOINT: 'https://files.example',
      }).objectStore?.endpoint,
    ).toBe('http://127.0.0.1:8333');
  });
});

describe('billing configuration (milestone 11)', () => {
  const testKey = `sk_${'test'}_${randomBytes(12).toString('hex')}`;
  const liveKey = `sk_${'live'}_${randomBytes(12).toString('hex')}`;
  const hook = `whsec_${randomBytes(16).toString('hex')}`;
  const dev = { ...base, APP_ENV: 'dev' };

  it('is off without a key; test keys outside prod, live keys only in prod', () => {
    expect(loadConfig(dev).billing.stripe).toBeNull();
    const cfg = loadConfig({
      ...dev,
      STRIPE_SECRET_KEY: testKey,
      STRIPE_WEBHOOK_SECRETS: `${hook}, ${hook}2`,
    });
    expect(cfg.billing.stripe).toMatchObject({ livemode: false, apiBase: 'https://api.stripe.com' });
    expect(cfg.billing.stripe?.webhookSecrets).toHaveLength(2);
    expect(() => loadConfig({ ...dev, STRIPE_SECRET_KEY: liveKey, STRIPE_WEBHOOK_SECRETS: hook })).toThrow(
      /live Stripe key/,
    );
    expect(() => loadConfig({ ...dev, STRIPE_SECRET_KEY: testKey })).toThrow(/STRIPE_WEBHOOK_SECRETS/);
    expect(() =>
      loadConfig({ ...dev, STRIPE_SECRET_KEY: 'pk_test_abcdefgh', STRIPE_WEBHOOK_SECRETS: hook }),
    ).toThrow(/not a Stripe secret/);
  });

  it('allows a local provider address only in dev/test, and validates the price map', () => {
    expect(
      loadConfig({
        ...dev,
        STRIPE_SECRET_KEY: testKey,
        STRIPE_WEBHOOK_SECRETS: hook,
        STRIPE_API_BASE: 'http://127.0.0.1:12111/',
      }).billing.stripe?.apiBase,
    ).toBe('http://127.0.0.1:12111');
    const staging = {
      ...base,
      APP_ENV: 'staging',
      OIDC_ISSUER: 'https://id.example',
      OIDC_CLIENT_ID: 'pb-desktop',
      SESSION_SIGNING_KEY: '{"kty":"EC"}',
      OBJECT_STORE_BUCKET: 'pb-snapshots-staging',
      STRIPE_SECRET_KEY: testKey,
      STRIPE_WEBHOOK_SECRETS: hook,
    };
    expect(() => loadConfig({ ...staging, STRIPE_API_BASE: 'http://127.0.0.1:12111' })).toThrow(
      /STRIPE_API_BASE/,
    );
    expect(loadConfig({ ...dev, BILLING_STRIPE_PRICES: '{"team@1":"price_123abc"}' }).billing.prices).toEqual(
      {
        'team@1': 'price_123abc',
      },
    );
    expect(() => loadConfig({ ...dev, BILLING_STRIPE_PRICES: '{"team":"price_123"}' })).toThrow(
      /plan@version/,
    );
    expect(() => loadConfig({ ...dev, BILLING_STRIPE_PRICES: '[1]' })).toThrow(/JSON object/);
    expect(() => loadConfig({ ...dev, BILLING_RETENTION_DAYS: '7' })).toThrow(/RETENTION/);
    expect(loadConfig(dev).billing.portalConfiguration).toBeNull();
    expect(
      loadConfig({ ...dev, STRIPE_PORTAL_CONFIGURATION: 'bpc_1AbCdEfGh' }).billing.portalConfiguration,
    ).toBe('bpc_1AbCdEfGh');
    expect(() => loadConfig({ ...dev, STRIPE_PORTAL_CONFIGURATION: 'https://x' })).toThrow(/bpc_/);
  });
});

describe('IP geolocation (ADR-0027)', () => {
  const dev = { ...base, APP_ENV: 'dev', DEV_AUTH_ENABLED: 'true', DEV_AUTH_SECRET: fixture };
  it('is optional and must be an absolute .mmdb path', () => {
    expect(loadConfig(dev).geo.dbPath).toBeNull();
    expect(loadConfig({ ...dev, GEOIP_DB: '/var/lib/pb-geo/dbip-city-lite.mmdb' }).geo.dbPath).toBe(
      '/var/lib/pb-geo/dbip-city-lite.mmdb',
    );
    for (const bad of ['geo.mmdb', '/var/lib/../etc/passwd.mmdb', '/var/lib/pb-geo/city.csv'])
      expect(() => loadConfig({ ...dev, GEOIP_DB: bad }), bad).toThrow(/GEOIP_DB/);
  });
});
