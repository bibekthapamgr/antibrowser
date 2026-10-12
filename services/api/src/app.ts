import type { IncomingMessage, ServerResponse } from 'node:http';
import swagger from '@fastify/swagger';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import type { AppConfig } from '@pb/config/env';
import { API_PREFIX, ApiError, ERROR_CODES, type ErrorBody, type ErrorCode, newId } from '@pb/contracts';
import ajvFormats from 'ajv-formats';
import Fastify, { type FastifyBaseLogger, type FastifyInstance, type RawServerDefault } from 'fastify';
import type pg from 'pg';
import { type Authenticator, createAuthenticator, type Principal } from './auth.ts';
import { healthRoutes } from './routes/health.ts';
import { leaseRoutes } from './routes/leases.ts';
import { meRoutes } from './routes/me.ts';
import { profileRoutes } from './routes/profiles.ts';
import { snapshotRoutes } from './routes/snapshots.ts';

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
}

declare module 'fastify' {
  interface FastifyRequest {
    principal: Principal | null;
  }
  interface FastifyContextConfig {
    public?: boolean;
  }
}

/** Header names never written to logs. */
const REDACT = ['req.headers.authorization', 'req.headers.cookie', 'req.headers["idempotency-key"]'];

export async function buildApp(
  config: AppConfig,
  pool: pg.Pool,
  opts: { logger?: boolean } = {},
): Promise<App> {
  const app = Fastify({
    logger: opts.logger === false ? false : { level: config.logLevel, redact: REDACT },
    genReqId: () => newId('request'),
    requestIdHeader: false,
    bodyLimit: 256 * 1024,
    ajv: {
      // Reject unknown properties instead of silently stripping them; apply schema defaults.
      customOptions: { removeAdditional: false, useDefaults: true, coerceTypes: 'array', allErrors: false },
      plugins: [ajvFormats as unknown as never],
    },
  }).withTypeProvider<TypeBoxTypeProvider>();

  const deps: Deps = { config, pool, auth: createAuthenticator(config, pool) };

  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'Project Browser control-plane API',
        version: '0.1.0',
        description:
          'Milestone 01 skeleton. Contracts: /v1 prefix, opaque ids, cursor pagination (max 100), ' +
          'If-Match/expected_version optimistic concurrency, Idempotency-Key on lease acquisition and snapshot commit.',
      },
      components: {
        securitySchemes: { bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } },
      },
      security: [{ bearer: [] }],
    },
  });

  app.decorateRequest('principal', null);

  app.addHook('onSend', async (req, reply) => {
    reply.header('x-request-id', req.id);
    reply.header('cache-control', 'no-store');
    reply.header('x-content-type-options', 'nosniff');
  });

  app.addHook('onRequest', async (req) => {
    if (req.is404 || req.routeOptions.config.public) return;
    req.principal = await deps.auth.authenticate(req.headers.authorization);
  });

  app.setErrorHandler((err, req, reply) => {
    const send = (code: ErrorCode, message: string, safeDetails: Record<string, unknown> = {}) => {
      const body: ErrorBody = {
        code,
        message,
        request_id: req.id,
        retryable: ERROR_CODES[code].retryable,
        safe_details: safeDetails,
      };
      return reply.status(ERROR_CODES[code].status).send(body);
    };

    if (err instanceof ApiError) return send(err.code, err.message, err.safeDetails);

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
      meRoutes(scoped, deps);
      profileRoutes(scoped, deps);
      leaseRoutes(scoped, deps);
      snapshotRoutes(scoped, deps);
    },
    { prefix: API_PREFIX },
  );

  return app;
}

/** Principal set by the preHandler hook; routes marked public never call this. */
export function principalOf(req: { principal: Principal | null }): Principal {
  if (!req.principal) throw new ApiError('UNAUTHENTICATED', 'Authentication required');
  return req.principal;
}
