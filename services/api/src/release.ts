/**
 * R4 (ADR-0023): what the website's download page offers — only a release on the signed **stable** update channel
 * (milestone 12), checked exactly like the app checks it (the release keys compiled into the app, the manifest's
 * signature, structure and validity). Internal and test builds are never listed: without a verified stable release
 * the answer is "not yet available"; a paused channel says so; a revoked version is never offered.
 *
 * The Windows installer is the signed artifact listed in the manifest. The macOS disk image is published next to it
 * in the same GitHub release; its SHA-256 comes from that release's SHA256SUMS file.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { PublicDownloads } from '@pb/contracts';
import { RELEASE_PREFIX } from '../../../scripts/release/channel-manifest.mjs';
import { parseReleaseKeys, parseUtc } from '../../../scripts/release/minisign.mjs';
import { verifyManifest } from '../../../scripts/release/verify.mjs';

const DEFAULT_KEYS = resolve(import.meta.dirname, '../../../apps/desktop/src-tauri/release-keys.json');
const OK_TTL_MS = 10 * 60_000;
const FAIL_TTL_MS = 2 * 60_000;

export interface ReleaseSource {
  /** The stable channel manifest URL (its signature is `<url>.sig`); null: downloads are off. */
  channelUrl: string | null;
  keysFile: string | null;
  fetch?: typeof fetch;
  now?: () => number;
}

const notAvailable = (checkedAt: string | null): PublicDownloads => ({
  channel: 'stable',
  status: 'not_available',
  version: null,
  published_at: null,
  notes_url: null,
  platforms: [],
  checked_at: checkedAt,
});

async function text(f: typeof fetch, url: string): Promise<string> {
  const res = await f(url, { signal: AbortSignal.timeout(8000), redirect: 'follow' });
  if (!res.ok) throw new Error(`${res.status}`);
  const body = await res.text();
  if (body.length > 1_000_000) throw new Error('too large');
  return body;
}

/** Reads and verifies the stable channel. Any failure means "not yet available", never a broken link. */
export async function readDownloads(src: ReleaseSource): Promise<PublicDownloads> {
  const f = src.fetch ?? fetch;
  const nowMs = src.now?.() ?? Date.now();
  const checked = new Date(nowMs).toISOString();
  if (!src.channelUrl) return notAvailable(checked);
  try {
    const keys = parseReleaseKeys(readFileSync(src.keysFile ?? DEFAULT_KEYS, 'utf8'));
    if (keys.length === 0) return notAvailable(checked);
    const [manifestText, sig] = await Promise.all([
      text(f, src.channelUrl),
      text(f, `${src.channelUrl}.sig`),
    ]);
    const m = verifyManifest(Buffer.from(manifestText), sig, keys, Math.floor(nowMs / 1000), {
      channel: 'stable',
    });
    // Outside its validity window the app refuses the manifest; the site does too.
    const issued = parseUtc(m.issued_at);
    const expires = parseUtc(m.expires_at);
    const nowS = Math.floor(nowMs / 1000);
    if (issued === null || expires === null || nowS < issued - 300 || nowS > expires)
      return notAvailable(checked);
    if (m.paused) return { ...notAvailable(checked), status: 'paused' };
    const r = m.release;
    if (!r || m.revoked_versions.includes(r.version)) return notAvailable(checked);
    const platforms: PublicDownloads['platforms'] = [];
    const win = r.artifacts.find((a) => a.platform === 'windows-x64' && a.kind === 'nsis');
    if (win)
      platforms.push({
        platform: 'windows-x64',
        label: 'Windows 10 or 11 (64-bit, x64)',
        kind: 'installer',
        url: win.url,
        sha256: win.sha256,
        size_bytes: win.size_bytes,
      });
    if (r.artifacts.some((a) => a.platform === 'macos-arm64')) {
      const tag = `desktop-v${r.version}`;
      const dmg = `Project.Browser_${r.version}_aarch64.dmg`;
      let sha: string | null = null;
      try {
        const sums = await text(f, `${RELEASE_PREFIX}${tag}/SHA256SUMS`);
        sha =
          sums
            .split('\n')
            .map((l) => /^([0-9a-f]{64})\s+\*?(.+)$/.exec(l.trim()))
            .find((x) => x?.[2] === dmg)?.[1] ?? null;
      } catch {
        sha = null;
      }
      platforms.push({
        platform: 'macos-arm64',
        label: 'macOS 13 or later on Apple silicon (M1 or newer)',
        kind: 'disk-image',
        url: `${RELEASE_PREFIX}${tag}/${dmg}`,
        sha256: sha,
        size_bytes: null,
      });
    }
    if (platforms.length === 0) return notAvailable(checked);
    return {
      channel: 'stable',
      status: 'available',
      version: r.version,
      published_at: r.published_at,
      notes_url: r.notes_url,
      platforms,
      checked_at: checked,
    };
  } catch {
    return notAvailable(checked);
  }
}

/** Cached for the website (10 minutes; 2 after a failure). */
export function downloadsReader(src: ReleaseSource): () => Promise<PublicDownloads> {
  let cached: { at: number; value: PublicDownloads } | null = null;
  let pending: Promise<PublicDownloads> | null = null;
  return async () => {
    const now = src.now?.() ?? Date.now();
    if (cached && now - cached.at < (cached.value.status === 'available' ? OK_TTL_MS : FAIL_TTL_MS))
      return cached.value;
    pending ??= readDownloads(src).finally(() => {
      pending = null;
    });
    const value = await pending;
    cached = { at: now, value };
    return value;
  };
}
