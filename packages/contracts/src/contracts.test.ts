import { describe, expect, it } from 'vitest';
import {
  decodeCursor,
  encodeCursor,
  ID_PATTERN,
  isId,
  newId,
  PERMISSIONS,
  ROLE_PERMISSIONS,
  ROLES,
  redactPayload,
  roleAllows,
} from './index.ts';

describe('ids', () => {
  it('generates opaque prefixed ids matching the shared grammar', () => {
    const id = newId('profile');
    expect(id).toMatch(new RegExp(ID_PATTERN('prf')));
    expect(isId('profile', id)).toBe(true);
    expect(isId('organization', id)).toBe(false);
  });

  it('rejects path-like and malformed values', () => {
    for (const bad of [
      'prf_../../etc',
      'prf_',
      'PRF_01J0000000000000000000000',
      '../prf',
      'prf_0123456789ABCDEFGHJKMNPQRI',
    ]) {
      expect(isId('profile', bad)).toBe(false);
    }
  });

  it('is unique under rapid generation', () => {
    const seen = new Set(Array.from({ length: 10_000 }, () => newId('event')));
    expect(seen.size).toBe(10_000);
  });
});

describe('cursor', () => {
  it('round-trips and rejects garbage', () => {
    const c = encodeCursor({ k: '2026-10-12T00:00:00.000Z', id: 'prf_x' });
    expect(decodeCursor(c)).toEqual({ k: '2026-10-12T00:00:00.000Z', id: 'prf_x' });
    expect(decodeCursor('not-a-cursor')).toBeNull();
    expect(decodeCursor(Buffer.from('{"k":"nope","id":"x"}').toString('base64url'))).toBeNull();
  });
});

describe('redaction', () => {
  it('drops forbidden keys at any depth', () => {
    expect(
      redactPayload({ name: 'a', proxy: { host: 'h', proxy_password: 'p', Token: 't' }, cookie: 'c' }),
    ).toEqual({
      name: 'a',
      proxy: { host: 'h' },
    });
  });
});

describe('permission matrix', () => {
  it('owner has everything, viewer is read-only, billing is owner-only', () => {
    expect(ROLE_PERMISSIONS.owner).toEqual(PERMISSIONS);
    expect(ROLE_PERMISSIONS.viewer.every((p) => p.endsWith('.read'))).toBe(true);
    for (const role of ROLES) {
      expect(roleAllows(role, 'org.manage_billing')).toBe(role === 'owner');
    }
  });
});
