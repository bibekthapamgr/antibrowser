/**
 * R2 (ADR-0021): the customer web portal's static page at /app/ (WEB_DIR, read once at start-up like the support
 * console) with a strict Content-Security-Policy, and its public settings at /v1/web/config. The page talks to the
 * API on the same origin with its cookie session (routes/web.ts); it holds no token.
 */
import Type from 'typebox';
import type { App, Deps } from '../app.ts';
import { loadConsoleFiles } from './console.ts';

export const PORTAL_PATH = '/app/';

export function portalCsp(): string {
  return [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
  ].join('; ');
}

/** Static files at /app/ (outside /v1). */
export function portalRoutes(app: App, deps: Deps): void {
  const dir = deps.config.web.dir;
  if (!dir || !deps.config.web.origin) return;
  let files: ReturnType<typeof loadConsoleFiles>;
  try {
    files = loadConsoleFiles(dir);
  } catch (err) {
    app.log.warn({ err: (err as Error).message }, 'customer portal not served');
    return;
  }
  const index = files.get('index.html');
  if (!index) return;
  const csp = portalCsp();
  app.get('/app', { config: { public: true }, schema: { hide: true } }, async (_req, reply) =>
    reply.redirect(PORTAL_PATH, 308),
  );
  app.get(`${PORTAL_PATH}*`, { config: { public: true }, schema: { hide: true } }, async (req, reply) => {
    const rel = (req.params as { '*': string })['*'] ?? '';
    const last = rel.split('/').pop() ?? '';
    const file = files.get(rel) ?? (rel === '' || !last.includes('.') ? index : undefined);
    reply
      .header('content-security-policy', csp)
      .header('referrer-policy', 'no-referrer')
      .header('x-frame-options', 'DENY')
      .header('x-content-type-options', 'nosniff')
      .header('cache-control', 'no-store')
      .header('cross-origin-opener-policy', 'same-origin')
      .header('cross-origin-resource-policy', 'same-origin')
      .header('permissions-policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
    if (!file) return reply.status(404).type('text/plain; charset=utf-8').send('Not found');
    return reply.type(file.type).send(file.body);
  });
}

/** Public portal settings (/v1/web/config): brand, terms and the download address. Nothing secret. */
export function portalConfigRoutes(app: App, deps: Deps): void {
  app.get(
    '/web/config',
    {
      config: { public: true },
      schema: {
        tags: ['auth'],
        security: [],
        description:
          'Customer portal settings: brand name, current terms version and address, desktop download.',
        response: {
          200: Type.Object(
            {
              brand: Type.String(),
              terms_version: Type.String(),
              terms_url: Type.Union([Type.String(), Type.Null()]),
              download_url: Type.Union([Type.String(), Type.Null()]),
              sign_in: Type.Boolean(),
            },
            { additionalProperties: false },
          ),
        },
      },
    },
    async (_req, reply) => {
      reply.header('cache-control', 'no-store');
      return {
        brand: process.env.BRAND_NAME || 'Project Browser',
        terms_version: deps.config.onboarding.termsVersion,
        terms_url: deps.config.onboarding.termsUrl,
        download_url: process.env.WEB_DOWNLOAD_URL || null,
        sign_in: Boolean(deps.config.web.origin && deps.config.web.oidcClientId && deps.webIdTokens),
      };
    },
  );
}
