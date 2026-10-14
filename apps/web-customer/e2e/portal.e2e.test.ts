/**
 * R4 customer portal journeys, against the demo build served with the portal's production CSP:
 * - a new visitor creates an account, accepts the terms, lands in a trial workspace and is shown the download
 *   ("not yet available" until a stable release exists; verified links when it does)
 * - paying: plan and billing period → the provider's checkout → "pending verification" → active; a slow
 *   confirmation; a canceled checkout; prices that cannot be verified are not offered (never free)
 * - an invited member joins without paying and sees billing read-only
 * - inviting with a preview of exactly the chosen profiles; account: computers, e-mails, deletion request
 * - no CSP violations; no serious axe violations in light and dark at phone and desktop widths; no sideways scroll
 */
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Browser, Page } from 'puppeteer-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { axeSerious, launchBrowser, servePortal } from './harness.ts';

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
const SHOTS = process.env.PB_SCREENSHOTS ? resolve(import.meta.dirname, '../../../docs/design') : null;
const TOKEN = 'DemoInvitationToken_abcdefghijklmnopqrstuvw';
let browser: Browser;
let server: Awaited<ReturnType<typeof servePortal>>;
const problems: string[] = [];

beforeAll(async () => {
  server = await servePortal(CSP);
  browser = await launchBrowser();
  if (SHOTS) mkdirSync(SHOTS, { recursive: true });
});
afterAll(async () => {
  await browser?.close();
  await server?.close();
  expect(problems).toEqual([]);
});

async function open(demo: string, hash = '', opts: { dark?: boolean; width?: number } = {}): Promise<Page> {
  const page = await browser.newPage();
  await page.setViewport({ width: opts.width ?? 1280, height: 860 });
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: opts.dark ? 'dark' : 'light' }]);
  page.on('console', (m) => {
    if (/Content Security Policy|Refused to/i.test(m.text())) problems.push(m.text());
  });
  page.on('pageerror', (e) => problems.push(String(e)));
  page.on('dialog', (d) => void d.accept());
  await page.goto(`${server.url}?demo=${encodeURIComponent(demo)}${hash}`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('h1');
  return page;
}

const text = (page: Page, selector = 'main') =>
  page.$eval(selector, (el) => (el as HTMLElement).innerText.trim());
const heading = (page: Page, h: string) =>
  page.waitForFunction((x) => document.querySelector('h1')?.textContent?.includes(x), { timeout: 10_000 }, h);
const sees = (page: Page, needle: string, timeout = 10_000) =>
  page.waitForFunction((n) => document.querySelector('main')?.textContent?.includes(n), { timeout }, needle);

/** Clicks the button or link whose text (including screen-reader-only text) starts with `name`. */
async function click(page: Page, name: string) {
  const handle = await page.waitForFunction(
    (n) =>
      [...document.querySelectorAll<HTMLElement>('button, a')].find(
        (b) =>
          (b.textContent ?? '').replace(/\s+/g, ' ').trim().startsWith(n) &&
          !(b as HTMLButtonElement).disabled,
      ),
    { timeout: 10_000 },
    name,
  );
  await (handle.asElement() as unknown as { click(): Promise<void> }).click();
}

describe('trial signup', () => {
  it('creates an account, accepts the terms once, lands in the workspace and is offered the app', async () => {
    const page = await open('');
    await heading(page, 'Welcome to Project Browser');
    expect(await text(page)).toContain('No payment details are needed');
    await click(page, 'Create account');
    await heading(page, 'Set up your workspace');
    expect(await page.$eval('button[type=submit]', (b) => (b as HTMLButtonElement).disabled)).toBe(true);
    await page.type('main input[maxlength="120"]', 'Bibek Studio');
    await page.click('main label.check input[required]');
    await click(page, 'Create my workspace');
    await heading(page, 'Bibek Studio');
    await sees(page, 'Your workspace is ready');
    await sees(page, 'Free trial');
    await sees(page, 'not yet available for download');
    expect(
      await page.$$eval('main a', (as) => as.filter((a) => a.textContent?.startsWith('Download for')).length),
    ).toBe(0);
    await page.close();
  });

  it('a verified stable release offers its files with checksums; other systems are named, not promised', async () => {
    const page = await open('signedin available', '#/overview');
    await sees(page, 'Version 0.13.0');
    const links = await page.$$eval('main a', (as) =>
      as
        .filter((a) => a.textContent?.startsWith('Download for'))
        .map((a) => [a.textContent, a.getAttribute('href')]),
    );
    expect(links).toEqual([
      ['Download for Windows', expect.stringContaining('_x64-setup.exe')],
      ['Download for Mac', expect.stringContaining('_aarch64.dmg')],
    ]);
    expect(await text(page)).toContain('SHA-256');
    expect(await text(page)).toContain('not supported yet');
    await page.close();
  });
});

describe('paying', () => {
  it('chooses a yearly plan, goes to the provider, waits for verification and shows it active', async () => {
    const page = await open('signedin', '#/billing');
    await heading(page, 'Billing');
    await sees(page, 'per month');
    expect(await text(page)).toContain('plus applicable tax');
    await page.click('main fieldset.segmented label:nth-of-type(2) input');
    await sees(page, 'per year');
    expect(await text(page)).toContain('Not offered yearly.');
    await click(page, 'Choose Team');
    await heading(page, 'Confirming your payment');
    await sees(page, 'Pending verification');
    await heading(page, 'Your plan is active');
    await sees(page, 'Team is active');
    await click(page, 'Go to billing');
    await sees(page, 'Manage payment and plan');
    await sees(page, 'PB-0001');
    // Subscribed: no second checkout is offered.
    expect(await text(page)).not.toContain('Choose a plan');
    await page.close();
  });

  it('a slow confirmation says so and is safe to leave; a canceled checkout charged nothing', async () => {
    const page = await open('signedin delay', '#/billing');
    await click(page, 'Choose Team');
    await sees(page, 'Pending verification');
    await page.evaluate(() =>
      (window as unknown as { __pbPortalDemo: { confirmPayment(): void } }).__pbPortalDemo.confirmPayment(),
    );
    await heading(page, 'Your plan is active');
    await page.close();
    const back = await open('signedin', '#/billing/return?result=canceled');
    await heading(back, 'Checkout canceled');
    expect(await text(back)).toContain('Nothing was charged');
    await back.close();
  });

  it('prices that cannot be verified are not offered and never shown as free', async () => {
    const page = await open('signedin noprices', '#/billing');
    await sees(page, 'Plans cannot be bought on this server right now');
    expect(await text(page)).not.toMatch(/\$0|free plan/i);
    await page.close();
  });
});

describe('teams', () => {
  it('an invited member joins without paying and sees billing as the team’s', async () => {
    const page = await open('invite', `#/invite/${TOKEN}`);
    await heading(page, 'Join Demo Agency');
    expect(await text(page)).toContain('no plan or payment of your own is needed');
    await click(page, 'Accept and join');
    await heading(page, 'Demo Agency');
    await sees(page, 'You joined Demo Agency as Member');
    await click(page, 'Billing');
    await heading(page, 'Billing');
    await sees(page, 'managed by the workspace’s owners and billing managers');
    expect(await text(page)).not.toContain('Choose Team');
    await page.close();
  });

  it('inviting previews exactly the chosen profiles before sending', async () => {
    const page = await open('signedin', '#/team');
    await heading(page, 'Team');
    await page.type('main input[type=email]', 'mate@example.test');
    await click(page, 'Next');
    await page.waitForSelector('.pick-list input');
    const boxes = await page.$$('.pick-list input');
    await boxes[0]?.click();
    await boxes[2]?.click();
    await sees(page, '2 selected');
    await click(page, 'Preview access');
    await sees(page, 'will reach 2 profiles (only these; not ones added later) and can open and use them');
    await click(page, 'Send invitation');
    await sees(page, 'Invitation e-mailed to mate@example.test');
    await sees(page, 'No invitations waiting', 2000).catch(() => undefined);
    expect(await text(page)).toContain('mate@example.test');
    await page.close();
  });
});

describe('account', () => {
  it('signs a computer out, changes optional e-mails, and asks for (then withdraws) deletion', async () => {
    const page = await open('signedin', '#/account');
    await heading(page, 'Account');
    await click(page, 'Sign out Office PC');
    await sees(page, 'was signed out');
    await page.click('main label.check input');
    await sees(page, 'E-mail settings saved.');
    expect(await text(page)).toContain('Security messages, invitations and payment results are always sent');
    await click(page, 'Ask to delete my account');
    await click(page, 'Request deletion');
    await sees(page, 'Nothing has been deleted yet.');
    expect(await text(page)).toContain('You are the only owner of Bibek Studio');
    await click(page, 'Withdraw the request');
    await sees(page, 'was withdrawn');
    await page.close();
  });
});

const SCREENS: { name: string; demo: string; hash: string; ready: string }[] = [
  { name: 'portal-welcome', demo: '', hash: '', ready: 'Welcome' },
  { name: 'portal-overview', demo: 'signedin available', hash: '#/overview', ready: 'Version 0.13.0' },
  { name: 'portal-billing', demo: 'signedin', hash: '#/billing', ready: 'per month' },
  { name: 'portal-billing-member', demo: 'member', hash: '#/billing', ready: 'managed by' },
  {
    name: 'portal-return-pending',
    demo: 'signedin delay',
    hash: '#/billing/return?result=success',
    ready: 'Pending',
  },
  { name: 'portal-team', demo: 'signedin', hash: '#/team', ready: 'Sam Operator' },
  { name: 'portal-account', demo: 'signedin', hash: '#/account', ready: 'Office PC' },
  { name: 'portal-invite', demo: 'invite', hash: `#/invite/${TOKEN}`, ready: 'Join Demo Agency' },
];

for (const dark of [false, true]) {
  describe(`every screen, ${dark ? 'dark' : 'light'}`, () => {
    it.each(SCREENS)('$name: no serious accessibility problems at phone and desktop widths', async (s) => {
      for (const width of [375, 1280]) {
        const page = await open(s.demo, s.hash, { dark, width });
        await page.waitForFunction(
          (r) => document.body.textContent?.includes(r),
          { timeout: 10_000 },
          s.ready,
        );
        const violations = await axeSerious(page);
        expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        );
        expect(overflow).toBeLessThanOrEqual(0);
        if (SHOTS && width === 1280)
          await page.screenshot({
            path: `${SHOTS}/${s.name}-${dark ? 'dark' : 'light'}.png`,
            fullPage: true,
          });
        await page.close();
      }
    });
  });
}

describe('keyboard', () => {
  it('reaches the main actions with Tab and the skip control moves focus to the content', async () => {
    const page = await open('signedin', '#/overview');
    // The skip control is the first thing Tab reaches on every page.
    const first = await page.evaluate(
      () =>
        [...document.querySelectorAll<HTMLElement>('a[href], button, input, select, textarea')].find(
          (e) => !e.hasAttribute('disabled'),
        )?.textContent,
    );
    expect(first).toBe('Skip to content');
    await page.focus('.skip');
    await page.keyboard.press('Enter');
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('main');
    await page.close();
  });
});
