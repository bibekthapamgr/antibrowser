/**
 * API tokens (milestone 10, ADR-0017). A token acts as the member who created it, never beyond that member's current
 * access, further limited by its scopes and optional client/profile restrictions. The secret is returned once; only a
 * SHA-256 digest is stored. Tokens are managed with an interactive sign-in only (a token never creates or rotates
 * tokens).
 *
 *   GET    /orgs/{org}/api-tokens            own tokens (all=true: everyone's, tokens.manage)
 *   POST   /orgs/{org}/api-tokens            create (tokens.create; scopes within the creator's role)
 *   POST   /orgs/{org}/api-tokens/{tok}/rotate  new secret; the previous one keeps working for a grace period
 *   DELETE /orgs/{org}/api-tokens/{tok}      revoke (owner of the token, or tokens.manage)
 *   GET    /orgs/{org}/api-tokens/current    the calling token itself (API tokens only)
 */
import { randomBytes } from 'node:crypto';
import {
  ApiError,
  ApiToken,
  ApiTokenCreate,
  ApiTokenCreated,
  ApiTokenQuery,
  ApiTokenRotate,
  formatApiToken,
  ID_PATTERN,
  newId,
  SCOPE_PERMISSIONS,
  scopeAllowedForRole,
  TOKEN_LIMITS,
} from '@pb/contracts';
import type pg from 'pg';
import Type, { type Static } from 'typebox';
import type { App, Deps } from '../app.ts';
import { audit, changeEntry } from '../audit.ts';
import { ts, withTx } from '../db.ts';
import { hit, LIMITS } from '../ratelimit.ts';
import { sha256Hex } from '../session.ts';
import { requireEntitlement } from '../sessions.ts';
import {
  clientVisible,
  profileVisible,
  requireInteractive,
  requirePermission,
  resolveTenant,
  type TenantAccess,
} from '../tenancy.ts';
import { errors, OrgParams } from './common.ts';

const TokenIdParams = Type.Object(
  {
    orgId: Type.String({ pattern: ID_PATTERN('org') }),
    tokenId: Type.String({ pattern: ID_PATTERN('tok') }),
  },
  { additionalProperties: false },
);

type TokenView = Static<typeof ApiToken>;

const TOKEN_COLUMNS = `t.id, t.org_id, t.name, t.user_id as owner_id, coalesce(u.display_name, '') as owner_name,
  t.scopes, t.client_ids, t.profile_ids,
  case when t.revoked_at is not null then 'revoked' when t.expires_at <= now() then 'expired' else 'active' end as state,
  ${ts('t.created_at')} as created_at, ${ts('t.expires_at')} as expires_at, ${ts('t.last_used_at')} as last_used_at,
  ${ts('t.rotated_at')} as rotated_at,
  case when t.previous_valid_until > now() then ${ts('t.previous_valid_until')} end as previous_valid_until,
  ${ts('t.revoked_at')} as revoked_at`;
const TOKEN_FROM = 'api_tokens t left join users u on u.id = t.user_id';

async function tokenView(c: pg.PoolClient, access: TenantAccess, id: string): Promise<TokenView> {
  const { rows } = await c.query<TokenView>(
    `select ${TOKEN_COLUMNS}, t.user_id = $3 as mine from ${TOKEN_FROM} where t.org_id = $1 and t.id = $2`,
    [access.orgId, id, access.userId],
  );
  const row = rows[0];
  if (!row) throw new ApiError('NOT_FOUND', 'Token not found');
  return row;
}

/** 256 random bits; 43 base64url characters. */
function newSecret(): string {
  return randomBytes(32).toString('base64url');
}

export function tokenRoutes(app: App, deps: Deps): void {
  app.get(
    '/orgs/:orgId/api-tokens',
    {
      schema: {
        tags: ['api-tokens'],
        description:
          'Your API tokens in this organization (all=true: everyone’s, needs tokens.manage). Secrets are never ' +
          'shown again. API tokens cannot call this route.',
        params: OrgParams,
        querystring: ApiTokenQuery,
        response: { 200: Type.Object({ items: Type.Array(ApiToken) }), ...errors },
      },
    },
    async (req) => {
      requireInteractive(req.principal);
      const access = await resolveTenant(deps.pool, req, req.params.orgId);
      const all = req.query.all === true;
      requirePermission(access, all ? 'tokens.manage' : 'tokens.create');
      const activeOnly = req.query.state !== 'all';
      return withTx(deps.pool, access, async (c) => {
        const { rows } = await c.query<TokenView>(
          `select ${TOKEN_COLUMNS}, t.user_id = $2 as mine from ${TOKEN_FROM}
            where t.org_id = $1 and ($3::boolean or t.user_id = $2)
              and (not $4::boolean or (t.revoked_at is null and t.expires_at > now()))
            order by t.created_at desc limit 200`,
          [access.orgId, access.userId, all, activeOnly],
        );
        return { items: rows };
      });
    },
  );

  app.post(
    '/orgs/:orgId/api-tokens',
    {
      schema: {
        tags: ['api-tokens'],
        description:
          'Creates a token for yourself. Each scope must be within your role; listed clients and profiles must be ' +
          'within your reach. The answer contains the secret once (`pbt_…`); store it in a secret manager. The token ' +
          'acts as you: if your access shrinks, so does the token’s; if you leave, it stops.',
        params: OrgParams,
        body: ApiTokenCreate,
        response: { 201: ApiTokenCreated, ...errors },
      },
    },
    async (req, reply) => {
      requireInteractive(req.principal);
      const access = await resolveTenant(deps.pool, req, req.params.orgId);
      requirePermission(access, 'tokens.create');
      await hit(deps.pool, LIMITS.tokenCreatePerUser, access.userId);
      const body = req.body;
      for (const scope of body.scopes) {
        if (!scopeAllowedForRole(access.role, scope)) {
          throw new ApiError('FORBIDDEN', 'Your role does not allow a token with this scope', {
            scope,
            permissions: SCOPE_PERMISSIONS[scope],
          });
        }
      }
      const id = newId('apiToken');
      const secret = newSecret();
      const created = await withTx(deps.pool, access, async (c) => {
        await requireEntitlement(c, access.orgId, 'api_access');
        const active = await c.query<{ n: number }>(
          `select count(*)::int as n from api_tokens
            where org_id = $1 and user_id = $2 and revoked_at is null and expires_at > now()`,
          [access.orgId, access.userId],
        );
        if ((active.rows[0]?.n ?? 0) >= TOKEN_LIMITS.maxActivePerUser) {
          throw new ApiError('QUOTA_EXCEEDED', 'Too many active tokens; revoke some first', {
            limit: TOKEN_LIMITS.maxActivePerUser,
          });
        }
        // Restrictions must be inside the creator's reach (unknown and unreachable ids answer alike).
        if (body.client_ids) {
          const { rows } = await c.query<{ id: string }>(
            `select c.id from clients c where c.org_id = $1 and c.id = any($2::text[]) and ${clientVisible(access, 'c', '$3')}`,
            [access.orgId, body.client_ids, access.userId],
          );
          if (rows.length !== body.client_ids.length) throw new ApiError('NOT_FOUND', 'Client not found');
        }
        if (body.profile_ids) {
          const { rows } = await c.query<{ id: string }>(
            `select p.id from profiles p
              where p.org_id = $1 and p.id = any($2::text[]) and p.deleted_at is null
                and ${profileVisible(access, 'p', '$3')}`,
            [access.orgId, body.profile_ids, access.userId],
          );
          if (rows.length !== body.profile_ids.length) throw new ApiError('NOT_FOUND', 'Profile not found');
        }
        await c.query(
          `insert into api_tokens (id, org_id, user_id, name, token_hash, scopes, client_ids, profile_ids, expires_at)
           values ($1, $2, $3, $4, $5, $6, $7, $8, now() + make_interval(days => $9))`,
          [
            id,
            access.orgId,
            access.userId,
            body.name.trim(),
            sha256Hex(secret),
            body.scopes,
            body.client_ids ?? null,
            body.profile_ids ?? null,
            body.expires_in_days,
          ],
        );
        await audit(
          c,
          changeEntry(access, 'api_token.created', 'api_token', id, {
            scopes: body.scopes,
            clients: body.client_ids?.length ?? null,
            profiles: body.profile_ids?.length ?? null,
            expires_in_days: body.expires_in_days,
          }),
        );
        return tokenView(c, access, id);
      });
      return reply.status(201).send({ token: created, secret: formatApiToken(id, secret) });
    },
  );

  app.post(
    '/orgs/:orgId/api-tokens/:tokenId/rotate',
    {
      schema: {
        tags: ['api-tokens'],
        description:
          'Issues a new secret for your own token (returned once). The previous secret keeps working for ' +
          'grace_minutes (default 60, at most 1440) so integrations can switch without downtime.',
        params: TokenIdParams,
        body: ApiTokenRotate,
        response: { 200: ApiTokenCreated, ...errors },
      },
    },
    async (req) => {
      requireInteractive(req.principal);
      const access = await resolveTenant(deps.pool, req, req.params.orgId);
      requirePermission(access, 'tokens.create');
      const grace = req.body.grace_minutes ?? 60;
      const secret = newSecret();
      const token = await withTx(deps.pool, access, async (c) => {
        const { rows } = await c.query<{ user_id: string; active: boolean }>(
          `select user_id, revoked_at is null and expires_at > now() as active from api_tokens
            where org_id = $1 and id = $2 for update`,
          [access.orgId, req.params.tokenId],
        );
        const t = rows[0];
        // Only the owner rotates (a new secret for someone else's token would let one act as them).
        if (!t || t.user_id !== access.userId) throw new ApiError('NOT_FOUND', 'Token not found');
        if (!t.active) throw new ApiError('VALIDATION_FAILED', 'This token is revoked or expired');
        await c.query(
          `update api_tokens
              set previous_hash = case when $3 > 0 then token_hash end,
                  previous_valid_until = case when $3 > 0 then now() + make_interval(mins => $3) end,
                  token_hash = $4, rotated_at = now()
            where org_id = $1 and id = $2`,
          [access.orgId, req.params.tokenId, grace, sha256Hex(secret)],
        );
        await audit(
          c,
          changeEntry(access, 'api_token.rotated', 'api_token', req.params.tokenId, { grace_minutes: grace }),
        );
        return tokenView(c, access, req.params.tokenId);
      });
      return { token, secret: formatApiToken(req.params.tokenId, secret) };
    },
  );

  app.delete(
    '/orgs/:orgId/api-tokens/:tokenId',
    {
      schema: {
        tags: ['api-tokens'],
        description:
          'Revokes a token at once (yours, or anyone’s with tokens.manage). Revoking twice is a no-op. Jobs it ' +
          'queued that have not started fail with ACCESS_REMOVED when a computer would pick them up.',
        params: TokenIdParams,
        response: { 204: Type.Null(), ...errors },
      },
    },
    async (req, reply) => {
      requireInteractive(req.principal);
      const access = await resolveTenant(deps.pool, req, req.params.orgId);
      await withTx(deps.pool, access, async (c) => {
        const { rows } = await c.query<{ user_id: string; revoked: boolean }>(
          `select user_id, revoked_at is not null as revoked from api_tokens
            where org_id = $1 and id = $2 for update`,
          [access.orgId, req.params.tokenId],
        );
        const t = rows[0];
        if (!t) throw new ApiError('NOT_FOUND', 'Token not found');
        if (t.user_id !== access.userId) {
          // Someone else's token: only with tokens.manage; without it the id answers like an unknown one.
          try {
            requirePermission(access, 'tokens.manage');
          } catch {
            throw new ApiError('NOT_FOUND', 'Token not found');
          }
        } else {
          requirePermission(access, 'tokens.create');
        }
        if (t.revoked) return;
        await c.query(
          `update api_tokens set revoked_at = now(), revoked_by = $3, revoke_reason = $4
            where org_id = $1 and id = $2`,
          [
            access.orgId,
            req.params.tokenId,
            access.userId,
            t.user_id === access.userId ? 'revoked' : 'revoked_by_admin',
          ],
        );
        await audit(
          c,
          changeEntry(access, 'api_token.revoked', 'api_token', req.params.tokenId, {
            owner: t.user_id,
            by_owner: t.user_id === access.userId,
          }),
        );
      });
      return reply.status(204).send(null);
    },
  );

  app.get(
    '/orgs/:orgId/api-tokens/current',
    {
      config: { tokens: true },
      schema: {
        tags: ['api-tokens'],
        description:
          'API tokens: yes. The calling token: scopes, restrictions, expiry. Useful to check what an integration ' +
          'may do. Interactive sign-ins get 404.',
        params: OrgParams,
        response: { 200: ApiToken, ...errors },
      },
    },
    async (req) => {
      const access = await resolveTenant(deps.pool, req, req.params.orgId);
      const token = access.token;
      if (!token) throw new ApiError('NOT_FOUND', 'Not an API token');
      return withTx(deps.pool, access, (c) => tokenView(c, access, token.id));
    },
  );
}
