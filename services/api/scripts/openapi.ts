/** Writes the OpenAPI document generated from route schemas to docs/openapi.json. */
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadConfig } from '@pb/config/env';
import { buildApp } from '../src/app.ts';
import { createPool } from '../src/db.ts';

const config = loadConfig();
const pool = createPool(config.databaseUrl, 1);
const app = await buildApp(config, pool, { logger: false });
await app.ready();
const out = join(import.meta.dirname, '../../../docs/openapi.json');
await writeFile(out, `${JSON.stringify(app.swagger(), null, 2)}\n`);
await app.close();
await pool.end();
console.log(`wrote ${out}`);
