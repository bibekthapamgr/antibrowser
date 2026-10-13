/**
 * Deterministic local fixtures: two tenants so isolation is testable from day one (milestone 01, step 3), with every
 * role of milestone 06 and grants for the operator and the viewer.
 * Fixture ids follow the production id grammar so no code path special-cases them.
 * Never loaded outside APP_ENV=dev|test (seed script refuses).
 */
import { ID_PATTERN, type IdPrefix } from '@pb/contracts';

export const fx = (prefix: IdPrefix, tag: string): string => {
  const id = `${prefix}_${`01J9ZSEED0${tag}`.padEnd(26, '0')}`;
  if (!new RegExp(ID_PATTERN(prefix)).test(id)) throw new Error(`bad fixture id ${id}`);
  return id;
};

export const DEV_ISSUER = 'pb-dev';

export const FIXTURES = {
  orgs: {
    acme: { id: fx('org', 'ACME'), name: 'Acme Agency (fixture)' },
    beta: { id: fx('org', 'BETA'), name: 'Beta Studio (fixture)' },
  },
  users: {
    acmeOwner: {
      id: fx('usr', 'A1'),
      name: 'Acme Owner',
      email: 'owner@acme.test',
      org: 'acme',
      role: 'owner',
    },
    acmeOperator: {
      id: fx('usr', 'A2'),
      name: 'Acme Operator',
      email: 'operator@acme.test',
      org: 'acme',
      role: 'operator',
    },
    acmeViewer: {
      id: fx('usr', 'A3'),
      name: 'Acme Viewer',
      email: 'viewer@acme.test',
      org: 'acme',
      role: 'viewer',
    },
    acmeAdmin: {
      id: fx('usr', 'A4'),
      name: 'Acme Admin',
      email: 'admin@acme.test',
      org: 'acme',
      role: 'admin',
    },
    acmeBilling: {
      id: fx('usr', 'A5'),
      name: 'Acme Billing',
      email: 'billing@acme.test',
      org: 'acme',
      role: 'billing',
    },
    betaOwner: {
      id: fx('usr', 'B1'),
      name: 'Beta Owner',
      email: 'owner@beta.test',
      org: 'beta',
      role: 'owner',
    },
  },
  devices: {
    acmeOwnerLaptop: {
      id: fx('dev', 'A1D1'),
      user: 'acmeOwner',
      name: 'Owner laptop',
      platform: 'windows-x64',
    },
    acmeOperatorMac: {
      id: fx('dev', 'A2D1'),
      user: 'acmeOperator',
      name: 'Operator Mac',
      platform: 'macos-arm64',
    },
    acmeOwnerMac: { id: fx('dev', 'A1D2'), user: 'acmeOwner', name: 'Owner Mac', platform: 'macos-arm64' },
    betaOwnerLaptop: {
      id: fx('dev', 'B1D1'),
      user: 'betaOwner',
      name: 'Beta laptop',
      platform: 'windows-x64',
    },
  },
  clients: {
    acmeNorth: { id: fx('cli', 'AN'), org: 'acme', name: 'Client North' },
    acmeSouth: { id: fx('cli', 'AS'), org: 'acme', name: 'Client South' },
    betaInternal: { id: fx('cli', 'B1C'), org: 'beta', name: 'Beta internal' },
  },
  profiles: {
    acmeShop: { id: fx('prf', 'A01'), org: 'acme', name: 'Client shop admin', client: 'acmeNorth' },
    acmeAds: { id: fx('prf', 'A02'), org: 'acme', name: 'Ads QA', client: 'acmeSouth' },
    betaSupport: { id: fx('prf', 'B01'), org: 'beta', name: 'Support desk', client: 'betaInternal' },
  },
  /** The operator works on everything of Client North; the viewer sees one profile. */
  grants: {
    operatorNorth: {
      id: fx('grt', 'A2G1'),
      org: 'acme',
      user: 'acmeOperator',
      client: 'acmeNorth',
      profile: null,
    },
    viewerShop: { id: fx('grt', 'A3G1'), org: 'acme', user: 'acmeViewer', client: null, profile: 'acmeShop' },
  },
} as const;

export type FixtureUserKey = keyof typeof FIXTURES.users;
