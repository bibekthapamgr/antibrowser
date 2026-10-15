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
  // Milestone 10: API tokens per token and per organization (all its tokens together); job creation per organization.
  apiPerToken: { bucket: 'api.token', max: 600, windowSeconds: 60 },
  apiPerOrg: { bucket: 'api.org', max: 3000, windowSeconds: 60 },
  jobCreatePerOrg: { bucket: 'job.create.org', max: 1000, windowSeconds: 3600 },
  tokenCreatePerUser: { bucket: 'token.create.user', max: 30, windowSeconds: 3600 },
  webhookTestPerOrg: { bucket: 'webhook.test.org', max: 30, windowSeconds: 600 },
  // Milestone 11: provider webhooks per source address; checkout/portal sessions per organization; staff sign-ins.
  billingWebhookPerIp: { bucket: 'billing.webhook.ip', max: 1200, windowSeconds: 60 },
  billingSessionPerOrg: { bucket: 'billing.session.org', max: 30, windowSeconds: 600 },
  staffSignInPerIp: { bucket: 'staff.signin.ip', max: 20, windowSeconds: 600 },
  // R2: onboarding (bootstrap) per person and per address; web portal sign-in starts per address.
  onboardingPerUser: { bucket: 'onboarding.user', max: 20, windowSeconds: 600 },
  onboardingPerIp: { bucket: 'onboarding.ip', max: 60, windowSeconds: 600 },
  webSignInPerIp: { bucket: 'web.signin.ip', max: 30, windowSeconds: 600 },
  // R4: the website's contact form per address and per e-mail; account deletion requests per person.
  contactPerIp: { bucket: 'contact.ip', max: 5, windowSeconds: 3600 },
  contactPerEmail: { bucket: 'contact.email', max: 3, windowSeconds: 3600 },
  deletionPerUser: { bucket: 'deletion.user', max: 5, windowSeconds: 86_400 },
  unsubscribePerIp: { bucket: 'unsubscribe.ip', max: 60, windowSeconds: 3600 },
  // ADR-0027: the desktop proxy check (one per proxy test or launch check; many people may share an exit address).
  netcheckPerIp: { bucket: 'netcheck.ip', max: 300, windowSeconds: 600 },
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
