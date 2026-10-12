import { describe, expect, it } from 'vitest';
import { ConfigError, FIXTURE_SECRETS, loadConfig } from './env.ts';

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
          OIDC_AUDIENCE: 'api',
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
        OIDC_AUDIENCE: 'api',
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
        OIDC_AUDIENCE: 'api',
        OBJECT_STORE_BUCKET: 'pb-snapshots-staging',
      }),
    ).toThrow(ConfigError);
  });

  it('accepts a complete prod config', () => {
    const cfg = loadConfig({
      ...base,
      APP_ENV: 'prod',
      OIDC_ISSUER: 'https://id.example',
      OIDC_AUDIENCE: 'api',
      OBJECT_STORE_BUCKET: 'pb-snapshots-prod',
    });
    expect(cfg.devAuth.enabled).toBe(false);
    expect(cfg.host).toBe('0.0.0.0');
  });
});
