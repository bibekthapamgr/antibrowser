#!/usr/bin/env node
/**
 * Sets or checks the desktop app's version everywhere it is compiled in: tauri.conf.json (installer and bundle),
 * src-tauri/Cargo.toml and Cargo.lock (the version the updater compares against) and apps/desktop/package.json.
 * They must agree, or the app would offer itself its own update forever (or never update).
 *
 *   set-version.mjs <version>          writes all four (dev/canary builds: 0.12.1-beta.1, 0.12.1-dev.3)
 *   set-version.mjs --check <version>  exits 1 unless all four already say <version>
 *   set-version.mjs --print            prints the version (after checking the four agree)
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseVersion } from './channel-manifest.mjs';

const root = resolve(import.meta.dirname, '../..');
const files = {
  conf: join(root, 'apps/desktop/src-tauri/tauri.conf.json'),
  cargo: join(root, 'apps/desktop/src-tauri/Cargo.toml'),
  lock: join(root, 'Cargo.lock'),
  pkg: join(root, 'apps/desktop/package.json'),
};
const LOCK_ENTRY = /(\[\[package\]\]\nname = "pb-desktop"\nversion = ")([^"]+)(")/;
const CARGO_VERSION = /^(version = ")([^"]+)(")/m;
const JSON_VERSION = /^( {2}"version": ")([^"]+)(")/m;

function current() {
  const read = (f) => readFileSync(f, 'utf8');
  return {
    conf: JSON.parse(read(files.conf)).version,
    cargo: CARGO_VERSION.exec(read(files.cargo))?.[2],
    lock: LOCK_ENTRY.exec(read(files.lock))?.[2],
    pkg: JSON.parse(read(files.pkg)).version,
  };
}

function agreed() {
  const v = current();
  const values = new Set(Object.values(v));
  if (values.size !== 1) throw new Error(`the versions differ: ${JSON.stringify(v)}`);
  return v.conf;
}

const [first, second] = process.argv.slice(2);
try {
  if (first === '--print') {
    console.log(agreed());
  } else if (first === '--check') {
    const v = agreed();
    if (v !== second) throw new Error(`the app is ${v}, not ${second}`);
    console.log(`ok: ${v}`);
  } else {
    const v = first;
    const p = parseVersion(v);
    if (!p || v.includes('+')) throw new Error(`not a release version: ${v}`);
    if (p.pre.some((x) => !/^(alpha|beta|rc|dev|\d+)$/.test(x)))
      throw new Error('prerelease labels: alpha, beta, rc or dev with numbers (e.g. 0.12.1-beta.1)');
    // Only the version text changes (the files keep their formatting).
    for (const f of [files.conf, files.pkg]) {
      writeFileSync(f, readFileSync(f, 'utf8').replace(JSON_VERSION, `$1${v}$3`));
    }
    writeFileSync(files.cargo, readFileSync(files.cargo, 'utf8').replace(CARGO_VERSION, `$1${v}$3`));
    writeFileSync(files.lock, readFileSync(files.lock, 'utf8').replace(LOCK_ENTRY, `$1${v}$3`));
    console.log(`desktop app version: ${agreed()}`);
  }
} catch (e) {
  console.error(`set-version: ${e.message}`);
  process.exit(1);
}
