/**
 * R4 (ADR-0023): routes the public website calls without signing in.
 *
 *   GET  /public/plans        the published catalog with verified prices (cacheable; revalidates on change)
 *   GET  /public/downloads    the signed stable release, or "not yet available" (never an internal build)
 *   POST /public/contact      the contact form (validated, rate limited, a honeypot; stored, e-mailed to support)
 *   POST /public/unsubscribe  one-click unsubscribe from product news (RFC 8058); GET shows a confirm button
 *
 * Nothing here reads a cookie or a session; answers carry no personal data.
 */
import { ContactRequest, PublicDownloads, PublicPlans } from '@pb/contracts';
import Type from 'typebox';
import type { App, Deps } from '../app.ts';
import { publicCatalog } from '../billing/catalog.ts';
import { withTx } from '../db.ts';
import { enqueueEmail, unsubscribeUser } from '../email.ts';
import { hit, LIMITS } from '../ratelimit.ts';
import { errors } from './common.ts';

const CATALOG_TTL_MS = 60_000;

export function publicRoutes(app: App, deps: Deps): void {
  let catalog: { at: number; value: PublicPlans } | null = null;

  app.get(
    '/public/plans',
    {
      config: { public: true },
      schema: {
        tags: ['public'],
        security: [],
        description:
          'The plans this server sells, with prices verified at the payment provider (one per configured interval). ' +
          'A plan whose price cannot be verified is listed without prices and cannot be bought; nothing is shown ' +
          'as free because a price is missing. `catalog_version` changes with the catalog or any price (ETag).',
        response: { 200: PublicPlans, 304: Type.Null(), ...errors },
      },
    },
    async (req, reply) => {
      const now = Date.now();
      if (!catalog || now - catalog.at > CATALOG_TTL_MS)
        catalog = { at: now, value: await publicCatalog(deps) };
      const etag = `"${catalog.value.catalog_version}"`;
      reply
        .header('cache-control', 'public, max-age=60, stale-while-revalidate=300')
        .header('etag', etag)
        .header('vary', 'accept-encoding');
      if (req.headers['if-none-match'] === etag) return reply.status(304).send(null);
      return catalog.value;
    },
  );

  app.get(
    '/public/downloads',
    {
      config: { public: true },
      schema: {
        tags: ['public'],
        security: [],
        description:
          'The desktop app on the signed stable channel (milestone 12): version, date, release notes and verified ' +
          'files per platform. `not_available` when there is no verified stable release (internal and test builds ' +
          'are never listed); `paused` while the publisher stopped offering it.',
        response: { 200: PublicDownloads, ...errors },
      },
    },
    async (_req, reply) => {
      reply.header('cache-control', 'public, max-age=300');
      return deps.downloads();
    },
  );

  app.post(
    '/public/contact',
    {
      config: { public: true },
      schema: {
        tags: ['public'],
        security: [],
        description:
          'The website contact form. Rate limited per address and per e-mail. Stored for the support team and ' +
          'e-mailed to the support address when one is configured. Never used for marketing.',
        body: ContactRequest,
        response: {
          202: Type.Object({ received: Type.Literal(true) }, { additionalProperties: false }),
          ...errors,
        },
      },
    },
    async (req, reply) => {
      await hit(deps.pool, LIMITS.contactPerIp, req.ip);
      const email = req.body.email.trim().toLowerCase();
      await hit(deps.pool, LIMITS.contactPerEmail, email);
      // A filled honeypot: answered like any other request, then dropped.
      if (req.body.website?.trim()) return reply.status(202).send({ received: true });
      await withTx(deps.pool, { orgId: null, userId: null }, async (c) => {
        // The API may only insert (no reading back): staff tools read the requests.
        await c.query(`insert into contact_requests (topic, name, email, message) values ($1, $2, $3, $4)`, [
          req.body.topic,
          req.body.name.trim(),
          email,
          req.body.message.trim(),
        ]);
        if (deps.config.site.supportEmail) {
          await enqueueEmail(c, deps.config.email.taskKey, {
            kind: 'contact_request',
            orgId: null,
            to: deps.config.site.supportEmail,
            dedupeKey: `contact:${req.id}`,
            vars: {
              topic: req.body.topic,
              name: req.body.name.trim(),
              reply_to: email,
              message: req.body.message.trim(),
            },
          });
        }
      });
      return reply.status(202).send({ received: true });
    },
  );

  // ---------------------------------------------------------------- one-click unsubscribe (product news only)
  const Token = Type.Object(
    { token: Type.String({ minLength: 10, maxLength: 120 }) },
    { additionalProperties: true },
  );
  const page = (text: string, form?: string) =>
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>E-mail preferences</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:36rem;margin:15vh auto;padding:0 16px;color:#1d2433;background:#fff}button{font:inherit;padding:.5rem 1rem}@media (prefers-color-scheme:dark){body{color:#e6e9ef;background:#14171d}}</style></head><body><h1>E-mail preferences</h1><p>${text}</p>${form ?? ''}</body></html>`;
  const html = (reply: import('fastify').FastifyReply, status: number, body: string) =>
    reply
      .status(status)
      .header('content-type', 'text/html; charset=utf-8')
      .header('cache-control', 'no-store')
      .header('referrer-policy', 'no-referrer')
      .header(
        'content-security-policy',
        "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
      )
      .send(body);

  app.get(
    '/public/unsubscribe',
    { config: { public: true }, schema: { tags: ['public'], security: [], hide: true, querystring: Token } },
    async (req, reply) => {
      const key = deps.config.email.taskKey;
      const user = key ? unsubscribeUser(key, req.query.token) : null;
      if (!user)
        return html(reply, 400, page('This link is not valid. Manage e-mails in your account settings.'));
      // A button, not an automatic change: link scanners must not unsubscribe people.
      return html(
        reply,
        200,
        page(
          'Stop product news? Messages about your account, security, invitations and payments still arrive.',
          `<form method="post" action="/v1/public/unsubscribe?token=${encodeURIComponent(req.query.token)}"><button type="submit">Unsubscribe</button></form>`,
        ),
      );
    },
  );

  app.register(async (scope) => {
    // RFC 8058 one-click: a form-encoded POST ("List-Unsubscribe=One-Click"), body ignored.
    scope.addContentTypeParser(
      'application/x-www-form-urlencoded',
      { parseAs: 'string', bodyLimit: 1024 },
      (_req, body, done) => done(null, body),
    );
    (scope as unknown as App).post(
      '/public/unsubscribe',
      {
        config: { public: true },
        schema: { tags: ['public'], security: [], hide: true, querystring: Token },
      },
      async (req, reply) => {
        await hit(deps.pool, LIMITS.unsubscribePerIp, req.ip);
        const key = deps.config.email.taskKey;
        const user = key ? unsubscribeUser(key, req.query.token) : null;
        if (!user)
          return html(reply, 400, page('This link is not valid. Manage e-mails in your account settings.'));
        await withTx(deps.pool, { orgId: null, userId: user }, (c) =>
          c.query(
            `insert into user_consents (user_id, kind, version, granted) values ($1, 'marketing', 'unsubscribe', false)`,
            [user],
          ),
        );
        return html(
          reply,
          200,
          page('You will not get product news any more. You can turn it back on in your account.'),
        );
      },
    );
  });
}
