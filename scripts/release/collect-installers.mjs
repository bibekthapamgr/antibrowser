#!/usr/bin/env node
/**
 * Collects the installers Tauri produced into dist-installers/, names them so an unsigned build can never be
 * mistaken for a signed one, and writes SHA256SUMS plus a provenance record next to them.
 *
 * Usage: node scripts/release/collect-installers.mjs <target> <signed|unsigned>
 * Environment (GitHub Actions): GITHUB_SHA, GITHUB_REF, GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID,
 * GITHUB_RUN_ATTEMPT, RUNNER_OS, RUNNER_ARCH.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';

const [target, signing] = process.argv.slice(2);
if (!target || !['signed', 'unsigned'].includes(signing ?? '')) {
  console.error('usage: collect-installers.mjs <target> <signed|unsigned>');
  process.exit(2);
}
const root = resolve(import.meta.dirname, '../..');
const conf = JSON.parse(readFileSync(join(root, 'apps/desktop/src-tauri/tauri.conf.json'), 'utf8'));
const bundle = join(root, 'target/release/bundle');
const out = join(root, 'dist-installers');
mkdirSync(out, { recursive: true });

const WANTED = new Set(['.dmg', '.zip', '.exe', '.msi']);
const found = [];
const walk = (dir) => {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory() && !name.endsWith('.app')) walk(p);
    else if (st.isFile() && WANTED.has(extname(name))) found.push(p);
  }
};
walk(bundle);
if (found.length === 0) {
  console.error(`no installers found under ${bundle}`);
  process.exit(1);
}

const label = signing === 'signed' ? 'internal' : 'internal-UNSIGNED';
const files = found.map((src) => {
  const kind = { '.dmg': 'dmg', '.zip': 'app', '.exe': 'nsis-setup', '.msi': 'msi' }[extname(src)];
  const name = `project-browser-${conf.version}-${label}-${target}-${kind}${extname(src)}`;
  copyFileSync(src, join(out, name));
  const data = readFileSync(join(out, name));
  return {
    name,
    source: basename(src),
    bytes: data.length,
    sha256: createHash('sha256').update(data).digest('hex'),
  };
});

writeFileSync(join(out, 'SHA256SUMS'), `${files.map((f) => `${f.sha256}  ${f.name}`).join('\n')}\n`);

const version = (cmd, args) => {
  try {
    return execFileSync(cmd, args, {
      encoding: 'utf8',
      shell: process.platform === 'win32',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
};
const env = process.env;
const provenance = {
  schema: 'project-browser/internal-build-provenance@1',
  product: conf.productName,
  identifier: conf.identifier,
  version: conf.version,
  channel: 'internal',
  target,
  signed: signing === 'signed',
  note:
    signing === 'signed'
      ? 'Signed with the organization certificate configured in repository secrets.'
      : 'UNSIGNED internal build: for engineering testing only. Operating systems will warn before opening it.',
  source: {
    repository: env.GITHUB_REPOSITORY ?? null,
    commit: env.GITHUB_SHA ?? version('git', ['rev-parse', 'HEAD']),
    ref: env.GITHUB_REF ?? null,
  },
  build: {
    run_url:
      env.GITHUB_RUN_ID && env.GITHUB_REPOSITORY
        ? `${env.GITHUB_SERVER_URL ?? 'https://github.com'}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`
        : null,
    run_attempt: env.GITHUB_RUN_ATTEMPT ?? null,
    runner: { os: env.RUNNER_OS ?? process.platform, arch: env.RUNNER_ARCH ?? process.arch },
    toolchain: {
      rustc: version('rustc', ['--version']),
      node: process.version,
      pnpm: version('pnpm', ['--version']),
    },
    built_at: new Date().toISOString(),
  },
  files,
};
writeFileSync(join(out, 'provenance.json'), `${JSON.stringify(provenance, null, 2)}\n`);
console.log(readFileSync(join(out, 'SHA256SUMS'), 'utf8'));
