#!/usr/bin/env node
/**
 * Writes the published record of a desktop release into its folder: SHA256SUMS (every file), provenance.json (what
 * was built from which commit by which run, with digests) and RELEASE_NOTES.md (how to verify). The GitHub
 * attestations (SLSA build provenance and the SBOM) are made by the workflow next to these.
 *
 * Usage: release-record.mjs <dir> <version> <channel>
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [dir, version, channel] = process.argv.slice(2);
if (!dir || !version || !channel) {
  console.error('usage: release-record.mjs <dir> <version> <channel>');
  process.exit(2);
}
const env = process.env;
const RECORD = new Set(['SHA256SUMS', 'provenance.json', 'RELEASE_NOTES.md']);
const files = readdirSync(dir)
  .filter((n) => !RECORD.has(n) && statSync(join(dir, n)).isFile())
  .sort()
  .map((name) => {
    const data = readFileSync(join(dir, name));
    return { name, bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') };
  });
writeFileSync(join(dir, 'SHA256SUMS'), `${files.map((f) => `${f.sha256}  ${f.name}`).join('\n')}\n`);

const repo = env.GITHUB_REPOSITORY ?? 'bibekthapamgr/antibrowser';
const server = env.GITHUB_SERVER_URL ?? 'https://github.com';
const run = env.GITHUB_RUN_ID ? `${server}/${repo}/actions/runs/${env.GITHUB_RUN_ID}` : null;
const provenance = {
  schema: 'project-browser/release-provenance@1',
  product: 'Project Browser',
  version,
  channel,
  source: { repository: repo, commit: env.GITHUB_SHA ?? null, ref: env.GITHUB_REF ?? null },
  build: { run_url: run, run_attempt: env.GITHUB_RUN_ATTEMPT ?? null, workflow: 'desktop release' },
  signing: {
    updates: 'Tauri update signature (minisign) by a key listed in apps/desktop/src-tauri/release-keys.json',
    windows: 'not code-signed (no certificate yet): Windows SmartScreen warns on a manual install',
    macos: 'ad-hoc signed, not notarized (no Apple Developer account): macOS asks to confirm the first open',
  },
  attestations: `${server}/${repo}/attestations`,
  published_at: new Date().toISOString(),
  files,
};
writeFileSync(join(dir, 'provenance.json'), `${JSON.stringify(provenance, null, 2)}\n`);

const installer = files.find((f) => f.name.endsWith('_x64-setup.exe'))?.name;
const dmg = files.find((f) => f.name.endsWith('.dmg'))?.name;
writeFileSync(
  join(dir, 'RELEASE_NOTES.md'),
  `Project Browser ${version} (${channel} channel). Installed apps on the ${channel} channel update themselves; ` +
    `these files are for new installs.

| File | For |
|---|---|
${installer ? `| \`${installer}\` | Windows 10/11 x64 (per-user install) |\n` : ''}${dmg ? `| \`${dmg}\` | macOS 13+ on Apple silicon |\n` : ''}| \`*.sig\` | Update signatures (checked by the app) |
| \`SHA256SUMS\`, \`provenance.json\`, \`*.sbom.cdx.json\` | Checksums, build record, software bill of materials |

**Before installing by hand**, check the file:

\`\`\`
sha256sum -c SHA256SUMS --ignore-missing          # macOS: shasum -a 256 -c SHA256SUMS --ignore-missing
gh attestation verify <file> --repo ${repo}       # built by this repository's release workflow
\`\`\`

Signing status: the Windows installer is not code-signed yet (SmartScreen shows a warning) and the macOS app is
signed ad hoc without notarization (macOS asks you to confirm the first open: Control-click → Open). Automatic updates
are verified by the app with the release key either way.

Built from ${env.GITHUB_SHA ? `\`${env.GITHUB_SHA.slice(0, 12)}\`` : 'this commit'}${run ? ` by [this run](${run})` : ''}.
`,
);
console.log(`recorded ${files.length} files`);
