/**
 * R5 business-owner administration, against the demo build served with the console's production CSP:
 * - the platform owner lands on the dashboard (customers by state, recurring revenue per currency, cash, refunds,
 *   alerts, freshness and gaps)
 * - customers: search and filters, a customer's detail, case notes (redacted), a payment restriction applied and lifted
 * - plans: a draft for a new version, a provider failure that publishes nothing, then a successful publication
 * - operations: a failed e-mail retried; a release action recorded as a request
 * - a business analyst sees customers with masked owner addresses and no restriction or publishing controls
 * - support-only staff do not see business screens; a session without the one-time code is told to sign in again
 * - no CSP violations, no serious axe violations (light and dark), phone width without sideways scrolling
 */
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { consoleCsp } from '@pb/contracts/billing';
import type { Browser, Page } from 'puppeteer-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { axeSerious, launchBrowser, serveConsole } from './harness.ts';

const SHOTS = process.env.PB_SCREENSHOTS ? resolve(import.meta.dirname, '../../../docs/design') : null;
let browser: Browser;
let server: Awaited<ReturnType<typeof serveConsole>>;
const problems: string[] = [];

beforeAll(async () => {
  server = await serveConsole(consoleCsp('http://127.0.0.1:8081'));
  browser = await launchBrowser();
  if (SHOTS) mkdirSync(SHOTS, { recursive: true });
});
afterAll(async () => {
  await browser?.close();
  await server?.close();
  expect(problems).toEqual([]);
});

async function open(as: string, opts: { dark?: boolean; width?: number; hash?: string } = {}): Promise<Page> {
  const page = await browser.newPage();
  await page.setViewport({ width: opts.width ?? 1280, height: 860 });
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: opts.dark ? 'dark' : 'light' }]);
  page.on('console', (m) => {
    if (/Content Security Policy|Refused to/i.test(m.text())) problems.push(m.text());
  });
  page.on('pageerror', (e) => problems.push(String(e)));
  await page.goto(`${server.url}?as=${as}${opts.hash ?? ''}`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('h1');
  await click(page, 'Sign in with your staff account');
  await page.waitForSelector('nav.tabs');
  return page;
}

const text = (page: Page, selector = 'main') =>
  page.$eval(selector, (el) => (el as HTMLElement).innerText.trim());

async function click(page: Page, name: string) {
  const ok = await page.evaluate((n) => {
    const els = [...document.querySelectorAll<HTMLElement>('button, a, summary')];
    const el = els.find((e) => (e.getAttribute('aria-label') ?? e.innerText.trim()) === n);
    if (!el) return false;
    el.click();
    return true;
  }, name);
  if (!ok) throw new Error(`nothing named "${name}"`);
}

const waitText = (page: Page, needle: string, selector = 'main') =>
  page.waitForFunction(
    (s, n) => (document.querySelector(s) as HTMLElement | null)?.innerText.includes(n),
    { timeout: 5000 },
    selector,
    needle,
  );

const go = async (page: Page, tab: string, heading: string) => {
  await click(page, tab);
  await page.waitForFunction(
    (h) => document.querySelector('h1')?.textContent === h,
    { timeout: 5000 },
    heading,
  );
};

async function noAxe(page: Page, where: string) {
  const v = await axeSerious(page);
  expect(v, `${where}: ${JSON.stringify(v, null, 2)}`).toEqual([]);
}

async function shot(page: Page, name: string) {
  if (SHOTS)
    await page.screenshot({ path: resolve(SHOTS, `${name}.png`) as `${string}.png`, fullPage: true });
}

describe('platform owner', () => {
  it('lands on the dashboard: customers, recurring revenue per currency, cash, alerts, freshness and gaps', async () => {
    const page = await open('owner');
    await page.waitForFunction(() => document.querySelector('h1')?.textContent === 'Dashboard');
    await waitText(page, 'Monthly recurring revenue');
    const main = await text(page);
    expect(main).toContain('Active customers');
    expect(main).toMatch(/USD\s+\$189\.83/);
    expect(main).toContain('EUR');
    expect(main).toContain('never converted');
    expect(main).toContain('Refunds, last 30 days');
    expect(main).toContain('Discounts, credits and one-time items');
    const nav = await text(page, 'nav.tabs');
    for (const tab of ['Dashboard', 'Customers', 'Plans', 'Operations', 'Staff']) expect(nav).toContain(tab);
    await noAxe(page, 'dashboard');
    await shot(page, 'admin-dashboard-light');
    await page.close();
  });

  it('finds a customer, adds a redacted note, restricts the workspace for payment and lifts it', async () => {
    const page = await open('owner');
    await go(page, 'Customers', 'Customers');
    await waitText(page, 'Northwind Agency');
    await page.type('.filters input', 'harb');
    await click(page, 'Show');
    await page.waitForFunction(() => !document.querySelector('main')?.textContent?.includes('Northwind'));
    expect(await text(page)).toContain('owner'.length ? 'ops@harbor.example' : '');
    await click(page, 'Harbor Studio');
    await page.waitForSelector('#customer-title');
    await waitText(page, 'Members by role');
    await page.type('#note-body', 'Owner read card 4242 4242 4242 4242 on the phone; reminded them not to.');
    await click(page, 'Add note');
    await waitText(page, 'were replaced with [redacted]');
    expect(await text(page)).not.toContain('4242 4242');
    await page.type('#restr-reason', 'Chargeback opened at the payment provider; holding new work');
    await click(page, 'Restrict workspace');
    await waitText(page, 'Restricted: creating and opening profiles stopped');
    await waitText(page, 'Payment restriction — active');
    await noAxe(page, 'customer');
    await shot(page, 'admin-customer-light');
    await click(page, 'Lift payment restriction');
    await page.type('#lift-reason', 'Chargeback withdrawn by the customer today');
    await click(page, 'Lift restriction');
    await waitText(page, 'Lifted.');
    await waitText(page, 'Payment restriction — lifted');
    await page.close();
  });

  it('publishes a new version of a plan; a provider failure publishes nothing and the draft stays editable', async () => {
    const page = await open('owner');
    await go(page, 'Plans', 'Plans');
    await waitText(page, 'A published plan version never changes');
    await click(page, 'New version of Team');
    await page.waitForSelector('#editor-title');
    const seats = await page.$$('label.inline input');
    await seats[1]?.click({ count: 3 });
    await seats[1]?.type('8');
    await page.evaluate(() => {
      (
        window as unknown as { __pbConsoleDemo: { failNextPublish(): void } }
      ).__pbConsoleDemo.failNextPublish();
    });
    await click(page, 'Publish…');
    await waitText(page, 'Publish team as a new version?');
    expect(await text(page, '.confirm')).toContain('cannot be changed afterwards');
    await noAxe(page, 'publish confirmation');
    await click(page, 'Publish now');
    await waitText(page, 'nothing was published');
    await waitText(page, 'Last attempt failed');
    await click(page, 'Edit draft Team');
    await page.waitForSelector('#editor-title');
    await click(page, 'Publish…');
    await click(page, 'Publish now');
    await waitText(page, 'Published team@2');
    await waitText(page, 'team@2 — succeeded');
    await shot(page, 'admin-plans-light');
    await page.close();
  });

  it('retries a failed e-mail and records a release request without changing a release', async () => {
    const page = await open('owner');
    await go(page, 'Operations', 'Operations');
    await waitText(page, 'Worker last ran');
    expect(await text(page)).toContain('Addresses and contents are never shown here.');
    await click(page, 'Retry invitation e-mail');
    await waitText(page, 'Queued again');
    await page.type('#rel-reason', 'Crash reports after the last update; pause until fixed');
    await click(page, 'Record request');
    await waitText(page, 'nothing was changed here');
    await waitText(page, 'pause channel — requested');
    await noAxe(page, 'operations');
    await shot(page, 'admin-operations-light');
    await go(page, 'Staff', 'Staff');
    await waitText(page, 'Platform owner');
    await page.close();
  });
});

describe('other roles', () => {
  it('a business analyst reads customers with masked addresses and has no restriction or publishing controls', async () => {
    const page = await open('analyst');
    await go(page, 'Customers', 'Customers');
    await waitText(page, 'Owner addresses are masked for your role.');
    await waitText(page, 'Northwind Agency');
    expect(await text(page)).toMatch(/o\*\*\*@northwind\.example/);
    await click(page, 'Northwind Agency');
    await page.waitForSelector('#customer-title');
    expect(await page.$('#restr-reason')).toBeNull();
    expect(await page.$('#note-body')).toBeNull();
    await go(page, 'Plans', 'Plans');
    await waitText(page, 'Team');
    expect(await page.$('#new-plan')).toBeNull();
    const nav = await text(page, 'nav.tabs');
    expect(nav).not.toContain('Staff');
    await page.close();
  });

  it('support-only staff do not see business screens; a session without the code is told to sign in again', async () => {
    const support = await open('support');
    const nav = await text(support, 'nav.tabs');
    expect(nav).not.toContain('Dashboard');
    expect(nav).not.toContain('Customers');
    expect(nav).not.toContain('Plans');
    await support.close();
    const nocode = await open('nomfa');
    await waitText(nocode, 'opened without your one-time code');
    await waitText(nocode, 'Sign in again with your one-time code');
    await nocode.close();
  });
});

const SCREENS = [
  { name: 'dashboard', hash: '#/dashboard', ready: 'Monthly recurring revenue' },
  { name: 'customers', hash: '#/customers', ready: 'Northwind Agency' },
  { name: 'plans', hash: '#/plans', ready: 'Publication history' },
  { name: 'operations', hash: '#/operations', ready: 'Desktop releases' },
];
for (const dark of [false, true]) {
  describe(`business screens, ${dark ? 'dark' : 'light'}`, () => {
    it.each(SCREENS)('$name: no serious accessibility problems at phone and desktop widths', async (s) => {
      for (const width of [390, 1280]) {
        const page = await open('owner', { dark, width, hash: s.hash });
        await waitText(page, s.ready);
        await noAxe(page, `${s.name} ${width}`);
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        );
        expect(overflow, `${s.name} at ${width}px scrolls sideways`).toBeLessThanOrEqual(0);
        if (dark && width === 1280) await shot(page, `admin-${s.name}-dark`);
        await page.close();
      }
    });
  });
}
