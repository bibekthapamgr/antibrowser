#!/usr/bin/env node
/**
 * Builds the next signed-update manifest of a channel (milestone 12, ADR-0019) from the current one. Used by the
 * `desktop release` workflow; the result is signed there with the release key and checked again with verify.mjs.
 * The rules match crates/update/src/app.rs, plus publishing rules the app cannot see:
 *   - the sequence only grows (the app refuses a smaller one as a replay);
 *   - a channel's release never goes back to an older version, and never to a revoked or below-minimum one;
 *   - stable takes only plain versions (no -beta / -dev suffix); promotion copies the exact signed files;
 *   - the minimum version only rises, and never above the channel's release (nobody could satisfy it);
 *   - validity is at most 120 days (the app refuses longer); the workflow re-signs monthly.
 *
 * Usage (prints the new manifest to --out):
 *   channel-manifest.mjs <action> --channel <dev|canary|stable> --sequence <n> --out <file>
 *       [--current <channel.json> | --none]        the verified current manifest (none for a first release)
 *       release  --version <v> --artifacts <dir> [--published-at <iso>]
 *       promote  --from <source channel.json>
 *       pause | resume | refresh
 *       revoke   [--versions <v,v>] [--runtime-sha256 <h,h>]
 *       minimum  --version <v>
 *   options: --issued-at <iso> (default now) --valid-days <n> (default 90)
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseUtc } from './minisign.mjs';

export const PRODUCT = 'project-browser-manager';
export const CHANNELS = ['dev', 'canary', 'stable'];
export const REPO = 'bibekthapamgr/antibrowser';
export const RELEASE_PREFIX = `https://github.com/${REPO}/releases/download/`;
export const MAX_VALIDITY_DAYS = 120;
export const MAX_ARTIFACT_BYTES = 512 * 1024 * 1024;

/** The files the release job signs and publishes, by platform. */
export const ARTIFACTS = [
  { platform: 'windows-x64', kind: 'nsis', match: /^Project\.Browser_.+_x64-setup\.exe$/ },
  { platform: 'macos-arm64', kind: 'app-tar-gz', match: /^Project\.Browser_.+_aarch64\.app\.tar\.gz$/ },
];

// ------------------------------------------------------------------------------------------------ semver
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export function parseVersion(v) {
  const m = SEMVER.exec(v ?? '');
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] ? m[4].split('.') : [] };
}

/** Semver precedence: -1, 0 or 1 (build metadata ignored). */
export function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) throw new Error(`not a version: ${!x ? a : b}`);
  for (const k of ['major', 'minor', 'patch']) if (x[k] !== y[k]) return x[k] < y[k] ? -1 : 1;
  if (!x.pre.length || !y.pre.length) return x.pre.length === y.pre.length ? 0 : x.pre.length ? -1 : 1;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn) return +p < +q ? -1 : 1;
    if (pn !== qn) return pn ? -1 : 1;
    return p < q ? -1 : 1;
  }
  return 0;
}

const isSha256 = (h) => /^[0-9a-f]{64}$/.test(h);
const iso = (secs) => new Date(secs * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
export const notesUrl = (version) => `https://github.com/${REPO}/releases/tag/desktop-v${version}`;
export const releaseTag = (version) => `desktop-v${version}`;

// ------------------------------------------------------------------------------------------------ validation
/** The structural rules the app applies (ChannelManifest::parse). Throws with the first problem. */
export function validate(m) {
  const fail = (what) => {
    throw new Error(`invalid manifest: ${what}`);
  };
  const allowed = [
    'schema',
    'product',
    'channel',
    'sequence',
    'issued_at',
    'expires_at',
    'paused',
    'minimum_version',
    'revoked_versions',
    'revoked_runtime_sha256',
    'release',
  ];
  for (const k of Object.keys(m)) if (!allowed.includes(k)) fail(`unknown field ${k}`);
  if (m.schema !== 1) fail('schema');
  if (m.product !== PRODUCT) fail('product');
  if (!CHANNELS.includes(m.channel)) fail('channel');
  if (!Number.isSafeInteger(m.sequence) || m.sequence <= 0) fail('sequence');
  const issued = parseUtc(m.issued_at);
  const expires = parseUtc(m.expires_at);
  if (
    issued === null ||
    expires === null ||
    expires <= issued ||
    expires - issued > MAX_VALIDITY_DAYS * 86400
  )
    fail('validity window');
  if (typeof m.paused !== 'boolean') fail('paused');
  if (m.minimum_version !== null && !parseVersion(m.minimum_version)) fail('minimum_version');
  if (
    !Array.isArray(m.revoked_versions) ||
    m.revoked_versions.length > 200 ||
    !m.revoked_versions.every(parseVersion)
  )
    fail('revoked_versions');
  if (
    !Array.isArray(m.revoked_runtime_sha256) ||
    m.revoked_runtime_sha256.length > 200 ||
    !m.revoked_runtime_sha256.every(isSha256)
  )
    fail('revoked_runtime_sha256');
  const r = m.release;
  if (r !== null) {
    const rk = ['version', 'published_at', 'notes_url', 'artifacts'];
    for (const k of Object.keys(r)) if (!rk.includes(k)) fail(`unknown release field ${k}`);
    if (!parseVersion(r.version)) fail('release.version');
    if (parseUtc(r.published_at) === null) fail('published_at');
    if (!r.notes_url.startsWith(`https://github.com/${REPO}/`) || r.notes_url.length > 512) fail('notes_url');
    if (!Array.isArray(r.artifacts) || r.artifacts.length === 0 || r.artifacts.length > 8) fail('artifacts');
    const seen = new Set();
    for (const a of r.artifacts) {
      const ak = ['platform', 'kind', 'url', 'sha256', 'size_bytes', 'signature'];
      for (const k of Object.keys(a)) if (!ak.includes(k)) fail(`unknown artifact field ${k}`);
      const known = ARTIFACTS.find((x) => x.platform === a.platform && x.kind === a.kind);
      if (!known || seen.has(a.platform)) fail('artifact platform or kind');
      seen.add(a.platform);
      const rest = a.url.startsWith(RELEASE_PREFIX) ? a.url.slice(RELEASE_PREFIX.length) : '';
      if (a.url.length > 512 || rest.split('/').length !== 2 || /[?#\\ ]|\.\./.test(a.url))
        fail('artifact url');
      if (!isSha256(a.sha256)) fail('artifact sha256');
      if (!Number.isSafeInteger(a.size_bytes) || a.size_bytes <= 0 || a.size_bytes > MAX_ARTIFACT_BYTES)
        fail('artifact size');
      if (typeof a.signature !== 'string' || !a.signature || a.signature.length > 4096)
        fail('artifact signature');
    }
  }
  return m;
}

// ------------------------------------------------------------------------------------------------ building
function empty(channel) {
  return {
    schema: 1,
    product: PRODUCT,
    channel,
    sequence: 0,
    issued_at: '',
    expires_at: '',
    paused: false,
    minimum_version: null,
    revoked_versions: [],
    revoked_runtime_sha256: [],
    release: null,
  };
}

const list = (s) =>
  (s ?? '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);

/** The artifacts of a release from the signed files in `dir` (each with its `.sig` next to it). */
export function releaseFromFiles(version, dir, publishedAt) {
  const artifacts = [];
  for (const spec of ARTIFACTS) {
    const files = existsSync(dir) ? readdirSync(dir).filter((n) => spec.match.test(n)) : [];
    if (files.length > 1) throw new Error(`more than one ${spec.kind} file in ${dir}`);
    const name = files[0];
    if (!name) continue;
    if (!name.includes(`_${version}_`)) throw new Error(`${name} is not version ${version}`);
    const data = readFileSync(join(dir, name));
    const sigPath = join(dir, `${name}.sig`);
    if (!existsSync(sigPath)) throw new Error(`${name} has no signature`);
    artifacts.push({
      platform: spec.platform,
      kind: spec.kind,
      url: `${RELEASE_PREFIX}${releaseTag(version)}/${name}`,
      sha256: createHash('sha256').update(data).digest('hex'),
      size_bytes: statSync(join(dir, name)).size,
      signature: readFileSync(sigPath, 'utf8').trim(),
    });
  }
  if (artifacts.length === 0) throw new Error(`no release files in ${dir}`);
  return { version, published_at: publishedAt, notes_url: notesUrl(version), artifacts };
}

function checkReleaseAllowed(next, release) {
  if (next.channel === 'stable' && parseVersion(release.version).pre.length)
    throw new Error(`stable takes only plain versions, not ${release.version}`);
  if (next.revoked_versions.some((v) => compareVersions(v, release.version) === 0))
    throw new Error(`${release.version} is revoked on ${next.channel}`);
  if (next.minimum_version && compareVersions(release.version, next.minimum_version) < 0)
    throw new Error(`${release.version} is below the minimum version ${next.minimum_version}`);
  const cur = next.release;
  if (cur && compareVersions(release.version, cur.version) < 0)
    throw new Error(
      `${next.channel} already has ${cur.version}; a release never goes back to ${release.version}`,
    );
}

/**
 * The next manifest. `current` is the verified current manifest of `channel` (or null), `sequence` the new
 * sequence (from the workflow run), `now` unix seconds.
 */
export function nextManifest({ action, channel, current, sequence, now, validDays = 90, ...o }) {
  if (!CHANNELS.includes(channel)) throw new Error(`unknown channel ${channel}`);
  if (current) {
    validate(current);
    if (current.channel !== channel) throw new Error(`the current manifest is for ${current.channel}`);
  }
  if (!Number.isSafeInteger(sequence) || sequence <= (current?.sequence ?? 0))
    throw new Error(`the sequence must grow: ${sequence} after ${current?.sequence ?? 0}`);
  if (!(validDays > 0 && validDays <= MAX_VALIDITY_DAYS)) throw new Error(`validity of ${validDays} days`);
  const next = structuredClone(current ?? empty(channel));
  next.sequence = sequence;
  next.issued_at = iso(now);
  next.expires_at = iso(now + Math.round(validDays * 86400));

  switch (action) {
    case 'release': {
      checkReleaseAllowed(next, o.release);
      next.release = o.release;
      break;
    }
    case 'promote': {
      const src = o.from;
      validate(src);
      if (!src.release) throw new Error(`${src.channel} has no release to promote`);
      if (src.channel === channel) throw new Error('promote from another channel');
      if (src.revoked_versions.some((v) => compareVersions(v, src.release.version) === 0))
        throw new Error(`${src.release.version} is revoked on ${src.channel}`);
      checkReleaseAllowed(next, src.release);
      next.release = structuredClone(src.release);
      break;
    }
    case 'pause':
      next.paused = true;
      break;
    case 'resume':
      next.paused = false;
      break;
    case 'refresh':
      if (!current) throw new Error(`${channel} has no manifest to refresh`);
      break;
    case 'revoke': {
      const versions = list(o.versions);
      const hashes = list(o.runtimeSha256).map((h) => h.toLowerCase());
      if (!versions.length && !hashes.length) throw new Error('nothing to revoke');
      for (const v of versions) if (!parseVersion(v)) throw new Error(`not a version: ${v}`);
      for (const h of hashes) if (!isSha256(h)) throw new Error(`not a SHA-256: ${h}`);
      next.revoked_versions = [...new Set([...next.revoked_versions, ...versions])];
      next.revoked_runtime_sha256 = [...new Set([...next.revoked_runtime_sha256, ...hashes])];
      // A revoked release is withdrawn: nothing is offered until a newer release (a fix) is published.
      if (next.release && versions.some((v) => compareVersions(v, next.release.version) === 0)) {
        next.release = null;
      }
      break;
    }
    case 'minimum': {
      const v = o.version;
      if (!parseVersion(v)) throw new Error(`not a version: ${v}`);
      if (next.minimum_version && compareVersions(v, next.minimum_version) < 0)
        throw new Error(`the minimum version only rises (now ${next.minimum_version})`);
      if (!next.release || compareVersions(v, next.release.version) > 0)
        throw new Error(`publish ${v} or newer on ${channel} before requiring it`);
      next.minimum_version = v;
      break;
    }
    default:
      throw new Error(`unknown action ${action}`);
  }
  return validate(next);
}

// ------------------------------------------------------------------------------------------------ CLI
function args(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) out[key] = true;
      else {
        out[key] = v;
        i++;
      }
    } else out._.push(a);
  }
  return out;
}

function main() {
  const a = args(process.argv.slice(2));
  const action = a._[0];
  const read = (p) => JSON.parse(readFileSync(p, 'utf8'));
  const now = a['issued-at'] ? parseUtc(a['issued-at']) : Math.floor(Date.now() / 1000);
  if (now === null) throw new Error('--issued-at');
  const current = a.current && a.current !== true ? read(a.current) : null;
  if (!current && !a.none && action !== 'release' && action !== 'promote')
    throw new Error('pass --current <manifest> (or --none for a first release)');
  const m = nextManifest({
    action,
    channel: a.channel,
    current,
    sequence: Number(a.sequence),
    now,
    validDays: a['valid-days'] ? Number(a['valid-days']) : 90,
    release:
      action === 'release'
        ? releaseFromFiles(a.version, a.artifacts, a['published-at'] ? a['published-at'] : iso(now))
        : undefined,
    from: action === 'promote' ? read(a.from) : undefined,
    versions: a.versions === true ? '' : a.versions,
    runtimeSha256: a['runtime-sha256'] === true ? '' : a['runtime-sha256'],
    version: a.version,
  });
  const text = `${JSON.stringify(m, null, 2)}\n`;
  if (!a.out || a.out === true) throw new Error('--out <file>');
  writeFileSync(a.out, text);
  console.log(
    `${m.channel}: sequence ${m.sequence}, release ${m.release?.version ?? 'none'}, paused ${m.paused}, ` +
      `minimum ${m.minimum_version ?? 'none'}, revoked [${m.revoked_versions.join(', ')}], expires ${m.expires_at}`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (e) {
    console.error(`channel-manifest: ${e.message}`);
    process.exit(1);
  }
}
