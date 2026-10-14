import { existsSync, readFileSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { extname, join, normalize, resolve, sep } from 'node:path';
import puppeteer, { type Browser, type Page } from 'puppeteer-core';

const DIST = resolve(import.meta.dirname, '../dist-demo');
const BASE = '/app/';
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
};

/** Serves the demo build at /app/ on 127.0.0.1 with the portal's production CSP. */
export async function servePortal(csp: string): Promise<{ url: string; close: () => Promise<void> }> {
  if (!existsSync(join(DIST, 'index.html'))) {
    throw new Error('dist-demo/ is missing: run `pnpm --filter @pb/web-customer build:demo` first');
  }
  const server: Server = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
    if (!path.startsWith(BASE)) {
      res.writeHead(404).end();
      return;
    }
    const rel = path.slice(BASE.length);
    const file = normalize(join(DIST, rel === '' ? 'index.html' : rel));
    if (!file.startsWith(DIST + sep) || !existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, {
      'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
      'content-security-policy': csp,
    });
    res.end(readFileSync(file));
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/app/`,
    close: () => new Promise((ok) => server.close(() => ok())),
  };
}

export async function launchBrowser(): Promise<Browser> {
  const executablePath = process.env.PB_CHROME_PATH;
  if (!executablePath) throw new Error('Set PB_CHROME_PATH to a Chromium/chrome-headless-shell binary');
  const args = ['--disable-gpu', '--disable-dev-shm-usage', '--font-render-hinting=none'];
  if (process.getuid?.() === 0 || process.env.PB_CHROME_NO_SANDBOX === '1') args.push('--no-sandbox');
  return puppeteer.launch({ executablePath, headless: true, args });
}

const require = createRequire(import.meta.url);
const AXE = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');

export interface AxeViolation {
  id: string;
  impact: string | null;
  help: string;
  nodes: { target: string[] }[];
}

/** Runs axe-core (WCAG 2.x A/AA rules) and returns serious/critical violations only. */
export async function axeSerious(page: Page): Promise<AxeViolation[]> {
  await page.evaluate(AXE);
  const result = (await page.evaluate(async () => {
    const axe = (window as unknown as { axe: { run: (ctx: unknown, opts: unknown) => Promise<unknown> } })
      .axe;
    return axe.run(document, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'] },
    });
  })) as { violations: AxeViolation[] };
  return result.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => ({
      id: v.id,
      impact: v.impact,
      help: v.help,
      nodes: v.nodes.map((n) => ({ target: n.target })),
    }));
}
