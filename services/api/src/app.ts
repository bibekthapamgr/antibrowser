import type { IncomingMessage, ServerResponse } from 'node:http';
import swagger from '@fastify/swagger';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import type { AppConfig } from '@pb/config/env';
import { API_PREFIX, ApiError, ERROR_CODES, type ErrorBody, type ErrorCode, newId } from '@pb/contracts';
import ajvFormats from 'ajv-formats';
import Fastify, {
  type FastifyBaseLogger,
  type FastifyInstance,
  type FastifyRequest,
  type RawServerDefault,
} from 'fastify';
import type pg from 'pg';
import { auditAlone } from './audit.ts';
import { type Authenticator, createAuthenticator, type Principal } from './auth.ts';
import { localKeyProvider, type RootKeyProvider } from './backup/keys.ts';
import { type ObjectStore, s3ObjectStore } from './backup/objects.ts';
import { createIdTokenVerifier, type IdTokenVerifier } from './oidc.ts';
import { hit, LIMITS } from './ratelimit.ts';
import { agencyRoutes } from './routes/agency.ts';
import { auditRoutes } from './routes/audit.ts';
import { authRoutes } from './routes/auth.ts';
import { automationRoutes } from './routes/automation.ts';
import { backupRoutes } from './routes/backups.ts';
import { clientRoutes } from './routes/clients.ts';
import { deviceRoutes } from './routes/devices.ts';
import { grantRoutes } from './routes/grants.ts';
import { healthRoutes } from './routes/health.ts';
import { importRoutes } from './routes/import.ts';
import { invitationRoutes } from './routes/invitations.ts';
import { leaseRoutes } from './routes/leases.ts';
import { meRoutes } from './routes/me.ts';
import { organizationRoutes } from './routes/organizations.ts';
import { profileRoutes } from './routes/profiles.ts';
import { sessionRoutes } from './routes/sessions.ts';
import { snapshotRoutes } from './routes/snapshots.ts';
import { tokenRoutes } from './routes/tokens.ts';
import { webhookRoutes } from './routes/webhooks.ts';
import { createSessionKeys, type SessionKeys } from './session.ts';
import type { TenantAccess } from './tenancy.ts';

export type App = FastifyInstance<
  RawServerDefault,
  IncomingMessage,
  ServerResponse,
  FastifyBaseLogger,
  TypeBoxTypeProvider
>;

export interface Deps {
  config: AppConfig;
  pool: pg.Pool;
  auth: Authenticator;
  sessions: SessionKeys;
  /** Null when no identity provider is configured (dev/test without OIDC): sign-in routes answer UNAVAILABLE. */
  idTokens: IdTokenVerifier | null;
  /** Snapshot storage and the root key provider (milestone 07). Null when not configured: snapshot routes answer 503. */
  backup: { objects: ObjectStore; kms: RootKeyProvider } | null;
}

declare module 'fastify' {
  interface FastifyRequest {
    principal: Principal | null;
    /** Set once the organization in the path has been resolved for the caller (used to audit denials). */
    tenant: TenantAccess | null;
  }
  interface FastifyContextConfig {
    public?: boolean;
    /** Milestone 10: API tokens may call this route (deny by default; scopes are checked by the route). */
    tokens?: boolean;
  }
}

/** Header names never written to logs. */
const REDACT = ['req.headers.authorization', 'req.headers.cookie', 'req.headers["idempotency-key"]'];

/** Invitation tokens travel in URL paths (links); they are masked before a URL is logged. */
export function redactUrl(url: string): string {
  return url.replace(/\/invitations\/[A-Za-z0-9_-]{20,}/g, '/invitations/[redacted]');
}

export interface BuildOptions {
  logger?: boolean;
  /** Tests inject an ID-token verifier bound to a local test identity provider. */
  idTokens?: IdTokenVerifier;
  /** Tests may capture log lines (to prove tokens never reach them). */
  logStream?: { write(line: string): void };
  /** Tests inject an in-memory object store (and key provider) instead of S3. */
  objects?: ObjectStore;
  kms?: RootKeyProvider;
}

export async function buildApp(config: AppConfig, pool: pg.Pool, opts: BuildOptions = {}): Promise<App> {
  const serializers = {
    req: (req: FastifyRequest) => ({
      method: req.method,
      url: redactUrl(req.url),
      host: req.host,
      remoteAddress: req.ip,
    }),
  };
  const logger =
    opts.logger === false
      ? false
      : {
          level: config.logLevel,
          redact: REDACT,
          serializers,
          ...(opts.logStream ? { stream: opts.logStream } : {}),
        };
  const app = Fastify({
    logger,
    genReqId: () => newId('request'),
    requestIdHeader: false,
    // The client address used for rate limits: the socket address, or N trusted reverse-proxy hops back.
    trustProxy:
      config.trustProxyHops > 0 ? (_address: string, hop: number) => hop < config.trustProxyHops : false,
    bodyLimit: 256 * 1024,
    ajv: {
      // Reject unknown properties instead of silently stripping them; apply schema defaults.
      customOptions: { removeAdditional: false, useDefaults: true, coerceTypes: 'array', allErrors: false },
      plugins: [ajvFormats as unknown as never],
    },
  }).withTypeProvider<TypeBoxTypeProvider>();

  const sessions = await createSessionKeys(config.session);
  const idTokens =
    opts.idTokens ??
    (config.oidc
      ? createIdTokenVerifier({
          issuer: config.oidc.issuer,
          clientId: config.oidc.clientId,
          allowLoopbackHttp: config.appEnv === 'dev' || config.appEnv === 'test',
        })
      : null);
  const objects = opts.objects ?? (config.objectStore ? s3ObjectStore(config.objectStore) : null);
  const kms = opts.kms ?? (config.kms ? localKeyProvider(config.kms) : null);
  const deps: Deps = {
    config,
    pool,
    auth: createAuthenticator(config, pool, sessions),
    sessions,
    idTokens,
    backup: objects && kms ? { objects, kms } : null,
  };

  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'Project Browser control-plane API',
        version: '0.10.0',
        description:
          'Contracts: /v1 prefix, opaque ids, cursor pagination (max 100), If-Match/expected_version optimistic ' +
          'concurrency, Idempotency-Key on lease acquisition, snapshot commit, local workspace import and automation ' +
          'jobs. Authentication: OIDC sign-in in the system browser (Authorization Code + PKCE), then API session ' +
          'tokens (ADR-0013); or an API token (`Authorization: Bearer pbt_…`, ADR-0017) on the routes marked ' +
          '"API tokens: yes", acting as its owner within its scopes and restrictions. Authorization: organization ' +
          'role combined with client/profile grants, deny by default; identifiers outside the caller’s reach answer ' +
          '404 exactly like nonexistent ones.',
      },
      components: {
        securitySchemes: {
          bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
          apiToken: {
            type: 'http',
            scheme: 'bearer',
            bearerFormat: 'pbt_<token id>_<secret>',
            description: 'API token (milestone 10). Only routes marked "API tokens: yes" accept it.',
          },
        },
      },
      security: [{ bearer: [] }],
    },
  });

  app.decorateRequest('principal', null);
  app.decorateRequest('tenant', null);

  app.addHook('onSend', async (req, reply) => {
    reply.header('x-request-id', req.id);
    reply.header('cache-control', 'no-store');
    reply.header('x-content-type-options', 'nosniff');
  });

  app.addHook('onRequest', async (req) => {
    if (req.is404 || req.routeOptions.config.public) return;
    req.principal = await deps.auth.authenticate(req.headers.authorization);
    const token = req.principal.token;
    if (token) {
      // Deny by default: a token reaches only routes declared for tokens, at a bounded rate per token and tenant.
      if (!req.routeOptions.config.tokens) {
        throw new ApiError('TOKEN_SCOPE_MISSING', 'API tokens cannot use this route', {
          route: 'not_for_tokens',
        });
      }
      await hit(pool, LIMITS.apiPerToken, token.id);
      await hit(pool, LIMITS.apiPerOrg, token.orgId);
    }
  });

  app.setErrorHandler(async (err, req, reply) => {
    const send = (code: ErrorCode, message: string, safeDetails: Record<string, unknown> = {}) => {
      const body: ErrorBody = {
        code,
        message,
        request_id: req.id,
        retryable: ERROR_CODES[code].retryable,
        safe_details: safeDetails,
      };
      if (code === 'RATE_LIMITED' && typeof safeDetails.retry_after_seconds === 'number') {
        reply.header('retry-after', String(safeDetails.retry_after_seconds));
      }
      return reply.status(ERROR_CODES[code].status).send(body);
    };

    if (err instanceof ApiError) {
      // Authorization denials inside an organization are part of the security audit (the change itself rolled back).
      if (err.code === 'FORBIDDEN' && req.tenant) {
        await auditAlone(pool, {
          orgId: req.tenant.orgId,
          actorUserId: req.tenant.userId,
          actorDeviceId: req.tenant.deviceId,
          action: 'access.denied',
          targetType: 'route',
          targetId: `${req.method} ${req.routeOptions.url ?? ''}`.slice(0, 64),
          outcome: 'denied',
          requestId: req.id,
          details: { permission: err.safeDetails.permission ?? null, role: req.tenant.role },
        });
      }
      return send(err.code, err.message, err.safeDetails);
    }

    const pgErr = err as { code?: string; message?: string };
    if (pgErr.code === 'P0001' && pgErr.message === 'LAST_OWNER') {
      return send('LAST_OWNER', 'An organization must keep at least one owner; transfer ownership first');
    }
    if (pgErr.code === 'P0001' && pgErr.message === 'JOB_FINISHED') {
      return send('JOB_FINISHED', 'This job already finished');
    }
    if (pgErr.code === 'P0001' && pgErr.message === 'JOB_TRANSITION') {
      return send('JOB_CLAIM_STALE', 'This job is not in a state that allows this');
    }
    if (pgErr.code === '23505') return send('ALREADY_EXISTS', 'This already exists');
    // A composite (org_id, id) reference that does not resolve inside the organization: reported like a missing id.
    if (pgErr.code === '23503') return send('NOT_FOUND', 'A referenced item was not found');
    if (pgErr.code === '40001' || pgErr.code === '40P01')
      return send('UNAVAILABLE', 'Busy; retry the request');

    const e = err as { validation?: { instancePath?: string; message?: string }[]; statusCode?: number };
    if (e.validation) {
      return send('VALIDATION_FAILED', 'Request failed validation', {
        issues: e.validation
          .slice(0, 10)
          .map((v) => ({ path: v.instancePath ?? '', message: v.message ?? '' })),
      });
    }
    const status = e.statusCode ?? 500;
    if (status === 404) return send('NOT_FOUND', 'Not found');
    if (status === 413) return send('VALIDATION_FAILED', 'Request body is too large');
    if (status === 429) return send('RATE_LIMITED', 'Too many requests');
    if (status >= 400 && status < 500) return send('VALIDATION_FAILED', 'Malformed request');

    req.log.error({ err }, 'unhandled error');
    return send('INTERNAL', 'An internal error occurred');
  });

  app.setNotFoundHandler((req, reply) => {
    const body: ErrorBody = {
      code: 'NOT_FOUND',
      message: 'Route not found',
      request_id: req.id,
      retryable: false,
      safe_details: {},
    };
    return reply.status(404).send(body);
  });

  await app.register(
    async (v1) => {
      const scoped = v1 as unknown as App;
      healthRoutes(scoped, deps);
      authRoutes(scoped, deps);
      deviceRoutes(scoped, deps);
      meRoutes(scoped, deps);
      organizationRoutes(scoped, deps);
      invitationRoutes(scoped, deps);
      clientRoutes(scoped, deps);
      grantRoutes(scoped, deps);
      profileRoutes(scoped, deps);
      leaseRoutes(scoped, deps);
      sessionRoutes(scoped, deps);
      agencyRoutes(scoped, deps);
      tokenRoutes(scoped, deps);
      automationRoutes(scoped, deps);
      webhookRoutes(scoped, deps);
      snapshotRoutes(scoped, deps);
      backupRoutes(scoped, deps);
      auditRoutes(scoped, deps);
      importRoutes(scoped, deps);
    },
    { prefix: API_PREFIX },
  );

  return app;
}

/** Principal set by the onRequest hook; routes marked public never call this. */
export function principalOf(req: { principal: Principal | null }): Principal {
  if (!req.principal) throw new ApiError('UNAUTHENTICATED', 'Authentication required');
  return req.principal;
}
