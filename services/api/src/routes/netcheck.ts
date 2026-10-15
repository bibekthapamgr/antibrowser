/**
 * ADR-0027: the desktop app's proxy check service.
 *
 *   GET /v1/netcheck   text/plain, Cloudflare trace format: `ip=<address this server saw>` and, when the IP
 *                      geolocation database is configured (GEOIP_DB), `loc=`, `city=`, `tz=`, `lat=`, `lon=`, `lang=`.
 *
 * The desktop app connects to it *through a proxy*, so the address is the proxy's exit address and the location is
 * the database's estimate for it. Public (no account needed), rate limited per address like the other public
 * routes, never cached. Nothing is stored or logged beyond the usual request log line (which already holds the
 * client address).
 */
import Type from 'typebox';
import type { App, Deps } from '../app.ts';
import { clientAddress, traceBody } from '../geo.ts';
import { hit, LIMITS } from '../ratelimit.ts';
import { errors } from './common.ts';

export function netcheckRoutes(app: App, deps: Deps): void {
  app.get(
    '/netcheck',
    {
      config: { public: true },
      schema: {
        tags: ['public'],
        security: [],
        description:
          'The address this server saw, for the desktop proxy check, as `key=value` lines (Cloudflare trace ' +
          'format): `ip=`, and when a geolocation database is configured `loc=` (country), `city=`, `tz=` (IANA ' +
          'time zone), `lat=`/`lon=` (two decimals) and `lang=` (the country’s most likely language, BCP 47). ' +
          'IP geolocation by DB-IP (https://db-ip.com, CC BY 4.0). An estimate, not a verified location. ' +
          'The address is the client address after TRUST_PROXY_HOPS trusted reverse-proxy hops. Rate limited per address.',
        response: {
          200: {
            description: 'key=value lines',
            content: { 'text/plain': { schema: Type.String() } },
          },
          ...errors,
        },
      },
    },
    async (req, reply) => {
      await hit(deps.pool, LIMITS.netcheckPerIp, req.ip);
      const ip = clientAddress(req.ip);
      const body = traceBody(ip, deps.geo(ip));
      return reply
        .header('content-type', 'text/plain; charset=utf-8')
        .header('cache-control', 'no-store')
        .send(body);
    },
  );
}
