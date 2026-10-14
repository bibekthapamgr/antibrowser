#!/usr/bin/env node
/**
 * Adds a release PUBLIC key to apps/desktop/src-tauri/release-keys.json, the keys the app trusts for updates.
 * The private key never comes here: it stays with the owner (offline copy) and in the `release` environment's
 * secrets. See docs/security/update-runbook.md.
 *
 *   node scripts/release/add-release-key.mjs <file.key.pub> [--not-before 2026-10-14] [--not-after 2029-10-14] [--note "…"]
 *
 * The validity window works like a certificate's: after not_after the app stops accepting signatures by this key,
 * so a rotated key is added (in a release signed by the old one) well before the old one ends.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseReleaseKeys, parseUtc, publicKeyEntry } from './minisign.mjs';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const file = args.find((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
try {
  if (!file)
    throw new Error('usage: add-release-key.mjs <file.key.pub> [--not-before …] [--not-after …] [--note …]');
  const text = readFileSync(file, 'utf8');
  if (/secret key/i.test(Buffer.from(text.trim(), 'base64').toString('utf8')) || /secret key/i.test(text))
    throw new Error('this is a PRIVATE key. Give the .pub file; the private key must never be committed.');
  const today = new Date().toISOString().slice(0, 10);
  const later = new Date(Date.now() + 3 * 365 * 86400_000).toISOString().slice(0, 10);
  const entry = publicKeyEntry(
    text,
    opt('not-before', today),
    opt('not-after', later),
    opt('note', 'release key'),
  );
  if (parseUtc(entry.not_before) === null || parseUtc(entry.not_after) === null)
    throw new Error('dates: YYYY-MM-DD');
  const path = resolve(import.meta.dirname, '../../apps/desktop/src-tauri/release-keys.json');
  const keys = JSON.parse(readFileSync(path, 'utf8'));
  if (keys.keys.some((k) => k.key_id === entry.key_id))
    throw new Error(`key ${entry.key_id} is already listed`);
  keys.keys.push(entry);
  parseReleaseKeys(keys); // the same checks the app makes
  writeFileSync(path, `${JSON.stringify(keys, null, 2)}\n`);
  console.log(`added release key ${entry.key_id}, valid ${entry.not_before} to ${entry.not_after}`);
} catch (e) {
  console.error(`add-release-key: ${e.message}`);
  process.exit(1);
}
