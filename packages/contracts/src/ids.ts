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
  // Milestone 06: identity and authorization.
  invitation: 'inv',
  grant: 'grt',
  session: 'ses',
  // Milestone 05: proxies and connectivity-check records.
  proxy: 'prx',
  networkCheck: 'nck',
  // Milestone 07: encrypted snapshots and synchronization.
  orgKeyVersion: 'okv',
  syncOperation: 'syn',
} as const;

export type IdKind = keyof typeof ID_PREFIXES;
export type IdPrefix = (typeof ID_PREFIXES)[IdKind];

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const BODY = '[0-9A-HJKMNP-TV-Z]{26}';

export const ID_PATTERN = (prefix: IdPrefix): string => `^${prefix}_${BODY}$`;

export function newId(kind: IdKind, now: number = Date.now()): string {
  const bytes = new Uint8Array(16);
  let t = now;
  for (let i = 5; i >= 0; i--) {
    bytes[i] = t % 256;
    t = Math.floor(t / 256);
  }
  globalThis.crypto.getRandomValues(bytes.subarray(6));
  return `${ID_PREFIXES[kind]}_${encodeBase32(bytes)}`;
}

export function isId(kind: IdKind, value: unknown): value is string {
  return typeof value === 'string' && new RegExp(ID_PATTERN(ID_PREFIXES[kind])).test(value);
}

function encodeBase32(bytes: Uint8Array): string {
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
