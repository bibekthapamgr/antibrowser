/**
 * The plaintext header of a sealed snapshot (pb-seal, scheme aes-256-gcm-chunked-v1):
 *   "PBSEAL" 0x00 0x01 | header length (u32 big endian) | header JSON | encrypted chunks...
 * The server cannot decrypt the payload without unwrapping the data key (it never needs to); it checks that the
 * header names exactly the organization, profile, snapshot, key version and format the manifest says. The header is
 * also authenticated by every encrypted chunk, so a device opening the file detects any edit.
 */
export const SEAL_MAGIC = Buffer.from([0x50, 0x42, 0x53, 0x45, 0x41, 0x4c, 0x00, 0x01]);
export const SEAL_MAX_HEADER = 16 * 1024;
export const SEAL_CHUNK = 1 << 20;

export interface SealedHeader {
  scheme: string;
  kind: string;
  org_id: string | null;
  profile_id: string;
  object_id: string;
  schema_version: number;
  key_version: string;
  chunk_size: number;
  nonce_prefix: string;
}

/** Parses the header from the first bytes of an object; null when it is not a sealed file. */
export function parseSealedHeader(prefix: Buffer): SealedHeader | null {
  if (prefix.length < 12 || !prefix.subarray(0, 8).equals(SEAL_MAGIC)) return null;
  const len = prefix.readUInt32BE(8);
  if (len === 0 || len > SEAL_MAX_HEADER || prefix.length < 12 + len) return null;
  try {
    const h = JSON.parse(prefix.subarray(12, 12 + len).toString('utf8')) as Record<string, unknown>;
    const str = (v: unknown) => (typeof v === 'string' ? v : null);
    const num = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) ? v : null);
    const header: SealedHeader = {
      scheme: str(h.scheme) ?? '',
      kind: str(h.kind) ?? '',
      org_id: str(h.org_id),
      profile_id: str(h.profile_id) ?? '',
      object_id: str(h.object_id) ?? '',
      schema_version: num(h.schema_version) ?? 0,
      key_version: str(h.key_version) ?? '',
      chunk_size: num(h.chunk_size) ?? 0,
      nonce_prefix: str(h.nonce_prefix) ?? '',
    };
    return header;
  } catch {
    return null;
  }
}

/** Smallest valid sealed file: header plus one (empty) final chunk tag. */
export function minimumSealedSize(headerLength: number): number {
  return 12 + headerLength + 16;
}
