/**
 * Webhook signing (milestone 10, ADR-0017), following the Standard Webhooks scheme:
 *
 *   webhook-id:        the event id (evt_…); the same on every retry, so receivers deduplicate on it
 *   webhook-timestamp: seconds since the epoch when this attempt was sent
 *   webhook-signature: `v1,<base64 HMAC-SHA256(secret, "<id>.<timestamp>.<body>")>`; during a secret rotation two
 *                      signatures separated by a space (either verifies)
 *
 * The secret is `whsec_` + base64 of 32 random bytes; the HMAC key is those 32 bytes. Receivers must compare in
 * constant time and refuse timestamps more than 5 minutes away from their clock.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const SECRET_PREFIX = 'whsec_';

export function newWebhookSecret(): { secret: string; key: Buffer } {
  const key = randomBytes(32);
  return { secret: `${SECRET_PREFIX}${key.toString('base64')}`, key };
}

export function secretKey(secret: string): Buffer {
  if (!secret.startsWith(SECRET_PREFIX)) throw new Error('not a webhook secret');
  return Buffer.from(secret.slice(SECRET_PREFIX.length), 'base64');
}

export function signature(key: Buffer, id: string, timestamp: number, body: string): string {
  return `v1,${createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64')}`;
}

/** Headers for one attempt; `keys` holds the current key and, during a rotation, the previous one. */
export function signedHeaders(
  keys: Buffer[],
  id: string,
  timestamp: number,
  body: string,
): Record<string, string> {
  return {
    'webhook-id': id,
    'webhook-timestamp': String(timestamp),
    'webhook-signature': keys.map((k) => signature(k, id, timestamp, body)).join(' '),
  };
}

/** Receiver side (used in tests and documented for integrators). */
export function verify(
  secret: string,
  headers: Record<string, string | undefined>,
  body: string,
  now: number = Math.floor(Date.now() / 1000),
  toleranceSeconds = 300,
): boolean {
  const id = headers['webhook-id'];
  const ts = Number(headers['webhook-timestamp']);
  const sigs = headers['webhook-signature'];
  if (!id || !Number.isInteger(ts) || !sigs) return false;
  if (Math.abs(now - ts) > toleranceSeconds) return false;
  const expected = Buffer.from(signature(secretKey(secret), id, ts, body).slice(3), 'base64');
  return sigs.split(' ').some((s) => {
    const [version, value] = s.split(',');
    if (version !== 'v1' || !value) return false;
    const got = Buffer.from(value, 'base64');
    return got.length === expected.length && timingSafeEqual(got, expected);
  });
}

/** The encrypted secret is bound to its organization and endpoint (moved elsewhere, it does not decrypt). */
export function secretContext(orgId: string, endpointId: string): Record<string, string> {
  return { use: 'webhook_secret', org_id: orgId, endpoint_id: endpointId };
}

/** The request body: Standard Webhooks shape. */
export function webhookBody(type: string, createdAt: Date, data: Record<string, unknown>): string {
  return JSON.stringify({ type, timestamp: createdAt.toISOString(), data });
}
