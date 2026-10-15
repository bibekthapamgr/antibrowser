/**
 * Milestone 02-04 UI acceptance, run against the production bundle in demo mode:
 * - a keyboard-only user can create a workspace and reach profile settings
 * - no serious/critical axe violations on each screen, in light and dark
 * - usable at the 900x600 minimum window size (no horizontal page scroll) and at 2x DPI
 * - large lists are virtualized
 * - closing the manager with profiles open asks, and says profiles can keep running
 * - milestone 04: folders, keyboard selection, bulk actions with undo, "all matching" selection with its count,
 *   the trash with a typed confirmation, import preview/commit/cancel, export, secret-looking notes
 * - milestone 05: proxies (paste line, hidden login, test), assignment, the credential prompt, a failing
 *   fail-closed proxy, privacy presets with settings this OS cannot apply, bulk "Set proxy"
 * - milestone 06: account (server, sign-in in the system browser, devices), organizations (switcher, profiles,
 *   clients, members, invitations, access, activity), re-authentication before an ownership transfer, offline
 *   information marked as such, copying a local workspace after a preview
 * - milestone 07: encrypted backups of linked profiles (progress, version history, restore), conflicts with three
 *   choices that never overwrite, putting an organization profile on this computer, the organization's retention,
 *   trash and key rotation with re-authentication
 * - milestone 08: shared sessions (one person at a time): who has a profile open, asking for it, requests that never
 *   close anything, close and hand off with a note (never a password), a forced takeover with a reason and warning,
 *   a session taken over here (closed, copy kept aside, recovery copy), offline shared opens refused, and what an
 *   operator's access allows
 * - milestone 10: the job dashboard (steps, screenshots, a stop that names the profile), API tokens and webhook
 *   secrets shown once, webhook destinations that are refused, dead letters sent again, and this computer enrolled
 *   to run jobs with Playwright connections off until confirmed
 * - milestone 12: app updates (check, download with progress and stop, install only with profiles closed, channel
 *   change, a withdrawn version flagged on every screen, a manifest with a bad signature offering nothing)
 */
import { mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Browser, Page } from 'puppeteer-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { axeSerious, focused, launchBrowser, serveDist, tabTo } from './harness.ts';

const conf = JSON.parse(
  readFileSync(resolve(import.meta.dirname, '../src-tauri/tauri.conf.json'), 'utf8'),
) as {
  app: { security: { csp: string } };
};
const SHOTS = process.env.PB_SCREENSHOTS ? resolve(import.meta.dirname, '../../../docs/design') : null;

let browser: Browser;
let server: Awaited<ReturnType<typeof serveDist>>;
const cspErrors: string[] = [];

beforeAll(async () => {
  server = await serveDist(conf.app.security.csp);
  browser = await launchBrowser();
  if (SHOTS) mkdirSync(SHOTS, { recursive: true });
});
afterAll(async () => {
  await browser?.close();
  await server?.close();
});

async function open(
  demo: string,
  opts: { width?: number; height?: number; dark?: boolean; scale?: number } = {},
): Promise<Page> {
  const page = await browser.newPage();
  await page.setViewport({
    width: opts.width ?? 1280,
    height: opts.height ?? 800,
    deviceScaleFactor: opts.scale ?? 1,
  });
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: opts.dark ? 'dark' : 'light' }]);
  page.on('console', (m) => {
    if (/Content Security Policy/i.test(m.text())) cspErrors.push(m.text());
  });
  page.on('pageerror', (e) => cspErrors.push(String(e)));
  // Milestone 02-12 suites run on the earlier screens (the R3 rollback switch, `classic`); R3 suites ask for
  // `unified`, the default navigation.
  const mode = demo.includes('unified') ? demo : `${demo} classic`.trim();
  await page.goto(`${server.url}?demo=${encodeURIComponent(mode)}`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('h1');
  return page;
}

const text = (page: Page, selector: string) =>
  page.$eval(selector, (el) => (el as HTMLElement).innerText.trim());

async function goTo(page: Page, nav: string) {
  const buttons = await page.$$('nav .nav-item');
  for (const b of buttons) {
    if ((await b.evaluate((el) => el.textContent?.trim())) === nav) {
      await b.click();
      await page.waitForFunction(
        (n) => document.querySelector('h1')?.textContent?.includes(n),
        {},
        nav.split(' ')[0] ?? nav,
      );
      return;
    }
  }
  throw new Error(`no nav item ${nav}`);
}

describe('keyboard-only first run', () => {
  it('creates a workspace and a profile, then reaches profile settings without a mouse', async () => {
    const page = await open('fresh');
    expect(await focused(page)).toMatchObject({ tag: 'h1' });

    await tabTo(page, 'the create-workspace button', (f) => f.text === 'Create a local workspace');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.activeElement?.tagName === 'INPUT');
    await page.keyboard.down('Control');
    await page.keyboard.press('KeyA');
    await page.keyboard.up('Control');
    await page.keyboard.type('Agency workspace');
    await page.keyboard.press('Enter');

    await page.waitForFunction(() => document.querySelector('h1')?.textContent === 'Profiles');
    expect(await text(page, '.workspace select')).toContain('Agency workspace');

    await tabTo(page, 'the new-profile button', (f) => f.text === 'New profile');
    await page.keyboard.press('Enter');
    await page.waitForSelector('[role=dialog]');
    expect(await focused(page)).toMatchObject({ tag: 'input', inDialog: true });
    await page.keyboard.type('Shop admin');
    await page.keyboard.press('Tab');
    await page.keyboard.type('Client North');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => !document.querySelector('[role=dialog]'));

    await tabTo(page, 'the profile list', (f) => f.role === 'grid');
    await page.keyboard.press('Enter');
    await page.waitForSelector('#profile-settings-title');
    const f = await focused(page);
    expect(f.text).toBe('Profile settings');
    expect(await page.$eval('.drawer input', (el) => (el as HTMLInputElement).value)).toBe('Shop admin');

    // Escape closes the drawer and focus returns to the list.
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.drawer'));
    await page.close();
  });

  it('traps focus inside dialogs and Escape closes them', async () => {
    const page = await open('');
    await tabTo(page, 'the new-profile button', (f) => f.text === 'New profile');
    await page.keyboard.press('Enter');
    await page.waitForSelector('[role=dialog]');
    for (let i = 0; i < 8; i++) {
      await page.keyboard.press('Tab');
      expect((await focused(page)).inDialog).toBe(true);
    }
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('[role=dialog]'));
    expect((await focused(page)).text).toBe('New profile');
    await page.close();
  });

  it('offers a skip link as the first tab stop', async () => {
    const page = await open('');
    await page.keyboard.press('Tab');
    expect((await focused(page)).text).toBe('Skip to content');
    await page.close();
  });
});

/** Switches the sidebar workspace to the demo organization and, optionally, opens one of its sections. */
async function openOrg(page: Page, section?: string) {
  const handle = await page.waitForFunction(
    () =>
      [...document.querySelectorAll<HTMLOptionElement>('.workspace option')].find((o) =>
        o.value.startsWith('org:'),
      )?.value,
    { timeout: 10_000 },
  );
  await page.select('.workspace select', (await handle.jsonValue()) as string);
  await page.waitForFunction(() => document.querySelector('h1')?.textContent?.includes('Demo Agency'));
  if (section) {
    await clickButton(page, '.org-nav', section);
    await page.waitForSelector(`#org-${section.toLowerCase()}-title`);
  }
  await page.waitForFunction(
    () => !document.querySelector('main [role=status].loading, main p[role=status]'),
  );
}

/** Milestone 11: puts the demo organization in a billing state (demo-billing.ts). */
async function simulateBilling(page: Page, state: string) {
  await page.waitForFunction(() => '__pbDemo' in window);
  await page.evaluate(
    (st) =>
      (
        window as unknown as { __pbDemo: { billing: { simulate(s: string): void } } }
      ).__pbDemo.billing.simulate(st),
    state,
  );
}

const SCREENS: { name: string; demo: string; nav?: string; prepare?: (p: Page) => Promise<void> }[] = [
  {
    name: 'profile-backups',
    demo: 'signedin linked',
    prepare: async (p) => {
      await clickRow(p, 'Shop admin');
      await p.waitForFunction(() =>
        document.querySelector('.drawer')?.textContent?.includes('Organization backup: version 1'),
      );
      await p.evaluate(() => document.querySelector('#backup-legend')?.scrollIntoView({ block: 'start' }));
    },
  },
  {
    name: 'profile-backup-conflict',
    demo: 'signedin linked conflict',
    prepare: async (p) => {
      await clickRow(p, 'Shop admin');
      await clickButton(p, '.drawer', 'Upload backup now');
      await p.waitForSelector('.drawer [role=alert]', { timeout: 10_000 });
      await p.evaluate(() => document.querySelector('#backup-legend')?.scrollIntoView({ block: 'start' }));
      // For the picture, let the transient "Backing up…" notice disappear (4 s) so it does not cover the panel.
      if (SHOTS) await new Promise((r) => setTimeout(r, 4500));
    },
  },
  {
    name: 'organization-backups',
    demo: 'signedin',
    prepare: async (p) => {
      await openOrg(p, 'Backups');
      await p.waitForSelector('#org-keys-title');
    },
  },
  {
    name: 'profile-shared-in-use',
    demo: 'signedin linked inuse',
    prepare: async (p) => {
      await clickRow(p, 'Shop admin');
      await p.waitForFunction(() => document.querySelector('.drawer')?.textContent?.includes('In use:'));
      await p.evaluate(() => document.querySelector('#team-legend')?.scrollIntoView({ block: 'start' }));
    },
  },
  {
    name: 'profile-handoff-request',
    demo: 'signedin linked requests',
    prepare: async (p) => {
      await clickRow(p, 'Shop admin');
      await clickButton(p, '.drawer', 'Open profile');
      await p.waitForFunction(
        () => document.querySelector('.drawer')?.textContent?.includes('asks for this profile'),
        { timeout: 10_000 },
      );
      await p.evaluate(() => document.querySelector('#team-legend')?.scrollIntoView({ block: 'start' }));
      if (SHOTS) await new Promise((r) => setTimeout(r, 4500));
    },
  },
  {
    name: 'profile-takeover-dialog',
    demo: 'signedin linked inuse',
    prepare: async (p) => {
      await clickRow(p, 'Shop admin');
      await clickButton(p, '.drawer', 'Take over…');
      await p.waitForSelector('[role=alertdialog] textarea');
    },
  },
  {
    name: 'profile-taken-over',
    demo: 'signedin linked takeover',
    prepare: async (p) => {
      await clickRow(p, 'Shop admin');
      await clickButton(p, '.drawer', 'Open profile');
      await p.waitForFunction(
        () => document.querySelector('.drawer')?.textContent?.includes('recovery copy'),
        { timeout: 10_000 },
      );
      await p.evaluate(() => document.querySelector('#team-legend')?.scrollIntoView({ block: 'start' }));
      if (SHOTS) await new Promise((r) => setTimeout(r, 4500));
    },
  },
  { name: 'org-profiles-in-use', demo: 'signedin inuse', prepare: (p) => openOrg(p) },
  // R3: the default navigation.
  {
    name: 'r3-profiles',
    demo: 'unified signedin linked',
    prepare: async (p) => {
      await p.waitForSelector('table.workspace-profiles');
    },
  },
  {
    name: 'r3-this-computer',
    demo: 'unified',
    prepare: async (p) => {
      await p.waitForSelector('[aria-label="About this view"]');
    },
  },
  {
    name: 'r3-member-profiles',
    demo: 'unified member fifty',
    prepare: async (p) => {
      await waitWorkspaceRows(p);
    },
  },
  {
    name: 'r3-create-profile',
    demo: 'unified signedin',
    prepare: async (p) => {
      await waitWorkspaceRows(p);
      await clickButton(p, '#main', 'New profile');
      await p.waitForSelector('[role=dialog] form');
    },
  },
  {
    name: 'r3-team',
    demo: 'unified signedin',
    nav: 'Team',
    prepare: async (p) => {
      await p.waitForSelector('#org-members-title');
    },
  },
  {
    name: 'r3-invite-wizard',
    demo: 'unified signedin fifty',
    nav: 'Team',
    prepare: async (p) => {
      await openInviteWizard(p);
      await p.waitForSelector('[role=dialog] input[type=email]');
      await p.type('[role=dialog] input[type=email]', 'mate@example.test');
      await clickButton(p, '[role=dialog]', 'Next');
      await clickButton(p, '[role=dialog]', 'Next');
      await p.waitForSelector('[role=dialog] .pick-list');
    },
  },
  { name: 'r3-subscription', demo: 'unified signedin', nav: 'Subscription' },
  { name: 'r3-settings', demo: 'unified signedin', nav: 'Settings' },
  { name: 'welcome', demo: 'fresh' },
  { name: 'profiles-empty', demo: 'rows:0' },
  { name: 'profiles', demo: '' },
  {
    name: 'profile-settings',
    demo: '',
    prepare: async (p) => {
      await p.click('.trow');
      await p.waitForSelector('.drawer');
    },
  },
  { name: 'settings', demo: '', nav: 'Settings' },
  { name: 'downloads', demo: '', nav: 'Downloads and updates' },
  {
    name: 'diagnostics',
    demo: '',
    nav: 'Health',
    prepare: async (p) => {
      await clickButton(p, '.org-nav', 'Diagnostics');
      await p.waitForSelector('#diag-title');
    },
  },
  { name: 'crash-recovery', demo: 'crash' },
  { name: 'database-recovery', demo: 'migration' },
  {
    name: 'profile-crashed-recovery',
    demo: 'crashed',
    prepare: async (p) => {
      await clickRow(p, 'Shop admin');
      await p.waitForSelector('.drawer fieldset legend');
    },
  },
  {
    name: 'profile-not-responding',
    demo: 'stuck',
    prepare: async (p) => {
      await clickRow(p, 'Shop admin');
      await clickButton(p, '.drawer', 'Close profile');
      await p.waitForFunction(() => document.querySelector('.drawer')?.textContent?.includes('Force close'));
    },
  },
  { name: 'downloads-install-browser', demo: 'noruntime', nav: 'Downloads and updates' },
  {
    name: 'profiles-selection',
    demo: '',
    prepare: async (p) => {
      await p.focus('[role=grid]');
      await p.keyboard.press('Space');
      await p.keyboard.press('ArrowDown');
      await p.keyboard.press('Space');
      await p.waitForSelector('.bulk-bar');
    },
  },
  { name: 'profiles-trash', demo: '', prepare: (p) => clickFolder(p, 'Trash') },
  {
    name: 'import-preview',
    demo: '',
    prepare: async (p) => {
      await clickButton(p, '.toolbar', 'Import…');
      await clickButton(p, '[role=dialog]', 'Choose file…');
      await p.waitForSelector('.summary');
    },
  },
  {
    name: 'import-unsafe-file',
    demo: 'unsafeimport',
    prepare: async (p) => {
      await clickButton(p, '.toolbar', 'Import…');
      await clickButton(p, '[role=dialog]', 'Choose file…');
      await p.waitForSelector('.notice--error');
    },
  },
  {
    name: 'export-dialog',
    demo: '',
    prepare: async (p) => {
      await p.click('.table__head input[type=checkbox]');
      await clickButton(p, '.bulk-bar', 'Export…');
      await p.waitForSelector('[role=dialog]');
    },
  },
  {
    name: 'delete-confirmation',
    demo: '',
    prepare: async (p) => {
      await clickFolder(p, 'Trash');
      await clickButton(p, '.filters', 'Empty trash…');
      await p.waitForSelector('[role=alertdialog]');
    },
  },
  // Milestone 09: health, resources, extensions, palette, notifications, dashboards and confirmations.
  { name: 'health', demo: 'signedin', nav: 'Health', prepare: (p) => healthReady(p) },
  {
    name: 'health-resources',
    demo: 'running',
    nav: 'Health',
    prepare: async (p) => {
      await clickButton(p, '.org-nav', 'Resources');
      await p.waitForSelector('table.records');
    },
  },
  {
    name: 'health-extensions',
    demo: 'extupdate',
    nav: 'Health',
    prepare: async (p) => {
      await clickButton(p, '.org-nav', 'Extensions');
      await p.waitForFunction(() =>
        document.querySelector('main')?.textContent?.includes('Mark as reviewed'),
      );
    },
  },
  {
    name: 'diagnostics-preview',
    demo: '',
    nav: 'Health',
    prepare: async (p) => {
      await clickButton(p, '.org-nav', 'Diagnostics');
      await clickButton(p, 'main', 'Preview and save report…');
      await p.waitForSelector('[role=dialog] textarea');
    },
  },
  {
    name: 'command-palette',
    demo: '',
    prepare: async (p) => {
      await p.keyboard.down('Control');
      await p.keyboard.press('k');
      await p.keyboard.up('Control');
      await p.waitForSelector('[role=combobox]');
      await p.keyboard.type('shop');
      await p.waitForFunction(() =>
        document.querySelector('[role=listbox]')?.textContent?.includes('Open Shop admin'),
      );
    },
  },
  {
    name: 'notifications',
    demo: 'extupdate',
    prepare: async (p) => {
      await p.waitForFunction(() => document.querySelector('.notices-button')?.textContent?.includes('(1)'));
      await p.click('.notices-button');
      await p.waitForSelector('.notice-list');
    },
  },
  {
    name: 'client-overview',
    demo: '',
    prepare: async (p) => {
      await clickFolder(p, 'Client North');
      await clickButton(p, '.toolbar', 'Client overview');
      await p.waitForSelector('#co-dl');
    },
  },
  {
    name: 'bulk-confirmation',
    demo: '',
    prepare: async (p) => {
      await p.focus('[role=grid]');
      await p.keyboard.press('Space');
      await p.keyboard.press('ArrowDown');
      await p.keyboard.press('Space');
      await clickButton(p, '.bulk-bar', 'Move 2 to trash');
      await p.waitForFunction(() =>
        document.querySelector('[role=alertdialog]')?.textContent?.includes('Client'),
      );
    },
  },
  {
    name: 'launch-memory-check',
    demo: 'lowmem',
    prepare: async (p) => {
      await clickRow(p, 'Shop admin');
      await clickButton(p, '.drawer', 'Open profile');
      await p.waitForFunction(() =>
        document.querySelector('[role=alertdialog]')?.textContent?.includes('Memory may run short'),
      );
    },
  },
  { name: 'org-client-dashboard', demo: 'signedin', prepare: (p) => openDashboard(p) },
  { name: 'org-extensions', demo: 'signedin', prepare: (p) => openOrg(p, 'Extensions') },
  // Milestone 10: automation.
  {
    name: 'org-automation-jobs',
    demo: 'signedin',
    prepare: async (p) => {
      await openOrg(p, 'Automation');
      await clickInRow(p, 'Morning login check', 'Steps');
      await p.waitForFunction(() => document.querySelector('.job-steps')?.textContent?.includes('Done'));
      await clickButton(p, '.job-steps', 'Show screenshot “login”');
      await p.waitForSelector('img.job-shot');
      await p.$eval('.job-steps', (el) => el.scrollIntoView());
    },
  },
  {
    name: 'org-automation-token',
    demo: 'signedin',
    prepare: async (p) => {
      await openOrg(p, 'Automation');
      await clickButton(p, 'main nav[aria-label="Automation sections"]', 'API tokens');
      await clickButton(p, 'main', 'New token…');
      await p.waitForSelector('[role=dialog] form');
    },
  },
  {
    name: 'org-automation-webhooks',
    demo: 'signedin',
    prepare: async (p) => {
      await openOrg(p, 'Automation');
      await clickButton(p, 'main nav[aria-label="Automation sections"]', 'Webhooks');
      await clickInRow(p, 'hooks.example.com', 'Deliveries');
      await p.waitForSelector('main ul.deliveries');
    },
  },
  // Milestone 11: billing.
  {
    name: 'org-billing-trial',
    demo: 'signedin',
    prepare: async (p) => {
      await openOrg(p, 'Billing');
      await p.waitForSelector('.plan-list');
    },
  },
  {
    name: 'org-billing-restricted',
    demo: 'signedin',
    prepare: async (p) => {
      await simulateBilling(p, 'restricted');
      await openOrg(p, 'Billing');
      await p.waitForSelector('.billing-banner');
    },
  },
  {
    name: 'settings-automation',
    demo: 'signedin',
    nav: 'Settings',
    prepare: async (p) => {
      await p.waitForFunction(() => document.querySelector('main')?.textContent?.includes('Run jobs here'));
      await p.$eval('.automation-here', (el) => el.scrollIntoView());
    },
  },
  { name: 'proxies', demo: '', nav: 'Proxies' },
  {
    name: 'proxy-add',
    demo: '',
    nav: 'Proxies',
    prepare: async (p) => {
      await clickButton(p, '.toolbar', 'Add proxy');
      await p.waitForSelector('[role=dialog] form');
    },
  },
  {
    name: 'profile-network-privacy',
    demo: 'win',
    prepare: async (p) => {
      await clickRow(p, 'Shop admin');
      await p.waitForSelector('form[aria-label=Network] select option:nth-child(2)');
      await p.$eval('form[aria-label=Network]', (el) => el.scrollIntoView());
    },
  },
  {
    name: 'proxy-login-prompt',
    demo: 'nologin',
    prepare: async (p) => {
      await clickRow(p, 'Shop admin');
      await clickButton(p, '.drawer', 'Open profile');
      await p.waitForSelector('[role=dialog] input[type=password]');
    },
  },
  {
    name: 'proxy-failing',
    demo: 'proxydown',
    prepare: async (p) => {
      await clickRow(p, 'Shop admin');
      await clickButton(p, '.drawer', 'Open profile');
      await p.waitForFunction(() =>
        document.querySelector('.drawer')?.textContent?.includes('Traffic is blocked'),
      );
    },
  },
  {
    name: 'quit-with-running-profiles',
    demo: 'running',
    prepare: async (p) => {
      await p.evaluate(() =>
        (window as unknown as { __pbDemo: { simulateQuitRequest(): void } }).__pbDemo.simulateQuitRequest(),
      );
      await p.waitForSelector('[role=alertdialog],[role=dialog]');
    },
  },
  { name: 'account-signed-out', demo: '', nav: 'Account' },
  { name: 'account', demo: 'signedin', nav: 'Account' },
  { name: 'org-profiles', demo: 'signedin', prepare: (p) => openOrg(p) },
  { name: 'org-clients', demo: 'signedin', prepare: (p) => openOrg(p, 'Clients') },
  { name: 'org-members', demo: 'signedin', prepare: (p) => openOrg(p, 'Members') },
  {
    name: 'org-invitations',
    demo: 'signedin',
    prepare: async (p) => {
      await openOrg(p, 'Invitations');
      await p.type('form[aria-label="Invite someone"] input[type=email]', 'new.person@example.test');
      await clickButton(p, 'form[aria-label="Invite someone"]', 'Create invitation');
      await p.waitForFunction(() =>
        document.querySelector('.notice')?.textContent?.includes('shown only now'),
      );
    },
  },
  { name: 'org-access', demo: 'signedin', prepare: (p) => openOrg(p, 'Access') },
  { name: 'org-activity', demo: 'signedin', prepare: (p) => openOrg(p, 'Activity') },
  { name: 'org-operator', demo: 'member', prepare: (p) => openOrg(p) },
  {
    name: 'org-copy-preview',
    demo: 'signedin',
    prepare: async (p) => {
      await openOrg(p, 'Settings');
      await clickButton(p, '#main', 'Copy profiles from this computer…');
      await clickButton(p, '[role=dialog]', 'Preview');
      await p.waitForFunction(() =>
        document.querySelector('[role=dialog]')?.textContent?.includes('will be added'),
      );
    },
  },
];

/** Waits until the health cards are shown (and the first server check finished). */
async function healthReady(page: Page) {
  await page.waitForSelector('.health-grid');
  await page.waitForFunction(() => !document.querySelector('.health-card button[disabled]'));
}

/** Organization → Clients → the dashboard of Client North. */
async function openDashboard(page: Page) {
  await openOrg(page, 'Clients');
  await clickButton(page, 'main', 'Dashboard of Client North');
  await page.waitForSelector('#cd-title');
  await page.waitForFunction(() => !document.querySelector('main p[role=status]'));
}

async function clickRow(page: Page, name: string) {
  const rows = await page.$$('.trow');
  for (const r of rows) {
    if ((await r.$eval('.trow__name', (el) => el.textContent?.trim())) === name) {
      await r.click();
      await page.waitForSelector('.drawer');
      return;
    }
  }
  throw new Error(`no row ${name}`);
}

async function clickFolder(page: Page, label: string) {
  const folders = await page.$$('.folder');
  for (const f of folders) {
    if ((await f.$eval('.folder__label', (el) => el.textContent?.trim())) === label) {
      await f.click();
      await page.waitForFunction(
        (l) => document.querySelector('.toolbar__title p')?.textContent?.startsWith(l),
        {},
        label,
      );
      // The table shows the new folder once its first page arrives.
      await page.waitForFunction(() => !document.querySelector('[role=row][aria-busy=true]'));
      return;
    }
  }
  throw new Error(`no folder ${label}`);
}

const rowCount = (page: Page, n: number) =>
  page.waitForFunction(
    (count) => document.querySelector('[role=grid]')?.getAttribute('aria-rowcount') === String(count),
    {},
    n,
  );

const toastContains = (page: Page, needle: string) =>
  page.waitForFunction(
    (t) => [...document.querySelectorAll('.toast')].some((x) => x.textContent?.includes(t)),
    {},
    needle,
  );

async function clickButton(page: Page, scope: string, label: string) {
  // Waits for the button to exist and be enabled (dialogs and previews render asynchronously).
  const handle = await page.waitForFunction(
    (sc, l) =>
      [...document.querySelectorAll<HTMLButtonElement>(`${sc} button`)].find(
        (b) => b.textContent?.trim() === l && !b.disabled,
      ),
    { timeout: 10_000 },
    scope,
    label,
  );
  const el = handle.asElement();
  if (!el) throw new Error(`no button ${label} in ${scope}`);
  await (el as unknown as { click(): Promise<void> }).click();
}

/** Clicks a button in the table row that mentions `rowText`. */
async function clickInRow(page: Page, rowText: string, label: string) {
  const handle = await page.waitForFunction(
    (t, l) => {
      const row = [...document.querySelectorAll('main table tbody tr')].find((r) =>
        r.querySelector('th')?.textContent?.includes(t),
      );
      return [...(row?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find(
        (b) => b.textContent?.trim() === l && !b.disabled,
      );
    },
    { timeout: 10_000 },
    rowText,
    label,
  );
  const el = handle.asElement();
  if (!el) throw new Error(`no button ${label} in the row of ${rowText}`);
  await (el as unknown as { click(): Promise<void> }).click();
}

describe.each([
  ['light', false],
  ['dark', true],
] as const)('every screen in %s mode', (mode, dark) => {
  it.each(SCREENS)('$name has no serious accessibility violations and fits 900x600', async (s) => {
    const page = await open(s.demo, { dark, width: 900, height: 600 });
    if (s.nav) await goTo(page, s.nav);
    await s.prepare?.(page);
    const violations = await axeSerious(page);
    expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    if (SHOTS) {
      await page.setViewport({ width: 1180, height: 760, deviceScaleFactor: 1 });
      await new Promise((r) => setTimeout(r, 150));
      await page.screenshot({ path: `${SHOTS}/${s.name}-${mode}.png` });
    }
    await page.close();
  });
});

describe('scale', () => {
  it('virtualizes 10,000 profiles and keyboard End reaches the last one', async () => {
    const page = await open('rows:10000');
    await page.waitForSelector('[role=grid]');
    const rendered = await page.$$eval('[role=row]', (r) => r.length);
    expect(rendered).toBeLessThan(100);
    expect(await page.$eval('[role=grid]', (g) => g.getAttribute('aria-rowcount'))).toBe('10000');
    await page.focus('[role=grid]');
    await page.keyboard.press('End');
    await page.waitForFunction(() => {
      const id = document.querySelector('[role=grid]')?.getAttribute('aria-activedescendant');
      return id ? document.getElementById(id)?.getAttribute('aria-rowindex') === '10000' : false;
    });
    await page.close();
  });

  it('debounces search over 10,000 profiles', async () => {
    const page = await open('rows:10000');
    await page.waitForSelector('[role=grid]');
    await page.type('input[type=search]', 'Profile 09999');
    await page.waitForFunction(
      () => document.querySelector('[role=grid]')?.getAttribute('aria-rowcount') === '1',
    );
    await page.close();
  });

  it('renders crisply at 2x device scale', async () => {
    const page = await open('', { scale: 2, width: 900, height: 600 });
    expect(await page.evaluate(() => window.devicePixelRatio)).toBe(2);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    await page.close();
  });
});

describe('quit flow', () => {
  it('explains that open profiles can keep running and offers cancel / leave running / close all', async () => {
    const page = await open('running');
    expect(await text(page, '.sidebar__status')).toContain('1 profile open');
    await page.evaluate(() =>
      (window as unknown as { __pbDemo: { simulateQuitRequest(): void } }).__pbDemo.simulateQuitRequest(),
    );
    const dialog = await page.waitForSelector('[role=alertdialog],[role=dialog]');
    const body = (await dialog?.evaluate((d) => (d as HTMLElement).innerText)) ?? '';
    expect(body).toMatch(/1 profile/);
    const buttons = await dialog?.$$eval('button', (b) => b.map((x) => x.textContent?.trim()));
    expect(buttons?.length).toBeGreaterThanOrEqual(3);
    await page.keyboard.press('Escape');
    await page.close();
  });
});

describe('profile lifecycle (milestone 03)', () => {
  it('opens and closes a profile, showing each state', async () => {
    const page = await open('');
    await clickRow(page, 'Ads QA');
    await clickButton(page, '.drawer', 'Open profile');
    await page.waitForFunction(() => document.querySelector('.drawer dd')?.textContent?.includes('Open'));
    await clickButton(page, '.drawer', 'Close profile');
    await page.waitForFunction(() => document.querySelector('.drawer dd')?.textContent?.includes('Closed'));
    await page.close();
  });

  it('offers a force close only after the browser did not respond', async () => {
    const page = await open('stuck');
    await clickRow(page, 'Shop admin');
    await clickButton(page, '.drawer', 'Close profile');
    await page.waitForFunction(() =>
      document.querySelector('.drawer')?.textContent?.includes('Not responding'),
    );
    await clickButton(page, '.drawer', 'Force close');
    await page.waitForFunction(() => document.querySelector('.drawer dd')?.textContent?.includes('Closed'));
    await page.close();
  });

  it('restores a crashed profile from its last good copy', async () => {
    const page = await open('crashed');
    await clickRow(page, 'Shop admin');
    expect(await text(page, '.drawer')).toMatch(/closed unexpectedly/i);
    await clickButton(page, '.drawer', 'Restore last good copy');
    await page.waitForFunction(() => document.querySelector('.drawer dd')?.textContent?.trim() === 'Closed');
    await page.close();
  });

  it('milestone 12: a profile migrated by a withdrawn browser rolls back to the copy made before the update', async () => {
    const page = await open('rollback');
    await clickRow(page, 'Shop admin');
    await page.waitForSelector('.drawer .notice[role=alert]');
    expect(await text(page, '.drawer .notice[role=alert]')).toContain('newer browser version');
    await clickButton(page, '.drawer', 'Restore the copy from before the browser update');
    await toastContains(page, 'Restoring the copy from before the browser update');
    await page.waitForFunction(() => !document.querySelector('.drawer .notice[role=alert]'), {
      timeout: 10_000,
    });
    const violations = await axeSerious(page);
    expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
    await page.close();
  });

  it('installs the approved browser with progress, then profiles can open', async () => {
    const page = await open('noruntime');
    await goTo(page, 'Downloads and updates');
    const install = await page.waitForSelector('button[data-variant=primary]');
    expect(await install?.evaluate((b) => b.textContent)).toMatch(/Install browser \d+/);
    await install?.click();
    await page.waitForFunction(() => document.querySelector('.card')?.textContent?.includes('Ready'), {
      timeout: 10_000,
    });
    await page.close();
  });

  it('quit prompt offers a force close when profiles did not respond', async () => {
    const page = await open('running');
    await page.evaluate(() =>
      (
        window as unknown as { __pbDemo: { simulateQuitRequest(n: number): void } }
      ).__pbDemo.simulateQuitRequest(1),
    );
    const dialog = await page.waitForSelector('[role=alertdialog]');
    const labels = await dialog?.$$eval('button', (b) => b.map((x) => x.textContent?.trim()));
    expect(labels).toContain('Force close and quit');
    await page.keyboard.press('Escape');
    await page.close();
  });
});

describe('content security policy', () => {
  it('the bundle runs under the shell CSP without violations', () => {
    expect(cspErrors).toEqual([]);
  });
});

describe('profile management (milestone 04)', () => {
  it('selects rows with the keyboard, archives them in bulk and undoes', async () => {
    const page = await open('');
    await page.waitForSelector('[role=grid]');
    await page.focus('[role=grid]');
    await page.keyboard.press('Space');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Space');
    await page.waitForSelector('.bulk-bar');
    expect(await text(page, '.bulk-bar__count')).toMatch(/^2 selected of 3/);
    await clickButton(page, '.bulk-bar', 'Archive 2');
    // The confirmation names the clients and profiles (milestone 09).
    await page.waitForFunction(() =>
      document.querySelector('[role=alertdialog]')?.textContent?.includes('Client North'),
    );
    await clickButton(page, '[role=alertdialog]', 'Archive');
    await page.waitForSelector('.undo-bar');
    expect(await text(page, '.undo-bar')).toContain('Archived 2 profiles.');
    await rowCount(page, 1);
    expect(await page.$('.bulk-bar')).toBeNull();
    await clickButton(page, '.undo-bar', 'Undo');
    await rowCount(page, 3);
    await page.close();
  });

  it('selects all matching profiles across pages and shows that count on the action', async () => {
    const page = await open('rows:10000');
    await page.waitForSelector('[role=grid]');
    await page.click('.table__head input[type=checkbox]');
    expect(await text(page, '.bulk-bar__count')).toMatch(/^200 selected of 10,000/);
    await clickButton(page, '.bulk-bar', 'Select all 10,000 matching');
    expect(await text(page, '.bulk-bar__count')).toContain('All 10,000 matching profiles selected');
    await clickButton(page, '.bulk-bar', 'Add tag…');
    const dialog = await page.waitForSelector('[role=dialog]');
    expect(await dialog?.$eval('h2', (h) => h.textContent)).toBe('Add a tag to 10,000 selected profiles');
    await page.keyboard.type('Batch 1');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.undo-bar');
    expect(await text(page, '.undo-bar')).toContain('Tagged 10,000 profiles');
    await page.close();
  });

  it('filters by client folder, tag and accent-insensitive search', async () => {
    const page = await open('');
    await clickFolder(page, 'Client North');
    await rowCount(page, 1);
    await clickFolder(page, 'All profiles');
    await rowCount(page, 3);
    await page.type('input[type=search]', 'ÃDS');
    await rowCount(page, 1);
    expect(await text(page, '.trow__name')).toBe('Ads QA');
    await page.close();
  });

  it('moves a profile to the trash and deletes permanently only after typing DELETE', async () => {
    const page = await open('');
    await clickRow(page, 'Support desk');
    await clickButton(page, '.drawer', 'Move to trash');
    await page.waitForSelector('.undo-bar');
    await page.waitForFunction(() =>
      document.querySelector('.drawer')?.textContent?.includes('In the trash'),
    );
    await page.click('.drawer [aria-label="Close profile settings"]');
    await clickFolder(page, 'Trash');
    await rowCount(page, 2);
    await clickButton(page, '.filters', 'Empty trash…');
    const dialog = await page.waitForSelector('[role=alertdialog]');
    expect(await dialog?.$eval('h2', (h) => h.textContent)).toBe('Delete 2 profiles permanently?');
    const disabled = await page.$$eval('[role=alertdialog] button', (b) =>
      b.filter((x) => x.textContent === 'Delete 2 profiles').map((x) => (x as HTMLButtonElement).disabled),
    );
    expect(disabled).toEqual([true]);
    await page.keyboard.type('DELETE');
    await clickButton(page, '[role=alertdialog]', 'Delete 2 profiles');
    await page.waitForFunction(() =>
      document.querySelector('.empty')?.textContent?.includes('Nothing in Trash'),
    );
    await toastContains(page, 'Deleted 2 profiles permanently.');
    await page.close();
  });

  it('previews an import with row errors, imports the valid rows and updates the table without a reload', async () => {
    const page = await open('');
    await clickButton(page, '.toolbar', 'Import…');
    await clickButton(page, '[role=dialog]', 'Choose file…');
    await page.waitForSelector('.summary');
    const summary = await text(page, '.summary');
    expect(summary).toMatch(/New profiles\s*5/);
    expect(summary).toMatch(/Skipped duplicates\s*2/);
    expect(summary).toMatch(/Rows with errors\s*3/);
    const errors = await page.$$eval('[role=dialog] details[open] tbody tr', (rows) =>
      rows.map((r) => r.firstElementChild?.textContent),
    );
    expect(errors).toEqual(['5', '6', '10']);
    await clickButton(page, '[role=dialog]', 'Import 5 profiles');
    await page.waitForFunction(() =>
      document.querySelector('[role=dialog]')?.textContent?.includes('Completed with errors'),
    );
    await clickButton(page, '[role=dialog]', 'Done');
    await page.waitForFunction(() =>
      [...document.querySelectorAll('.trow__name')].some((n) => n.textContent === 'Café orders'),
    );
    await page.close();
  });

  it('cancels a 10,000-row import and offers to continue it', async () => {
    const page = await open('bigimport');
    await clickButton(page, '.toolbar', 'Import…');
    await clickButton(page, '[role=dialog]', 'Choose file…');
    await page.waitForSelector('.summary');
    await clickButton(page, '[role=dialog]', 'Import 9,999 profiles');
    await page.waitForSelector('[role=dialog] progress');
    await clickButton(page, '[role=dialog]', 'Cancel import');
    await page.waitForFunction(() =>
      document.querySelector('[role=dialog]')?.textContent?.includes('Cancelled.'),
    );
    await clickButton(page, '[role=dialog]', 'Continue import');
    await page.waitForFunction(
      () => document.querySelector('[role=dialog]')?.textContent?.includes('Completed with errors'),
      { timeout: 15_000 },
    );
    expect(await text(page, '[role=dialog]')).toContain('9,999 profiles imported or updated');
    await page.close();
  });

  it('names the client when a profile opens', async () => {
    const page = await open('');
    await clickRow(page, 'Shop admin');
    await clickButton(page, '.drawer', 'Open profile');
    await toastContains(page, 'Opening Shop admin (Client North)');
    await page.close();
  });

  it('warns about secrets in notes and does not save them', async () => {
    const page = await open('');
    await clickRow(page, 'Ads QA');
    await page.type('.drawer textarea[aria-describedby]', 'Password: hunter2');
    await page.waitForFunction(() => document.querySelector('.drawer textarea[aria-invalid=true]'));
    await clickButton(page, '.drawer', 'Save changes');
    await page.waitForFunction(() =>
      document.querySelector('.drawer [role=alert]')?.textContent?.includes('password manager'),
    );
    await page.close();
  });
});

describe('proxies and privacy (milestone 05)', () => {
  const secret = ['pw', 'Zq7', 'Lm'].join('-');

  async function rowButton(page: Page, rowName: string, label: string) {
    const handle = await page.waitForFunction(
      (n, l) => {
        const row = [...document.querySelectorAll('.proxy-table tbody tr')].find(
          (r) => r.querySelector('th')?.textContent?.trim() === n,
        );
        return [...(row?.querySelectorAll('button') ?? [])].find(
          (b) => b.firstChild?.textContent?.trim() === l && !(b as HTMLButtonElement).disabled,
        );
      },
      { timeout: 10_000 },
      rowName,
      label,
    );
    await (handle.asElement() as unknown as { click(): Promise<void> }).click();
  }

  it('adds a proxy from a pasted line, never shows the login again, and tests it', async () => {
    const page = await open('');
    await goTo(page, 'Proxies');
    await clickButton(page, '.toolbar', 'Add proxy');
    await page.waitForSelector('[role=dialog] form');
    await page.type(
      '[role=dialog] input[placeholder^="host:port"]',
      `gate.example.net:3128:agency-17:${secret}`,
    );
    await clickButton(page, '[role=dialog]', 'Fill in');
    await page.waitForFunction(() =>
      [...document.querySelectorAll<HTMLInputElement>('[role=dialog] input')].some(
        (i) => i.value === 'gate.example.net',
      ),
    );
    await page.type('[role=dialog] input[required][maxlength="80"]', 'Gate');
    await clickButton(page, '[role=dialog]', 'Add proxy');
    await toastContains(page, 'Proxy “Gate” added.');
    const html = await page.content();
    expect(html).not.toContain(secret);
    expect(await text(page, '.proxy-table')).toContain('gate.example.net:3128');
    await rowButton(page, 'Gate', 'Test');
    await toastContains(page, 'Gate works');
    await page.close();
  });

  it('assigns a proxy in profile settings and shows it in the table', async () => {
    const page = await open('');
    await clickRow(page, 'Ads QA');
    await page.waitForSelector('form[aria-label=Network] select option:nth-child(2)');
    const value = await page.$eval(
      'form[aria-label=Network] select option:nth-child(2)',
      (o) => (o as HTMLOptionElement).value,
    );
    await page.select('form[aria-label=Network] select', value);
    await clickButton(page, 'form[aria-label=Network]', 'Save network settings');
    await toastContains(page, 'Network settings saved.');
    await page.waitForFunction(() =>
      [...document.querySelectorAll('.trow')].some(
        (r) =>
          r.querySelector('.trow__name')?.textContent?.trim() === 'Ads QA' &&
          r.querySelector('.col-proxy')?.textContent?.includes('Residential DE'),
      ),
    );
    await page.close();
  });

  it('asks for a missing proxy login when opening, then opens the profile', async () => {
    const page = await open('nologin');
    await clickRow(page, 'Shop admin');
    await clickButton(page, '.drawer', 'Open profile');
    await page.waitForSelector('[role=dialog] input[type=password]');
    expect(await text(page, '[role=dialog] h2')).toContain('Enter the login');
    await page.type('[role=dialog] input[autocomplete=off]', 'agency-de');
    await page.type('[role=dialog] input[type=password]', secret);
    await clickButton(page, '[role=dialog]', 'Save login');
    await toastContains(page, 'Opening Shop admin');
    await page.close();
  });

  it('shows that a fail-closed proxy blocks traffic when it stops working', async () => {
    const page = await open('proxydown');
    await clickRow(page, 'Shop admin');
    await clickButton(page, '.drawer', 'Open profile');
    await toastContains(page, 'stopped working');
    await page.waitForFunction(() =>
      document.querySelector('.drawer')?.textContent?.includes('Traffic is blocked'),
    );
    await page.close();
  });

  it('applies a preset and says which settings this computer cannot apply', async () => {
    const page = await open('win');
    await clickRow(page, 'Ads QA');
    const form = 'form[aria-label="Privacy and environment"]';
    await page.waitForSelector(`${form} select option[value="locale-ne-np"]`);
    await page.select(`${form} select`, 'locale-ne-np');
    await page.waitForFunction(
      (f) => document.querySelector(f)?.textContent?.includes('Not available on this computer'),
      {},
      form,
    );
    await clickButton(page, form, 'Save privacy settings');
    await toastContains(page, 'Privacy and environment settings saved.');
    await page.close();
  });

  it('sets the proxy of selected profiles in bulk', async () => {
    const page = await open('');
    await page.focus('[role=grid]');
    await page.keyboard.press('Space');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Space');
    await clickButton(page, '.bulk-bar', 'Set proxy…');
    await page.waitForSelector('[role=dialog] select');
    await clickButton(page, '[role=dialog]', 'Set proxy');
    await page.waitForFunction(() =>
      document.querySelector('[role=alertdialog]')?.textContent?.includes('2 profiles'),
    );
    await clickButton(page, '[role=alertdialog]', 'Set a different proxy');
    // Shop admin already uses the first proxy, so one profile changes and one already matched.
    await toastContains(page, 'Set the proxy of 1 profile.');
    await toastContains(page, '1 profile already matched.');
    await page.close();
  });
});

describe('account and organizations (milestone 06)', () => {
  it('signs in through the browser and switches to an organization', async () => {
    const page = await open('');
    await goTo(page, 'Account');
    const signIn = await page.$$eval('button', (bs) =>
      bs
        .filter((b) => ['Sign in', 'Create account'].includes(b.textContent?.trim() ?? ''))
        .map((b) => (b as HTMLButtonElement).disabled),
    );
    expect(signIn).toEqual([true, true]); // no server yet
    await page.type('input[type=url]', 'http://browser.example.test');
    await clickButton(page, 'form[aria-labelledby=server-title]', 'Save');
    await toastContains(page, 'https://');
    await page.$eval('input[type=url]', (i) => {
      (i as HTMLInputElement).select();
    });
    await page.type('input[type=url]', 'https://browser.example.test');
    await clickButton(page, 'form[aria-labelledby=server-title]', 'Save');
    await toastContains(page, 'Server saved.');
    // With a server saved (or built in), only Sign in / Create account are in view; the address folds away.
    await page.waitForSelector('details.server-details:not([open]) form[aria-labelledby=server-title]');
    expect(await text(page, 'details.server-details summary')).toContain('https://browser.example.test');
    await clickButton(page, '#main', 'Sign in');
    // R2: onboarding completes by itself (a returning person: their workspace is selected) and Profiles opens.
    await toastContains(page, 'Signed in. Demo Agency opens first.');
    await page.waitForFunction(() => document.querySelector('h1')?.textContent?.includes('Profiles'));
    await goTo(page, 'Account');
    await page.waitForFunction(() => document.body.textContent?.includes('Signed in as Demo Person'));
    expect(await text(page, '#devices-title')).toBe('Your devices');
    await openOrg(page);
    expect(await text(page, '#main')).toContain('North shop admin');
    expect(await text(page, '.sidebar__note')).toContain('signed in as Demo Person');
    await page.close();
  });

  it('R2: "Create account" asks for the terms once, creates one workspace with a trial and opens Profiles', async () => {
    const page = await open('');
    await goTo(page, 'Account');
    await page.type('input[type=url]', 'https://browser.example.test');
    await clickButton(page, 'form[aria-labelledby=server-title]', 'Save');
    await toastContains(page, 'Server saved.');
    await clickButton(page, '#main', 'Create account');
    await page.waitForFunction(() =>
      document.querySelector('[role=dialog]')?.textContent?.includes('Set up your workspace'),
    );
    expect(await text(page, '[role=dialog]')).toContain('free trial');
    // Nothing is created before the terms are accepted.
    const create = await page.$$eval('[role=dialog] button', (bs) =>
      bs
        .filter((b) => b.textContent?.trim() === 'Create workspace')
        .map((b) => (b as HTMLButtonElement).disabled),
    );
    expect(create).toEqual([true]);
    await page.type('[role=dialog] input[maxlength="120"]', 'Bibek Studio');
    await page.click('[role=dialog] label.check input');
    await clickButton(page, '[role=dialog]', 'Create workspace');
    await toastContains(page, 'Welcome! Bibek Studio is ready.');
    await page.waitForFunction(() => document.querySelector('h1')?.textContent?.includes('Profiles'));
    expect(await page.$('[role=dialog]')).toBeNull();
    // Signing in again later lands in the same workspace without asking anything.
    await goTo(page, 'Account');
    await clickButton(page, '#main', 'Sign out');
    await clickButton(page, '#main', 'Sign in');
    await toastContains(page, 'Signed in. Bibek Studio opens first.');
    expect(await page.$('[role=dialog]')).toBeNull();
    await page.close();
  });

  it('creates an invitation code shown once and explains a code for another address', async () => {
    const page = await open('signedin');
    await openOrg(page, 'Invitations');
    await page.type('form[aria-label="Invite someone"] input[type=email]', 'someone.else@example.test');
    await clickButton(page, 'form[aria-label="Invite someone"]', 'Create invitation');
    await page.waitForSelector('.notice input.mono');
    const code = await page.$eval('.notice input.mono', (i) => (i as HTMLInputElement).value);
    expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    await clickButton(page, '.notice', 'Done');
    expect(await page.content()).not.toContain(code);
    await page.waitForFunction(() =>
      document.querySelector('table.records')?.textContent?.includes('someone.else@example.test'),
    );

    await goTo(page, 'Account');
    await page.type('form[aria-labelledby=join-title] input', `Your code: ${code}`);
    await clickButton(page, 'form[aria-labelledby=join-title]', 'Check');
    await page.waitForFunction(() =>
      document
        .querySelector('form[aria-labelledby=join-title]')
        ?.textContent?.includes('different e-mail address'),
    );
    await page.close();
  });

  it('asks the owner to sign in again before transferring ownership, then completes it', async () => {
    const page = await open('signedin');
    await openOrg(page, 'Members');
    await clickButton(page, '#main', 'Transfer ownership');
    await page.waitForSelector('[role=alertdialog] select');
    await clickButton(page, '[role=alertdialog]', 'Transfer');
    await clickButton(page, '[role=alertdialog]', "Confirm it's me");
    await toastContains(page, 'is now the owner. You are an admin.');
    await page.waitForFunction(() => document.querySelector('header')?.textContent?.includes('Admin'));
    await page.close();
  });

  it('gives an operator access to a client, and an operator sees only what was shared', async () => {
    const page = await open('signedin');
    await openOrg(page, 'Access');
    await page.waitForSelector('form[aria-label="Give access"] select');
    const option = await page.$eval(
      'form[aria-label="Give access"] select',
      (sel) =>
        [...(sel as HTMLSelectElement).options].find((o) => o.textContent === 'Client South')?.value ?? '',
    );
    await page.select('form[aria-label="Give access"] select', option);
    await clickButton(page, 'form[aria-label="Give access"]', 'Give access');
    await page
      .waitForFunction(() => document.querySelector('ul.plain')?.textContent?.includes('Client South'))
      .catch(async (e) => {
        console.error(
          'Access section when the grant did not appear:',
          await page.$eval('#main', (m) => (m as HTMLElement).innerText),
        );
        throw e;
      });
    await page.close();

    const member = await open('member');
    await openOrg(member);
    const rows = await text(member, 'table.records');
    expect(rows).toContain('North shop admin');
    expect(rows).not.toContain('South support desk');
    const buttons = await member.$$eval('.org-nav button', (bs) => bs.map((b) => b.textContent?.trim()));
    // Milestone 10: operators see automation jobs on what was shared with them (and may run them).
    expect(buttons).toEqual(['Profiles', 'Clients', 'Extensions', 'Automation', 'Settings']);
    expect(await member.$$eval('#main button', (bs) => bs.map((b) => b.textContent?.trim()))).not.toContain(
      'Add profile',
    );
    await member.close();
  });

  it('marks information as offline and refuses changes until the server is back', async () => {
    const page = await open('signedin-cloudoffline');
    await openOrg(page, 'Clients');
    await clickButton(page, '.org-nav', 'Profiles');
    await clickButton(page, '.org-nav', 'Clients');
    await page.waitForFunction(() =>
      document.body.textContent?.includes('Offline: showing information saved'),
    );
    await page.close();
  });

  it('copies a local workspace into an organization after a preview, keeping the local profiles', async () => {
    const page = await open('signedin');
    const before = await page.$eval('[role=grid]', (g) => g.getAttribute('aria-rowcount'));
    await openOrg(page, 'Settings');
    await clickButton(page, '#main', 'Copy profiles from this computer…');
    await clickButton(page, '[role=dialog]', 'Preview');
    await page.waitForFunction(() =>
      document.querySelector('[role=dialog]')?.textContent?.includes('will be added'),
    );
    const label = await page.$eval(
      '[role=dialog] .row--end button[data-variant=primary]',
      (b) => b.textContent ?? '',
    );
    await clickButton(page, '[role=dialog]', label.trim());
    await page.waitForFunction(() =>
      document.querySelector('[role=dialog]')?.textContent?.includes('are unchanged'),
    );
    await clickButton(page, '[role=dialog]', 'Done');
    await clickButton(page, '.org-nav', 'Profiles');
    await page.waitForFunction(() => document.querySelectorAll('table.records tbody tr').length > 3);
    await page.select(
      '.workspace select',
      await page.$eval('.workspace option', (o) => (o as HTMLOptionElement).value),
    );
    await page.waitForSelector('[role=grid]');
    expect(await page.$eval('[role=grid]', (g) => g.getAttribute('aria-rowcount'))).toBe(before);
    await page.close();
  });
});

describe('encrypted backups (milestone 07)', () => {
  const drawerHas = (page: Page, needle: string, timeout = 10_000) =>
    page.waitForFunction(
      (t) => document.querySelector('.drawer')?.textContent?.includes(t),
      { timeout },
      needle,
    );

  it('backs up a linked profile with progress, then lists and restores versions', async () => {
    const page = await open('signedin linked');
    await clickRow(page, 'Shop admin');
    await drawerHas(page, 'Organization backup: version 1');
    await clickButton(page, '.drawer', 'Upload backup now');
    await page.waitForSelector('.drawer progress[aria-label="Backup progress"]');
    await drawerHas(page, 'Organization backup: version 2');
    await clickButton(page, '.drawer', 'Version history…');
    await page.waitForFunction(() => document.querySelectorAll('[role=dialog] tbody tr').length === 2);
    const violations = await axeSerious(page);
    expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
    await clickButton(page, '[role=dialog]', 'Restore as copy of version 1');
    await toastContains(page, 'separate copy');
    await page.waitForFunction(
      () =>
        [...document.querySelectorAll('.trow__name')].some((n) => n.textContent?.includes('(restored copy)')),
      { timeout: 10_000 },
    );
    await page.close();
  });

  it('a newer backup from another computer is a conflict with three choices, never an overwrite', async () => {
    const page = await open('signedin linked conflict');
    await clickRow(page, 'Shop admin');
    await clickButton(page, '.drawer', 'Upload backup now');
    await page.waitForSelector('.drawer [role=alert]', { timeout: 10_000 });
    await drawerHas(page, 'Nothing was overwritten');
    for (const label of [
      'Keep mine as the newest',
      'Replace mine with the newer one',
      'Open the newer one as a copy',
    ]) {
      await page.waitForFunction(
        (l) => [...document.querySelectorAll('.drawer [role=alert] button')].some((b) => b.textContent === l),
        {},
        label,
      );
    }
    // Backing up again is refused until the user chooses.
    const disabled = await page.$$eval('.drawer button', (bs) =>
      bs.filter((b) => b.textContent === 'Upload backup now').map((b) => (b as HTMLButtonElement).disabled),
    );
    expect(disabled).toEqual([true]);
    await clickButton(page, '.drawer', 'Keep mine as the newest');
    await drawerHas(page, 'Organization backup: version 2');
    expect(await page.$('.drawer [role=alert]')).toBeNull();
    await page.close();
  });

  it('puts an organization profile on this computer and says sign-ins do not carry over', async () => {
    const page = await open('signedin');
    await openOrg(page, 'Profiles');
    await clickButton(page, '#main', 'Put on this computer North shop admin');
    await toastContains(page, 'Restoring North shop admin');
    await page.waitForFunction(
      () => document.querySelector('table.records')?.textContent?.includes('On this computer'),
      { timeout: 10_000 },
    );
    // A profile without any backup cannot be put here.
    await clickButton(page, '#main', 'Put on this computer North ads');
    await toastContains(page, 'has no backup yet');
    await page.select(
      '.workspace select',
      await page.$eval('.workspace option', (o) => (o as HTMLOptionElement).value),
    );
    await page.waitForSelector('[role=grid]');
    await clickRow(page, 'North shop admin');
    await drawerHas(page, 'sign in to websites again');
    await page.close();
  });

  it('owners set retention, restore from the trash and rotate the key after confirming it is them', async () => {
    const page = await open('signedin');
    await openOrg(page, 'Profiles');
    await clickButton(page, '#main', 'Delete South support desk');
    await clickButton(page, '[role=alertdialog]', 'Delete profile');
    await toastContains(page, 'Deleted South support desk');
    await clickButton(page, '.org-nav', 'Backups');
    await page.waitForSelector('#org-keys-title');
    const retention = await page.waitForSelector('#main input[type=number]');
    await retention?.click({ count: 3 });
    await retention?.type('14');
    await clickButton(page, '#main', 'Save retention');
    await toastContains(page, 'Backup policy saved');
    await clickButton(page, '#main', 'Restore South support desk');
    await toastContains(page, 'Restored South support desk from the trash');
    await clickButton(page, '#main', 'Rotate key…');
    await clickButton(page, '[role=alertdialog]', 'Rotate key');
    await clickButton(page, '[role=alertdialog]', "Confirm it's me");
    await toastContains(page, 'The organization key was rotated');
    await page.waitForFunction(() =>
      [...document.querySelectorAll('#main table.records tbody th')].some((t) => t.textContent === '2'),
    );
    await page.close();
  });
});

describe('shared sessions (milestone 08)', () => {
  const drawerHas = (page: Page, needle: string, timeout = 10_000) =>
    page.waitForFunction(
      (t) => document.querySelector('.drawer')?.textContent?.includes(t),
      { timeout },
      needle,
    );
  const rowShared = (page: Page, name: string) =>
    page.$$eval(
      '.trow',
      (rows, n) =>
        rows
          .find((r) => r.querySelector('.trow__name')?.textContent?.trim() === n)
          ?.querySelector('.col-sync')
          ?.textContent?.trim() ?? '',
      name,
    );

  it('opens a shared profile, shows a request that closes nothing, and hands off with a note', async () => {
    const page = await open('signedin linked requests');
    await clickRow(page, 'Shop admin');
    await drawerHas(page, 'Shared with your organization');
    await drawerHas(page, 'Nobody has it open');
    expect(await rowShared(page, 'Shop admin')).toBe('Shared');
    await clickButton(page, '.drawer', 'Open profile');
    await drawerHas(page, 'Others see that you have it open');
    await page.waitForFunction(
      () => document.querySelector('.trow .col-sync .badge')?.textContent === 'Open here',
    );
    // A teammate asks: told, never closed.
    await toastContains(page, 'Sam Operator asks for “Shop admin”');
    await drawerHas(page, 'Sam Operator asks for this profile: “Need it for the refund queue”');
    expect(await page.$eval('.drawer', (d) => d.textContent?.includes('Close profile'))).toBe(true);
    const violations = await axeSerious(page);
    expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);

    await clickButton(page, '.drawer [role=alert]', 'Close and hand off…');
    const note = await page.waitForSelector('[role=dialog] textarea');
    // Built at run time: a note that looks like a password is refused before it is sent.
    await note?.type(`${['pass', 'word'].join('')}: not-a-real-one`);
    await page.waitForFunction(() =>
      [...document.querySelectorAll<HTMLButtonElement>('[role=dialog] button[type=submit]')].every(
        (b) => b.disabled,
      ),
    );
    await note?.click({ count: 3 });
    await page.keyboard.press('Backspace');
    await note?.type('Refund half done');
    await clickButton(page, '[role=dialog]', 'Close and hand off');
    await toastContains(page, 'handed off once its backup is saved');
    await drawerHas(page, 'Handing off');
    await toastContains(page, '“Shop admin” is saved and free for the next person');
    await drawerHas(page, 'Nobody has it open');
    expect(await rowShared(page, 'Shop admin')).toBe('Shared');
    await page.close();
  });

  it('someone else has it: opening is refused, asking is offered, and an admin takes over with a reason', async () => {
    const page = await open('signedin linked inuse');
    await clickRow(page, 'Shop admin');
    await drawerHas(page, 'In use: open by Sam Operator on Sam’s Windows laptop');
    await clickButton(page, '.drawer', 'Open profile');
    await toastContains(page, 'Someone else has this profile open');
    await clickButton(page, '.drawer', 'Ask for it…');
    await clickButton(page, '[role=dialog]', 'Send request');
    await toastContains(page, 'Asked Sam Operator');
    await drawerHas(page, 'Waiting for an answer');

    await clickButton(page, '.drawer', 'Take over…');
    await page.waitForSelector('[role=alertdialog] textarea');
    const takeDisabled = () =>
      page.$$eval('[role=alertdialog] button[type=submit]', (bs) => (bs[0] as HTMLButtonElement).disabled);
    expect(await takeDisabled()).toBe(true);
    await page.type('[role=alertdialog] textarea', 'Sam is away and refunds are due today');
    expect(await takeDisabled()).toBe(true);
    await page.click('[role=alertdialog] input[type=checkbox]');
    expect(await takeDisabled()).toBe(false);
    const violations = await axeSerious(page);
    expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
    await clickButton(page, '[role=alertdialog]', 'Take over');
    await toastContains(page, 'Taken over.');
    await drawerHas(page, 'Nobody has it open');
    await clickButton(page, '.drawer', 'Open profile');
    await drawerHas(page, 'Others see that you have it open');
    await page.close();
  });

  it('taken over here: the profile closes, this copy is kept aside and becomes a recovery copy', async () => {
    const page = await open('signedin linked takeover');
    await clickRow(page, 'Shop admin');
    await clickButton(page, '.drawer', 'Open profile');
    await toastContains(page, 'An admin took over “Shop admin”');
    await drawerHas(page, 'uploaded as a recovery copy');
    await page.waitForFunction(() =>
      [...document.querySelectorAll('.drawer button')].some((b) => b.textContent === 'Open profile'),
    );
    await page.waitForFunction(
      () => document.querySelector('.trow .col-sync .badge')?.textContent === 'Taken over',
    );
    await clickButton(page, '.drawer', 'Open profile');
    await toastContains(page, 'Dismiss the notice first');
    await clickButton(page, '.drawer', 'Dismiss');
    await drawerHas(page, 'Nobody has it open');
    await openOrg(page, 'Backups');
    await page.waitForSelector('#org-recovery-title');
    await clickButton(page, '#main', 'Restore as a new profile from North shop admin');
    await toastContains(page, 'Restoring the recovery copy');
    await page.close();
  });

  it('a shared profile does not open offline; local profiles still do', async () => {
    const page = await open('signedin linked teamoffline');
    await clickRow(page, 'Shop admin');
    await clickButton(page, '.drawer', 'Open profile');
    await toastContains(page, 'only when this computer can reach');
    await page.close();
  });

  it('organization profiles show who has each one open, and access says what operators may do', async () => {
    const page = await open('signedin inuse');
    await openOrg(page, 'Profiles');
    await page.waitForFunction(() =>
      document.querySelector('table.records')?.textContent?.includes('Sam Operator · Sam’s Windows laptop'),
    );
    await page.waitForFunction(() =>
      [...document.querySelectorAll('#main button')].some(
        (b) => b.textContent === 'Take over… North shop admin',
      ),
    );
    await clickButton(page, '.org-nav', 'Access');
    await page.waitForSelector('#org-access-title');
    const sam = await page.waitForFunction(
      () =>
        [...document.querySelectorAll<HTMLOptionElement>('#main select option')].find((o) =>
          o.textContent?.includes('Sam Operator'),
        )?.value,
      { timeout: 10_000 },
    );
    await page.select('#main select', (await sam.jsonValue()) as string);
    const boxes = await page.waitForFunction(
      () => {
        const labels = [...document.querySelectorAll('#main .choice')];
        return labels.length === 3
          ? labels.map((l) => [l.textContent?.trim(), l.querySelector('input')?.checked])
          : null;
      },
      { timeout: 10_000 },
    );
    expect(await boxes.jsonValue()).toEqual([
      ['Open', true],
      ['Change settings', false],
      ['Restore backups', true],
    ]);
    const labels = await page.$$('#main .choice input');
    await labels[1]?.click();
    await toastContains(page, 'Access changed.');
    await page.waitForFunction(
      () => document.querySelectorAll<HTMLInputElement>('#main .choice input')[1]?.checked === true,
    );
    const violations = await axeSerious(page);
    expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
    await page.close();
  });
});

describe('agency workspace and technical health (milestone 09)', () => {
  it('health cards say when each thing was checked, and a check can run again', async () => {
    const page = await open('signedin');
    await goTo(page, 'Health');
    await healthReady(page);
    const cards = await page.$$eval('.health-card h2', (hs) => hs.map((h) => h.textContent?.trim()));
    expect(cards).toEqual([
      'Server connection',
      'Proxies',
      'Browser',
      'Backups',
      'Sync conflicts',
      'Disk space',
      'Open profiles and sessions',
      'Extensions',
      'Memory',
    ]);
    // Status is written out, never colour alone; the server was checked when the page opened.
    const server = await text(page, '.health-card');
    expect(server).toMatch(/OK/);
    expect(server).toMatch(/Checked (just now|\d+ min ago)/);
    const all = (await text(page, '.health-grid')).toLowerCase();
    for (const word of ['ban', 'suspend', 'risk score']) expect(all).not.toContain(word);
    await clickButton(page, '.health-card', 'Check again (Server connection)');
    await page.waitForFunction(() =>
      document.querySelector('.health-card')?.textContent?.includes('Checked'),
    );
    await page.close();
  });

  it('shows what open profiles use, with the manager counted apart', async () => {
    const page = await open('running');
    await goTo(page, 'Health');
    await clickButton(page, '.org-nav', 'Resources');
    await page.waitForSelector('table.records');
    const body = await text(page, 'main');
    expect(body).toContain('the manager uses');
    expect(body).toContain('Only browsers this app opened are counted');
    expect(body).toMatch(/Real use depends on the sites/);
    await page.close();
  });

  it('an extension update that asks for more access is a notification until reviewed', async () => {
    const page = await open('extupdate');
    await page.waitForFunction(() => document.querySelector('.notices-button')?.textContent?.includes('(1)'));
    await page.click('.notices-button');
    await page.waitForFunction(() =>
      document.querySelector('.notice-list')?.textContent?.includes('asks for more access'),
    );
    await clickButton(page, '.notice-list', 'Review');
    await page.waitForFunction(() =>
      document.querySelector('main')?.textContent?.includes('Mark as reviewed'),
    );
    await clickButton(page, 'main', 'Mark as reviewed (Tab saver)');
    await toastContains(page, 'Tab saver: marked as reviewed.');
    await page.close();
  });

  it('the command palette finds a profile by client and opens it with the keyboard; ? lists shortcuts', async () => {
    const page = await open('');
    await page.keyboard.down('Control');
    await page.keyboard.press('k');
    await page.keyboard.up('Control');
    await page.waitForSelector('[role=combobox]');
    expect((await focused(page)).role).toBe('combobox');
    await page.keyboard.type('ads qa');
    await page.waitForFunction(() =>
      document.querySelector('[role=listbox]')?.textContent?.includes('Open Ads QA (Client South)'),
    );
    // Commands first, then profiles: move down to the profile and run it.
    for (let i = 0; i < 12; i++) {
      const active = await page.$eval('[role=option][aria-selected=true]', (o) => o.textContent ?? '');
      if (active.includes('Open Ads QA')) break;
      await page.keyboard.press('ArrowDown');
    }
    await page.keyboard.press('Enter');
    await toastContains(page, 'Opening Ads QA (Client South)');
    await page.keyboard.press('?');
    await page.waitForFunction(
      () => document.querySelector('[role=dialog] h2')?.textContent === 'Keyboard shortcuts',
    );
    await page.keyboard.press('Escape');
    // Ctrl+4 goes to the fourth screen (Health).
    await page.keyboard.down('Control');
    await page.keyboard.press('4');
    await page.keyboard.up('Control');
    await page.waitForFunction(() => document.querySelector('h1')?.textContent === 'Health');
    await page.close();
  });

  it('a bulk move to the trash names the clients and profiles first', async () => {
    const page = await open('');
    await page.focus('[role=grid]');
    await page.keyboard.press('Space');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Space');
    await clickButton(page, '.bulk-bar', 'Move 2 to trash');
    await page.waitForFunction(() =>
      document.querySelector('[role=alertdialog]')?.textContent?.includes('2 profiles'),
    );
    const dialog = await text(page, '[role=alertdialog]');
    expect(dialog).toMatch(/Client (North|South)/);
    expect(dialog).toContain('Nothing is done on websites');
    await clickButton(page, '[role=alertdialog]', 'Cancel');
    expect(await page.$('[role=alertdialog]')).toBeNull();
    await page.close();
  });

  it('warns before opening when memory looks short, and opens on confirmation', async () => {
    const page = await open('lowmem');
    await clickRow(page, 'Ads QA');
    await clickButton(page, '.drawer', 'Open profile');
    await page.waitForFunction(() =>
      document.querySelector('[role=alertdialog]')?.textContent?.includes('Memory may run short'),
    );
    expect(await text(page, '[role=alertdialog]')).toContain('Real use depends on the sites');
    await clickButton(page, '[role=alertdialog]', 'Open anyway');
    await toastContains(page, 'Opening Ads QA (Client South)');
    await page.close();
  });

  it('previews the diagnostics report before saving it', async () => {
    const page = await open('');
    await goTo(page, 'Health');
    await clickButton(page, '.org-nav', 'Diagnostics');
    await clickButton(page, 'main', 'Preview and save report…');
    await page.waitForSelector('[role=dialog] textarea');
    const preview = await page.$eval('[role=dialog] textarea', (t) => (t as HTMLTextAreaElement).value);
    expect(preview).toContain('"error_summary"');
    expect(preview).not.toMatch(/https?:\/\//);
    expect(await text(page, '[role=dialog]')).toMatch(/Removed: .*web address/);
    await clickButton(page, '[role=dialog]', 'Save…');
    await toastContains(page, 'Diagnostics saved to');
    await page.close();
  });

  it('client dashboard: tasks are ticked off and shared bookmarks refuse executable links', async () => {
    const page = await open('signedin');
    await openDashboard(page);
    const stats = await text(page, '.stat-row');
    expect(stats).toContain('profiles you can see');
    // A task, then ticked off.
    await page.type('form[aria-label="Add a task"] input', 'Reply to the supplier');
    await clickButton(page, 'form[aria-label="Add a task"]', 'Add task');
    await toastContains(page, 'Task “Reply to the supplier” added.');
    const box = await page.waitForFunction(() =>
      [...document.querySelectorAll('.task')]
        .find((t) => t.textContent?.includes('Reply to the supplier'))
        ?.querySelector('input[type=checkbox]'),
    );
    await (box.asElement() as unknown as { click(): Promise<void> }).click();
    await toastContains(page, 'Ticked off “Reply to the supplier”.');
    // Bookmarks: javascript: is refused with an explanation; https is added.
    const form = 'form[aria-label="Add a bookmark"]';
    await page.type(`${form} input[maxlength="120"]`, 'Trick');
    await page.type(`${form} input[type=url]`, 'javascript:alert(document.cookie)');
    await clickButton(page, form, 'Add bookmark');
    await page.waitForFunction(() =>
      document.querySelector('#bk-problem')?.textContent?.includes('Only http'),
    );
    await page.$eval(`${form} input[type=url]`, (i) => {
      (i as HTMLInputElement).value = '';
    });
    await page.click(`${form} input[type=url]`, { count: 3 });
    await page.keyboard.press('Backspace');
    await page.type(`${form} input[type=url]`, 'https://support.shop.example/');
    await clickButton(page, form, 'Add bookmark');
    await toastContains(page, 'Bookmark “Trick” added.');
    await page.waitForFunction(() =>
      document.querySelector('.bookmark-list')?.textContent?.includes('support.shop.example'),
    );
    await page.close();
  });

  it('owners block a reported extension in the organization policy', async () => {
    const page = await open('signedin');
    await openOrg(page, 'Extensions');
    await page.waitForFunction(() => document.querySelector('main')?.textContent?.includes('Coupon finder'));
    expect(await text(page, 'main')).toContain('Not on your organization’s list');
    await clickButton(page, 'main', 'Block Coupon finder');
    await clickButton(page, 'main', 'Save policy');
    await toastContains(page, 'Extension policy saved.');
    await page.waitForFunction(() =>
      document.querySelector('main')?.textContent?.includes('Blocked by your organization'),
    );
    await page.close();
  });
});

describe('billing (milestone 11)', () => {
  const opened = (page: Page) =>
    page.evaluate(
      () => (window as unknown as { __pbDemo: { billing: { opened: string[] } } }).__pbDemo.billing.opened,
    );

  it('an owner chooses a plan; the screen waits for the server to confirm, then lists the invoice', async () => {
    const page = await open('signedin');
    await openOrg(page, 'Billing');
    const main = await text(page, 'main');
    expect(main).not.toContain('Trial · Trial');
    expect(main).toMatch(/Trial: \d+ days left/);
    expect(main).toContain('Choose a plan');
    expect(main).toContain('this app never sees card details');
    expect(await text(page, '.plan-list')).toContain('Team');
    await clickButton(page, '.plan-list', 'Choose Team');
    await toastContains(page, 'Checkout for Team opened in your browser');
    expect(await opened(page)).toContain('checkout:team');
    expect(await text(page, 'main')).toContain('Waiting for the payment provider to confirm');
    await toastContains(page, 'Subscription updated: Team');
    // The plan card names the plan and shows its state as a pill.
    await page.waitForFunction(() => {
      const hero = document.querySelector('main .plan-hero[data-state=active]');
      return (
        hero?.querySelector('.plan-hero__name')?.textContent === 'Team' &&
        hero.textContent?.includes('Active')
      );
    });
    // Now managed in the portal: no plan list, an invoice to open.
    expect(await page.$('.plan-list')).toBeNull();
    await clickButton(page, 'main', 'Manage subscription…');
    expect(await opened(page)).toContain('portal');
    await page.waitForFunction(() => document.querySelector('main')?.textContent?.includes('DEMO-0001'));
    await clickInRow(page, 'DEMO-0001', 'PDF of invoice DEMO-0001');
    expect((await opened(page)).some((o: string) => o.endsWith(':pdf'))).toBe(true);
    const violations = await axeSerious(page);
    expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
    await page.close();
  });

  it('a restricted organization says what still works, on every screen of it', async () => {
    const page = await open('signedin');
    await simulateBilling(page, 'restricted');
    await openOrg(page);
    await page.waitForSelector('.billing-banner[role=alert]');
    const banner = await text(page, '.billing-banner');
    expect(banner).toContain('Restricted.');
    expect(banner).toContain('close profiles, back up, export and delete');
    expect(banner).toContain('Nothing is deleted.');
    await clickButton(page, '.billing-banner', 'Open billing');
    await page.waitForSelector('#org-billing-title');
    expect(await text(page, 'main .plan-hero[data-state=restricted]')).toContain(
      'The subscription needs attention.',
    );
    const violations = await axeSerious(page);
    expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
    await page.close();
  });

  it('members without billing access see the banner but not the billing screen', async () => {
    const member = await open('member');
    await member.waitForFunction(() => '__pbDemo' in window);
    await member.waitForSelector('.workspace option[value^="org:"]');
    await member.evaluate(() => {
      const demo = (
        window as unknown as { __pbDemo: { billing: { simulate(s: string, org?: string): void } } }
      ).__pbDemo;
      // The operator's organization is owned by someone else: put it in grace by id.
      const orgId = [...document.querySelectorAll<HTMLOptionElement>('.workspace option')]
        .find((o) => o.value.startsWith('org:'))
        ?.value.slice(4);
      demo.billing.simulate('grace', orgId);
    });
    await openOrg(member);
    await member.waitForSelector('.billing-banner');
    expect(await text(member, '.billing-banner')).toContain('Ask an owner of this organization.');
    const nav = await member.$$eval('.org-nav button', (bs) => bs.map((b) => b.textContent?.trim()));
    expect(nav).not.toContain('Billing');
    await member.close();
  });
});

describe('developer API and automation (milestone 10)', () => {
  const automationTab = (page: Page, tab: string) =>
    clickButton(page, 'main nav[aria-label="Automation sections"]', tab);

  it('the job dashboard shows steps and screenshots, and a stop names the profile first', async () => {
    const page = await open('signedin');
    await openOrg(page, 'Automation');
    await page.waitForFunction(() =>
      document.querySelector('main')?.textContent?.includes('Morning login check'),
    );
    const main = await text(page, 'main');
    expect(main).toContain('The page went to a site that is not approved; the job stopped there.');
    expect(main).toContain('Holding open');
    expect(main).toContain('token “Nightly checks”');
    // Steps of the succeeded job, then its screenshot (downloaded by the shell, shown as an image).
    await clickInRow(page, 'Morning login check', 'Steps');
    await page.waitForFunction(() =>
      document.querySelector('.job-steps')?.textContent?.includes('Wait for the text'),
    );
    expect(await text(page, '.job-steps')).toContain('closing backup saved');
    await clickButton(page, '.job-steps', 'Show screenshot “login”');
    await page.waitForSelector('img.job-shot');
    const alt = await page.$eval('img.job-shot', (i) => (i as HTMLImageElement).alt);
    expect(alt).toMatch(/^Screenshot “login” of /);
    // Stopping a profile held open: the confirmation names the profile; the job then ends as succeeded.
    await clickInRow(page, 'Keep open for review', 'Stop');
    await page.waitForSelector('[role=alertdialog]');
    expect(await text(page, '[role=alertdialog] h2')).toMatch(/^Stop holding .+ open\?$/);
    expect(await text(page, '[role=alertdialog]')).toContain('closing backup still uploads');
    await clickButton(page, '[role=alertdialog]', 'Stop and close the profile');
    await toastContains(page, 'Stopping');
    await page.waitForFunction(
      () =>
        [...document.querySelectorAll('main table tbody tr')]
          .find((r) => r.textContent?.includes('Keep open for review'))
          ?.textContent?.includes('Succeeded'),
      { timeout: 15_000 },
    );
    const violations = await axeSerious(page);
    expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
    await page.close();
  });

  it('an API token is limited to what its creator can do and its secret is shown once', async () => {
    const page = await open('signedin');
    await openOrg(page, 'Automation');
    await automationTab(page, 'API tokens');
    await page.waitForFunction(() => document.querySelector('main')?.textContent?.includes('Nightly checks'));
    await clickButton(page, 'main', 'New token…');
    await page.waitForSelector('[role=dialog] form');
    await page.type('[role=dialog] input', 'CI smoke tests');
    await page.evaluate(() => {
      const box = [...document.querySelectorAll<HTMLLabelElement>('[role=dialog] label.choice')].find((l) =>
        l.textContent?.includes('Run automation jobs'),
      );
      box?.querySelector('input')?.click();
    });
    await clickButton(page, '[role=dialog]', 'Create token');
    await page.waitForSelector('[role=alertdialog] input.mono');
    const secret = await page.$eval('[role=alertdialog] input.mono', (i) => (i as HTMLInputElement).value);
    expect(secret).toMatch(/^pbt_tok_[0-9A-HJKMNP-TV-Z]{26}_[A-Za-z0-9_-]{43}$/);
    expect(await text(page, '[role=alertdialog]')).toContain('shown only this once');
    await clickButton(page, '[role=alertdialog]', 'I copied it');
    await page.waitForFunction(() => document.querySelector('main')?.textContent?.includes('CI smoke tests'));
    // The list never shows a secret again.
    expect(await text(page, 'main')).not.toContain(secret);
    await page.close();
  });

  it('webhooks refuse internal destinations, show the signing secret once and send dead letters again', async () => {
    const page = await open('signedin');
    await openOrg(page, 'Automation');
    await automationTab(page, 'Webhooks');
    await page.waitForFunction(() =>
      document.querySelector('main')?.textContent?.includes('hooks.example.com'),
    );
    await clickButton(page, 'main', 'New endpoint…');
    await page.waitForSelector('[role=dialog] form');
    const url = '[role=dialog] input.mono';
    await page.$eval(url, (i) => {
      (i as HTMLInputElement).select();
    });
    await page.type(url, 'https://169.254.169.254/latest');
    await page.waitForFunction(() =>
      document
        .querySelector('[role=dialog]')
        ?.textContent?.includes('cloud-metadata addresses cannot receive webhooks'),
    );
    await page.$eval(url, (i) => {
      (i as HTMLInputElement).select();
    });
    await page.type(url, 'https://hooks.example.org/pb');
    await clickButton(page, '[role=dialog]', 'Create endpoint');
    await page.waitForSelector('[role=alertdialog] input.mono');
    const secret = await page.$eval('[role=alertdialog] input.mono', (i) => (i as HTMLInputElement).value);
    expect(secret).toMatch(/^whsec_[A-Za-z0-9+/]{43}=$/);
    await clickButton(page, '[role=alertdialog]', 'I copied it');
    // Listed with the seeded endpoint (whose dead letter is sent again below).
    await page.waitForFunction(() =>
      document.querySelector('main table')?.textContent?.includes('hooks.example.org/pb'),
    );
    await clickInRow(page, 'hooks.example.com/project-browser', 'Deliveries');
    await page.waitForFunction(() =>
      document.querySelector('main ul.deliveries')?.textContent?.includes('server error (5xx)'),
    );
    await clickButton(page, 'main ul.deliveries', 'Send again');
    await toastContains(page, 'Sending it again.');
    await page.close();
  });

  it('this computer runs its organization’s jobs once enrolled; Playwright connections need confirming', async () => {
    const page = await open('signedin');
    await goTo(page, 'Settings');
    await page.waitForFunction(() => document.querySelector('main')?.textContent?.includes('Run jobs here'));
    expect(await text(page, '.automation-here')).toContain('it never opens a port for them');
    await clickButton(page, '.automation-here', 'Run jobs here');
    await toastContains(page, 'now runs');
    // The queued job of this person is taken by this computer and runs to the end.
    await page.waitForFunction(
      () => document.querySelector('.automation-here ul.runs')?.textContent?.includes('Succeeded'),
      { timeout: 20_000 },
    );
    expect(await text(page, '.automation-here ul.runs')).toContain('Weekly invoice screenshot');
    // Playwright connections stay off until the warning is confirmed.
    await page.evaluate(() => {
      const box = [...document.querySelectorAll<HTMLLabelElement>('.automation-here label.choice')].find(
        (l) => l.textContent?.includes('Allow Playwright connections'),
      );
      box?.querySelector('input')?.click();
    });
    await page.waitForSelector('[role=alertdialog]');
    expect(await text(page, '[role=alertdialog]')).toContain('including its sign-ins');
    await clickButton(page, '[role=alertdialog]', 'Keep it off');
    const checked = await page.evaluate(
      () =>
        [...document.querySelectorAll<HTMLLabelElement>('.automation-here label.choice')]
          .find((l) => l.textContent?.includes('Allow Playwright connections'))
          ?.querySelector('input')?.checked,
    );
    expect(checked).toBe(false);
    const violations = await axeSerious(page);
    expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
    await page.close();
  });
});

describe('app updates (milestone 12)', () => {
  const installed = (page: Page) =>
    page.evaluate(
      () =>
        (window as unknown as { __pbDemo: { updates: { installed: string[] } } }).__pbDemo.updates.installed,
    );
  const cardHas = (page: Page, needle: string) =>
    page.waitForFunction((t) => document.querySelector('.updates')?.textContent?.includes(t), {}, needle);

  it('checks the channel, downloads with progress and installs on a click, never with profiles open', async () => {
    const page = await open('running');
    await goTo(page, 'Downloads and updates');
    await page.waitForSelector('#updates-title');
    expect(await text(page, '.updates')).toContain('Not checked yet on this channel.');
    await clickButton(page, '.updates', 'Check now');
    await cardHas(page, 'Version 0.12.1 is available');
    await clickButton(page, '.updates', 'Download 0.12.1');
    await page.waitForSelector('.updates progress');
    await cardHas(page, 'Version 0.12.1 is downloaded and verified.');
    // A profile is open: installing (which restarts the app) waits until it is closed.
    expect(await text(page, '.updates')).toContain('Close the open profiles first');
    const disabled = await page.$$eval('.updates button', (bs) =>
      bs.filter((b) => (b as HTMLButtonElement).disabled).map((b) => b.textContent?.trim()),
    );
    expect(disabled).toContain('Restart and install 0.12.1');
    expect(await installed(page)).toEqual([]);
    const violations = await axeSerious(page);
    expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
    await page.close();

    const idle = await open('');
    await goTo(idle, 'Downloads and updates');
    await clickButton(idle, '.updates', 'Check now');
    await clickButton(idle, '.updates', 'Download 0.12.1');
    await clickButton(idle, '.updates', 'Restart and install 0.12.1');
    await toastContains(idle, 'Installing the update');
    expect(await installed(idle)).toEqual(['0.12.1']);
    await idle.close();
  });

  it('a channel change checks that channel; a stopped download can continue', async () => {
    const page = await open('', { dark: true });
    await goTo(page, 'Downloads and updates');
    await page.waitForSelector('#updates-title');
    const canary = await page.$('input[name=update-channel]:not(:checked)');
    expect(canary).not.toBeNull();
    await page.$$eval('.updates label.choice', (ls) =>
      ls
        .find((l) => l.textContent?.startsWith('Canary'))
        ?.querySelector('input')
        ?.click(),
    );
    await cardHas(page, 'Version 0.13.0-beta.1 is available');
    await clickButton(page, '.updates', 'Download 0.13.0-beta.1');
    await clickButton(page, '.updates', 'Stop');
    await cardHas(page, 'it continues where it stopped');
    expect(await text(page, 'main')).toContain('Downloading an app update');
    const violations = await axeSerious(page);
    expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
    await page.close();
  });

  it('a withdrawn version is flagged on every screen; a failed signature check offers nothing', async () => {
    const page = await open('update-blocked');
    // The banner appears once the first check has run (automatic in the app; here from the Downloads screen).
    await goTo(page, 'Downloads and updates');
    await clickButton(page, '.updates', 'Check now');
    await page.waitForFunction(() =>
      document.querySelector('main > .banner')?.textContent?.includes('was withdrawn'),
    );
    expect(await text(page, 'main > .banner')).toContain('your profiles and data are not affected');
    await goTo(page, 'Profiles');
    expect(await text(page, 'main > .banner')).toContain('This version (0.12.0) was withdrawn');
    await clickButton(page, 'main > .banner', 'Update');
    await page.waitForSelector('#updates-title');
    const violations = await axeSerious(page);
    expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
    await page.close();

    const forged = await open('update-bad-signature');
    await goTo(forged, 'Downloads and updates');
    await clickButton(forged, '.updates', 'Check now');
    await cardHas(forged, 'not signed with the Project Browser release key');
    expect(
      await forged.$$eval('.updates button', (bs) => bs.map((b) => b.textContent?.trim())),
    ).not.toContain('Download 0.12.1');
    await forged.close();
  });
});

// ------------------------------------------------------------------------------------------------ R3 (ADR-0022)
/** Names of the rows of the unified Profiles list. */
const unifiedRows = (page: Page) =>
  page.$$eval('table.workspace-profiles tbody th[scope=row]', (ths) => ths.map((t) => t.textContent?.trim()));
const waitRowStatus = (page: Page, name: string, status: string) =>
  page.waitForFunction(
    (n, st) =>
      [...document.querySelectorAll('table.workspace-profiles tbody tr')]
        .find((tr) => tr.querySelector('th')?.textContent?.trim() === n)
        ?.querySelector('.badge')
        ?.textContent?.startsWith(st),
    { timeout: 15_000 },
    name,
    status,
  );
/** Team → Invite someone…, once the Team page has finished loading (its sections move while lists arrive). */
async function openInviteWizard(page: Page) {
  await page.waitForFunction(
    () =>
      document.querySelectorAll('table.records').length > 0 &&
      !document.querySelector('#main p[role=status]'),
    { timeout: 10_000 },
  );
  await page.waitForFunction(
    () => {
      const b = [...document.querySelectorAll<HTMLButtonElement>('#main button')].find(
        (x) => x.textContent?.trim() === 'Invite someone…' && !x.disabled,
      );
      b?.click();
      return !!document.querySelector('[role=dialog] input[type=email]');
    },
    { timeout: 10_000, polling: 250 },
  );
}
async function clickChoice(page: Page, label: string) {
  await page.$$eval(
    '[role=dialog] label.choice',
    (ls, l) =>
      ls
        .find((x) => x.textContent?.includes(l))
        ?.querySelector('input')
        ?.click(),
    label,
  );
}
const waitWorkspaceRows = (page: Page) =>
  page.waitForFunction(
    () =>
      !!document.querySelector('table.workspace-profiles tbody tr') ||
      !!document.querySelector('.empty-state'),
    { timeout: 10_000 },
  );

describe('R3 unified profiles and simple team sharing', () => {
  it('a fresh user signs up and reaches Create Profile without any organization, client or server setup', async () => {
    const page = await open('unified fresh server');
    // First run: no local-workspace step; signed out, the local view says what it is and offers an account.
    await page.waitForFunction(() => document.querySelector('[aria-label="About this view"]'));
    expect(await text(page, '.sidebar nav')).toBe('Profiles\nProxies\nTeam\nSubscription\nSettings');
    await clickButton(page, '#main', 'Sign in or create an account');
    await page.waitForFunction(() => document.querySelector('h1')?.textContent === 'Account');
    await clickButton(page, '#main', 'Create account');
    await page.waitForSelector('[role=dialog] input[maxlength="120"]');
    await page.type('[role=dialog] input[maxlength="120"]', 'Bibek Studio');
    await page.click('[role=dialog] label.check input');
    await clickButton(page, '[role=dialog]', 'Create workspace');
    await toastContains(page, 'Welcome! Bibek Studio is ready.');
    // The new workspace's Profiles open at once, with New profile right there.
    await page.waitForFunction(() => document.querySelector('h1')?.textContent === 'Profiles');
    await waitWorkspaceRows(page);
    expect(await page.$eval('.workspace select', (s) => (s as HTMLSelectElement).value)).toMatch(/^org:/);
    await clickButton(page, '#main', 'New profile');
    await page.waitForSelector('[role=dialog] form');
    const fields = await page.$$eval('[role=dialog] label', (ls) =>
      ls.map((l) => l.childNodes[0]?.textContent?.trim()),
    );
    expect(fields).toEqual(['Name', 'Folder (optional)', 'Proxy on this computer (optional)']);
    await page.type('[role=dialog] input', 'Shop admin');
    await clickButton(page, '[role=dialog]', 'Create profile');
    await toastContains(page, 'Profile “Shop admin” created.');
    await waitRowStatus(page, 'Shop admin', 'Available');
    // Opening goes through the session lease, then the browser on this computer.
    await clickButton(page, '#main', 'Open Shop admin');
    await waitRowStatus(page, 'Shop admin', 'Running');
    await clickButton(page, '#main', 'Close Shop admin');
    await waitRowStatus(page, 'Shop admin', 'Available');
    await page.close();
  });

  it('an invitation shares exactly the chosen profiles, previewed first; Members open and use only', async () => {
    const page = await open('unified signedin fifty');
    await page.waitForFunction(() => document.querySelector('h1')?.textContent === 'Profiles');
    await waitWorkspaceRows(page);
    expect(await unifiedRows(page)).toHaveLength(50);
    await goTo(page, 'Team');
    await openInviteWizard(page);
    await page.waitForSelector('[role=dialog] input[type=email]');
    await page.type('[role=dialog] input[type=email]', 'mate@example.test');
    await clickButton(page, '[role=dialog]', 'Next');
    // The Member preset is the default: open and use only.
    expect(await text(page, '[role=dialog]')).toContain(
      'Cannot change their settings, download backups, delete, share or manage billing',
    );
    await clickButton(page, '[role=dialog]', 'Next');
    await page.waitForSelector('[role=dialog] .pick-list input');
    await page.$$eval('[role=dialog] .pick-list label', (labels) => {
      for (const l of labels)
        if (/^Profile (1[1-9]|20)$/.test(l.textContent?.trim() ?? ''))
          (l.querySelector('input') as HTMLInputElement).click();
    });
    expect(await text(page, '[role=dialog]')).toContain('10 profiles selected');
    await clickButton(page, '[role=dialog]', 'Preview access');
    await page.waitForFunction(() =>
      document.querySelector('[role=dialog] section')?.textContent?.includes('10 profiles'),
    );
    const preview = await text(page, '[role=dialog] section');
    expect(preview).toContain(
      'will reach 10 profiles (only these; not ones added later) and can open and use them.',
    );
    expect(preview).toContain('Profile 11');
    expect(preview).not.toContain('Profile 21');
    await clickButton(page, '[role=dialog]', 'Send invitation');
    await page.waitForSelector('.notice input.mono');
    await page.waitForFunction(() =>
      [...document.querySelectorAll('table.records')].some((t) =>
        t.textContent?.includes('mate@example.test'),
      ),
    );
    await page.close();
  });

  it('the teammate sees and opens only the 10 shared profiles, with no billing, export or sharing', async () => {
    const page = await open('unified member fifty');
    await page.waitForFunction(() => document.querySelector('h1')?.textContent === 'Profiles');
    await waitWorkspaceRows(page);
    const rows = await unifiedRows(page);
    expect(rows).toHaveLength(10);
    expect(rows.every((r) => /^Profile (1[1-9]|20)$/.test(r ?? ''))).toBe(true);
    const buttons = await page.$$eval('#main button', (bs) => bs.map((b) => b.textContent?.trim() ?? ''));
    expect(buttons.some((b) => b.startsWith('Delete') || b.startsWith('Move'))).toBe(false);
    expect(buttons).not.toContain('New profile');
    await clickButton(page, '#main', 'Open Profile 12');
    await waitRowStatus(page, 'Profile 12', 'Running');
    await goTo(page, 'Subscription');
    expect(await text(page, '#main')).toContain('managed by its owners and billing managers');
    await goTo(page, 'Team');
    expect(await page.$$eval('#main button', (bs) => bs.map((b) => b.textContent?.trim()))).not.toContain(
      'Invite someone…',
    );
    await page.close();
  });

  it('switching workspaces never shows the previous workspace’s rows', async () => {
    const page = await open('unified signedin');
    await page.waitForFunction(() => document.querySelector('h1')?.textContent === 'Profiles');
    await waitWorkspaceRows(page);
    expect(await unifiedRows(page)).toContain('North shop admin');
    await page.evaluate(async () => {
      const demo = (
        window as unknown as {
          __pbDemo: { account: { request(r: unknown): Promise<unknown> } };
        }
      ).__pbDemo;
      await demo.account.request({
        method: 'POST',
        path: '/v1/organizations',
        body: { name: 'Second shop' },
      });
    });
    await goTo(page, 'Settings'); // reloads the account and its workspaces
    await goTo(page, 'Profiles');
    const second = await page.waitForFunction(
      () =>
        [...document.querySelectorAll<HTMLOptionElement>('.workspace option')].find((o) =>
          o.textContent?.startsWith('Second shop'),
        )?.value,
    );
    // Record every row that appears once the switch has started (mutations before it, such as a toast, still show
    // the first workspace legitimately).
    await page.evaluate(
      (target) => {
        const seen: string[] = [];
        (window as unknown as { __seen: string[] }).__seen = seen;
        new MutationObserver(() => {
          if (document.querySelector<HTMLSelectElement>('.workspace select')?.value !== target) return;
          for (const th of document.querySelectorAll('table.workspace-profiles tbody th'))
            seen.push(th.textContent ?? '');
        }).observe(document.body, { subtree: true, childList: true, characterData: true });
      },
      (await second.jsonValue()) as string,
    );
    await page.select('.workspace select', (await second.jsonValue()) as string);
    await page.waitForFunction(() => document.querySelector('.empty-state'));
    const seen = await page.evaluate(() => (window as unknown as { __seen: string[] }).__seen);
    expect(seen.filter((x) => x.includes('North'))).toEqual([]);
    expect(await text(page, '.toolbar__title p')).toContain('in Second shop');
    await page.close();
  });

  it('a linked profile appears once and opens its earlier session here', async () => {
    const page = await open('unified signedin linked');
    await page.waitForFunction(() => document.querySelector('h1')?.textContent === 'Profiles');
    await waitWorkspaceRows(page);
    const rows = await unifiedRows(page);
    expect(rows.filter((r) => r === 'North shop admin')).toHaveLength(1);
    expect(rows).not.toContain('Shop admin'); // the local copy is the same row, not a second one
    await page.waitForFunction(() =>
      [...document.querySelectorAll('#main button')].some(
        (b) => b.textContent?.trim() === 'Details of North shop admin',
      ),
    );
    await clickButton(page, '#main', 'Open North shop admin');
    await waitRowStatus(page, 'North shop admin', 'Running');
    // The local-only view still has it (and only shows this computer's profiles).
    const local = await page.$eval(
      '.workspace select',
      (s) => [...(s as HTMLSelectElement).options].find((o) => o.value.startsWith('local:'))?.value,
    );
    await page.select('.workspace select', local as string);
    await page.waitForFunction(() => document.querySelector('[aria-label="About this view"]'));
    await page.close();
  });

  it('recoverable states: a teammate has it open; the server cannot be reached', async () => {
    const page = await open('unified signedin inuse');
    await page.waitForFunction(() => document.querySelector('h1')?.textContent === 'Profiles');
    await waitWorkspaceRows(page);
    await waitRowStatus(page, 'North shop admin', 'In use by teammate');
    expect(await page.$$eval('#main button', (bs) => bs.map((b) => b.textContent?.trim()))).toContain(
      'Ask for it North shop admin',
    );
    await page.close();

    const offline = await open('unified signedin cloudoffline');
    await offline.waitForFunction(() => document.querySelector('h1')?.textContent === 'Profiles');
    // Later answers come from the saved copy: marked, and nothing can be opened or changed from it.
    await goTo(offline, 'Team');
    await goTo(offline, 'Profiles');
    // Either the saved copy (marked) or, with nothing saved yet, a plain message with "Try again".
    await offline.waitForFunction(
      () =>
        document.querySelector('#main')?.textContent?.includes('Offline: showing') ||
        document.querySelector('#main [role=alert]')?.textContent?.includes('cannot be reached'),
      {
        timeout: 10_000,
      },
    );
    const open_ = await offline.$$eval('#main table.workspace-profiles button', (bs) =>
      bs.filter((b) => b.textContent?.startsWith('Open ')).map((b) => (b as HTMLButtonElement).disabled),
    );
    expect(open_.every(Boolean)).toBe(true);
    if (await offline.$('#main [role=alert]')) await clickButton(offline, '#main', 'Try again');
    await offline.close();
  });

  it('moving a profile shows who gains or loses access before anything changes', async () => {
    const page = await open('unified signedin');
    await waitWorkspaceRows(page);
    await clickButton(page, '#main', 'New folder');
    await page.type('[role=dialog] input', 'Shops');
    await clickButton(page, '[role=dialog]', 'Create folder');
    await toastContains(page, 'Folder “Shops” created.');
    // Sam (a Member) gets the folder, with profiles added later.
    await goTo(page, 'Team');
    await clickButton(page, '#main', 'Access… of Sam Operator');
    await page.waitForFunction(() =>
      [...document.querySelectorAll('[role=dialog] label.choice')].some(
        (l) => l.textContent?.includes('The profiles in a folder') && !l.querySelector('input')?.disabled,
      ),
    );
    await clickChoice(page, 'The profiles in a folder');
    await clickChoice(page, 'added to this folder later');
    await clickButton(page, '[role=dialog]', 'Preview access');
    await page.waitForFunction(() =>
      document.querySelector('[role=dialog] section')?.textContent?.includes('profiles added there later'),
    );
    await clickButton(page, '[role=dialog]', 'Save access');
    await toastContains(page, 'access was changed');
    await goTo(page, 'Profiles');
    await waitWorkspaceRows(page);
    await clickButton(page, '#main', 'Move… South support desk');
    await page.select(
      '[role=dialog] select',
      (await page.$eval(
        '[role=dialog] select',
        (s) => [...(s as HTMLSelectElement).options].find((o) => o.textContent === 'Shops')?.value,
      )) as string,
    );
    await page.waitForFunction(() =>
      document.querySelector('[role=dialog] section')?.textContent?.includes('Gain access: Sam Operator'),
    );
    await clickButton(page, '[role=dialog]', 'Move');
    await toastContains(page, 'South support desk was moved.');
    await page.close();
  });
});

describe('account gate (sign-in and plan required)', () => {
  it('shows only the welcome screen until the person signs in, then their workspace', async () => {
    const page = await open('unified gate');
    expect(await text(page, 'h1')).toBe('Welcome');
    expect(await page.$('.sidebar')).toBeNull(); // no profiles, proxies or settings before signing in
    const disabled = await page.$$eval('#main button', (bs) =>
      bs
        .filter((b) => ['Sign in', 'Create account'].includes(b.textContent?.trim() ?? ''))
        .map((b) => (b as HTMLButtonElement).disabled),
    );
    expect(disabled).toEqual([true, true]); // this demo build has no server built in
    await page.type('input[type=url]', 'https://browser.example.test');
    await clickButton(page, '#main', 'Save');
    await page.waitForFunction(() => document.body.textContent?.includes('Server: browser.example.test'));
    await clickButton(page, '#main', 'Sign in');
    await page.waitForSelector('.sidebar');
    await page.waitForFunction(() => document.querySelector('h1')?.textContent?.includes('Profiles'));
    expect(await text(page, '.account-chip')).toContain('Demo Person');
    await page.close();
  });

  it('asks for a plan when no workspace has a usable one', async () => {
    const page = await open('unified gate');
    await page.type('input[type=url]', 'https://browser.example.test');
    await clickButton(page, '#main', 'Save');
    await page.waitForFunction(() => document.body.textContent?.includes('Server: browser.example.test'));
    await clickButton(page, '#main', 'Sign in');
    await page.waitForSelector('.sidebar');
    // The plan ends; the next check (here: opening Settings) closes the app behind the plan screen.
    await page.evaluate(() =>
      (
        window as unknown as { __pbDemo: { billing: { simulate(s: string): void } } }
      ).__pbDemo.billing.simulate('canceled'),
    );
    // (Any account refresh may already have closed the app; the click is then simply not needed.)
    await page.evaluate(() =>
      [...document.querySelectorAll<HTMLButtonElement>('nav .nav-item')]
        .find((b) => b.textContent?.trim() === 'Settings')
        ?.click(),
    );
    await page.waitForFunction(() => document.querySelector('h1')?.textContent === 'Your plan has ended');
    expect(await page.$('.sidebar')).toBeNull();
    expect(await text(page, '#main')).toContain('Choose a plan for Demo Agency');
    await page.close();
  });
});
