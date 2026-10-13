import { randomBytes } from 'node:crypto';

/**
 * Opaque, server-generated identifiers.
 *
 * Format: `<prefix>_<26 chars Crockford base32>` (128 bits: 48-bit millisecond time + 80 random bits).
 * The time component exists only for index locality; clients MUST treat IDs as opaque strings and
 * MUST NOT parse, sort by, or derive anything (including disk paths) from them beyond the format check.
 * The desktop runtime crate (crates/runtime) validates the same grammar before any filesystem use.
 */
export const ID_PREFIXES = {
  organization: 'org',
  user: 'usr',
  device: 'dev',
  profile: 'prf',
  snapshot: 'snp',
  event: 'evt',
  request: 'req',
  audit: 'aud',
  // Local manager entities (milestone 04); mapped to organization-owned data in milestone 06.
  workspace: 'wsp',
  client: 'cli',
  tag: 'tag',
  template: 'tpl',
  importJob: 'imp',
  savedFilter: 'flt',
  // Milestone 05: proxies and connectivity-check records.
  proxy: 'prx',
  networkCheck: 'nck',
} as const;

export type IdKind = keyof typeof ID_PREFIXES;
export type IdPrefix = (typeof ID_PREFIXES)[IdKind];

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const BODY = '[0-9A-HJKMNP-TV-Z]{26}';

export const ID_PATTERN = (prefix: IdPrefix): string => `^${prefix}_${BODY}$`;

export function newId(kind: IdKind, now: number = Date.now()): string {
  const bytes = Buffer.alloc(16);
  bytes.writeUIntBE(now, 0, 6);
  randomBytes(10).copy(bytes, 6);
  return `${ID_PREFIXES[kind]}_${encodeBase32(bytes)}`;
}

export function isId(kind: IdKind, value: unknown): value is string {
  return typeof value === 'string' && new RegExp(ID_PATTERN(ID_PREFIXES[kind])).test(value);
}

function encodeBase32(bytes: Buffer): string {
  // 128 bits -> 26 base32 chars (130 bits, top 2 bits zero).
  let value = 0n;
  for (const b of bytes) value = (value << 8n) | BigInt(b);
  let out = '';
  for (let i = 0; i < 26; i++) {
    out = CROCKFORD.charAt(Number(value & 31n)) + out;
    value >>= 5n;
  }
  return out;
}
