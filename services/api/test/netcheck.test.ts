/**
 * ADR-0027: GET /v1/netcheck, the desktop proxy check service (trace format, optional IP geolocation).
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CityResponse } from 'maxmind';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  clientAddress,
  fromCityRecord,
  type GeoInfo,
  languageFor,
  openGeoLookup,
  safeCity,
  safeTimeZone,
  traceBody,
} from '../src/geo.ts';
import { type Harness, harness } from './helpers.ts';

const lines = (body: string) =>
  Object.fromEntries(
    body
      .trim()
      .split('\n')
      .map((l) => l.split(/=(.*)/s, 2)),
  );

describe('trace answers', () => {
  it('lists ip first, then only the geo facts that are known and safe', () => {
    expect(traceBody('198.51.100.7', null)).toBe('ip=198.51.100.7\n');
    const full: GeoInfo = {
      country: 'US',
      city: 'New York',
      tz: 'America/New_York',
      lat: 40.7128,
      lon: -74.006,
      lang: 'en-US',
    };
    expect(traceBody('198.51.100.7', full)).toBe(
      'ip=198.51.100.7\nloc=US\ncity=New York\ntz=America/New_York\nlat=40.71\nlon=-74.01\nlang=en-US\n',
    );
    // Values that could become browser settings never pass through unchecked.
    const hostile = traceBody('198.51.100.7', {
      city: 'Evil\nip=1.2.3.4 <script>',
      tz: '../../etc/passwd',
      lat: 1000,
      lon: 5,
      lang: 'en-US --no-sandbox',
    });
    expect(hostile).toBe('ip=198.51.100.7\ncity=Evil ip1.2.3.4 script\n');
    expect(hostile.split('\n').filter((l) => l.startsWith('ip='))).toHaveLength(1);
  });

  it('sanitises each value to a small safe alphabet', () => {
    expect(safeTimeZone('America/Argentina/Buenos_Aires')).toBe('America/Argentina/Buenos_Aires');
    expect(safeTimeZone('Etc/GMT+5')).toBe('Etc/GMT+5');
    expect(safeTimeZone('UTC')).toBe('UTC');
    for (const bad of [
      '',
      'america/new_york',
      'A/B/C/D',
      'Europe/Ber lin',
      'Europe/../x',
      'Europe/Berlin;rm',
    ])
      expect(safeTimeZone(bad), bad).toBeUndefined();
    expect(safeCity('  São   Paulo ')).toBe('São Paulo');
    expect(safeCity('x'.repeat(200))).toHaveLength(64);
    expect(safeCity('\u0000\n')).toBeUndefined();
    expect(languageFor('US')).toBe('en-US');
    expect(languageFor('NP')).toBe('ne-NP');
    expect(languageFor('DE')).toBe('de-DE');
    expect(languageFor('us')).toBeUndefined();
    expect(clientAddress('::ffff:203.0.113.5')).toBe('203.0.113.5');
    expect(clientAddress('2001:db8::5')).toBe('2001:db8::5');
  });

  it('reads a City record (DB-IP Lite has no time zone: it comes from the coordinates)', () => {
    const rec = {
      country: { iso_code: 'DE', geoname_id: 1, names: { en: 'Germany' } },
      city: { geoname_id: 2, names: { en: 'Berlin' } },
      location: { latitude: 52.52437, longitude: 13.41053, accuracy_radius: 50 },
    } as unknown as CityResponse;
    expect(fromCityRecord(rec)).toEqual({
      country: 'DE',
      city: 'Berlin',
      tz: 'Europe/Berlin',
      lat: 52.52,
      lon: 13.41,
      lang: 'de-DE',
    });
    const withZone = {
      country: { iso_code: 'US' },
      location: { latitude: 40.7, longitude: -74, time_zone: 'America/New_York', accuracy_radius: 5 },
    } as unknown as CityResponse;
    expect(fromCityRecord(withZone)?.tz).toBe('America/New_York');
    expect(fromCityRecord(null)).toBeNull();
    expect(fromCityRecord({} as CityResponse)).toBeNull();
  });

  it('answers with the address only when the database is missing or unreadable', async () => {
    const warnings: string[] = [];
    const none = await openGeoLookup(null);
    expect(none('198.51.100.7')).toBeNull();
    const missing = await openGeoLookup('/nonexistent/pb-geo/city.mmdb', (m) => warnings.push(m));
    expect(missing('198.51.100.7')).toBeNull();
    const dir = mkdtempSync(join(tmpdir(), 'pb-geo-'));
    const junk = join(dir, 'junk.mmdb');
    writeFileSync(junk, 'not a database');
    const broken = await openGeoLookup(junk, (m) => warnings.push(m));
    expect(broken('198.51.100.7')).toBeNull();
    expect(warnings).toHaveLength(2);
    expect(warnings.join(' ')).not.toContain('198.51.100.7');
  });
});

describe('GET /v1/netcheck', () => {
  let h: Harness;
  let trusted: Harness;
  const seen: string[] = [];
  const geo = (ip: string): GeoInfo | null => {
    seen.push(ip);
    return ip === '198.51.100.7'
      ? { country: 'US', city: 'New York', tz: 'America/New_York', lat: 40.71, lon: -74.01, lang: 'en-US' }
      : null;
  };
  beforeAll(async () => {
    h = await harness({ geo });
    trusted = await harness({ geo, env: { TRUST_PROXY_HOPS: '1' } });
    await h.owner.query("delete from rate_limit_counters where bucket = 'netcheck.ip'");
  });
  afterAll(async () => {
    await h.close();
    await trusted.close();
  });

  it('is public, plain text, never cached, and lists the location of the address it saw', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/v1/netcheck', remoteAddress: '198.51.100.7' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(lines(res.body)).toEqual({
      ip: '198.51.100.7',
      loc: 'US',
      city: 'New York',
      tz: 'America/New_York',
      lat: '40.71',
      lon: '-74.01',
      lang: 'en-US',
    });
    const unknown = await h.app.inject({ method: 'GET', url: '/v1/netcheck', remoteAddress: '203.0.113.9' });
    expect(unknown.body).toBe('ip=203.0.113.9\n');
  });

  it('uses the socket address unless reverse-proxy hops are trusted (TRUST_PROXY_HOPS)', async () => {
    const forwarded = { 'x-forwarded-for': '198.51.100.7' };
    const direct = await h.app.inject({
      method: 'GET',
      url: '/v1/netcheck',
      remoteAddress: '10.0.0.2',
      headers: forwarded,
    });
    expect(lines(direct.body).ip).toBe('10.0.0.2');
    const proxied = await trusted.app.inject({
      method: 'GET',
      url: '/v1/netcheck',
      remoteAddress: '10.0.0.2',
      headers: forwarded,
    });
    expect(lines(proxied.body)).toMatchObject({ ip: '198.51.100.7', loc: 'US' });
    // A client cannot claim another address by adding its own hop in front: only one hop is trusted.
    const spoofed = await trusted.app.inject({
      method: 'GET',
      url: '/v1/netcheck',
      remoteAddress: '10.0.0.2',
      headers: { 'x-forwarded-for': '198.51.100.7, 203.0.113.50' },
    });
    expect(lines(spoofed.body).ip).toBe('203.0.113.50');
  });

  it('is rate limited per address', async () => {
    let last = 0;
    for (let i = 0; i < 301; i++) {
      const r = await h.app.inject({ method: 'GET', url: '/v1/netcheck', remoteAddress: '192.0.2.77' });
      last = r.statusCode;
    }
    expect(last).toBe(429);
    const other = await h.app.inject({ method: 'GET', url: '/v1/netcheck', remoteAddress: '192.0.2.78' });
    expect(other.statusCode).toBe(200);
    await h.owner.query("delete from rate_limit_counters where bucket = 'netcheck.ip'");
  });
});
