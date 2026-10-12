/**
 * Prints a short-lived development token for a fixture user.
 * Usage: pnpm --filter @pb/api dev-token acmeOwner
 */
import { loadConfig } from '@pb/config/env';
import { SignJWT } from 'jose';
import { DEV_ISSUER, FIXTURES, type FixtureUserKey } from '../src/fixtures.ts';

export async function devToken(secret: string, userId: string, ttl = '1h'): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setIssuer(DEV_ISSUER)
    .setAudience('pb-api')
    .setIssuedAt()
    .setExpirationTime(ttl)
    .sign(new TextEncoder().encode(secret));
}

if (import.meta.main) {
  const config = loadConfig();
  if (!config.devAuth.enabled) throw new Error('Dev auth is disabled in this environment');
  const name = (process.argv[2] ?? 'acmeOwner') as FixtureUserKey;
  const user = FIXTURES.users[name];
  if (!user)
    throw new Error(`Unknown fixture user. Choose one of: ${Object.keys(FIXTURES.users).join(', ')}`);
  console.log(await devToken(config.devAuth.secret, user.id));
}
