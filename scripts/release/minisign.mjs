/**
 * Verifies Tauri update signatures (minisign format) with Node's built-in crypto only, so the release job can check
 * what it signed against the public keys compiled into the app (apps/desktop/src-tauri/release-keys.json) before
 * anything is published. Same rules as crates/update/src/app.rs: a trusted key, inside its validity window, and the
 * trusted comment's fields returned only after the signature that covers them has been checked.
 *
 * Formats (https://jedisct1.github.io/minisign/):
 *   public key: base64("Ed" | key id (8, little-endian) | Ed25519 public key (32))
 *   signature:  base64("ED" | key id | Ed25519 signature over BLAKE2b-512(data)) — "Ed" signs the data itself
 *   global:     Ed25519 signature over (signature (64) | trusted comment)
 * A Tauri signature file is base64 of the whole minisign signature text.
 */
import { createHash, createPublicKey, verify } from 'node:crypto';

const b64 = (s) => Buffer.from(s.trim(), 'base64');

/** The minisign key id as uppercase hex (as `tauri signer generate` prints it). */
export const keyIdHex = (bytes) => Buffer.from(bytes).reverse().toString('hex').toUpperCase();

export function parseUtc(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?Z)?$/.exec(s ?? '');
  if (!m) return null;
  const [, y, mo, d, h = '0', mi = '0', se = '0'] = m;
  const t = Date.UTC(+y, +mo - 1, +d, +h, +mi, +se);
  const back = new Date(t);
  if (back.getUTCMonth() !== +mo - 1 || back.getUTCDate() !== +d) return null;
  return Math.floor(t / 1000);
}

function keyLine(text) {
  return text.split('\n').find((l) => l.trim() && !l.startsWith('untrusted comment:'));
}

/** Parses release-keys.json: `{ keys: [{ key_id, public_key (base64 of the .pub text), not_before, not_after }] }`. */
export function parseReleaseKeys(json) {
  const file = typeof json === 'string' ? JSON.parse(json) : json;
  return (file.keys ?? []).map((k) => {
    const text = b64(k.public_key).toString('utf8');
    const raw = b64(keyLine(text) ?? '');
    if (raw.length !== 42 || raw.subarray(0, 2).toString() !== 'Ed')
      throw new Error(`release key ${k.key_id}: not a minisign key`);
    if (keyIdHex(raw.subarray(2, 10)) !== k.key_id)
      throw new Error(`release key ${k.key_id}: the key id does not match the key`);
    const notBefore = parseUtc(k.not_before);
    const notAfter = parseUtc(k.not_after);
    if (notBefore === null || notAfter === null || notAfter <= notBefore)
      throw new Error(`release key ${k.key_id}: validity`);
    const key = createPublicKey({
      key: { kty: 'OKP', crv: 'Ed25519', x: raw.subarray(10).toString('base64url') },
      format: 'jwk',
    });
    return {
      keyId: k.key_id,
      idBytes: raw.subarray(2, 10),
      key,
      notBefore,
      notAfter,
      notAfterText: k.not_after,
    };
  });
}

/** Parses the public key text `tauri signer generate` writes (`*.key.pub`, base64 of the minisign .pub file). */
export function publicKeyEntry(pubFileContent, notBefore, notAfter, note = '') {
  const text = b64(pubFileContent).toString('utf8');
  const raw = b64(keyLine(text) ?? '');
  if (raw.length !== 42) throw new Error('not a minisign public key');
  return {
    key_id: keyIdHex(raw.subarray(2, 10)),
    public_key: pubFileContent.trim(),
    not_before: notBefore,
    not_after: notAfter,
    note,
  };
}

export class SignatureError extends Error {}

/**
 * Verifies a Tauri-format signature over `data` (Buffer) with one of `keys` valid at `now` (unix seconds) and returns
 * the trusted comment's fields (`timestamp`, `file`, `version`).
 */
export function verifySignature(data, sigB64, keys, now) {
  let text;
  try {
    text = b64(sigB64).toString('utf8');
  } catch {
    throw new SignatureError('not base64');
  }
  const lines = text.split('\n').map((l) => l.replace(/\r$/, ''));
  const sigLine = lines.find((l) => l && !l.includes(':'));
  const trusted = lines.find((l) => l.startsWith('trusted comment: '));
  const globalLine = lines[lines.indexOf(trusted ?? '') + 1];
  if (!sigLine || !trusted || !globalLine) throw new SignatureError('incomplete signature');
  const sig = b64(sigLine);
  if (sig.length !== 74) throw new SignatureError('bad signature length');
  const alg = sig.subarray(0, 2).toString();
  const k = keys.find((x) => x.idBytes.equals(sig.subarray(2, 10)));
  if (!k) throw new SignatureError('signed by a key this app does not trust');
  if (now > k.notAfter) throw new SignatureError(`the release key expired on ${k.notAfterText}`);
  if (now < k.notBefore) throw new SignatureError('the release key is not valid yet');
  const message = alg === 'ED' ? createHash('blake2b512').update(data).digest() : alg === 'Ed' ? data : null;
  if (!message) throw new SignatureError('unknown signature algorithm');
  const ed = sig.subarray(10);
  if (!verify(null, message, k.key, ed)) throw new SignatureError('signature does not match');
  const comment = trusted.slice('trusted comment: '.length);
  if (!verify(null, Buffer.concat([ed, Buffer.from(comment)]), k.key, b64(globalLine))) {
    throw new SignatureError('trusted comment does not match');
  }
  return Object.fromEntries(
    comment
      .split('\t')
      .map((f) => f.split(/:(.*)/s).slice(0, 2))
      .filter(([key, v]) => key && v !== undefined),
  );
}
