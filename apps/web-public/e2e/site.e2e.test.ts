/**
 * R4 public website in a real browser, served from dist/ with the site's production CSP and stand-in API answers:
 * - pricing shows verified prices with currency, interval and tax; monthly/yearly only when both exist; nothing
 *   is offered (and nothing shown as free) when prices cannot be verified or the API is down
 * - download offers verified files only; "not yet available" otherwise
 * - the contact form validates, sends, and reports rate limits
 * - no CSP violations; no serious axe violations in light and dark at phone and desktop widths; no sideways scroll
 */
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { extname, join, normalize, resolve, sep } from 'node:path';
import puppeteer, { type Browser, type Page } from 'puppeteer-core';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const DIST = resolve(import.meta.dirname, '../dist');
const SHOTS = process.env.PB_SCREENSHOTS ? resolve(import.meta.dirname, '../../../docs/design') : null;
const CSP = [
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
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.png': 'image/png',
  '.txt': 'text/plain',
};

const NOW = '2026-10-15T08:00:00.000Z';
const price = (interval: 'month' | 'year', amount: number) => ({
  interval,
  amount_minor: amount,
  currency: 'usd',
  tax: 'exclusive',
  verified_at: NOW,
});
const plan = (id: string, name: string, prices: unknown[], available = true) => ({
  id,
  version: 1,
  name,
  description: `${name} plan`,
  limits: { profiles: id === 'solo' ? 50 : 500, seats: id === 'solo' ? 1 : 10, storage_bytes: 5 * 1024 ** 3 },
  features: { team_sessions: id !== 'solo', api_access: false },
  prices,
  available,
});
const PLANS = {
  catalog_version: '0123456789abcdef',
  generated_at: NOW,
  trial_days: 14,
  checkout: true,
  items: [
    plan('solo', 'Solo', [price('month', 1900)]),
    plan('team', 'Team', [price('month', 4900), price('year', 49000)]),
  ],
};
const RELEASE = {
  channel: 'stable',
  status: 'available',
  version: '1.0.0',
  published_at: NOW,
  notes_url: 'https://example.test/releases/1.0.0',
  platforms: [
    {
      platform: 'windows-x64',
      label: 'Windows 10/11, 64-bit installer',
      kind: 'installer',
      url: 'https://example.test/pb_1.0.0_x64-setup.exe',
      sha256: 'a'.repeat(64),
      size_bytes: 90_000_000,
    },
    {
      platform: 'macos-arm64',
      label: 'macOS 13+, Apple silicon',
      kind: 'disk-image',
      url: 'https://example.test/pb_1.0.0_aarch64.dmg',
      sha256: 'b'.repeat(64),
      size_bytes: 110_000_000,
    },
  ],
  checked_at: NOW,
};
const NOT_AVAILABLE = {
  ...RELEASE,
  status: 'not_available',
  version: null,
  published_at: null,
  notes_url: null,
  platforms: [],
};

// What the stand-in API answers; each test sets what it needs.
let api: { plans: unknown; downloads: unknown; contact: number } = {
  plans: PLANS,
  downloads: RELEASE,
  contact: 202,
};
const contactBodies: unknown[] = [];

let server: Server;
let base = '';
let browser: Browser;
const problems: string[] = [];

beforeAll(async () => {
  if (!existsSync(join(DIST, 'index.html'))) throw new Error('dist/ is missing: run `node build.mjs` first');
  server = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(body === undefined ? '' : JSON.stringify(body));
    };
    if (path === '/v1/public/plans')
      return api.plans ? json(200, api.plans) : json(503, { code: 'UNAVAILABLE' });
    if (path === '/v1/public/downloads') return json(200, api.downloads);
    if (path === '/v1/web/config') return json(200, { status_url: 'https://status.example.test/' });
    if (path === '/v1/public/contact' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => {
        body += c;
      });
      req.on('end', () => {
        contactBodies.push(JSON.parse(body));
        json(api.contact, api.contact === 202 ? { accepted: true } : { code: 'RATE_LIMITED' });
      });
      return;
    }
    let file = normalize(join(DIST, path));
    if (path.endsWith('/')) file = join(file, 'index.html');
    const found =
      (file === DIST || file.startsWith(DIST + sep)) && existsSync(file) && statSync(file).isFile();
    if (!found) file = join(DIST, '404.html');
    res.writeHead(found ? 200 : 404, {
      'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
      'content-security-policy': CSP,
    });
    res.end(readFileSync(file));
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const executablePath = process.env.PB_CHROME_PATH;
  if (!executablePath) throw new Error('Set PB_CHROME_PATH to a Chromium/chrome-headless-shell binary');
  const args = ['--disable-gpu', '--disable-dev-shm-usage', '--font-render-hinting=none'];
  if (process.getuid?.() === 0 || process.env.PB_CHROME_NO_SANDBOX === '1') args.push('--no-sandbox');
  browser = await puppeteer.launch({ executablePath, headless: true, args });
  if (SHOTS) mkdirSync(SHOTS, { recursive: true });
});
afterAll(async () => {
  await browser?.close();
  await new Promise((ok) => server?.close(ok));
  expect(problems).toEqual([]);
});
beforeEach(() => {
  api = { plans: PLANS, downloads: RELEASE, contact: 202 };
});

async function open(path: string, opts: { dark?: boolean; width?: number } = {}): Promise<Page> {
  const page = await browser.newPage();
  await page.setViewport({ width: opts.width ?? 1280, height: 860 });
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: opts.dark ? 'dark' : 'light' }]);
  page.on('console', (m) => {
    if (/Content Security Policy|Refused to/i.test(m.text())) problems.push(m.text());
  });
  page.on('pageerror', (e) => problems.push(String(e)));
  await page.goto(`${base}${path}`, { waitUntil: 'load' });
  return page;
}
const text = (page: Page) => page.$eval('main', (el) => (el as HTMLElement).innerText);
const sees = (page: Page, needle: string) =>
  page.waitForFunction(
    (n) => document.querySelector('main')?.textContent?.includes(n),
    { timeout: 10_000 },
    needle,
  );

const require = createRequire(import.meta.url);
const AXE = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
async function axeSerious(page: Page) {
  await page.evaluate(AXE);
  const r = (await page.evaluate(() =>
    (window as unknown as { axe: { run: (c: unknown, o: unknown) => Promise<unknown> } }).axe.run(document, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'] },
    }),
  )) as { violations: { id: string; impact: string | null; nodes: { target: string[] }[] }[] };
  return r.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => ({ id: v.id, nodes: v.nodes.map((n) => n.target) }));
}

describe('pricing', () => {
  it('shows verified prices with interval and tax, and switches to yearly where offered', async () => {
    const page = await open('/pricing/');
    await sees(page, '14-day free trial');
    const t = await text(page);
    expect(t).toContain('$19.00');
    expect(t).toContain('$49.00');
    expect(t).toContain('plus applicable tax');
    expect(t).toContain('10 seats (owner included)');
    await page.click('fieldset.segmented label:nth-of-type(2) input');
    await sees(page, '$490.00');
    expect(await text(page)).toContain('Not offered yearly.');
    const hrefs = await page.$$eval('.plan a', (as) => as.map((a) => a.getAttribute('href')));
    expect(hrefs).toEqual(['/app/#/welcome?plan=solo', '/app/#/welcome?plan=team']);
    await page.close();
  });

  it('offers no billing-period switch when only monthly prices exist', async () => {
    api.plans = { ...PLANS, items: [PLANS.items[0]] };
    const page = await open('/pricing/');
    await sees(page, '$19.00');
    expect(await page.$('fieldset.segmented')).toBeNull();
    await page.close();
  });

  it('plans whose price cannot be verified are not offered and never shown as free', async () => {
    api.plans = { ...PLANS, items: PLANS.items.map((p) => ({ ...p, prices: [], available: false })) };
    const page = await open('/pricing/');
    await sees(page, 'Plans cannot be bought online right now');
    expect(await text(page)).not.toMatch(/\$0|free plan/i);
    expect(await page.$('.plan')).toBeNull();
    await page.close();
  });

  it('says so when prices cannot be loaded', async () => {
    api.plans = null;
    const page = await open('/pricing/');
    await sees(page, 'Prices cannot be shown right now');
    await page.close();
  });
});

describe('download', () => {
  it('offers the verified files of a stable release with checksums', async () => {
    const page = await open('/download/');
    await sees(page, 'Version 1.0.0');
    const links = await page.$$eval('.downloads a', (as) =>
      as.map((a) => [a.textContent, a.getAttribute('href')]),
    );
    expect(links).toEqual([
      ['Download for Windows', 'https://example.test/pb_1.0.0_x64-setup.exe'],
      ['Download for Mac', 'https://example.test/pb_1.0.0_aarch64.dmg'],
    ]);
    expect(await text(page)).toContain(`SHA-256 ${'a'.repeat(64)}`);
    await page.close();
  });

  it('says "not yet available" (and offers no file) when no release passes the gate', async () => {
    api.downloads = NOT_AVAILABLE;
    const page = await open('/download/');
    await sees(page, 'not yet available for download');
    expect(await page.$('.downloads')).toBeNull();
    await page.close();
  });

  it('paused downloads offer nothing', async () => {
    api.downloads = { ...NOT_AVAILABLE, status: 'paused' };
    const page = await open('/download/');
    await sees(page, 'Downloads are paused');
    expect(await page.$('.downloads')).toBeNull();
    await page.close();
  });
});

describe('contact', () => {
  it('validates, sends, and explains rate limits', async () => {
    contactBodies.length = 0;
    const page = await open('/contact/');
    await page.click('#contact button[type=submit]');
    expect(contactBodies).toHaveLength(0); // the browser's validation stops an empty form
    await page.select('select[name=topic]', 'billing');
    await page.type('input[name=name]', 'Bibek');
    await page.type('input[name=email]', 'bibek@example.test');
    await page.type('textarea[name=message]', 'Do you offer yearly invoices?');
    await page.click('#contact button[type=submit]');
    await sees(page, 'your message was sent');
    expect(contactBodies).toEqual([
      {
        topic: 'billing',
        name: 'Bibek',
        email: 'bibek@example.test',
        message: 'Do you offer yearly invoices?',
        website: '',
      },
    ]);
    api.contact = 429;
    await page.type('input[name=name]', 'Bibek');
    await page.type('input[name=email]', 'bibek@example.test');
    await page.type('textarea[name=message]', 'A second message here.');
    await page.click('#contact button[type=submit]');
    await sees(page, 'Too many messages');
    await page.close();
  });
});

describe('site', () => {
  it('links the status page configured by the owner, and unknown pages answer 404', async () => {
    const page = await open('/');
    await page.waitForSelector('#status-link a');
    expect(await page.$eval('#status-link a', (a) => a.getAttribute('href'))).toBe(
      'https://status.example.test/',
    );
    const res = await page.goto(`${base}/no-such-page/`);
    expect(res?.status()).toBe(404);
    expect(await page.$eval('h1', (h) => h.textContent)).toBe('Page not found');
    await page.close();
  });

  it('the skip link is the first thing Tab reaches and moves focus to the content', async () => {
    const page = await open('/');
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => document.activeElement?.textContent)).toBe('Skip to content');
    await page.keyboard.press('Enter');
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('main');
    await page.close();
  });
});

const PAGES = [
  { name: 'home', path: '/', ready: 'What it does' },
  { name: 'pricing', path: '/pricing/', ready: '$49.00' },
  { name: 'download', path: '/download/', ready: 'Version 1.0.0' },
  { name: 'help', path: '/help/', ready: 'Teams' },
  { name: 'contact', path: '/contact/', ready: 'Topic' },
  { name: 'security', path: '/security/', ready: 'Backups' },
  { name: 'privacy', path: '/legal/privacy/', ready: 'Draft' },
];
for (const dark of [false, true]) {
  describe(`every page, ${dark ? 'dark' : 'light'}`, () => {
    it.each(PAGES)('$name: no serious accessibility problems at phone and desktop widths', async (p) => {
      for (const width of [375, 1280]) {
        const page = await open(p.path, { dark, width });
        await sees(page, p.ready);
        const violations = await axeSerious(page);
        expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        );
        expect(overflow).toBeLessThanOrEqual(0);
        if (SHOTS && ['home', 'pricing', 'download'].includes(p.name))
          await page.screenshot({
            path: `${SHOTS}/site-${p.name}-${width === 375 ? 'phone' : 'desktop'}-${dark ? 'dark' : 'light'}.png`,
            fullPage: width === 1280,
          });
        await page.close();
      }
    });
  });
}
