import Type from 'typebox';
import type { App, Deps } from '../app.ts';
import { errors } from './common.ts';

export function healthRoutes(app: App, deps: Deps): void {
  app.get(
    '/health',
    {
      config: { public: true },
      schema: {
        tags: ['ops'],
        security: [],
        response: { 200: Type.Object({ status: Type.Literal('ok') }), ...errors },
      },
    },
    async () => ({ status: 'ok' as const }),
  );

  app.get(
    '/ready',
    {
      config: { public: true },
      schema: {
        tags: ['ops'],
        security: [],
        response: { 200: Type.Object({ status: Type.Literal('ready') }), ...errors },
      },
    },
    async () => {
      await deps.pool.query('select 1');
      return { status: 'ready' as const };
    },
  );
}
