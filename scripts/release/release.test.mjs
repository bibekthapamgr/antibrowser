/**
 * Release tooling tests (node --test scripts/release): signature checks against files made by the real Tauri CLI,
 * the publishing rules of channel-manifest.mjs, and verify.mjs on a whole release.
 */
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { compareVersions, nextManifest, releaseFromFiles, validate } from './channel-manifest.mjs';
import { keyIdHex, parseReleaseKeys, parseUtc, publicKeyEntry, verifySignature } from './minisign.mjs';
import { verifyFile, verifyManifest } from './verify.mjs';

const FIXTURES = resolve(import.meta.dirname, '../../crates/update/tests/fixtures/tauri-cli');
const fixture = (n) => readFileSync(join(FIXTURES, n));
const NOW = parseUtc('2026-10-15T08:00:00Z');

const cliKeys = () =>
  parseReleaseKeys({
    keys: [publicKeyEntry(fixture('throwaway.key.pub').toString(), '2026-10-01', '2027-12-31', 'throwaway')],
  });

/** A minisign key pair made here (prehashed "ED" signatures, like `tauri signer`). */
function testKey() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const id = Buffer.from([1, 2, 3, 4, 5, 6, 7, Math.floor(Math.random() * 255)]);
  const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url');
  const pubText = `untrusted comment: minisign public key: ${keyIdHex(id)}\n${Buffer.concat([Buffer.from('Ed'), id, raw]).toString('base64')}\n`;
  return {
    pub: Buffer.from(pubText).toString('base64'),
    sign(data, comment, legacy = false) {
      const message = legacy ? data : createHash('blake2b512').update(data).digest();
      const sig = sign(null, message, privateKey);
      const global = sign(null, Buffer.concat([sig, Buffer.from(comment)]), privateKey);
      const alg = legacy ? 'Ed' : 'ED';
      const text = `untrusted comment: signature from tauri secret key\n${Buffer.concat([Buffer.from(alg), id, sig]).toString('base64')}\ntrusted comment: ${comment}\n${global.toString('base64')}\n`;
      return Buffer.from(text).toString('base64');
    },
  };
}

describe('signatures', () => {
  it('verifies what the Tauri CLI signed, with the trusted comment fields', () => {
    const keys = cliKeys();
    assert.equal(keys[0].keyId, '4814555635DFEA4F');
    const exe = verifySignature(
      fixture('Project.Browser_0.12.1_x64-setup.exe'),
      fixture('Project.Browser_0.12.1_x64-setup.exe.sig').toString(),
      keys,
      NOW,
    );
    assert.equal(exe.version, '0.12.1');
    assert.equal(exe.file, 'Project.Browser_0.12.1_x64-setup.exe');
    const m = verifySignature(fixture('stable.json'), fixture('stable.json.sig').toString(), keys, NOW);
    assert.equal(m.file, 'stable.json');
  });

  it('refuses other bytes, unknown keys, expired keys and mismatched key ids', () => {
    const keys = cliKeys();
    const sig = fixture('stable.json.sig').toString();
    assert.throws(() => verifySignature(Buffer.from('other'), sig, keys, NOW), /does not match/);
    const other = testKey();
    const otherKeys = parseReleaseKeys({
      keys: [publicKeyEntry(Buffer.from(other.pub, 'base64').toString('base64'), '2026-01-01', '2030-01-01')],
    });
    assert.throws(() => verifySignature(fixture('stable.json'), sig, otherKeys, NOW), /does not trust/);
    // Legacy (not prehashed) signatures are refused, as in the app, even from a trusted key.
    const data = Buffer.from('{"channel":"stable"}');
    const comment = 'timestamp:1\tfile:stable.json';
    assert.equal(verifySignature(data, other.sign(data, comment), otherKeys, NOW).file, 'stable.json');
    assert.throws(() => verifySignature(data, other.sign(data, comment, true), otherKeys, NOW), /legacy/);
    const expired = parseReleaseKeys({
      keys: [publicKeyEntry(fixture('throwaway.key.pub').toString(), '2026-01-01', '2026-10-02')],
    });
    assert.throws(() => verifySignature(fixture('stable.json'), sig, expired, NOW), /expired on 2026-10-02/);
    const entry = publicKeyEntry(fixture('throwaway.key.pub').toString(), '2026-01-01', '2030-01-01');
    assert.throws(
      () => parseReleaseKeys({ keys: [{ ...entry, key_id: '0000000000000000' }] }),
      /does not match/,
    );
  });

  it('the release keys compiled into the app parse', () => {
    const file = JSON.parse(
      readFileSync(resolve(import.meta.dirname, '../../apps/desktop/src-tauri/release-keys.json'), 'utf8'),
    );
    parseReleaseKeys(file);
  });
});

describe('channel manifests', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'pb-release-'));
  const k = testKey();
  const keys = parseReleaseKeys({ keys: [publicKeyEntry(k.pub, '2026-01-01', '2030-01-01')] });
  /** Signed release files for `version` in a new folder. */
  const files = (version) => {
    const dir = mkdtempSync(join(tmp, `${version}-`));
    for (const name of [
      `Project.Browser_${version}_x64-setup.exe`,
      `Project.Browser_${version}_aarch64.app.tar.gz`,
    ]) {
      const data = Buffer.from(`${name} contents`);
      writeFileSync(join(dir, name), data);
      writeFileSync(
        join(dir, `${name}.sig`),
        k.sign(data, `timestamp:${NOW}\tfile:${name}\tversion:${version}`),
      );
    }
    return dir;
  };
  const release = (channel, current, sequence, version) =>
    nextManifest({
      action: 'release',
      channel,
      current,
      sequence,
      now: NOW,
      release: releaseFromFiles(version, files(version), '2026-10-15T08:00:00Z'),
    });

  it('a first release lists both platforms and passes the app rules', () => {
    const m = release('canary', null, 100, '0.12.1-beta.1');
    assert.equal(m.release.artifacts.length, 2);
    assert.deepEqual(
      m.release.artifacts.map((a) => [a.platform, a.kind]),
      [
        ['windows-x64', 'nsis'],
        ['macos-arm64', 'app-tar-gz'],
      ],
    );
    assert.match(
      m.release.artifacts[0].url,
      /\/releases\/download\/desktop-v0\.12\.1-beta\.1\/Project\.Browser_/,
    );
    assert.equal(m.expires_at, '2026-11-14T08:00:00Z');
    validate(m);
  });

  it('publishing rules: growing sequence, no going back, stable takes plain versions, validity ≤ 45 days', () => {
    const m = release('canary', null, 100, '0.12.1-beta.1');
    assert.throws(() => release('canary', m, 100, '0.12.1-beta.2'), /sequence must grow/);
    assert.throws(() => release('canary', m, 101, '0.12.0'), /never goes back/);
    assert.throws(() => release('stable', null, 1, '0.12.1-beta.1'), /only plain versions/);
    assert.throws(
      () =>
        nextManifest({
          action: 'pause',
          channel: 'canary',
          current: m,
          sequence: 102,
          now: NOW,
          validDays: 46,
        }),
      /validity/,
    );
    assert.equal(compareVersions('0.12.1-beta.2', '0.12.1-beta.10'), -1);
  });

  it('promotion copies the exact signed files; revoked or prerelease builds are not promoted', () => {
    const canary = release('canary', null, 100, '0.12.1');
    const stable = nextManifest({
      action: 'promote',
      channel: 'stable',
      current: null,
      sequence: 5,
      now: NOW,
      from: canary,
    });
    assert.deepEqual(stable.release, canary.release);
    const beta = release('canary', canary, 101, '0.12.2-beta.1');
    assert.throws(
      () =>
        nextManifest({
          action: 'promote',
          channel: 'stable',
          current: stable,
          sequence: 6,
          now: NOW,
          from: beta,
        }),
      /only plain versions/,
    );
    const revoked = nextManifest({
      action: 'revoke',
      channel: 'canary',
      current: canary,
      sequence: 102,
      now: NOW,
      versions: '0.12.1',
    });
    assert.equal(revoked.release, null);
    assert.throws(
      () =>
        nextManifest({
          action: 'promote',
          channel: 'stable',
          current: stable,
          sequence: 7,
          now: NOW,
          from: { ...revoked, release: canary.release },
        }),
      /revoked/,
    );
  });

  it('pause, resume, revoke and minimum version', () => {
    let m = release('stable', null, 10, '0.12.1');
    m = nextManifest({ action: 'pause', channel: 'stable', current: m, sequence: 11, now: NOW });
    assert.equal(m.paused, true);
    assert.equal(m.release.version, '0.12.1');
    m = nextManifest({ action: 'resume', channel: 'stable', current: m, sequence: 12, now: NOW });
    assert.equal(m.paused, false);
    m = nextManifest({
      action: 'revoke',
      channel: 'stable',
      current: m,
      sequence: 13,
      now: NOW,
      versions: '0.12.0',
      runtimeSha256: 'A'.repeat(64),
    });
    assert.deepEqual(m.revoked_versions, ['0.12.0']);
    assert.deepEqual(m.revoked_runtime_sha256, ['a'.repeat(64)]);
    assert.equal(m.release.version, '0.12.1');
    assert.throws(() => release('stable', m, 14, '0.12.0'), /never goes back|revoked/);
    assert.throws(
      () =>
        nextManifest({
          action: 'minimum',
          channel: 'stable',
          current: m,
          sequence: 14,
          now: NOW,
          version: '0.13.0',
        }),
      /before requiring it/,
    );
    m = nextManifest({
      action: 'minimum',
      channel: 'stable',
      current: m,
      sequence: 14,
      now: NOW,
      version: '0.12.1',
    });
    assert.equal(m.minimum_version, '0.12.1');
    assert.throws(
      () =>
        nextManifest({
          action: 'minimum',
          channel: 'stable',
          current: m,
          sequence: 15,
          now: NOW,
          version: '0.12.0',
        }),
      /only rises/,
    );
    m = nextManifest({ action: 'refresh', channel: 'stable', current: m, sequence: 16, now: NOW + 86400 });
    assert.equal(m.issued_at, '2026-10-16T08:00:00Z');
    assert.throws(
      () => nextManifest({ action: 'refresh', channel: 'dev', current: null, sequence: 1, now: NOW }),
      /no manifest/,
    );
  });

  it('verify.mjs checks the manifest signature, its file name and every listed file', () => {
    const dir = files('0.12.1');
    const m = nextManifest({
      action: 'release',
      channel: 'stable',
      current: null,
      sequence: 20,
      now: NOW,
      release: releaseFromFiles('0.12.1', dir, '2026-10-15T08:00:00Z'),
    });
    const body = Buffer.from(`${JSON.stringify(m, null, 2)}\n`);
    const sig = k.sign(body, `timestamp:${NOW}\tfile:stable.json`);
    assert.equal(verifyManifest(body, sig, keys, NOW, { channel: 'stable', files: dir }).sequence, 20);
    // Signed as another channel's file.
    assert.throws(
      () => verifyManifest(body, k.sign(body, `timestamp:${NOW}\tfile:canary.json`), keys, NOW),
      /not stable\.json/,
    );
    // A file changed after signing.
    const copy = mkdtempSync(join(tmp, 'copy-'));
    cpSync(dir, copy, { recursive: true });
    writeFileSync(join(copy, 'Project.Browser_0.12.1_x64-setup.exe'), 'changed');
    assert.throws(() => verifyManifest(body, sig, keys, NOW, { files: copy }), /size|SHA-256/);
    // An installer signed for another version.
    const name = 'Project.Browser_0.12.1_x64-setup.exe';
    const wrong = k.sign(readFileSync(join(dir, name)), `timestamp:${NOW}\tfile:${name}\tversion:0.12.0`);
    assert.throws(() => verifyFile(join(dir, name), wrong, '0.12.1', keys, NOW), /version 0\.12\.0/);
    assert.throws(() => verifyManifest(body, sig, keys, NOW, { minSequence: 21 }), /below 21/);
  });

  it('the fixture manifest made by this tool and the Tauri CLI verifies with its file', () => {
    const m = verifyManifest(fixture('stable.json'), fixture('stable.json.sig').toString(), cliKeys(), NOW, {
      channel: 'stable',
      files: FIXTURES,
    });
    assert.equal(m.release.version, '0.12.1');
  });
});
