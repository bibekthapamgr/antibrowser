#!/usr/bin/env node
/**
 * Runtime manifest tooling for the runtime pipeline (docs/runtime-pipeline.md).
 *
 *   resolve                       print the current Chrome for Testing stable version as JSON
 *   artifact <platform> <zip> <url> <version>
 *                                 print one artifact entry (sha256, size, executable path) for a downloaded archive
 *   build <version> <revision> <artifacts-dir> [compat-dir]
 *                                 assemble runtimes/manifest.json from artifact-*.json (+ compat-*.json)
 *   sign <manifest> <key-id>      sign with the Ed25519 seed in $RUNTIME_MANIFEST_SIGNING_KEY (64 hex chars);
 *                                 refuses if the seed does not match the trusted public key for <key-id>
 *   verify <manifest> <sig> <trusted-keys.json>
 *   keygen                        print a new key pair (seed stays on stdout only; store it as a secret)
 *
 * The manager verifies the same signature in Rust (crates/update); this script never weakens that check.
 */
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
} from 'node:crypto';
import { createReadStream, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const CFT =
  'https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json';
const PLATFORMS = {
  'macos-arm64': {
    cft: 'mac-arm64',
    exe: 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    codesign: 'required',
  },
  'windows-x64': { cft: 'win64', exe: 'chrome-win64/chrome.exe' },
  'linux-x64': { cft: 'linux64', exe: 'chrome-linux64/chrome' },
};
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

const die = (msg) => {
  console.error(msg);
  process.exit(1);
};

const sha256File = (path) =>
  new Promise((ok, fail) => {
    const h = createHash('sha256');
    createReadStream(path)
      .on('data', (d) => h.update(d))
      .on('end', () => ok(h.digest('hex')))
      .on('error', fail);
  });

const privateFromSeed = (hex) => {
  if (!/^[0-9a-f]{64}$/.test(hex ?? '')) die('RUNTIME_MANIFEST_SIGNING_KEY must be 64 lowercase hex chars');
  return createPrivateKey({
    key: Buffer.concat([PKCS8_PREFIX, Buffer.from(hex, 'hex')]),
    format: 'der',
    type: 'pkcs8',
  });
};
const publicFromHex = (hex) =>
  createPublicKey({
    key: Buffer.concat([SPKI_PREFIX, Buffer.from(hex, 'hex')]),
    format: 'der',
    type: 'spki',
  });

const [cmd, ...args] = process.argv.slice(2);
switch (cmd) {
  case 'resolve': {
    const res = await fetch(CFT);
    if (!res.ok) die(`chrome-for-testing index: HTTP ${res.status}`);
    const stable = (await res.json()).channels.Stable;
    const urls = {};
    for (const [platform, p] of Object.entries(PLATFORMS)) {
      const d = stable.downloads.chrome.find((x) => x.platform === p.cft);
      if (!d) die(`no ${p.cft} download for ${stable.version}`);
      urls[platform] = d.url;
    }
    console.log(JSON.stringify({ version: stable.version, revision: stable.revision, urls }));
    break;
  }
  case 'artifact': {
    const [platform, zip, url, version] = args;
    const p = PLATFORMS[platform] ?? die(`unknown platform ${platform}`);
    if (!url.startsWith(`https://storage.googleapis.com/chrome-for-testing-public/${version}/`))
      die(`unexpected url ${url}`);
    const entry = {
      platform,
      url,
      sha256: await sha256File(zip),
      size_bytes: statSync(zip).size,
      format: 'zip',
      executable: p.exe,
      // The pipeline sets PB_MACOS_CODESIGN=none only if the upstream bundle's signature did not verify.
      ...(p.codesign ? { macos_codesign: process.env.PB_MACOS_CODESIGN ?? p.codesign } : {}),
    };
    console.log(JSON.stringify(entry));
    break;
  }
  case 'build': {
    const [version, revision, artifactsDir, compatDir] = args;
    const read = (dir, prefix) =>
      dir
        ? readdirSync(dir, { recursive: true })
            .map(String)
            .filter((f) => f.split(/[\\/]/).pop().startsWith(prefix) && f.endsWith('.json'))
            .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')))
        : [];
    const artifacts = read(artifactsDir, 'artifact-').sort((a, b) => a.platform.localeCompare(b.platform));
    const compatibility = read(compatDir, 'compat-').sort((a, b) => a.platform.localeCompare(b.platform));
    if (artifacts.length === 0) die('no artifact-*.json files');
    for (const a of artifacts) {
      const c = compatibility.find((x) => x.platform === a.platform);
      if (c?.result !== 'pass') die(`compatibility tests did not pass for ${a.platform}`);
    }
    const manifest = {
      schema: 2,
      channel: 'internal-alpha',
      created_at: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
      distribution: {
        id: 'chrome-for-testing',
        name: 'Chrome for Testing',
        license:
          'Google Chrome for Testing binaries: intended for automated testing; internal engineering use only, not for customer distribution (ADR-0010)',
        customer_distribution: false,
        source: 'https://googlechromelabs.github.io/chrome-for-testing/',
      },
      runtime: { version, revision: String(revision), artifacts },
      compatibility,
    };
    writeFileSync('runtimes/manifest.json', `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(`runtimes/manifest.json: ${version} (${artifacts.map((a) => a.platform).join(', ')})`);
    break;
  }
  case 'sign': {
    const [manifestPath, keyId] = args;
    if (!/^[a-z0-9-]{3,64}$/.test(keyId ?? '')) die('key id must be [a-z0-9-]{3,64}');
    const key = privateFromSeed(process.env.RUNTIME_MANIFEST_SIGNING_KEY);
    // The secret must belong to the trusted public key the manager embeds; refuse to sign otherwise.
    const derived = createPublicKey(key)
      .export({ format: 'der', type: 'spki' })
      .subarray(-32)
      .toString('hex');
    const trusted = JSON.parse(readFileSync('runtimes/trusted-keys.json', 'utf8')).keys.find(
      (k) => k.key_id === keyId,
    );
    if (!trusted) die(`key id ${keyId} is not in runtimes/trusted-keys.json`);
    if (trusted.public_key !== derived)
      die(`RUNTIME_MANIFEST_SIGNING_KEY does not match trusted key ${keyId}`);
    const signature = sign(null, readFileSync(manifestPath), key).toString('hex');
    writeFileSync(
      `${manifestPath}.sig`,
      `${JSON.stringify({ schema: 1, key_id: keyId, algorithm: 'ed25519', signature })}\n`,
    );
    console.log(`signed ${manifestPath} with ${keyId}`);
    break;
  }
  case 'verify': {
    const [manifestPath, sigPath, keysPath] = args;
    const sig = JSON.parse(readFileSync(sigPath, 'utf8'));
    const key = JSON.parse(readFileSync(keysPath, 'utf8')).keys.find((k) => k.key_id === sig.key_id);
    if (!key) die(`untrusted key ${sig.key_id}`);
    const ok = verify(
      null,
      readFileSync(manifestPath),
      publicFromHex(key.public_key),
      Buffer.from(sig.signature, 'hex'),
    );
    if (!ok) die('signature does NOT verify');
    console.log(`signature ok (${sig.key_id})`);
    break;
  }
  case 'keygen': {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const seed = privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32).toString('hex');
    const pub = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');
    console.log(JSON.stringify({ seed, public_key: pub }));
    break;
  }
  default:
    die('usage: manifest.mjs resolve|artifact|build|sign|verify|keygen');
}
