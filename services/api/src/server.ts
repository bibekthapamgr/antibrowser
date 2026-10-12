import { loadConfig } from '@pb/config/env';
import { buildApp } from './app.ts';
import { createPool } from './db.ts';

const config = loadConfig();
const pool = createPool(config.databaseUrl);
const app = await buildApp(config, pool);

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'shutting down');
  await app.close();
  await pool.end();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

await app.listen({ host: config.host, port: config.port });
