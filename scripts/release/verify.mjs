#!/usr/bin/env node
/**
 * Checks a channel manifest and its release files the way the app does, against the release keys compiled into
 * the app (apps/desktop/src-tauri/release-keys.json). The release job runs it on the current manifest before
 * building on it, and on everything it signed before publishing; anyone can run it on a downloaded release.
 *
 *   verify.mjs manifest <channel.json> [--sig <channel.json.sig>] [--keys <release-keys.json>] [--files <dir>]
 *       [--channel <name>] [--min-sequence <n>]
 *   verify.mjs file <file> [--sig <file.sig>] --version <v> [--keys <release-keys.json>]
 *
 * --files: every artifact listed must be in <dir> with the listed size and SHA-256, and its signature must be by a
 * trusted key, for this version and file name. Exit code 0 only when everything holds.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { compareVersions, validate } from './channel-manifest.mjs';
import { parseReleaseKeys, verifySignature } from './minisign.mjs';

const DEFAULT_KEYS = resolve(import.meta.dirname, '../../apps/desktop/src-tauri/release-keys.json');

export function verifyFile(path, sigB64, version, keys, now) {
  const fields = verifySignature(readFileSync(path), sigB64, keys, now);
  if (fields.file !== basename(path))
    throw new Error(`${basename(path)}: signed as ${fields.file ?? 'no file'}`);
  if (!fields.version || compareVersions(fields.version, version) !== 0)
    throw new Error(`${basename(path)}: signed for version ${fields.version ?? 'none'}, not ${version}`);
  return fields;
}

export function verifyManifest(bytes, sigB64, keys, now, opts = {}) {
  const fields = verifySignature(bytes, sigB64, keys, now);
  const m = validate(JSON.parse(bytes.toString('utf8')));
  if (fields.file !== `${m.channel}.json`)
    throw new Error(`signed as ${fields.file ?? 'no file'}, not ${m.channel}.json`);
  if (opts.channel && m.channel !== opts.channel)
    throw new Error(`a ${m.channel} manifest, not ${opts.channel}`);
  if (opts.minSequence !== undefined && m.sequence < opts.minSequence)
    throw new Error(`sequence ${m.sequence} is below ${opts.minSequence}`);
  if (opts.files && m.release) {
    for (const a of m.release.artifacts) {
      const name = a.url.split('/').pop();
      const path = join(opts.files, name);
      if (!existsSync(path)) throw new Error(`${name} is missing`);
      const data = readFileSync(path);
      if (data.length !== a.size_bytes)
        throw new Error(`${name}: size ${data.length}, manifest ${a.size_bytes}`);
      if (createHash('sha256').update(data).digest('hex') !== a.sha256)
        throw new Error(`${name}: SHA-256 differs`);
      verifyFile(path, a.signature, m.release.version, keys, now);
    }
  }
  return m;
}

function main() {
  const [kind, target, ...rest] = process.argv.slice(2);
  const opt = (name) => {
    const i = rest.indexOf(`--${name}`);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  const keys = parseReleaseKeys(readFileSync(opt('keys') ?? DEFAULT_KEYS, 'utf8'));
  if (keys.length === 0) throw new Error('release-keys.json has no key: the app would not trust any release');
  const now = Math.floor(Date.now() / 1000);
  const sig = readFileSync(opt('sig') ?? `${target}.sig`, 'utf8');
  if (kind === 'manifest') {
    const m = verifyManifest(readFileSync(target), sig, keys, now, {
      channel: opt('channel'),
      minSequence: opt('min-sequence') ? Number(opt('min-sequence')) : undefined,
      files: opt('files'),
    });
    console.log(
      `ok: ${m.channel} manifest, sequence ${m.sequence}, release ${m.release?.version ?? 'none'}, expires ${m.expires_at}` +
        (opt('files') && m.release ? `, ${m.release.artifacts.length} files checked` : ''),
    );
  } else if (kind === 'file') {
    const version = opt('version');
    if (!version) throw new Error('--version');
    verifyFile(target, sig, version, keys, now);
    console.log(`ok: ${basename(target)} signed for ${version}`);
  } else {
    throw new Error('usage: verify.mjs manifest|file <path> …');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (e) {
    console.error(`verify: ${e.message}`);
    process.exit(1);
  }
}
