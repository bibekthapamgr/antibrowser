/**
 * Notes are plain text: rendered as text (never HTML), with hidden control and bidirectional-override characters
 * removed. They are not a safe place for secrets: `secretHint` flags text that looks like a password, key, token or
 * card number. It mirrors the Rust check (`pb_import::notes`), runs in the window while typing, and the API refuses
 * such text in organization notes, handoff notes and access requests (NOTE_LOOKS_SECRET, milestone 08).
 */

// Built from a string so the source never contains the invisible characters themselves.
const BIDI = /[\u202A-\u202E\u2066-\u2069\u200E\u200F\u061C]/gu;
// biome-ignore lint/suspicious/noControlCharactersInRegex: removing control characters is the point
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/gu;

export function sanitizeNotes(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(CONTROL, '').replace(BIDI, '').replace(/\s+$/u, '');
}

const SECRET_WORDS = [
  'password',
  'passwort',
  'passwd',
  'passcode',
  'pwd',
  'pin code',
  'otp',
  '2fa',
  'backup code',
  'recovery code',
  'seed phrase',
  'mnemonic',
  'api key',
  'api_key',
  'apikey',
  'secret',
  'token',
  'private key',
];

function luhn(digits: number[]): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let v = digits[digits.length - 1 - i] as number;
    if (i % 2 === 1) {
      v *= 2;
      if (v > 9) v -= 9;
    }
    sum += v;
  }
  return sum % 10 === 0;
}

/** A short reason when `text` looks like it holds a secret; `null` otherwise. */
export function secretHint(text: string): string | null {
  const lower = text.toLowerCase();
  if (lower.includes('-----begin') && lower.includes('private key'))
    return 'This looks like a private key. Keep keys out of notes.';
  for (const word of SECRET_WORDS) {
    const pos = lower.indexOf(word);
    if (pos < 0) continue;
    const rest = lower.slice(pos + word.length).trimStart();
    if (rest.startsWith(':') || rest.startsWith('=') || rest.startsWith('is '))
      return 'This looks like a password or key. Notes are not encrypted: use a password manager instead.';
  }
  for (const token of text.split(/[\s,;"'()]+/u)) {
    if (token.length === 20 && /^AKIA[A-Z0-9]{16}$/.test(token)) return 'This looks like a cloud access key.';
    if (token.startsWith('eyJ') && token.split('.').length === 3 && token.length > 30)
      return 'This looks like an access token.';
    if (
      token.length >= 32 &&
      /^[A-Za-z0-9_\-+/=]+$/.test(token) &&
      /\d/.test(token) &&
      /[A-Za-z]/.test(token) &&
      !token.includes('://')
    )
      return 'This looks like a key or token.';
  }
  let digits: number[] = [];
  for (const c of `${text}x`) {
    if (c >= '0' && c <= '9') digits.push(c.charCodeAt(0) - 48);
    else if ((c === ' ' || c === '-') && digits.length > 0) continue;
    else {
      if (digits.length >= 13 && digits.length <= 19 && luhn(digits))
        return 'This looks like a payment card number.';
      digits = [];
    }
  }
  return null;
}
