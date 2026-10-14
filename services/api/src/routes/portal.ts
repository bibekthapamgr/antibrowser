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
      // Built files carry a content hash in their names (R4); the page itself is never cached.
      .header('cache-control', rel.startsWith('assets/') ? 'public, max-age=31536000, immutable' : 'no-store')
      .header('cross-origin-opener-policy', 'same-origin')
      .header('cross-origin-resource-policy', 'same-origin')
      .header('permissions-policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
    if (!file) return reply.status(404).type('text/plain; charset=utf-8').send('Not found');
    return reply.type(file.type).send(file.body);
  });
}

// ------------------------------------------------------------------------------------------------ R4 website
export function siteCsp(): string {
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

/**
 * R4 (ADR-0023): the public website's built pages at / (PUBLIC_DIR). Public and cacheable (pages for five minutes,
 * hashed assets for a year); nothing here reads a cookie. Unknown /v1 paths keep the API's JSON 404.
 */
export function publicSiteRoutes(app: App, deps: Deps): void {
  const dir = deps.config.site.dir;
  if (!dir) return;
  let files: ReturnType<typeof loadConsoleFiles>;
  try {
    files = loadConsoleFiles(dir);
  } catch (err) {
    app.log.warn({ err: (err as Error).message }, 'public website not served');
    return;
  }
  const csp = siteCsp();
  const notFound = files.get('404.html');
  app.get('/*', { config: { public: true }, schema: { hide: true } }, async (req, reply) => {
    const rel = ((req.params as { '*': string })['*'] ?? '').replace(/^\/+/, '');
    if (rel === 'v1' || rel.startsWith('v1/')) {
      return reply.status(404).send({
        code: 'NOT_FOUND',
        message: 'Route not found',
        request_id: req.id,
        retryable: false,
        safe_details: {},
      });
    }
    const file =
      files.get(rel) ??
      files.get(rel === '' ? 'index.html' : `${rel.replace(/\/$/, '')}/index.html`) ??
      undefined;
    reply
      .header('content-security-policy', csp)
      .header('referrer-policy', 'strict-origin-when-cross-origin')
      .header('x-frame-options', 'DENY')
      .header('x-content-type-options', 'nosniff')
      .header('cross-origin-opener-policy', 'same-origin')
      .header('permissions-policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
    if (!file) {
      reply.header('cache-control', 'no-store');
      return notFound
        ? reply.status(404).type(notFound.type).send(notFound.body)
        : reply.status(404).type('text/plain; charset=utf-8').send('Not found');
    }
    // A directory without its trailing slash: redirect, so relative links on the page resolve.
    if (rel && !rel.endsWith('/') && !rel.includes('.') && files.has(`${rel}/index.html`))
      return reply.redirect(`/${rel}/`, 308);
    reply.header(
      'cache-control',
      rel.startsWith('assets/') ? 'public, max-age=31536000, immutable' : 'public, max-age=300',
    );
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
              /** R4: the identity provider's own account page (password, sign-in settings), if known. */
              account_url: Type.Union([Type.String(), Type.Null()]),
              /** R4: the service status page, if the owner has one. */
              status_url: Type.Union([Type.String(), Type.Null()]),
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
        // Keycloak's account console lives at <issuer>/account/ (ADR-0021 provider).
        account_url: deps.config.oidc ? `${deps.config.oidc.issuer.replace(/\/$/, '')}/account/` : null,
        status_url: deps.config.site.statusUrl,
      };
    },
  );
}
