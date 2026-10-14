/**
 * One-time codes for the deploy checks (R2: staff sign in to the console with a password and a one-time code).
 * Keycloak's TOTP: HMAC-SHA1 over the secret as it stores it (the hidden `totpSecret` field, used as UTF-8 bytes),
 * 30-second steps, 6 digits. The secret of a test account is kept in a file (mode 0600) between steps; a code is
 * never used twice (Keycloak refuses a reused code), so a check waits for the next step when needed.
 */
import { createHmac } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function totp(secret: string, step = Math.floor(Date.now() / 30_000)): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac('sha1', Buffer.from(secret, 'utf8')).update(counter).digest();
  const offset = (mac[mac.length - 1] ?? 0) & 0x0f;
  const value = (mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return value.toString().padStart(6, '0');
}

const file = (dir: string, email: string) => join(dir, `${email.replace(/[^a-z0-9@._-]/gi, '_')}.totp`);

export function saveSecret(dir: string, email: string, secret: string, usedStep: number): void {
  writeFileSync(file(dir, email), JSON.stringify({ secret, usedStep }), { mode: 0o600 });
}

export function loadSecret(dir: string, email: string): { secret: string; usedStep: number } | null {
  const f = file(dir, email);
  return existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')) as { secret: string; usedStep: number }) : null;
}

/** A code for a step not used before (waits up to 30 s for the next step). */
export async function freshCode(dir: string, email: string): Promise<string | null> {
  const saved = loadSecret(dir, email);
  if (!saved) return null;
  let step = Math.floor(Date.now() / 30_000);
  while (step <= saved.usedStep) {
    await new Promise((r) => setTimeout(r, 1000));
    step = Math.floor(Date.now() / 30_000);
  }
  saveSecret(dir, email, saved.secret, step);
  return totp(saved.secret, step);
}
