/**
 * IP geolocation for the proxy check (`GET /v1/netcheck`, ADR-0027).
 *
 * The source is a local MaxMind-format (MMDB) database file, normally DB-IP's free "IP to City Lite" database
 * (CC BY 4.0, "IP geolocation by DB-IP", https://db-ip.com), refreshed monthly by scripts/deploy. Its path comes
 * from GEOIP_DB; without it (or when the file cannot be read) the check answers with the address only.
 *
 * Every value leaves here already reduced to a small safe alphabet, because the desktop app turns some of them into
 * browser settings: a two-letter country code, a plausible IANA time zone name (from the coordinates, offline), a
 * BCP 47 language tag derived from the country, coordinates rounded to two decimals (city level) and a short city
 * name. Nothing is logged and nothing is stored.
 */
import { stat } from 'node:fs/promises';
import tzLookup from '@photostructure/tz-lookup';
import maxmind, { type CityResponse, type Reader } from 'maxmind';

export interface GeoInfo {
  /** ISO 3166-1 alpha-2, upper case. */
  country?: string;
  city?: string;
  /** IANA time zone name. */
  tz?: string;
  lat?: number;
  lon?: number;
  /** BCP 47 `ll-CC` (or `lll-CC`). */
  lang?: string;
}

/** Looks an address up; `null` when nothing is known. Tests inject their own. */
export type GeoLookup = (ip: string) => GeoInfo | null;

const COUNTRY = /^[A-Z]{2}$/;
/** `UTC`, `Etc/GMT+5`, `America/Argentina/Buenos_Aires`… : letters, digits, `_+-`, at most three parts. */
const TZ = /^(?:UTC|[A-Z][A-Za-z]{1,19}(?:\/[A-Za-z0-9_+-]{1,30}){1,2})$/;
const LANG = /^[a-z]{2,3}-[A-Z]{2}$/;
const CITY_MAX = 64;

export function safeCountry(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const c = v.trim().toUpperCase();
  // XX/ZZ and the like are "unknown" in several databases.
  return COUNTRY.test(c) && c !== 'XX' && c !== 'ZZ' ? c : undefined;
}

export function safeTimeZone(v: unknown): string | undefined {
  return typeof v === 'string' && v.length <= 64 && TZ.test(v) && !v.includes('..') ? v : undefined;
}

/** Letters (any script), marks, digits, spaces and `.'-()`; other characters dropped; at most 64 characters. */
export function safeCity(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const cleaned = v
    .normalize('NFC')
    .replace(/\s+/g, ' ')
    .replace(/[^\p{L}\p{M}\p{N} .'()-]/gu, '')
    .replace(/ +/g, ' ')
    .trim();
  const short = [...cleaned].slice(0, CITY_MAX).join('').trim();
  return short ? short : undefined;
}

export function safeCoordinate(v: unknown, limit: 90 | 180): number | undefined {
  if (typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v) > limit) return undefined;
  return Math.round(v * 100) / 100;
}

/** The country's most likely language (CLDR likely subtags): `US` → `en-US`, `NP` → `ne-NP`, `CH` → `de-CH`. */
export function languageFor(country: string | undefined): string | undefined {
  if (!country || !COUNTRY.test(country)) return undefined;
  try {
    const language = new Intl.Locale(`und-${country}`).maximize().language;
    const tag = `${language}-${country}`;
    return LANG.test(tag) ? tag : undefined;
  } catch {
    return undefined;
  }
}

export function timeZoneAt(lat: number | undefined, lon: number | undefined): string | undefined {
  if (lat === undefined || lon === undefined) return undefined;
  try {
    return safeTimeZone(tzLookup(lat, lon));
  } catch {
    return undefined;
  }
}

/** Builds safe geo facts from an MMDB City record (MaxMind GeoIP2/GeoLite2 City or DB-IP City Lite layout). */
export function fromCityRecord(r: CityResponse | null | undefined): GeoInfo | null {
  if (!r) return null;
  const country = safeCountry(r.country?.iso_code ?? r.registered_country?.iso_code);
  const lat = safeCoordinate(r.location?.latitude, 90);
  const lon = safeCoordinate(r.location?.longitude, 180);
  // The database's own zone when it has one (GeoLite2 does; DB-IP Lite does not), else from the coordinates.
  const tz = safeTimeZone(r.location?.time_zone) ?? timeZoneAt(lat, lon);
  const out: GeoInfo = {};
  if (country) out.country = country;
  const city = safeCity(r.city?.names?.en);
  if (city) out.city = city;
  if (tz) out.tz = tz;
  if (lat !== undefined && lon !== undefined) {
    out.lat = lat;
    out.lon = lon;
  }
  const lang = languageFor(country);
  if (lang) out.lang = lang;
  return Object.keys(out).length > 0 ? out : null;
}

/** The client address as text: an IPv4-mapped IPv6 address (`::ffff:203.0.113.5`) is shown as IPv4. */
export function clientAddress(ip: string): string {
  const m = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  return m?.[1] ?? ip;
}

/** `key=value` lines in Cloudflare's trace format (the desktop parser ignores lines it does not know). */
export function traceBody(ip: string, geo: GeoInfo | null): string {
  const lines = [`ip=${ip}`];
  if (geo?.country) lines.push(`loc=${geo.country}`);
  const city = safeCity(geo?.city);
  if (city) lines.push(`city=${city}`);
  const tz = safeTimeZone(geo?.tz);
  if (tz) lines.push(`tz=${tz}`);
  const lat = safeCoordinate(geo?.lat, 90);
  const lon = safeCoordinate(geo?.lon, 180);
  if (lat !== undefined && lon !== undefined) lines.push(`lat=${lat}`, `lon=${lon}`);
  if (geo?.lang && LANG.test(geo.lang)) lines.push(`lang=${geo.lang}`);
  return `${lines.join('\n')}\n`;
}

/** How often the file's modification time is looked at (the monthly refresh replaces it). */
const RECHECK_MS = 10 * 60 * 1000;

/**
 * A lookup over the database at `path` (`null` path: no geolocation). The file is opened at start and reopened
 * when it is replaced; a missing or unreadable file means "address only" with one warning, never a failed request.
 */
export async function openGeoLookup(
  path: string | null,
  warn: (message: string) => void = () => undefined,
): Promise<GeoLookup> {
  if (!path) return () => null;
  let reader: Reader<CityResponse> | null = null;
  let mtime = 0;
  let checkedAt = 0;
  let warned = false;
  const load = async () => {
    checkedAt = Date.now();
    try {
      const s = await stat(path);
      if (s.mtimeMs === mtime && reader) return;
      reader = await maxmind.open<CityResponse>(path, { cache: { max: 5000 } });
      mtime = s.mtimeMs;
      warned = false;
    } catch {
      if (!warned)
        warn(
          'The IP geolocation database (GEOIP_DB) could not be opened; checks answer with the address only.',
        );
      warned = true;
    }
  };
  await load();
  return (ip) => {
    if (Date.now() - checkedAt > RECHECK_MS) void load();
    if (!reader || !maxmind.validate(ip)) return null;
    try {
      return fromCityRecord(reader.get(ip));
    } catch {
      return null;
    }
  };
}
