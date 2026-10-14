/**
 * The internal support console's static files (milestone 11, ADR-0018), served at /console/ from CONSOLE_DIR when it
 * is set. Same origin as the API, so the console's /v1/support requests need no CORS. The files are read once at
 * start-up into memory: only those exact paths are served (nothing is resolved against the disk per request, so no
 * path can escape the directory), anything else without a file extension gets the page itself (hash routing), and
 * every answer carries the console's strict Content-Security-Policy.
 *
 * The console holds no secrets: it signs staff in with its own public OIDC client (PKCE) and keeps the 30-minute
 * staff token in memory only.
 */
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { extname, join, relative, sep } from 'node:path';
import { CONSOLE_PATH, consoleCsp } from '@pb/contracts/billing';
import type { App, Deps } from '../app.ts';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
};
const MAX_FILES = 200;
const MAX_BYTES = 20 * 1024 * 1024;

interface File {
  type: string;
  body: Buffer;
}

/** The console bundle as path → file (paths relative to the directory, with forward slashes). */
export function loadConsoleFiles(dir: string): Map<string, File> {
  const files = new Map<string, File>();
  let total = 0;
  const walk = (at: string) => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const full = join(at, entry.name);
      // Regular files and directories only: a symbolic link could point outside the bundle.
      const st = lstatSync(full);
      if (st.isDirectory()) {
        walk(full);
        continue;
      }
      if (!st.isFile()) continue;
      const type = TYPES[extname(entry.name).toLowerCase()];
      if (!type) continue;
      total += st.size;
      if (files.size >= MAX_FILES || total > MAX_BYTES) {
        throw new Error(`console bundle in ${dir} is larger than expected`);
      }
      files.set(relative(dir, full).split(sep).join('/'), { type, body: readFileSync(full) });
    }
  };
  walk(dir);
  if (!files.has('index.html')) throw new Error(`console bundle in ${dir} has no index.html`);
  return files;
}

export function consoleRoutes(app: App, deps: Deps): void {
  const dir = deps.config.console.dir;
  if (!dir) return;
  let files: Map<string, File>;
  try {
    files = loadConsoleFiles(dir);
  } catch (err) {
    app.log.warn({ err: (err as Error).message }, 'support console not served');
    return;
  }
  const issuer = deps.config.oidc?.issuer;
  const csp = consoleCsp(issuer ? new URL(issuer).origin : null);
  const index = files.get('index.html') as File;
  const base = CONSOLE_PATH.replace(/\/$/, '');

  app.get(base, { config: { public: true }, schema: { hide: true } }, async (_req, reply) =>
    reply.redirect(CONSOLE_PATH, 308),
  );

  app.get(`${CONSOLE_PATH}*`, { config: { public: true }, schema: { hide: true } }, async (req, reply) => {
    const rel = (req.params as { '*': string })['*'] ?? '';
    const last = rel.split('/').pop() ?? '';
    const file = files.get(rel) ?? (rel === '' || !last.includes('.') ? index : undefined);
    reply
      .header('content-security-policy', csp)
      .header('referrer-policy', 'no-referrer')
      .header('x-frame-options', 'DENY')
      .header('cross-origin-opener-policy', 'same-origin')
      .header('cross-origin-resource-policy', 'same-origin')
      .header('permissions-policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
    if (!file) return reply.status(404).type('text/plain; charset=utf-8').send('Not found');
    return reply.type(file.type).send(file.body);
  });
}
