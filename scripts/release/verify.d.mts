/** Types for verify.mjs (used by the API's download page, R4). */
export interface ReleaseKey {
  keyId: string;
}
export interface ChannelManifest {
  schema: 1;
  product: string;
  channel: 'dev' | 'canary' | 'stable';
  sequence: number;
  issued_at: string;
  expires_at: string;
  paused: boolean;
  minimum_version: string | null;
  revoked_versions: string[];
  revoked_runtime_sha256: string[];
  release: {
    version: string;
    published_at: string;
    notes_url: string;
    artifacts: {
      platform: 'windows-x64' | 'macos-arm64';
      kind: 'nsis' | 'app-tar-gz';
      url: string;
      sha256: string;
      size_bytes: number;
      signature: string;
    }[];
  } | null;
}
export function verifyManifest(
  bytes: Buffer,
  sigB64: string,
  keys: ReleaseKey[],
  now: number,
  opts?: { channel?: string; minSequence?: number },
): ChannelManifest;
