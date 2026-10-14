/** Types for minisign.mjs (used by the API's download page, R4). */
import type { ReleaseKey } from './verify.mjs';
export function parseReleaseKeys(json: string | object): ReleaseKey[];
export function parseUtc(s: string): number | null;
export const keyIdHex: (bytes: Uint8Array) => string;
export function publicKeyEntry(
  pubFileContent: string,
  notBefore: string,
  notAfter: string,
  note?: string,
): { key_id: string; public_key: string; not_before: string; not_after: string; note: string };
