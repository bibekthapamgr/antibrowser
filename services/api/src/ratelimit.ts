/**
 * Rate limits for invitations and login-adjacent operations (milestone 06). Fixed windows counted in PostgreSQL, so
 * every API instance shares them; keys are SHA-256 digests (no raw IP addresses are stored).
 */
import { ApiError } from '@pb/contracts';
import type pg from 'pg';
import { withTx } from './db.ts';
import { sha256Hex } from './session.ts';

export interface Limit {
  bucket: string;
  max: number;
  windowSeconds: number;
}

export const LIMITS = {
  signInPerIp: { bucket: 'signin.ip', max: 30, windowSeconds: 600 },
  refreshPerIp: { bucket: 'refresh.ip', max: 120, windowSeconds: 600 },
  refreshPerSession: { bucket: 'refresh.session', max: 30, windowSeconds: 600 },
  invitePerOrg: { bucket: 'invite.org', max: 100, windowSeconds: 86_400 },
  invitePerUser: { bucket: 'invite.user', max: 30, windowSeconds: 3_600 },
  acceptPerUser: { bucket: 'accept.user', max: 10, windowSeconds: 600 },
  acceptPerIp: { bucket: 'accept.ip', max: 30, windowSeconds: 600 },
  orgCreatePerUser: { bucket: 'org.create.user', max: 10, windowSeconds: 86_400 },
  // Milestone 07: each restore plan unwraps a data key.
  restorePerUser: { bucket: 'restore.user', max: 120, windowSeconds: 600 },
} satisfies Record<string, Limit>;

/** Counts one hit; throws RATE_LIMITED (with retry_after_seconds) above the limit. */
export async function hit(pool: pg.Pool, limit: Limit, key: string): Promise<void> {
  const { rows } = await withTx(pool, { orgId: null, userId: null }, (c) =>
    c.query<{ hits: number }>('select app.rate_limit_hit($1, $2, $3) as hits', [
      limit.bucket,
      sha256Hex(`${limit.bucket}:${key}`),
      limit.windowSeconds,
    ]),
  );
  if ((rows[0]?.hits ?? 0) > limit.max) {
    const now = Math.floor(Date.now() / 1000);
    throw new ApiError('RATE_LIMITED', 'Too many attempts; try again later', {
      retry_after_seconds: limit.windowSeconds - (now % limit.windowSeconds),
    });
  }
}
