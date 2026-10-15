import type { IncomingMessage, ServerResponse } from 'node:http';
import swagger from '@fastify/swagger';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import type { AppConfig } from '@pb/config/env';
import {
  API_PREFIX,
  ApiError,
  ERROR_CODES,
  type ErrorBody,
  type ErrorCode,
  newId,
  type PublicDownloads,
} from '@pb/contracts';
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
import { type CatalogCache, newCatalogCache } from './billing/catalog.ts';
import { type ProviderCall, providerCaller } from './billing/provision.ts';
import { planLimitError, restrictedFromDatabase } from './billing/state.ts';
import { createStripe, type Stripe, type StripePrice } from './billing/stripe.ts';
import { withTx } from './db.ts';
import { createIdTokenVerifier, type IdTokenVerifier } from './oidc.ts';
import { hit, LIMITS } from './ratelimit.ts';
import { downloadsReader } from './release.ts';
import { accountRoutes } from './routes/account.ts';
import { adminRoutes } from './routes/admin.ts';
import { agencyRoutes } from './routes/agency.ts';
import { auditRoutes } from './routes/audit.ts';
import { authRoutes } from './routes/auth.ts';
import { automationRoutes } from './routes/automation.ts';
import { backupRoutes } from './routes/backups.ts';
import { billingRoutes } from './routes/billing.ts';
import { clientRoutes } from './routes/clients.ts';
import { consoleRoutes } from './routes/console.ts';
import { deviceRoutes } from './routes/devices.ts';
import { grantRoutes } from './routes/grants.ts';
import { healthRoutes } from './routes/health.ts';
import { importRoutes } from './routes/import.ts';
import { invitationRoutes } from './routes/invitations.ts';
import { leaseRoutes } from './routes/leases.ts';
import { meRoutes } from './routes/me.ts';
import { onboardingRoutes } from './routes/onboarding.ts';
import { organizationRoutes } from './routes/organizations.ts';
import { portalConfigRoutes, portalRoutes, publicSiteRoutes } from './routes/portal.ts';
import { profileRoutes } from './routes/profiles.ts';
import { publicRoutes } from './routes/public.ts';
import { sessionRoutes } from './routes/sessions.ts';
import { snapshotRoutes } from './routes/snapshots.ts';
import { supportRoutes } from './routes/support.ts';
import { tokenRoutes } from './routes/tokens.ts';
import { authenticateWeb, hasWebCookie, webRoutes } from './routes/web.ts';
import { webhookRoutes } from './routes/webhooks.ts';
import { workspaceRoutes } from './routes/workspace.ts';
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
  /** Milestone 11: billing (the provider client is null when not configured; DB-only routes still work). */
  billing: BillingDeps;
  /** Milestone 11: ID tokens of the support console's own OIDC client (null: the console cannot sign in). */
  consoleIdTokens: IdTokenVerifier | null;
  /** R2: ID tokens of the customer portal's own client (backend-for-frontend sign-in). */
  webIdTokens: IdTokenVerifier | null;
  /** R4: the download page's view of the signed stable channel (cached). */
  downloads: () => Promise<PublicDownloads>;
}

export interface BillingDeps {
  stripe: Stripe | null;
  /** `plan@version` -> provider price id. */
  prices: Record<string, string>;
  returnUrl: string;
  automaticTax: boolean;
  retentionDays: number | null;
  /** Customer portal configuration (bpc_…), or null for the account's default. */
  portalConfiguration: string | null;
  webhookSecrets: readonly string[];
  livemode: boolean;
  /** Display prices read from the provider (not entitlement data; an hour old at most). */
  priceCache: Map<string, { at: number; price: StripePrice | null }>;
  /** R5: the database catalog (plans, published prices) as last read, and the public pricing answer. */
  catalog: CatalogCache;
  /** R5: raw provider calls for publishing plans from the console (null: no provider configured). */
  provider: ProviderCall | null;
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
    /** Milestone 11: a support console route (staff tokens only; organization credentials never work here). */
    staff?: boolean;
    /** R2: the customer web portal's cookie session may call this route (deny by default; CSRF on changes). */
    web?: boolean;
  }
}

/** Header names never written to logs. */
const REDACT = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["idempotency-key"]',
  'req.headers["x-csrf-token"]',
];

/**
 * Invitation tokens travel in URL paths (links), and the support console receives the identity provider's one-time
 * code in its address; both are masked before a URL is logged.
 */
export function redactUrl(url: string): string {
  return url
    .replace(/\/invitations\/[A-Za-z0-9_-]{20,}/g, '/invitations/[redacted]')
    .replace(
      /([?&](?:code|state|session_state|id_token|access_token|refresh_token)=)[^&#]*/g,
      '$1[redacted]',
    );
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
  /** Tests inject a provider client (normally built from the configuration). */
  stripe?: Stripe;
  /** Tests inject the support console's ID-token verifier. */
  consoleIdTokens?: IdTokenVerifier;
  webIdTokens?: IdTokenVerifier;
  /** Tests inject the download page's source (R4). */
  downloads?: () => Promise<PublicDownloads>;
  /** Tests inject the raw provider caller used to publish plans (R5). */
  provider?: ProviderCall;
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
  const stripeCfg = config.billing.stripe;
  const consoleIdTokens =
    opts.consoleIdTokens ??
    (config.oidc && config.console.oidcClientId
      ? createIdTokenVerifier({
          issuer: config.oidc.issuer,
          clientId: config.console.oidcClientId,
          allowLoopbackHttp: config.appEnv === 'dev' || config.appEnv === 'test',
        })
      : null);
  const webIdTokens =
    opts.webIdTokens ??
    (config.oidc && config.web.oidcClientId
      ? createIdTokenVerifier({
          issuer: config.oidc.issuer,
          clientId: config.web.oidcClientId,
          allowLoopbackHttp: config.appEnv === 'dev' || config.appEnv === 'test',
        })
      : null);
  const deps: Deps = {
    config,
    pool,
    auth: createAuthenticator(config, pool, sessions),
    sessions,
    idTokens,
    backup: objects && kms ? { objects, kms } : null,
    billing: {
      stripe:
        opts.stripe ??
        (stripeCfg ? createStripe({ secretKey: stripeCfg.secretKey, apiBase: stripeCfg.apiBase }) : null),
      prices: config.billing.prices,
      returnUrl: config.billing.returnUrl,
      automaticTax: config.billing.automaticTax,
      retentionDays: config.billing.retentionDays,
      portalConfiguration: config.billing.portalConfiguration,
      webhookSecrets: stripeCfg?.webhookSecrets ?? [],
      livemode: stripeCfg?.livemode ?? false,
      priceCache: new Map(),
      catalog: newCatalogCache(),
      provider: opts.provider ?? (stripeCfg ? providerCaller(stripeCfg.secretKey, stripeCfg.apiBase) : null),
    },
    consoleIdTokens,
    webIdTokens,
    downloads:
      opts.downloads ??
      downloadsReader({ channelUrl: config.site.downloadChannelUrl, keysFile: config.site.releaseKeysFile }),
  };

  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'Project Browser control-plane API',
        version: '0.19.0',
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
    // Routes API tokens may call say so in their description and list both schemes (milestone 10).
    transform: ({ schema, url, route }) => {
      if (!(route.config as { tokens?: boolean } | undefined)?.tokens || !schema) return { schema, url };
      const s = schema as { description?: string; security?: unknown };
      return {
        url,
        schema: {
          ...schema,
          description: `API tokens: yes (scopes apply). ${s.description ?? ''}`.trim(),
          security: [{ bearer: [] }, { apiToken: [] }],
        } as typeof schema,
      };
    },
  });

  app.decorateRequest('principal', null);
  app.decorateRequest('tenant', null);

  app.addHook('onSend', async (req, reply) => {
    reply.header('x-request-id', req.id);
    // Private by default (account and billing answers); R4 public pages and catalog set their own cache rules.
    if (!reply.hasHeader('cache-control')) reply.header('cache-control', 'no-store');
    reply.header('x-content-type-options', 'nosniff');
  });

  app.addHook('onRequest', async (req) => {
    if (req.is404 || req.routeOptions.config.public) return;
    // Milestone 12: desktop apps below the server's minimum version (a known problem) must update first. Tokens,
    // the SDK and browsers do not send the desktop's user agent and are not affected.
    const min = config.minDesktopVersion;
    if (min && !req.routeOptions.config.staff && desktopTooOld(req.headers, min)) {
      throw new ApiError('CLIENT_UPDATE_REQUIRED', 'Update Project Browser to keep using this server', {
        minimum_version: min,
      });
    }
    if (req.routeOptions.config.staff) {
      req.principal = await deps.auth.authenticateStaff(req.headers.authorization);
      return;
    }
    // R2: the customer portal's cookie session, on routes that accept it (a bearer token always wins).
    if (!req.headers.authorization && hasWebCookie(req, deps)) {
      if (!req.routeOptions.config.web) {
        throw new ApiError('UNAUTHENTICATED', 'This route is not available to the web portal', {
          reason: 'not_for_web',
        });
      }
      req.principal = await authenticateWeb(req, deps);
      return;
    }
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
      // Milestone 11 usage ledger: API-token requests per organization and day.
      await withTx(pool, { orgId: token.orgId, userId: null }, (c) =>
        c.query('select app.billing_count_api($1)', [token.orgId]),
      ).catch(() => undefined);
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

    const pgErr = err as { code?: string; message?: string; detail?: string };
    if (pgErr.code === 'P0001' && pgErr.message === 'PLAN_LIMIT') {
      const limit = planLimitError(pgErr.detail);
      return send(limit.code, limit.message, limit.safeDetails);
    }
    if (pgErr.code === 'P0001' && pgErr.message === 'BILLING_RESTRICTED') {
      const restricted = restrictedFromDatabase(pgErr.detail);
      return send(restricted.code, restricted.message, restricted.safeDetails);
    }
    if (pgErr.code === 'P0001' && pgErr.message === 'STAFF_FORBIDDEN') {
      return send('FORBIDDEN', 'Your staff role does not allow this', { permission: pgErr.detail ?? null });
    }
    if (pgErr.code === 'P0001' && pgErr.message === 'LAST_PLATFORM_OWNER') {
      return send(
        'LAST_PLATFORM_OWNER',
        'The last platform owner cannot be removed; add another owner first',
      );
    }
    if (pgErr.code === 'P0001' && pgErr.message === 'PLAN_VERSION_IMMUTABLE') {
      return send('VERSION_CONFLICT', 'A published plan version never changes; publish a new version');
    }
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

  // Milestone 11: the support console's static page at /console/ (outside /v1; only when CONSOLE_DIR is set).
  consoleRoutes(app as unknown as App, deps);
  // R2: the customer portal's static page at /app/ (only when WEB_DIR and WEB_ORIGIN are set).
  portalRoutes(app as unknown as App, deps);
  // R4: the public website's pages at / (only when PUBLIC_DIR is set).
  publicSiteRoutes(app as unknown as App, deps);

  await app.register(
    async (v1) => {
      const scoped = v1 as unknown as App;
      healthRoutes(scoped, deps);
      authRoutes(scoped, deps);
      deviceRoutes(scoped, deps);
      meRoutes(scoped, deps);
      organizationRoutes(scoped, deps);
      invitationRoutes(scoped, deps);
      onboardingRoutes(scoped, deps);
      webRoutes(scoped, deps);
      portalConfigRoutes(scoped, deps);
      publicRoutes(scoped, deps);
      accountRoutes(scoped, deps);
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
      workspaceRoutes(scoped, deps);
      billingRoutes(scoped, deps);
      supportRoutes(scoped, deps);
      adminRoutes(scoped, deps);
    },
    { prefix: API_PREFIX },
  );

  return app;
}

/**
 * A desktop request (user agent `project-browser-manager/…`) whose `x-pb-client-version` is missing (apps before
 * 0.12 did not send it) or below `min`. A pre-release (0.12.1-beta.1) is below its release (0.12.1).
 */
export function desktopTooOld(headers: Record<string, string | string[] | undefined>, min: string): boolean {
  const ua = String(headers['user-agent'] ?? '');
  if (!ua.startsWith('project-browser-manager/')) return false;
  const parse = (v: string) => {
    const m = /^(\d{1,6})\.(\d{1,6})\.(\d{1,6})(-[0-9A-Za-z.-]+)?$/.exec(v);
    return m ? { n: [Number(m[1]), Number(m[2]), Number(m[3])], pre: Boolean(m[4]) } : null;
  };
  const v = parse(String(headers['x-pb-client-version'] ?? ''));
  const m = parse(min);
  if (!m) return false;
  if (!v) return true;
  for (let i = 0; i < 3; i++) {
    const a = v.n[i] ?? 0;
    const b = m.n[i] ?? 0;
    if (a !== b) return a < b;
  }
  return v.pre && !m.pre;
}

/** Principal set by the onRequest hook; routes marked public never call this. */
export function principalOf(req: { principal: Principal | null }): Principal {
  if (!req.principal) throw new ApiError('UNAUTHENTICATED', 'Authentication required');
  return req.principal;
}
