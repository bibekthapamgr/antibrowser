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

  it('accepts a complete prod config', () => {
    const cfg = loadConfig({ ...prod, KMS_LOCAL_KEY_FILE: keyFile({ 'root-1': realKey }, 'root-1') });
    expect(cfg.devAuth.enabled).toBe(false);
    expect(cfg.host).toBe('0.0.0.0');
    expect(cfg.kms).toEqual({ provider: 'local', activeKeyId: 'root-1', keys: { 'root-1': realKey } });
    expect(cfg.objectStore).toMatchObject({ publicEndpoint: 'https://s3.example', forcePathStyle: false });
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
      loadConfig({ ...prod, KMS_LOCAL_KEY_FILE: file, OBJECT_STORE_ENDPOINT: 'http://127.0.0.1:8333' })
        .objectStore?.endpoint,
    ).toBe('http://127.0.0.1:8333');
  });
});
