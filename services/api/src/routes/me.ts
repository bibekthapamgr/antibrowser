import { Device, DeviceRegistration, Me, newId } from '@pb/contracts';
import type { Static } from 'typebox';
import { type App, type Deps, principalOf } from '../app.ts';
import { ts, withTx } from '../db.ts';
import { errors } from './common.ts';

export function meRoutes(app: App, deps: Deps): void {
  app.get('/me', { schema: { tags: ['identity'], response: { 200: Me, ...errors } } }, async (req) => {
    const { userId } = principalOf(req);
    return withTx(deps.pool, { orgId: null, userId }, async (c) => {
      const user = await c.query<{ display_name: string }>('select display_name from users where id = $1', [
        userId,
      ]);
      const memberships = await c.query<Static<typeof Me>['memberships'][number]>(
        `select m.org_id, o.name as org_name, m.role
             from memberships m join organizations o on o.id = m.org_id
            where m.user_id = $1
            order by o.name, m.org_id
            limit 100`,
        [userId],
      );
      return {
        user_id: userId,
        display_name: user.rows[0]?.display_name ?? '',
        memberships: memberships.rows,
      };
    });
  });

  app.post(
    '/me/devices',
    { schema: { tags: ['identity'], body: DeviceRegistration, response: { 201: Device, ...errors } } },
    async (req, reply) => {
      const { userId } = principalOf(req);
      const id = newId('device');
      const device = await withTx(deps.pool, { orgId: null, userId }, async (c) => {
        const { rows } = await c.query<Static<typeof Device>>(
          `insert into devices (id, user_id, name, platform) values ($1, $2, $3, $4)
           returning id, name, platform, ${ts('created_at')} as created_at`,
          [id, userId, req.body.name, req.body.platform],
        );
        return rows[0];
      });
      if (!device) throw new Error('device insert returned no row');
      return reply.status(201).send(device);
    },
  );
}
