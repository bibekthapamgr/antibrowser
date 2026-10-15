/**
 * R5 (ADR-0024): support-case notes are redacted before they are stored. Notes are for what happened and what was
 * agreed — never for card numbers, passwords, keys or tokens, which a staff member may paste by mistake from a
 * customer's message. The same patterns as the profile-notes check (packages/contracts notes.ts `secretHint`) are
 * REPLACED here instead of refused, so a note is never lost:
 *  - card-like numbers (13-19 digits, spaces or dashes allowed, Luhn-valid);
 *  - values after "password:", "token=", "api key is" and similar;
 *  - private key blocks, JWT-like tokens, provider keys (sk_…, rk_…, whsec_…, pbt_…, AKIA…) and other long
 *    key-looking strings.
 */
import { sanitizeNotes } from '@pb/contracts';

const MARK = '[redacted]';

const SECRET_WORDS =
  /\b(password|passwort|passwd|passcode|pwd|pin code|otp|2fa|backup code|recovery code|seed phrase|mnemonic|api[ _]?key|secret|token|private key)(\s*(?::|=|is)\s*)(\S+)/giu;

function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let v = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      v *= 2;
      if (v > 9) v -= 9;
    }
    sum += v;
  }
  return sum % 10 === 0;
}

export function redactNote(input: string): { text: string; redacted: boolean } {
  let text = sanitizeNotes(input);
  const before = text;
  text = text.replace(
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g,
    MARK,
  );
  text = text.replace(SECRET_WORDS, (_m, word: string, sep: string) => `${word}${sep}${MARK}`);
  text = text.replace(/\b(?:\d[ -]?){12,18}\d\b/g, (m) => {
    const digits = m.replace(/[ -]/g, '');
    return digits.length >= 13 && digits.length <= 19 && luhn(digits) ? MARK : m;
  });
  text = text.replace(/[A-Za-z0-9_\-+/=.]{20,}/g, (token) => {
    if (token.includes('://')) return token;
    if (/^(sk|rk|pk)_(live|test)_/.test(token) || /^whsec_/.test(token) || /^pbt_/.test(token)) return MARK;
    if (/^AKIA[A-Z0-9]{16}$/.test(token)) return MARK;
    if (token.startsWith('eyJ') && token.split('.').length === 3) return MARK;
    if (
      token.length >= 32 &&
      /\d/.test(token) &&
      /[A-Za-z]/.test(token) &&
      /^[A-Za-z0-9_\-+/=]+$/.test(token)
    )
      return MARK;
    return token;
  });
  return { text, redacted: text !== before };
}
