/**
 * Milestone 11 support console acceptance, against the demo build served with the production CSP:
 * - sign-in screen, search by exact e-mail / customer id, organization billing overview
 * - members and activity hidden until a DIFFERENT support lead approves time-bound access; own requests cannot be
 *   approved; expired access hides them again; every view lands in the platform audit
 * - billing admins add (reason, expiry) and end overrides; others do not see the controls
 * - reconciliation alerts resolved by a billing admin; support staff see neither alerts nor the audit
 * - no CSP violations, no serious/critical axe violations (light and dark), focus on the page heading
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

async function open(as = 'all', opts: { dark?: boolean; width?: number } = {}): Promise<Page> {
  const page = await browser.newPage();
  await page.setViewport({ width: opts.width ?? 1280, height: 860 });
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: opts.dark ? 'dark' : 'light' }]);
  page.on('console', (m) => {
    if (/Content Security Policy|Refused to/i.test(m.text())) problems.push(m.text());
  });
  page.on('pageerror', (e) => problems.push(String(e)));
  await page.goto(`${server.url}?as=${as}`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('h1');
  return page;
}

const text = (page: Page, selector = 'body') =>
  page.$eval(selector, (el) => (el as HTMLElement).innerText.trim());

/** Clicks the button or link whose accessible name (aria-label, else text) is exactly `name`. */
async function click(page: Page, name: string) {
  const ok = await page.evaluate((n) => {
    const els = [...document.querySelectorAll<HTMLElement>('button, a')];
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

async function signIn(page: Page) {
  await click(page, 'Sign in with your staff account');
  await page.waitForSelector('nav.tabs');
}

async function search(page: Page, q: string) {
  await page.click('#q', { count: 3 });
  await page.keyboard.press('Backspace');
  await page.type('#q', q);
  await click(page, 'Search');
  await page.waitForSelector('#results-title');
}

async function openOrg(page: Page, email: string, name: string) {
  await search(page, email);
  await click(page, name);
  await page.waitForSelector('#org-title');
  await waitText(page, 'Subscription');
}

async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  await page.screenshot({ path: resolve(SHOTS, `${name}.png`) as `${string}.png`, fullPage: false });
}

async function noAxe(page: Page, where: string) {
  const v = await axeSerious(page);
  expect(v, `${where}: ${JSON.stringify(v, null, 2)}`).toEqual([]);
}

describe('support console (milestone 11)', () => {
  it('signs in, finds an organization by exact e-mail and shows its billing overview', async () => {
    const page = await open();
    expect(await text(page, 'h1')).toBe('Support console');
    expect(await text(page)).toContain('Every search and view is recorded');
    await noAxe(page, 'sign-in');
    await signIn(page);
    expect(await text(page, 'header')).toContain('Jordan Park · Support lead, Billing admin');
    expect(await text(page, 'header')).toMatch(/Session ends in (29|30) min/);
    // The page heading has focus after sign-in and after each navigation.
    expect(await page.evaluate(() => document.activeElement?.tagName)).toBe('H1');

    await search(page, 'nobody@example.com');
    expect(await text(page, '#results-title')).toBe('No organization found');
    await search(page, 'owner@northwind.example');
    expect(await text(page, '#results-title')).toBe('1 organization');
    await search(page, 'cus_DemoHarbor01');
    expect(await text(page, 'main')).toContain('Harbor Studio');
    expect(await text(page, 'main')).toContain('Past due');

    await openOrg(page, 'owner@northwind.example', 'Northwind Agency');
    expect(await page.evaluate(() => document.activeElement?.textContent)).toBe('Northwind Agency');
    const main = await text(page, 'main');
    expect(main).toContain('Agency (agency@1)');
    expect(main).toContain('Active — paid');
    expect(main).toContain('cus_DemoNorthwind01');
    expect(main).toContain('Seat limit until');
    expect(main).toContain('charge.refunded');
    // Member e-mails are not part of the overview.
    expect(main).not.toContain('casey@northwind.example');
    expect(main).toContain('Hidden by default');
    await noAxe(page, 'organization');
    await shot(page, 'console-org-light');
    await page.close();
  });

  it('a search that is not an id, customer or exact e-mail is refused with the reason', async () => {
    const page = await open();
    await signIn(page);
    await page.type('#q', 'northwind');
    await click(page, 'Search');
    await waitText(page, 'Search by organization id, customer id or an exact e-mail address');
    await page.close();
  });

  it('members stay hidden until a different support lead approves; access ends by itself and is audited', async () => {
    const both = await open('all');
    await signIn(both);
    await openOrg(both, 'owner@northwind.example', 'Northwind Agency');
    await both.type('#access-reason', 'Owner asked why an invited colleague cannot sign in (ticket 4812).');
    await both.select('#access-minutes', '30');
    await click(both, 'Request access');
    await waitText(both, 'Waiting for approval: Members (30 min)');

    // The requester cannot approve their own request, even as a support lead.
    await click(both, 'Access requests');
    await waitText(both, 'You cannot decide on your own requests');
    await waitText(both, 'Owner asked why an invited colleague');
    expect(await both.$('button[aria-label^="Approve Jordan"]')).toBeNull();

    // Another support lead (Lee Chen) approves it.
    const as = (p: string) =>
      both.evaluate(
        (x) =>
          (
            window as unknown as { __pbConsoleDemo: { switchTo: (p: string) => void } }
          ).__pbConsoleDemo.switchTo(x),
        p,
      );
    const relogin = async (p: string) => {
      await as(p);
      await click(both, 'Sign out');
      await both.waitForFunction(() => document.querySelector('h1')?.textContent === 'Support console');
      await signIn(both);
    };
    await relogin('lead');
    expect(await text(both, 'header')).toContain('Lee Chen · Support lead');
    await click(both, 'Access requests');
    await both.waitForSelector('button[aria-label^="Approve Jordan"]');
    await noAxe(both, 'access requests');
    await shot(both, 'console-requests-light');
    await click(both, 'Approve Jordan Park’s request for members');
    await waitText(both, 'Approved: Jordan Park can see members for 30 minutes.');

    await relogin('all');
    await both.evaluate(() => {
      window.location.hash = '#/orgs/org_01J9ZN0RTHW1ND000000000000';
    });
    await waitText(both, 'Members: access approved until');
    await click(both, 'Show members');
    await waitText(both, 'casey@northwind.example');
    expect(await text(both, 'table[aria-label="Members"]')).toContain('operator');
    // Activity was not approved.
    expect(await text(both, 'main')).not.toContain('Show activity log');

    // When the window ends, the information is refused again.
    await both.evaluate(() =>
      (window as unknown as { __pbConsoleDemo: { expireAccess: () => void } }).__pbConsoleDemo.expireAccess(),
    );
    await click(both, 'Show members');
    await waitText(both, 'Request access to this information first');

    await click(both, 'Audit');
    await waitText(both, 'support.viewed_members');
    const audit = await text(both, 'main');
    expect(audit).toContain('support.access_requested');
    expect(audit).toContain('support.access_approved');
    expect(audit).toContain('support.viewed_overview');
    await noAxe(both, 'audit');
    await both.close();
  });

  it('billing admins add and end overrides with a reason and an expiry; support staff cannot', async () => {
    const page = await open('admin');
    await signIn(page);
    await openOrg(page, 'ops@harbor.example', 'Harbor Studio');
    await page.select('#ovr-scope', 'limit.profiles');
    await page.type('#ovr-amount', '150');
    await page.type('#ovr-reason', 'too short');
    await click(page, 'Add override');
    // The browser refuses a reason under 20 characters before anything is sent.
    expect(await page.$eval('#ovr-reason', (el) => (el as HTMLTextAreaElement).validity.valid)).toBe(false);
    await page.type('#ovr-reason', ' — agreed extension while the customer migrates');
    await page.$eval('#ovr-days', (el) => {
      (el as HTMLInputElement).value = '';
    });
    await page.type('#ovr-days', '14');
    await click(page, 'Add override');
    await waitText(page, 'Added: Profile limit 150 until');
    await waitText(page, 'Overrides in force: Profile limit until');
    await noAxe(page, 'overrides');
    await click(page, 'End now: Profile limit override');
    await waitText(page, 'Override ended.');
    await waitText(page, 'Ended ');
    await click(page, 'Confirm with the payment provider now');
    await waitText(page, 'Queued: the worker confirms the subscription');
    await page.close();

    const support = await open('support');
    await signIn(support);
    const nav = await text(support, 'nav.tabs');
    expect(nav).toContain('Organizations');
    expect(nav).not.toContain('Alerts');
    expect(nav).not.toContain('Audit');
    await openOrg(support, 'ops@harbor.example', 'Harbor Studio');
    expect(await support.$('#ovr-scope')).toBeNull();
    expect(await text(support, 'main')).not.toContain('Confirm with the payment provider now');
    // Non-leads see their own requests and can end them, but decide nothing.
    await click(support, 'Access requests');
    await waitText(support, 'Your requests.');
    await waitText(support, 'The owner reports a member');
    expect(await support.$('button[aria-label^="Approve"]')).toBeNull();
    await click(support, 'End the request for members by you');
    await waitText(support, 'Access ended.');
    await support.close();
  });

  it('reconciliation alerts are resolved by a billing admin', async () => {
    const page = await open();
    await signIn(page);
    await click(page, 'Alerts');
    await waitText(page, 'Refund');
    expect(await text(page, 'main')).toContain('Provider event failing');
    expect(await text(page, 'main')).not.toContain('Provider events waiting');
    await noAxe(page, 'alerts');
    await shot(page, 'console-alerts-light');
    await click(page, 'Resolve Refund alert');
    await page.waitForFunction(
      () => !document.querySelector('main')?.textContent?.includes('ch_DemoRefund01'),
    );
    await page.evaluate(() =>
      (document.querySelector('main input[type=checkbox]') as HTMLInputElement).click(),
    );
    await waitText(page, 'Provider events waiting');
    await page.close();
  });

  it('dark theme, narrow window and sign-out', async () => {
    const page = await open('all', { dark: true, width: 760 });
    await shot(page, 'console-signin-dark');
    await noAxe(page, 'sign-in dark');
    await signIn(page);
    await openOrg(page, 'admin@brightline.example', 'Brightline Labs');
    expect(await text(page, 'main')).toContain('Restricted — grace period ended');
    expect(await text(page, 'main')).toContain('over the limit');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(
      true,
    );
    await noAxe(page, 'organization dark');
    await shot(page, 'console-org-dark');
    await click(page, 'Sign out');
    await page.waitForFunction(() => document.querySelector('h1')?.textContent === 'Support console');
    expect(await text(page)).toContain('You signed out.');
    await page.close();
  });
});

describe('break-glass and the verifiable audit export (milestone 12)', () => {
  const demo = (page: Page) => ({
    breakGlass: (minutes: number) =>
      page.evaluate(
        (m) =>
          (
            window as unknown as { __pbConsoleDemo: { breakGlass: (m: number) => void } }
          ).__pbConsoleDemo.breakGlass(m),
        minutes,
      ),
  });

  it('break-glass shows on the organization, opens members without approval, revokes API tokens with a reason', async () => {
    const page = await open('support');
    await signIn(page);
    await demo(page).breakGlass(30);
    await openOrg(page, 'owner@northwind.example', 'Northwind Agency');
    await waitText(page, 'Break-glass access until');
    expect(await text(page, '.break-glass')).toContain('recorded in the platform audit');
    await waitText(page, 'Members: break-glass access until');
    await click(page, 'Show members');
    await waitText(page, 'casey@northwind.example');
    const disabled = await page.$eval(
      '.break-glass button[type=submit]',
      (b) => (b as HTMLButtonElement).disabled,
    );
    expect(disabled).toBe(true);
    await page.type('#bg-reason', 'A token was posted in a public issue tracker (ticket 5120).');
    await click(page, 'Revoke all API tokens');
    await waitText(page, '3 API tokens revoked');
    await noAxe(page, 'break-glass');
    // The grant names its organizations: another one still needs the usual approval.
    await page.evaluate(() => {
      window.location.hash = '#/search';
    });
    await openOrg(page, 'ops@harbor.example', 'Harbor Studio');
    expect(await page.$('.break-glass')).toBeNull();
    // Ended on the server: the banner is gone and approval is needed again.
    await demo(page).breakGlass(0);
    await page.evaluate(() => {
      window.location.hash = '#/search';
    });
    await openOrg(page, 'owner@northwind.example', 'Northwind Agency');
    expect(await page.$('.break-glass')).toBeNull();
    await page.close();
  });

  it('support leads export a copy of the audit that verifies in the browser', async () => {
    const page = await open('lead');
    await signIn(page);
    await click(page, 'Audit');
    await page.waitForSelector('#audit-title');
    await click(page, 'Export a verifiable copy');
    await waitText(page, 'the chain verifies up to entry');
    await noAxe(page, 'audit export');
    await page.close();
  });
});
